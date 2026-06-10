# Agent 源码走读完整记录（packages/agent + packages/coding-agent）

## 目标

- 建立 `packages/agent` 的最小心智模型（入口、循环、状态）
- 打通 `packages/coding-agent` 如何调用 `Agent`
- 理解 `retry + continue + queue` 的协作机制

---

## 一、最小阅读路径（先快后深）

推荐顺序：

1. `packages/agent/src/index.ts`
2. `packages/agent/src/agent.ts`
3. `packages/agent/src/agent-loop.ts`
4. `packages/agent/src/types.ts`（遇到类型再回查）
5. `packages/agent/src/harness/agent-harness.ts`（最后补）

核心分工：

- `agent.ts`：有状态外壳（状态、生命周期、队列、事件订阅）
- `agent-loop.ts`：执行引擎（LLM 调用、tool call、turn 循环、终止条件）

---

## 二、入口与导出地图

`index.ts` 表明该包对外暴露了两类核心能力：

- Core runtime：`agent.ts` + `agent-loop.ts`
- Harness/compaction/session 等运行支撑

阅读重点先放在 core runtime，不要一开始展开所有 harness 细节。

---

## 三、Agent 层（agent.ts）心智模型

`Agent` 的角色是“低层 loop 的 stateful wrapper”。

### 1) 状态持有

- `state.messages`：完整会话消息
- `state.streamingMessage`：当前流式中的消息
- `state.pendingToolCalls`：正在执行的 tool 集合
- `state.errorMessage`：最后错误消息

### 2) 生命周期控制

- `runWithLifecycle(...)` 负责：
  - 防重入（activeRun 时拒绝再次执行）
  - 初始化运行态（isStreaming 等）
  - 捕获异常并转失败事件
  - finally 统一收尾（finishRun）

### 3) 队列语义

- `steer(message)`：下一次 assistant 响应前插入
- `followUp(message)`：本轮本该结束时触发下一轮
- `continue()`：
  - 如果最后一条是 assistant，优先 drain steering/followUp
  - 若无可消费队列，才报错（不能直接从 assistant 继续）

### 4) API -> Loop 调用链

- `prompt(...)` -> `runPromptMessages(...)` -> `runWithLifecycle(...)` -> `runAgentLoop(...)`
- `continue()` -> `runContinuation(...)` -> `runWithLifecycle(...)` -> `runAgentLoopContinue(...)`

### 5) LoopConfig 注入点

`createLoopConfig()` 把策略注入 loop：

- `toolExecution`
- `beforeToolCall` / `afterToolCall`
- `convertToLlm` / `transformContext`
- `getSteeringMessages` / `getFollowUpMessages`

---

## 四、Loop 层（agent-loop.ts）心智模型

### 1) 总体结构

- `runAgentLoop(...)`：带新 prompt 启动
- `runAgentLoopContinue(...)`：基于当前上下文续跑
- 两者都进入 `runLoop(...)`

### 2) 双层循环语义

- 外层 `while (true)`：决定是否开启下一轮（常由 follow-up 触发）
- 内层 `while (hasMoreToolCalls || pendingMessages.length > 0)`：
  - 处理 steering 消息
  - 请求 assistant
  - 执行 tool
  - 回填 toolResult

### 3) Tool 执行路径

主要函数链：

- `executeToolCalls(...)`
- `prepareToolCall(...)`（含 `beforeToolCall`）
- `executePreparedToolCall(...)`
- `finalizeExecutedToolCall(...)`（含 `afterToolCall`）

并发/串行判定：

- 来自 `config.toolExecution`
- 或存在工具级顺序执行要求（sequential）时走串行路径

### 4) 批次终止条件（重点）

`terminate` 不是“某个 tool 返回 true 就停”，而是：

- `finalizedCalls.every(result.terminate === true)` 才终止该批次后续推进

---

## 五、上层集成（packages/coding-agent）

### 1) 创建 Agent（sdk.ts）

`new Agent({...})` 注入了：

- 自定义 `streamFn`（鉴权、重试参数、headers）
- `convertToLlm`（含 image block 防御）
- `transformContext`
- `onPayload` / `onResponse`
- `steeringMode` / `followUpMode` / `transport` / `thinkingBudgets`

### 2) 业务编排（agent-session.ts）

`AgentSession.prompt(...)` 做大量前置逻辑：

- 命令拦截（`/command`）
- extension input 拦截与 transform
- skill/template 展开
- streaming 场景下 steer/followUp 入队
- model/auth 校验
- compaction 检查
- 组装 `AgentMessage[]`
- 最终调用 `await this.agent.prompt(messages)`

### 3) 事件桥接

- `this.agent.subscribe(this._handleAgentEvent)`
- `_handleAgentEvent/_processAgentEvent` 负责：
  - session 持久化
  - extension 事件转发
  - retry 与 compaction 触发

---

## 六、Retry + Continue + Queue 协作闭环

### 1) 触发时机

- `agent_end` 时检测最后 assistant 是否为可重试错误

### 2) 防竞态设计

- `_createRetryPromiseForAgentEnd(event)` 在 `_handleAgentEvent` 同步阶段先建 promise
- 避免 `prompt()` 后 `waitForRetry()` 漏等在途重试

### 3) 重试执行

`_handleRetryableError(...)`：

- `_retryAttempt++`
- 指数退避 sleep（可 abort）
- 从 `agent.state.messages` 去除末尾 error assistant
- `setTimeout(() => this.agent.continue().catch(...), 0)`

选择 `continue()` 的原因：

- 复用当前上下文与队列语义，不重发新 prompt
- 保持 turn 内逻辑一致，不制造重复用户输入

选择 `setTimeout` 的原因：

- 脱离当前事件处理链，避免在事件栈中 re-enter loop
- 非阻塞当前 handler

### 4) 队列保活

在 auto-compaction 完成后，如果还有 queued messages，会主动触发一次 `agent.continue()`，防止“队列有消息但 loop 已停”。

---

## 七、最终一句话架构总结

- `packages/agent` 提供通用 Agent runtime 内核
- `packages/coding-agent` 提供产品级编排（输入、扩展、鉴权、持久化、重试、压缩）

读取源码时先分层定位，再沿调用链追踪，不要在单层中横向漫游。
