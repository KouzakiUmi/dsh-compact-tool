#!/usr/bin/env node
/**
 * Build script: emits the host entry (ESM, external @deepseek-ai/*) and the
 * client bundle (CJS body wrapped in the window.__ModuleLoader__ factory).
 *
 *   node build.mjs           one-shot build
 *   node build.mjs --watch   rebuild on changes
 */

import { build, context } from 'esbuild'
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const root = dirname(fileURLToPath(import.meta.url))
const watch = process.argv.includes('--watch')
const pkgName = '@mileskent/dsh-compact-tool'

const shared = {
  absWorkingDir: root,
  bundle: true,
  sourcemap: true,
  minify: false,
  logLevel: 'info',
  target: 'es2022',
  jsx: 'automatic',
  tsconfig: resolve(root, 'tsconfig.json'),
}

/** Client bundle must load through the DSH ModuleLoader factory contract. */
const clientBanner = `window.__ModuleLoader__.load({id:'${pkgName}', factory:(require)=>{var module={exports:{}};var exports=module.exports;`
const clientFooter = `return module.exports}})`

/** externals resolvable by the client seed-word/module-table require. */
const clientExternal = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/*',
]

const hostConfig = {
  ...shared,
  entryPoints: ['src/index.ts'],
  outfile: 'lib/index.js',
  format: 'esm',
  platform: 'node',
  packages: 'external',
}

const clientConfig = {
  ...shared,
  entryPoints: ['src/client/index.tsx'],
  outfile: 'lib/client.js',
  // CJS, not iife: the ModuleLoader banner declares `module`/`exports` locals
  // and the footer returns module.exports. With 'iife' esbuild folds the
  // entry exports into locals and the factory returns {} — the loader then
  // reports "import failed" and the whole plugin is dead client-side.
  format: 'cjs',
  platform: 'browser',
  external: clientExternal,
  banner: { js: clientBanner },
  footer: { js: clientFooter },
  define: {
    'process.env.NODE_ENV': '"production"',
  },
}

async function main() {
  await mkdir(resolve(root, 'lib'), { recursive: true })
  if (watch) {
    const ctxs = await Promise.all([context(hostConfig), context(clientConfig)])
    await Promise.all(ctxs.map(c => c.watch()))
    console.log('[build] watching…')
    return
  }
  await Promise.all([build(hostConfig), build(clientConfig)])

  // Sanity: the client bundle must open with the ModuleLoader factory call.
  const { readFile } = await import('node:fs/promises')
  const clientJs = await readFile(resolve(root, 'lib/client.js'), 'utf8')
  if (!clientJs.startsWith('window.__ModuleLoader__.load({id:\'@mileskent/dsh-compact-tool\'')) {
    throw new Error('client bundle is missing the ModuleLoader factory banner')
  }
  console.log('[build] done → lib/index.js, lib/client.js')
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
