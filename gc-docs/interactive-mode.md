# InteractiveMode 阅读索引

文件：`packages/coding-agent/src/modes/interactive/interactive-mode.ts`

这个文件是 interactive 模式的总控类。建议不要线性阅读 5000+ 行，按下面分组跳读。

## 1) 入口与生命周期

- `constructor(runtimeHost, options)`
  - 绑定 runtime 失效/重绑回调
  - 初始化 TUI 容器、编辑器、footer、keybindings
  - 读取 settings（硬件光标、clear-on-shrink、hide thinking 等）
- `init()`
  - 初始化 UI 组件树、注册事件处理、首屏状态
- `run()`
  - 启动 interactive 主循环
- `shutdown()`
  - 清理订阅、停止 loader、恢复终端状态、释放扩展 UI

## 2) 输入处理（Editor Submit Router）

重点函数：

- `setupEditorSubmitHandler()`
  - slash 命令分发（如 `/model`、`/tree`、`/resume`、`/compact`、`/quit`）
  - bash 命令分支（`!cmd` / `!!cmd`）
  - compaction 期间消息排队
  - streaming 期间 steer 行为
  - 普通消息提交路径

阅读建议：先看这个函数，能快速理解“用户敲回车后到底发生什么”。

## 3) Agent 事件订阅与渲染

重点函数：

- `subscribeToAgent()`
- `handleEvent(event)`

职责：

- 订阅 `session` 事件流
- 增量渲染 assistant message
- 跟踪 tool call 执行组件
- 更新 status/footer/progress
- 处理重试、compaction、工作状态提示

## 4) 会话树与分支相关操作

常见命令入口（在 submit handler 触发）：

- `/resume`
- `/fork`
- `/tree`
- `/new`
- `/compact`

这些最终会调用 `SessionManager` 能力（branch/open/createBranchedSession/buildSessionContext）。

## 5) 模型与认证流程

重点函数簇：

- `showOAuthSelector(...)`
- `showLoginDialog(...)`
- `showApiKeyLoginDialog(...)`
- `completeProviderAuthentication(...)`

职责：

- API key/OAuth 登录流程
- 登录后刷新 model registry
- unknown model 场景下尝试自动选择 provider 默认模型

## 6) 扩展系统与自定义 UI

关注这些状态和函数：

- `extensionSelector` / `extensionInput` / `extensionEditor`
- `extensionWidgetsAbove` / `extensionWidgetsBelow`
- `customHeader` / `customFooter`
- `resetExtensionUI()`
- 会话失效时 runtime 回调触发的重绑逻辑

职责：

- 承载扩展注入的交互 UI
- 扩展命令与内建命令冲突诊断
- 扩展 autocomplete 信息拼接

## 7) UI 结构总览（心智模型）

主要容器：

- `headerContainer`
- `chatContainer`
- `pendingMessagesContainer`
- `statusContainer`
- `widgetContainerAbove`
- `editorContainer`
- `widgetContainerBelow`
- `footer`

可以把它理解为：`header -> chat -> pending -> status -> widgets/editor/widgets -> footer`。

## 8) 建议的二次阅读顺序（最快上手）

1. `constructor`
2. `init` / `run` / `shutdown`
3. `setupEditorSubmitHandler`
4. `handleEvent`
5. 登录与模型切换函数簇
6. 会话树相关命令处理
7. 扩展 UI 相关函数簇

## 9) 调试建议

- 启动耗时：`PI_TIMING=1 ./pi-test.sh --no-env`
- 若只看 interactive 初始化：`PI_TIMING=1 PI_STARTUP_BENCHMARK=1 ./pi-test.sh --no-env`
- 阅读时优先定位“入口函数 + 状态字段”，再看工具函数。

这段 `init()` 是 interactive 模式的**完整启动编排**。  
可以按“启动顺序”来理解：

1. **防重复初始化**
   - `if (this.isInitialized) return;`
   - 避免重复注册事件/重复启动 UI。

2. **准备阶段**
   - `registerSignalHandlers()`：注册退出/中断信号处理。
   - `getChangelogForDisplay()`：计算本次是否展示 changelog（恢复会话时会跳过）。
   - `ensureTool("fd")` + `ensureTool("rg")`：确保工具存在（必要时下载），并把 `fd` 路径存到 `this.fdPath`（给补全等功能用）。

3. **构建 Header**
   - 把 `headerContainer` 先加到 UI。
   - 若 `verbose` 或非 `quietStartup`：
     - 组装 logo、快捷键说明、compact/expanded 两种文案
     - 用 `ExpandableText` 做可展开头部（默认状态来自 `getStartupExpansionState()`）
   - 否则只放最小空 header（静默启动）。

4. **搭整棵 UI 组件树**
   - 依次加入：`chat`、`pending`、`status`、`widgets above`、`editor`、`widgets below`、`footer`
   - `setFocus(this.editor)` 把焦点放到输入框
   - `renderWidgets()` 先渲染默认占位

5. **绑定交互逻辑**
   - `setupKeyHandlers()`：键盘快捷键
   - `setupEditorSubmitHandler()`：回车提交/命令路由逻辑

