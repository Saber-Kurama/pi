下面按「这段函数在整条链路里干什么 → 每一行在干什么 → 和返回值的关系」说明。你贴的版本里有多处 `console.log`，多半是本地调试用的；解释逻辑时我会顺带提一句。

---

## 1. 函数角色

`runAgentLoop` 是 **`agentLoop()` 与 `Agent` 内部共用的「异步入口」**：  
在一轮 agent 运行里，把**本次新加的 `prompts`** 并进会话上下文，先发一轮**生命周期事件**，再进入 `runLoop` 做 **多轮 LLM ↔ 工具**，最后返回**本轮运行新产生/新纳入的消息列表**（`newMessages`）。

文件头注释说得很清楚：全程用 `AgentMessage`，只在调 LLM 前才 `convertToLlm` 成 `Message[]`。

---

## 2. 参数分别是什么

| 参数 | 含义 |
|------|------|
| `prompts` | 本次调用要**追加进对话**的新消息（常见是用户的 `user` 消息；也可能是扩展注入的多条）。 |
| `context` | 调用时的快照：`systemPrompt`、`messages`（已有历史）、`tools`。来自 `Agent` 的 `createContextSnapshot()`。 |
| `config` | `AgentLoopConfig`：`convertToLlm`、`streamFn`、`getSteeringMessages` 等。 |
| `emit` | 把 `AgentEvent` 交给上层（`Agent.processEvents` → UI / session）。 |
| `signal` | 取消本轮运行。 |
| `streamFn` | 默认 `streamSimple`；可注入 mock 或包装。 |

---

## 3. `newMessages`（第 103 行）

```ts
const newMessages: AgentMessage[] = [...prompts];
```

语义：**「本轮 `runAgentLoop` 会返回的消息列表」** 的累加器。

- 初始化 = 本轮**用户（等）刚发进来的** `prompts` 的浅拷贝。  
- 之后在 `runLoop` → `streamAssistantResponse`、工具执行等里，会 **`push` 助手消息、tool 结果等**，所以返回时 `newMessages` 不只有 prompts，而是**本轮 run 产生的整条增量 transcript**。

`Agent` 里 `runPromptMessages` 用返回值是为了知道这轮 run 追加了什么；和 `context.messages`（agent 内存里的完整会话）要区分开。

---

## 4. `currentContext`（第 105–108 行）

```ts
const currentContext: AgentContext = {
  ...context,
  messages: [...context.messages, ...prompts],
};
```

- 对 `context` 做浅拷贝，但 **`messages` 换成新数组**：**历史 + 本次 prompts**。  
- 这是交给 `runLoop` 的**工作副本**；`runLoop` 里会在流式 assistant、tool 执行后继续 **`push` 到 `currentContext.messages`**，让下一轮 LLM 调用看到完整上下文。  
- 不会直接改调用方传进来的 `context` 对象里那个 `messages` 数组本身（除非引用被别处共享——但通常 `createContextSnapshot` 已经 `slice()` 过）。

---

## 5. 事件：`agent_start` → `turn_start` → 每条 prompt（第 110–115 行）

```ts
await emit({ type: "agent_start" });
await emit({ type: "turn_start" });
for (const prompt of prompts) {
  await emit({ type: "message_start", message: prompt });
  await emit({ type: "message_end", message: prompt });
}
```

- **`agent_start`**：整次 agent 运行开始（可能包含多 turn、多轮工具）。UI 可用来清 pending、打日志等。  
- **`turn_start`**：第一个「回合」开始。  
- 对 **`prompts` 里每一条** 发 **`message_start` / `message_end`**：即便尚未调用模型，也先在协议上把「用户侧消息已入账」通知出去，便于 UI 立刻画出用户气泡。

注意：这里对每条 prompt 都打了 **完整** 的 start/end（无流式 delta），因为 user 消息在这里视为已定型。

---

## 6. `await runLoop(...)`（第 119 行）

真正的工作：**流式拉 assistant → 解析 tool calls → 执行工具 → 拼接 tool results → 可能再 steer/follow-up、再开下一轮**，直到 `runLoop` 内部发 `agent_end` 并 return。

传入：

- **`currentContext`**：会被就地更新（新 assistant、tool results 等）。  
- **`newMessages`**：同一引用，会被追加本轮产生的新消息。  
- **`config` / `signal` / `emit` / `streamFn`**：原样下传。

---

## 7. `return newMessages`（第 121 行）

