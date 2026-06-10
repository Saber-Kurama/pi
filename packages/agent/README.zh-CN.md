# @earendil-works/pi-agent-core

[English](README.md)

带工具执行与事件流的有状态 Agent。基于 `@earendil-works/pi-ai` 构建。

## 安装

```bash
npm install @earendil-works/pi-agent-core
```

## 快速开始

```typescript
import { Agent } from "@earendil-works/pi-agent-core";
import { getModel } from "@earendil-works/pi-ai";

const agent = new Agent({
  initialState: {
    systemPrompt: "You are a helpful assistant.",
    model: getModel("anthropic", "claude-sonnet-4-20250514"),
  },
});

agent.subscribe((event) => {
  if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
    // Stream just the new text chunk
    process.stdout.write(event.assistantMessageEvent.delta);
  }
});

await agent.prompt("Hello!");
```

## 核心概念

### AgentMessage 与 LLM Message

Agent 使用 `AgentMessage`，一种可扩展的消息类型，可包含：

- 标准 LLM 消息（`user`、`assistant`、`toolResult`）
- 通过声明合并（declaration merging）扩展的应用自定义消息类型

LLM 仅理解 `user`、`assistant` 和 `toolResult`。`convertToLlm` 在每次调用 LLM 前负责过滤与转换，弥合这一差异。

### 消息流

```
AgentMessage[] → transformContext() → AgentMessage[] → convertToLlm() → Message[] → LLM
                    (可选)                           (必需)
```

1. **transformContext**：裁剪旧消息、注入外部上下文
2. **convertToLlm**：过滤仅用于 UI 的消息，将自定义类型转为 LLM 格式

## 事件流

Agent 会发出事件供 UI 更新。理解事件顺序有助于构建响应式界面。

### prompt() 事件序列

调用 `prompt("Hello")` 时：

```
prompt("Hello")
├─ agent_start
├─ turn_start
├─ message_start   { message: userMessage }      // 你的 prompt
├─ message_end     { message: userMessage }
├─ message_start   { message: assistantMessage } // LLM 开始回复
├─ message_update  { message: partial... }       // 流式片段
├─ message_update  { message: partial... }
├─ message_end     { message: assistantMessage } // 完整回复
├─ turn_end        { message, toolResults: [] }
└─ agent_end       { messages: [...] }
```

### 含工具调用时

若 assistant 调用工具，循环会继续：

```
prompt("Read config.json")
├─ agent_start
├─ turn_start
├─ message_start/end  { userMessage }
├─ message_start      { assistantMessage with toolCall }
├─ message_update...
├─ message_end        { assistantMessage }
├─ tool_execution_start  { toolCallId, toolName, args }
├─ tool_execution_update { partialResult }           // 若工具支持流式
├─ tool_execution_end    { toolCallId, result }
├─ message_start/end  { toolResultMessage }
├─ turn_end           { message, toolResults: [toolResult] }
│
├─ turn_start                                        // 下一回合
├─ message_start      { assistantMessage }           // LLM 根据工具结果回复
├─ message_update...
├─ message_end
├─ turn_end
└─ agent_end
```

工具执行模式可配置：

- `parallel`（默认）：预检（preflight）按顺序执行各工具调用，允许的工具并发执行；每个工具完成后立即发出 `tool_execution_end`，再按 assistant 源顺序发出 toolResult 消息与 `turn_end.toolResults`
- `sequential`：逐个执行工具调用，与历史行为一致

并行模式下，工具完成事件按完成顺序发出，但持久化的 toolResult 消息仍按 assistant 源顺序排列。

可通过 Agent 配置中的 `toolExecution` 全局设置，或在 `AgentTool` 上用 `executionMode` 按工具设置。若一批调用中有任一工具为 `executionMode: "sequential"`，整批均按顺序执行，忽略全局设置。

`beforeToolCall` 钩子在 `tool_execution_start` 且参数校验之后运行，可阻止执行。`afterToolCall` 在工具执行结束、发出 `tool_execution_end` 与最终 tool result 消息事件之前运行。

