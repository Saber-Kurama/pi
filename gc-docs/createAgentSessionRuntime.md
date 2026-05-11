这段是 `main.ts` 的**runtime 装配核心**：把 CLI 参数 + settings + session 合成一个可运行的 `AgentSessionRuntime`。

可以按 4 步看：

## 1) 先解析 CLI 传入的资源路径（518-521）

- `resolvedExtensionPaths / resolvedSkillPaths / resolvedPromptTemplatePaths / resolvedThemePaths`
- 作用：把命令行里给的相对路径转换成基于 `cwd` 的绝对/可用路径，后面交给 resource loader。

---

## 2) 定义 `createRuntime` 工厂（523-607）

`createRuntime` 是一个闭包工厂，后面传给 `createAgentSessionRuntime(...)` 使用。它每次被调用会：

### a) 创建服务层（529-548）
`createAgentSessionServices(...)` 初始化：

- `settingsManager`
- `modelRegistry`
- `resourceLoader`
- `authStorage`
- 扩展相关开关（`--no-extensions` 等）
- 额外路径、system prompt、扩展工厂等

相当于把“可配置资源宇宙”先搭起来。

### b) 收集诊断（550-557）
把错误/警告统一收集到 `diagnostics`：

- services 本身诊断
- settings 读取诊断
- extension 加载失败诊断（会转成 `Failed to load extension "...": ...`）

### c) 决定模型范围（559-561）
优先级是：

1. CLI `--models`（`parsed.models`）
2. settings 的 `enabledModels`

然后 `resolveModelScope(...)` 解析成 `scopedModels`。

### d) 计算会话启动选项（562-573）
`buildSessionOptions(...)` 会综合：

- CLI 参数
- `scopedModels`
- 当前 session 是否已有消息（`sessionManager.buildSessionContext().messages.length > 0`）
- modelRegistry
- settingsManager

产出：
- `sessionOptions`（最终 model/thinking/tools/noTools/customTools）
- 以及额外诊断信息

### e) 处理 `--api-key` 临时注入（575-584）
- 若用户给了 `--api-key` 但没选 model -> 记一条 error 诊断
- 否则写入 `authStorage.setRuntimeApiKey(provider, key)`，仅本次 runtime 生效

### f) 真正创建 session 运行体（586-600）
`createAgentSessionFromServices(...)` 结合 services + sessionManager + 选项，生成真正可跑的 `created.session`。

`cliThinkingOverride` 这段（597-600）是为了在 CLI 显式设置 thinking（或由 model 推导）时，把 thinking level 再应用一次，确保 session 内状态一致。

### g) 返回 runtime 构件（602-606）
返回 `created + services + diagnostics`，供外层统一处理。

---

## 3) 打 timing 点并实例化 Runtime（608-613）

- `time("createRuntime")`：启动性能打点
- `createAgentSessionRuntime(createRuntime, {...})`：调用上面定义的工厂，注入：
  - `cwd: sessionManager.getCwd()`
  - `agentDir`
  - `sessionManager`

这一步之后得到 `runtime`，后续 interactive/print/rpc 都基于它运行。

---

## 4) 这段代码在整体架构中的意义

一句话：**它是“参数编排层”**。  
上游（CLI、settings、session）是输入，下游（agent session runtime）是执行体；这段代码把二者桥接起来，并集中处理诊断、模型选择、扩展装载和临时认证。  

如果你在找“改启动行为该从哪下手”，这段就是第一入口。