返回的是**数组引用**（与 `runLoop` 里修改的是同一个），内容包含：

- 开头的 `prompts` 副本，以及  
- 本轮产生的 assistant、toolResult 等（由 `runLoop` 内部逻辑 `push`）。

`Agent` / 测试可以用这个返回值做断言或合并到 session 持久化逻辑（具体看调用方）。

---

## 8. 关于 `console.log`（第 104、109、118、120 行）

这些 **`console.log` 不是 `agent-loop` 核心协议的一部分**，通常是调试时打印 `newMessages` / `currentContext` / `runLoop` 起止。若你要干净日志或避免泄露内容，提交前应删掉或改成可控的 debug 开关。

---

## 9. 和同文件 `agentLoop()` 包装器的关系（第 31–53 行）

```ts
void runAgentLoop(..., async (event) => { stream.push(event); }, ...)
  .then((messages) => { stream.end(messages); });
```

公开 API **`agentLoop()`** 把 `runAgentLoop` 包进 **`EventStream`**：`emit` 等价于 `stream.push(event)`，跑完后用**返回的 `newMessages`** 调 `stream.end(messages)`，这样外部既能 `for await` 事件，也能拿到最终消息数组。

---

## 一句话串起来

**`runAgentLoop` = 把本次 `prompts` 并入可变的 `currentContext`，用事件先「官宣」用户消息入账，再进入 `runLoop` 完成 ReAct 循环，并把本轮新增消息累积在 `newMessages` 里返回。**

若要继续往下深究，下一步应读 **`runLoop`** 里如何把 `streamAssistantResponse` 的结果 push 进 `currentContext.messages` 与 `newMessages`（两处是否总一致）。






下面只针对「这一块事件」和 `prompts` 何时是数组，把语义说透；并顺带对齐 **`runLoop` 里后面的 `turn_start`**，否则「第一个回合」容易误解。

---

## 1. `agent_start` 和「同时有几个 Agent」

- **`agent_start` 的范围**：一次 **`runAgentLoop(...)` 调用**，从进到函数到最终 **`agent_end`**（在 `runLoop` 里发出）为止。
- **单进程里单个 `Agent` 实例**：`Agent` 用 `activeRun` 保证**同一时刻只能跑一轮** `runPromptMessages` / `runContinuation`，不会两个 `runAgentLoop` 在**同一个 Agent** 上并发叠在一起。
- **可以有多个运行**的是：多个进程、多个 `Agent` 实例、或多个 CLI 会话——那就不在「一个 Agent 对象」的约束里。

所以「整次 agent 运行」指的是 **这一次 `runAgentLoop`  invocation**，不是全宇宙只有一个 agent。

**UI / 扩展里 `agent_start` 常见用途**：这一轮推理开始了——清「本轮」的 pending 工具 UI、重置 footer 状态、打点日志、扩展里做 `session_start` 类逻辑等。和「全局只有一个人在用 pi」无关。

---

## 2. `turn_start` 到底干什么（和「第一个回合」）

在协议里，**「一轮 turn」= 一次「要产生 assistant 输出」的周期**：先（可选）注入一些 user/steering 消息 → **调一次** `streamAssistantResponse` → 可能执行 tool → **`turn_end`**。

### 第一次 `turn_start`（你问的 108–109 行）

```108:109:packages/agent/src/agent-loop.ts
	await emit({ type: "agent_start" });
	await emit({ type: "turn_start" });
```

表示：**这一轮 `runAgentLoop` 里，第一个「即将去调 LLM 产出 assistant」的回合开始了**。

它出现在 **发完本轮所有 `prompts` 的 `message_*` 之后、进入 `runLoop` 之前**。顺序是：

1. 用户侧消息在协议上已经 `message_start` / `message_end` 入账；
2. **`turn_start`**：下面要开始 **第一次** `streamAssistantResponse`；
3. `runLoop` 里第一次进内层 `while` 时 **`firstTurn === true`**，**不会再发第二个 `turn_start`**（避免和上面重复）。

### 后面的 `turn_start`（在 `runLoop` 里）

```175:179:packages/agent/src/agent-loop.ts
			if (!firstTurn) {
				await emit({ type: "turn_start" });
			} else {
				firstTurn = false;
			}
```

从**第二次**进入「要去调 LLM」的那一圈开始，每次都会再 **`turn_start`**，典型场景包括：