工具也可返回 `terminate: true`，提示跳过自动的后续 LLM 调用。仅当该批中每个已完成的工具结果都设置 `terminate: true` 时，循环才会提前结束；混合批次则照常继续。

底层循环调用方可设置 `shouldStopAfterTurn`，在当前回合正常结束后优雅停止：

```typescript
const stream = agentLoop(prompts, context, {
  model,
  convertToLlm,
  shouldStopAfterTurn: async ({ message, toolResults, context, newMessages }) => {
    return shouldCompactBeforeNextTurn(context.messages);
  },
});
```

`shouldStopAfterTurn` 在发出 `turn_end` 之后、assistant 回复与工具执行均正常完成之后运行。若返回 `true`，循环会发出 `agent_end` 并退出，不再轮询 steering 或 follow-up 队列，也不再发起新的 LLM 调用。它不会中止 provider 流、不会取消正在运行的工具，也不会改变 assistant 消息的 stop reason。

使用 `Agent` 类时，assistant 的 `message_end` 处理在工具预检开始前作为屏障。因此 `beforeToolCall` 看到的 agent 状态已包含发起该工具调用的 assistant 消息。

### continue() 事件序列

`continue()` 从现有上下文继续，不添加新消息。适用于出错后的重试。

```typescript
// After an error, retry from current state
await agent.continue();
```

上下文中最后一条消息必须是 `user` 或 `toolResult`（不能是 `assistant`）。

### 事件类型

| 事件 | 说明 |
|-------|-------------|
| `agent_start` | Agent 开始处理 |
| `agent_end` | 本次运行的最终事件。对此事件的 awaited 订阅者仍计入结算 |
| `turn_start` | 新回合开始（一次 LLM 调用 + 工具执行） |
| `turn_end` | 回合结束，含 assistant 消息与工具结果 |
| `message_start` | 任意消息开始（user、assistant、toolResult） |
| `message_update` | **仅 assistant。** 含 `assistantMessageEvent` 与增量 |
| `message_end` | 消息完成 |
| `tool_execution_start` | 工具开始 |
| `tool_execution_update` | 工具流式进度 |
| `tool_execution_end` | 工具完成 |

`Agent.subscribe()` 的监听器按注册顺序 await。`agent_end` 表示不会再发出循环事件，但 `await agent.waitForIdle()` 与 `await agent.prompt(...)` 仅在 awaited 的 `agent_end` 监听器全部完成后才 settle。

## Agent 选项

```typescript
const agent = new Agent({
  // Initial state
  initialState: {
    systemPrompt: string,
    model: Model<any>,
    thinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh",
    tools: AgentTool<any>[],
    messages: AgentMessage[],
  },

  // Convert AgentMessage[] to LLM Message[] (required for custom message types)
  convertToLlm: (messages) => messages.filter(...),

  // Transform context before convertToLlm (for pruning, compaction)
  transformContext: async (messages, signal) => pruneOldMessages(messages),

  // Steering mode: "one-at-a-time" (default) or "all"
  steeringMode: "one-at-a-time",

  // Follow-up mode: "one-at-a-time" (default) or "all"
  followUpMode: "one-at-a-time",

  // Custom stream function (for proxy backends)
  streamFn: streamProxy,

  // Session ID for provider caching
  sessionId: "session-123",

  // Dynamic API key resolution (for expiring OAuth tokens)
  getApiKey: async (provider) => refreshToken(),

  // Tool execution mode: "parallel" (default) or "sequential"
  toolExecution: "parallel",

  // Preflight each tool call after args are validated. Can block execution.
  beforeToolCall: async ({ toolCall, args, context }) => {
    if (toolCall.name === "bash") {
      return { block: true, reason: "bash is disabled" };
    }
  },

  // Postprocess each tool result before final tool events are emitted.
  afterToolCall: async ({ toolCall, result, isError, context }) => {
    if (toolCall.name === "notify_done" && !isError) {
      return { terminate: true };
    }
    if (!isError) {
      return { details: { ...result.details, audited: true } };
    }
  },

  // Custom thinking budgets for token-based providers
  thinkingBudgets: {
    minimal: 128,
    low: 512,
    medium: 1024,
    high: 2048,
  },
});
```