6. **启动 TUI 主循环**
   - `this.ui.start();`
   - 然后 `isInitialized = true`

7. **会话与消息初始化顺序（重点）**
   - 先 `await this.rebindCurrentSession();`  
     目的是先初始化 extensions，让资源先显示出来。
   - 再 `renderInitialMessages();`  
     初始消息（CLI 传入等）在资源展示后再渲染，用户体验更清晰。

8. **注册运行时监听**
   - `onThemeChange(...)`：主题变化时 `invalidate + updateEditorBorderColor + requestRender`
   - `footerDataProvider.onBranchChange(...)`：分支变化时刷新 UI

9. **最后补充 footer 统计数据**
   - `await this.updateAvailableProviderCount();`
   - 用于 footer 显示可用 provider 数量。

---

一句话总结：  
这段代码把 interactive 模式从“对象构造完成”推进到“可交互运行状态”，并且刻意保证了顺序：**先 UI 骨架 -> 启动 -> 绑定 session/extensions -> 渲染初始消息 -> 挂监听与统计**。



这段 `prompt()` 是 `AgentSession` 的**统一发消息入口**，把“用户输入”变成“可发送给 agent 的消息数组”，并处理 streaming、扩展、模板、鉴权、compaction 等前置逻辑。

按执行顺序解释：

## 1) 前置参数与局部变量

- `expandPromptTemplates`：默认 `true`，控制是否展开 `/skill:*` 和 prompt template。
- `preflightResult`：一个回调，用于告诉调用方“预检查是否通过”（`true/false`）。
- `messages`：最终发送给 `this.agent.prompt(...)` 的消息数组。

---

## 2) 先处理“扩展命令”与输入拦截（最优先）

### 扩展命令即时执行
如果文本以 `/` 开头且允许模板展开，先尝试 `_tryExecuteExtensionCommand(text)`：

- 处理成功：说明命令已被扩展消费，不再发送给 LLM，直接 `preflightResult(true)` 并返回。

### 输入事件拦截（extension input hook）
调用 `this._extensionRunner.emitInput(...)`，可能出现三种动作：

- `handled`：扩展完全接管，直接返回。
- `transform`：扩展改写文本/图片（更新 `currentText/currentImages`）。
- 默认：继续后续流程。

---

## 3) 展开 skill/template

在 `expandPromptTemplates = true` 时：

1. `_expandSkillCommand(expandedText)`：把 `/skill:name ...` 展开。
2. `expandPromptTemplate(expandedText, [...this.promptTemplates])`：套用模板命令展开。

---

## 4) streaming 中的特殊行为（不直接发）

如果 `this.isStreaming`：

- 必须提供 `options.streamingBehavior`，否则抛错。
- `followUp` -> `_queueFollowUp(...)`
- `steer` -> `_queueSteer(...)`

然后 `preflightResult(true)` 并返回，不进入真实 `agent.prompt`。

---

## 5) 非 streaming 时的真正发送前校验

### a) 先清空待注入 bash 消息
`_flushPendingBashMessages()`

### b) 校验模型
`if (!this.model)` -> 报 “No model selected”。

### c) 校验认证
`_modelRegistry.hasConfiguredAuth(this.model)` 不通过时：

- OAuth provider：提示 `/login <provider>` 重新认证。
- API key provider：报缺少 key。

### d) compaction 检查
如果有最近 assistant 消息，先 `await _checkCompaction(...)`，避免上下文过长或中断后状态不一致。

---

## 6) 组装将要发送的消息数组

### 基础 user 消息
先创建 `messages = []`，再 push：

- `role: "user"`
- content 至少包含文本 `{type: "text", text: expandedText}`
- 有图则把 `currentImages` 追加到 content
- 带时间戳

### 注入 nextTurn 消息
`_pendingNextTurnMessages` 会被并入当前发送批次，然后清空。

---

## 7) before_agent_start 扩展钩子

`emitBeforeAgentStart(...)` 可以让扩展在真正发请求前追加/修改上下文：

- 若返回 `result.messages`：把它们转成 `role: "custom"` 消息追加到 `messages`。
- 若返回 `result.systemPrompt`：覆盖本轮系统提示词。
- 否则：重置为 `_baseSystemPrompt`（防止上一轮残留污染）。

---

## 8) 错误与最终发送

- try 内任意一步异常：
  - `preflightResult(false)`
  - `throw` 给上层处理
- 正常到末尾：
  - `preflightResult(true)`
  - `await this.agent.prompt(messages)`
  - `await this.waitForRetry()`（处理自动重试流程同步）

---

## 这段代码的核心价值（总结）

`prompt()` 做的是“**发送前编排层**”：

- 先让扩展有机会拦截/改写输入
- 根据 streaming 状态决定“直接发送”还是“排队”
- 在真正调用模型前统一完成模型/鉴权/compaction 检查
- 允许扩展在起跑线注入 custom message + system prompt
- 最终只保留一个发送出口：`this.agent.prompt(messages)`

所以它是 `AgentSession` 里最关键的“输入到推理”网关。