- 上一轮 assistant **带了 tool calls**，执行完 tool results 后**又要再调一次 LLM**；
- 或注入了 **steering** 队列里的消息后，**再开一轮 assistant**。

**作用概括**：

- 给 UI / 订阅者一个稳定的**边界**：新的一轮「assistant 生成」要开始画了（可以换 loading、新气泡、新的 token 统计等）。
- 和 **`turn_end` 配对**：一轮推理 + 这一轮里的 tool 批次结束会有 `turn_end`，下一轮 assistant 前再 `turn_start`。

所以 **`turn_start` 不是为了「全局第一个回合」这种一次性概念**，而是：**在同一个 `agent_start`…`agent_end` 里，每一次「即将开始一次 assistant 流式响应」都打一个标记**；其中**第一次**在 `runAgentLoop` 里发，**后续**在 `runLoop` 里发。

---

## 3. 对每条 `prompt` 发 `message_start` / `message_end`

含义就是：**在还没调模型之前**，先在事件协议里宣布：「这条 user（或程序化组装的）消息已经进 transcript」。

- **UI**：可以立刻画用户消息、滚动、高亮，而不用等首个 token。
- **`Agent.processEvents` / `AgentSession`**：内存里的 state 往往和事件同步更新，保证展示和内部 `messages` 一致。

`message_start` 与 `message_end` 成对出现，是因为中间没有对用户消息做流式 delta（用户这条在进 `runAgentLoop` 时已是完整 `AgentMessage`）。

---

## 4. `prompts` 什么时候是「数组」？里面可能是什么？

类型上 **`runAgentLoop` 始终接收 `AgentMessage[]`**。长度常见情况：

| 长度 | 典型来源 |
|------|----------|
| **1** | 最常见：`agent.prompt("你好")` → `normalizePromptInput` 变成 `[{ role: "user", ... }]`；或 `agent.prompt(singleMessage)`。 |
| **>1** | `agent.prompt([msgA, msgB, ...])` 直接传数组；或 **`continue()` 时**从 `steeringQueue` / `followUpQueue` **`drain()`** 出多条再一次性 `runPromptMessages(queued)`；coding-agent 里也可能把多条合成一批（例如扩展注入的多段 user/custom，取决于调用方）。 |

数组里**每条**一般是 **`AgentMessage`**：多数是 `role: "user"`，也可以是扩展场景下的多条 user/custom（只要调用方这样传）。**不是**「多轮对话历史」——历史已经在传入的 **`context.messages`** 里；**`prompts` 只是本轮新追加的那几条**。

---

## 5. 和 `runAgentLoopContinue` 的对比（帮你建立完整图景）

**`runAgentLoopContinue`** 没有 `prompts`，所以**不会**在开头对「新用户消息」发那一串 `message_start`/`message_end`，只发 **`agent_start` + `turn_start`** 然后进 `runLoop`——因为上下文里**最后一条已经是 user 或 toolResult**，继续生成即可。

---

如果你愿意，我可以按**时间线**把「第一次 `turn_start` → `streamAssistantResponse` → `turn_end` → 若有 tool 再下一轮 `turn_start`」画成一条带事件顺序的列表，和 TUI 里每个事件对应什么 UI 更新对齐。

下面是**按时间顺序的事件链**，并和 **Interactive TUI**（`interactive-mode.ts` 里 `handleEvent`）对齐。源码里 **`turn_start` / `turn_end` 在 TUI 的 `switch` 里没有单独分支**，因此标成「扩展用 / 仅 footer」。

---

## 一、第一轮（用户发了一句，模型先回复、再决定是否调工具）