## Agent 状态

```typescript
interface AgentState {
  systemPrompt: string;
  model: Model<any>;
  thinkingLevel: ThinkingLevel;
  tools: AgentTool<any>[];
  messages: AgentMessage[];
  readonly isStreaming: boolean;
  readonly streamingMessage?: AgentMessage;
  readonly pendingToolCalls: ReadonlySet<string>;
  readonly errorMessage?: string;
}
```

通过 `agent.state` 访问状态。

对 `agent.state.tools = [...]` 或 `agent.state.messages = [...]` 赋值时，会先复制顶层数组再存储。若直接修改返回的数组引用，会改动当前 agent 状态。

流式输出期间，`agent.state.streamingMessage` 为当前未完成的 assistant 消息。

`agent.state.isStreaming` 在运行完全 settle 前（含 awaited 的 `agent_end` 订阅者）保持为 `true`。

## 方法

### 发起对话

```typescript
// Text prompt
await agent.prompt("Hello");

// With images
await agent.prompt("What's in this image?", [
  { type: "image", data: base64Data, mimeType: "image/jpeg" }
]);

// AgentMessage directly
await agent.prompt({ role: "user", content: "Hello", timestamp: Date.now() });

// Continue from current context (last message must be user or toolResult)
await agent.continue();
```

### 状态管理

```typescript
agent.state.systemPrompt = "New prompt";
agent.state.model = getModel("openai", "gpt-4o");
agent.state.thinkingLevel = "medium";
agent.state.tools = [myTool];
agent.toolExecution = "sequential";
agent.beforeToolCall = async ({ toolCall }) => undefined;
agent.afterToolCall = async ({ toolCall, result }) => undefined;
agent.state.messages = newMessages; // top-level array is copied
agent.state.messages.push(message);
agent.reset();
```

### 会话与思考预算

```typescript
agent.sessionId = "session-123";

agent.thinkingBudgets = {
  minimal: 128,
  low: 512,
  medium: 1024,
  high: 2048,
};
```

### 控制

```typescript
agent.abort();           // Cancel current operation
await agent.waitForIdle(); // Wait for completion
```

### 事件

```typescript
const unsubscribe = agent.subscribe(async (event, signal) => {
  if (event.type === "agent_end") {
    // Final barrier work for the run
    await flushSessionState(signal);
  }
});
unsubscribe();
```

## Steering 与 Follow-up

Steering 消息可在工具运行期间打断 Agent。Follow-up 消息可在 Agent 本应停止时排队后续工作。

```typescript
agent.steeringMode = "one-at-a-time";
agent.followUpMode = "one-at-a-time";

// While agent is running tools
agent.steer({
  role: "user",
  content: "Stop! Do this instead.",
  timestamp: Date.now(),
});

// After the agent finishes its current work
agent.followUp({
  role: "user",
  content: "Also summarize the result.",
  timestamp: Date.now(),
});

const steeringMode = agent.steeringMode;
const followUpMode = agent.followUpMode;

agent.clearSteeringQueue();
agent.clearFollowUpQueue();
agent.clearAllQueues();
```

使用 `clearSteeringQueue`、`clearFollowUpQueue` 或 `clearAllQueues` 清空队列中的消息。

回合结束后若检测到 steering 消息：

1. 当前 assistant 消息上的所有工具调用已完成
2. 注入 steering 消息
3. 下一回合由 LLM 响应

Follow-up 仅在没有更多工具调用且没有 steering 消息时检查。若有排队消息则注入并再跑一回合。

## 自定义消息类型

通过声明合并扩展 `AgentMessage`：

