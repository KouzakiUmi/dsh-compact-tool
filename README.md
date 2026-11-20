# dsh-compact-tool

为 DeepSeek Harness 内置的 `@deepseek-ai/dsh-compaction-basic` 提供设置页、按模型覆盖和实时上下文压力监控。已在 DSH `0.2.2-rc.3` 上验证插件挂载。

## 功能

- **设置 → 上下文压缩**（`settings.section`）
  - 全局策略：`thresholdRatio`（触发比例）、`headroomTokens`（预留余量）、`retainRatio`/`retainTokens`（压缩后保留）、`maxTokens`（摘要输出上限）、`compactionRetries`、`maxOverflowRetries`、`auto`（自动压缩开关）、摘要模型路由。
  - **预算条**：按所选模型上下文窗口显示 headroom、输出预留、触发点和保留点。
  - **按模型覆盖**：从当前 provider/模型目录下拉新增覆盖行；行内每个字段带「继承全局」开关。
- **会话输入框页脚**（`conversation.composer.dock`）显示实时上下文使用率和压缩触发刻度。点击环形图可查看压力明细和调整当前模型的策略。
- **模型选择器 ⚙ 压缩设置…**（`conversation.input.model.options` 会话槽位）
  - 弹窗显示该会话**实时**上下文压力（system/tools/messages 分段、projected 动态指示器）叠加在预算条上，阈值/保留标记随滑块联动。
  - 「使用全局策略」开关一键增删该模型的覆盖行。
- 保存通过 `ctx.configEditor.edit` 将配置持久化到 profile 的 `cordis.patch.yml`。使用 agent preset 时，写入其 `config.plugins` 中的 `compaction-basic` 条目。新会话使用已保存的配置，现有会话可能继续使用原有的 preset 实例。

## 架构

```
src/index.ts          Host: CompactToolController extends TypertRemoteService
                      namespace `compactTool`，service key `compactTool`
                      @Remote: describe / catalog / modelInfo / effectiveFor
                              / patchGlobal / setModelPolicy / removeModelPolicy
src/shared.ts         Host↔Client 共享的 wire 类型与默认值
                      （字段名逐字节镜像 dsh-compaction-basic 的 Config schema）
src/client/index.tsx  Client: remote $mount + locale + 槽位注册
src/client/*.tsx      SettingsPage / DockEntry / PolicyDialog / GearOption / BudgetBar /
                      PolicyEditor / controls
build.mjs             esbuild：lib/index.js (ESM, external @deepseek-ai/*)
                              lib/client.js (ModuleLoader CJS factory)
```

### Remote 契约

`@Remote` 方法由网关 SRC 描述符推导（参数 → src-json，末尾 `signal` → cancellation）。客户端用等价的手写 InvocationDescriptor（`mode:'strict'` 存根 codec 满足 `requireStrictInputs`，结果 `src-json` 原样返回）。调用返回 `RemoteResult`（`{ok,value}|{ok:false,error}`）。

### 配置写入语义

- `patchGlobal`：`null` 值 = 删除该键；`modelPolicies` 整体替换。
- `setModelPolicy(provider, model, fields)`：按 `provider\0model` upsert 覆盖行；`null` 删除行内字段（回到继承）。
- `removeModelPolicy`：删除整行，恢复全局继承。
- 同一个策略的连续编辑合并后保存。Host 写入前会核对全局和模型继承后的保留比例低于触发比例。
- 对模型覆盖选择「改用会话模型」会保存一对空字符串。选择「继承全局」会删除这两个字段并恢复全局摘要路由。

## 构建

```bash
npm ci
npm run build      # → lib/index.js + lib/client.js（含 banner 校验）
npm run watch
```

## 安装

克隆仓库并完成上述构建后，在仓库目录运行以下 PowerShell 命令。`desktop` 可以替换为你的 DSH profile 名。

```powershell
$pluginPath = (Get-Location).Path
dsh plugin --profile desktop add "link:$pluginPath"
```

运行时在 GUI 插件管理页可见 `include:compact-tool`，`fiberPhase: active`。

依赖：`llm`、`configEditor`（host inject）；client `inject` 声明在 `package.json` 的 `dsh.client.inject`（session-controller、api-remotes、locale、ui-slots、ui-layout、ui-settings、ui-model-selection）。