| # | 事件（来自 `agent-loop` / `streamAssistantResponse` / `executeToolCalls`） | TUI 里大致做什么 |
|---|--------------------------------|------------------|
| 1 | `agent_start` | `pendingTools.clear()`；可选 OSC 进度条 `setProgress(true)`；清重试 UI；停掉 working loader 再按需新建；`footer.invalidate()`；`requestRender` |
| 2 | `turn_start` | **`handleEvent` 无 `case`** → 只有函数开头的 **`footer.invalidate()`**（以及扩展在 `AgentSession._emitExtensionEvent` 里收到带 `turnIndex` 的 `turn_start`）。**不单独换一屏、不新建 assistant 气泡** |
| 3 | `message_start`（user，每条 prompt） | `addMessageToChat`：用户气泡；`updatePendingMessagesDisplay`；`requestRender` |
| 4 | `message_end`（user） | **`case "message_end"` 里对 `user` 直接 `break`** → **不画图**（用户气泡已在 `message_start` 画过） |
| 5 | 进入 `streamAssistantResponse` → 调 LLM | （中间无额外 `AgentEvent`，直到流式事件） |
| 6 | `message_start`（assistant，partial） | 新建 `AssistantMessageComponent` → `streamingComponent`；挂到 `chatContainer`；`updateContent` |
| 7 | 多次 `message_update`（assistant） | 更新同一条 assistant 的 `streamingComponent`；若 content 里出现 `toolCall`，为每个 id 建 **`ToolExecutionComponent`** 放进 `pendingTools` |
| 8 | `message_end`（assistant，final） | 最终 `updateContent`；若 `aborted`/`error` 则给所有 pending 工具组件塞错误文案并 `clear` pending；否则 `setArgsComplete`；**清空 `streamingComponent` 引用**；`footer.invalidate()` |
| 9 | `turn_end` | **`handleEvent` 无 `case`** → 仅 **`footer.invalidate()`**；扩展侧有 `turn_end`（含 `message`、`toolResults`、`turnIndex`） |
| 10a | **若无 tool**：外层循环可能拉 follow-up / 结束 → 见第四节 | … |
| 10b | **若有 tool**：`tool_execution_start`（每个 call） | 取或建 `ToolExecutionComponent`，`markExecutionStarted` |
| 11 | `tool_execution_update`（可选，流式工具） | 更新对应工具组件的 partial 结果 |
| 12 | `tool_execution_end`（每个 call） | `updateResult` 最终结果；**`pendingTools.delete(toolCallId)`** |
| 13 | 内层 `while` 下一轮前再发 **`turn_start`**（第二次起） | 同 #2：TUI **仍无专用分支**，仅 footer；语义上表示「又要开始一次 assistant 流」 |
| 14 | 再 `streamAssistantResponse` … | 重复 6–12，直到不再有更多 tool 且 steering/follow-up 也空 |

---

## 二、为什么你在界面上看不到「`turn_start` 专场」

- **画布更新**主要绑在 **`message_*` / `tool_execution_*` / `agent_*`**。  
- **`turn_start` / `turn_end`** 在协议里用于：**扩展**（`turnIndex`）、统计、以及 **`footer.invalidate()`**（每次事件进 `handleEvent` 都会先调一次）。  
- 所以时间线上的「新一整轮 assistant」在 UI 上是由 **`message_start`(assistant)** 和后续 **`message_update`** 体现的，**不是** `turn_start`。

---

## 三、`streamAssistantResponse` 在事件表里的位置

| 阶段 | 发生的事 |
|------|-----------|
| 进入前 | 已有 `turn_start`（首轮已在 `runAgentLoop` 发过） |
| 内部 | `transformContext` → `convertToLlm` → `streamSimple` → `for await` 流式事件 |
| 映射到 Agent | 流式 → **`message_start`（assistant）** → 若干 **`message_update`** → **`message_end`（assistant）** |

---

## 四、整次 `runAgentLoop` 收尾

| 事件 | TUI |
|------|-----|
| `agent_end` | 关终端 progress；停 status 区 `loadingAnimation`；若还有 orphan `streamingComponent` 则移除；**`pendingTools.clear()`**；`checkShutdownRequested`；`requestRender` |

---

## 五、`prompts` 多条时时间线怎么变

只有 **`message_start` / `message_end` 对用户消息**会 **按条重复**：先画第 1 条用户，再画第 2 条……然后才进入 `runLoop` 里第一次 `streamAssistantResponse`。**一次 `turn_start` 仍然只标志「接下来这一轮里第一次 assistant 流」**（后续轮次在 `runLoop` 里再发 `turn_start`）。

---

## 六、和文档/笔记的对接建议

若你写在 `gc-docs/runAgentLoop.md`，可加一句 **事实说明**：

> Interactive 里 **`turn_start` / `turn_end` 无独立 UI 分支**；需要按 turn 切 UI 时，应监听扩展的 `turn_start`/`turn_end`，或根据 **`message_start`(assistant)** 作为「新 assistant 块」的边界。

如果你希望 **TUI 也对 `turn_start` 做可见反馈**（例如状态栏「Turn 2」），需要在 `handleEvent` 里**新增** `case "turn_start"` / `case "turn_end"`，那就属于功能改动，而不是当前行为描述了。