```typescript
declare module "@earendil-works/pi-agent-core" {
  interface CustomAgentMessages {
    notification: { role: "notification"; text: string; timestamp: number };
  }
}

// Now valid
const msg: AgentMessage = { role: "notification", text: "Info", timestamp: Date.now() };
```

在 `convertToLlm` 中处理自定义类型：

```typescript
const agent = new Agent({
  convertToLlm: (messages) => messages.flatMap(m => {
    if (m.role === "notification") return []; // Filter out
    return [m];
  }),
});
```

## 工具

使用 `AgentTool` 定义工具：

```typescript
import { Type } from "typebox";

const readFileTool: AgentTool = {
  name: "read_file",
  label: "Read File",  // For UI display
  description: "Read a file's contents",
  parameters: Type.Object({
    path: Type.String({ description: "File path" }),
  }),
  // Override execution mode for this tool (optional).
  // "sequential" forces the entire batch to run one at a time.
  // "parallel" allows concurrent execution with other tool calls.
  // If omitted, the global toolExecution config applies.
  executionMode: "sequential",
  execute: async (toolCallId, params, signal, onUpdate) => {
    const content = await fs.readFile(params.path, "utf-8");

    // Optional: stream progress
    onUpdate?.({ content: [{ type: "text", text: "Reading..." }], details: {} });

    // Optional: add `terminate: true` here to skip the automatic follow-up LLM call
    // when every finalized tool result in the batch does the same.
    return {
      content: [{ type: "text", text: content }],
      details: { path: params.path, size: content.length },
    };
  },
};

agent.state.tools = [readFileTool];
```

### 错误处理

工具失败时应 **抛出错误**，不要将错误信息作为 content 返回。

```typescript
execute: async (toolCallId, params, signal, onUpdate) => {
  if (!fs.existsSync(params.path)) {
    throw new Error(`File not found: ${params.path}`);
  }
  // Return content only on success
  return { content: [{ type: "text", text: "..." }] };
}
```

抛出的错误由 Agent 捕获，并以 `isError: true` 的形式作为工具错误报告给 LLM。

在 `execute()` 或 `afterToolCall` 中返回 `terminate: true` 可提示 Agent 在当前工具批次后停止。仅当该批每个已完成的工具结果都终止时才生效。该提示仅运行时有效；发出的 `toolResult` 转录消息仍是标准 LLM 工具结果。

## 代理（Proxy）用法

适用于通过后端代理的浏览器应用：

```typescript
import { Agent, streamProxy } from "@earendil-works/pi-agent-core";

const agent = new Agent({
  streamFn: (model, context, options) =>
    streamProxy(model, context, {
      ...options,
      authToken: "...",
      proxyUrl: "https://your-server.com",
    }),
});
```

## 底层 API

无需 `Agent` 类、直接控制循环时：

```typescript
import { agentLoop, agentLoopContinue } from "@earendil-works/pi-agent-core";

const context: AgentContext = {
  systemPrompt: "You are helpful.",
  messages: [],
  tools: [],
};

const config: AgentLoopConfig = {
  model: getModel("openai", "gpt-4o"),
  convertToLlm: (msgs) => msgs.filter(m => ["user", "assistant", "toolResult"].includes(m.role)),
  toolExecution: "parallel",  // overridden by per-tool executionMode if set
  beforeToolCall: async ({ toolCall, args, context }) => undefined,
  afterToolCall: async ({ toolCall, result, isError, context }) => undefined,
};

const userMessage = { role: "user", content: "Hello", timestamp: Date.now() };

for await (const event of agentLoop([userMessage], context, config)) {
  console.log(event.type);
}

// Continue from existing context
for await (const event of agentLoopContinue(context, config)) {
  console.log(event.type);
}
```

这些底层流仅供观察：保持事件顺序，但不会等待你的异步事件处理完成再继续后续生产阶段。若需要在工具预检前以消息处理作为屏障，请使用 `Agent` 类，而非裸的 `agentLoop()` / `agentLoopContinue()`。

## 许可证

MIT
