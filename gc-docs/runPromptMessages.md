这段代码是 **`Agent` 真正跑一轮「推理 + 工具」循环的私有入口**：把上层组好的消息交给 `runAgentLoop`，并由一层生命周期包住。

---

## `runPromptMessages` 做什么

它是 `prompt(...)`、`continue(...)`（里面对 steering/follow-up 队列的那两条分支）共用的内核调用点。

---

## 逐层拆开

### 1. `runWithLifecycle(async (signal) => { ... })`

- 建立 **单次运行**：`activeRun`、内部 `AbortController`、`signal`
- 设 `_state.isStreaming = true`，清掉上一次流式消息/错误等
- 跑完或在异常里走 **`handleRunFailure` / `finishRun`**（你上面同文件里有）
- 作用：**同一时间只允许一圈 loop**、`abort()` 能打断这一圈

所以这层不关心「模型怎么调」，只关心「这一轮 run 的并发与收尾」。

### 2. `runAgentLoop(...)`

这才是 **ReAct 式 agent loop** 的实现（定义在 `agent-loop.ts`）：

- 先把 `prompts` 并进当前上下文：`messages = [...快照里的历史, ...本次 prompts]`
- 发 `agent_start` / `turn_start`，并对每条 prompt 发 `message_start` / `message_end`
- 再进入 **`runLoop`**：流式调用 LLM、解析 tool calls、执行工具、把结果追加进上下文……直到本轮结束  
  （也就是 Think → Act → Observe → 再看要不要下一轮）

也就是说：**你从 `coding-agent` 里 `session.prompt(messages)`，最终会走到这里**，和 UI 无关。

### 3. `this.createContextSnapshot()`

快照里带：

- 当前 **systemPrompt**
- **messages**（`slice()` 一份，避免循环里和被共享引用搞乱）
- **tools**

这是 loop 的起点上下文；之后的 tool 结果、assistant 回复由 loop 往里追加。

### 4. `this.createLoopConfig(options)`

把「这一圈该怎么调 pi-ai」的配置绑上去，其中包括：

- `model`、`thinkingLevel`/`reasoning`、transport、`getApiKey` 等
- **`getSteeringMessages`**：默认会从 `steeringQueue.drain()` 取排队消息  
  —— 但若 `skipInitialSteeringPoll: true`，**第一轮**会刻意返回空，避免在刚 `continue` 时又把同一批 steer 再吃一遍（见你上面 `continue()` 从 assistant 出来时那段逻辑）

另外还有 `getFollowUpMessages` → `followUpQueue.drain()`。

### 5. `(event) => this.processEvents(event)`

Loop 内部每产生一个 `AgentEvent`，都交给 **`processEvents`**：

- 更新 `_state`（例如在内存里维护 transcript、streaming 段落、pending tools）
- 再通知外层订阅者（coding-agent / TUI）

所以：**数据面在 loop，状态/UI 一面在 processEvents**。

### 6. `signal`、`this.streamFn`

- `signal`：用户 `abort()` 时中断流式请求和后续步骤  
- `streamFn`：实际调 `@earendil-works/pi-ai` 的流（按 provider/model 接上）

---

## 和邻近 API 的区别（帮助定位）

| 调用 | 走哪条路 |
|------|----------|
| `prompt(...)`（无并发 run） | `runPromptMessages(messages)` → **带新消息的** `runAgentLoop` |
| `continue()` 在最后一条不是 assistant | `runContinuation()` → `runAgentLoopContinue`（不额外塞一批「新 user」前缀事件，而是从当前 transcript 往后接） |

---

## 一句话

这段代码 = **生命周期（单 run + 可中止） + 快照上下文 + loop 配置（含 steer/follow-up） + 驱动 `runAgentLoop`（核心 ReAct 循环）并把事件_sink 到自己的 `processEvents`**。