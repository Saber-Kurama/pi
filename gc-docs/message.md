下面按 **`AgentState` → `MutableAgentState` → `AgentMessage`** 说明。类型定义在 `packages/agent/src/types.ts`；`Message` 及各 content 块在 `packages/ai/src/types.ts`；coding-agent 还通过声明合并给 `CustomAgentMessages` 加了额外形态（`packages/coding-agent/src/core/messages.ts` / `packages/agent/src/harness/messages.ts`）。

---

## 1. `AgentState`（对外状态）

```288:313:packages/agent/src/types.ts
export interface AgentState {
	/** System prompt sent with each model request. */
	systemPrompt: string;
	/** Active model used for future turns. */
	model: Model<any>;
	/** Requested reasoning level for future turns. */
	thinkingLevel: ThinkingLevel;
	/** Available tools. Assigning a new array copies the top-level array. */
	set tools(tools: AgentTool<any>[]);
	get tools(): AgentTool<any>[];
	/** Conversation transcript. Assigning a new array copies the top-level array. */
	set messages(messages: AgentMessage[]);
	get messages(): AgentMessage[];
	/**
	 * True while the agent is processing a prompt or continuation.
	 *
	 * This remains true until awaited `agent_end` listeners settle.
	 */
	readonly isStreaming: boolean;
	/** Partial assistant message for the current streamed response, if any. */
	readonly streamingMessage?: AgentMessage;
	/** Tool call ids currently executing. */
	readonly pendingToolCalls: ReadonlySet<string>;
	/** Error message from the most recent failed or aborted assistant turn, if any. */
	readonly errorMessage?: string;
}
```

| 字段 | 含义 |
|------|------|
| `systemPrompt` | 发给模型的系统提示（可被扩展在单轮前改写） |
| `model` | 当前使用的 `Model`（含 api、provider、id 等） |
| `thinkingLevel` | `"off" \| "minimal" \| "low" \| "medium" \| "high" \| "xhigh"` |
| `tools` | 工具列表；**赋值时会拷贝顶层数组**（见接口注释） |
| `messages` | 对话 transcript；**赋值时会拷贝顶层数组** |
| `isStreaming`（只读） | 正在处理一轮 prompt/continue，直到 `agent_end` 收尾 |
| `streamingMessage`（只读） | 当前流式 assistant 的半成品（若有） |
| `pendingToolCalls`（只读） | 正在进行中的 toolCall id 集合 |
| `errorMessage`（只读） | 最近失败/中断轮次的错误文案（若有） |

---

## 2. `MutableAgentState`（内部可写状态）

```57:62:packages/agent/src/agent.ts
type MutableAgentState = Omit<AgentState, "isStreaming" | "streamingMessage" | "pendingToolCalls" | "errorMessage"> & {
	isStreaming: boolean;
	streamingMessage?: AgentMessage;
	pendingToolCalls: Set<string>;
	errorMessage?: string;
};
```

含义：

- 与 `AgentState` **同一套业务字段**（`systemPrompt`、`model`、`thinkingLevel`、`tools`、`messages` 的 getter/setter 行为仍来自被 `Omit` 后保留的那部分）。
- 被拿掉再写回的 4 个字段，在 **实现类内部** 要**可赋值**：
  - `isStreaming`：不再是 `readonly`
  - `streamingMessage`：可写
  - `pendingToolCalls`：改成普通 **`Set<string>`**（可增删），不再是 `ReadonlySet`
  - `errorMessage`：可写

对外 `Agent` 仍通过只读视图暴露 `AgentState`；内部用 `MutableAgentState` 在 `processEvents` 等路径里改这 4 个运行期字段。

---

## 3. `AgentMessage`

```275:280:packages/agent/src/types.ts
/**
 * AgentMessage: Union of LLM messages + custom messages.
 * ...
 */
export type AgentMessage = Message | CustomAgentMessages[keyof CustomAgentMessages];
```

即：**标准 LLM 消息** + （通过 `CustomAgentMessages` 声明合并进来的）**自定义消息**。

### 3.1 `Message`（pi-ai，三选一）

```271:302:packages/ai/src/types.ts
export interface UserMessage {
	role: "user";
	content: string | (TextContent | ImageContent)[];
	timestamp: number; // Unix timestamp in milliseconds
}

export interface AssistantMessage {
	role: "assistant";
	content: (TextContent | ThinkingContent | ToolCall)[];
	api: Api;
	provider: Provider;
	model: string;
	responseModel?: string; // ...
	responseId?: string; // ...
	diagnostics?: AssistantMessageDiagnostic[]; // ...
	usage: Usage;
	stopReason: StopReason;
	errorMessage?: string;
	timestamp: number; // Unix timestamp in milliseconds
}

export interface ToolResultMessage<TDetails = any> {
	role: "toolResult";
	toolCallId: string;
	toolName: string;
	content: (TextContent | ImageContent)[]; // Supports text and images
	details?: TDetails;
	isError: boolean;
	timestamp: number; // Unix timestamp in milliseconds
}

export type Message = UserMessage | AssistantMessage | ToolResultMessage;
```

公共子结构（内容块）要点：

- **`TextContent`**：`{ type: "text"; text: string }`
- **`ImageContent`**：`{ type: "image"; data: string; mimeType: string }`（base64）
- **`ThinkingContent`**（assistant 里）：`type: "thinking"` + `thinking`、`thinkingSignature?`、`redacted?` 等
- **`ToolCall`**（assistant 里）：`type: "toolCall"` + `id`、`name`、`arguments`、`thoughtSignature?`
- **`Usage`**：`input/output/cacheRead/cacheWrite/totalTokens/cost{...}`
- **`StopReason`**：`"stop" | "length" | "toolUse" | "error" | "aborted"`

### 3.2 `CustomAgentMessages` 合并后（在 coding-agent / harness 里）

默认 `packages/agent/src/types.ts` 里 `CustomAgentMessages` 是空接口；coding-agent 合并后等价于还会在 union 里出现这些 **role** 类型（节选字段）：

- **`BashExecutionMessage`**：`role: "bashExecution"`，`command`、`output`、`exitCode?`、`cancelled`、`truncated`、`fullOutputPath?`、`timestamp`、`excludeFromContext?`
- **`CustomMessage`**：`role: "custom"`，`customType`、`content`（字符串或 Text/Image 数组）、`display`、`details?`、`timestamp`
- **`BranchSummaryMessage`**：`role: "branchSummary"`，`summary`、`fromId`、`timestamp`
- **`CompactionSummaryMessage`**：`role: "compactionSummary"`，`summary`、`tokensBefore`、`timestamp`

其它应用仍可再通过 `declare module` 再往 `CustomAgentMessages` 里加键，届时 `AgentMessage` 会自动变宽。

---

## 小结

- **`AgentState`**：会话级配置 + transcript + 对外只读的「是否在跑流 / 流式片段 / 挂起工具 / 错误」。
- **`MutableAgentState`**：**同一状态树**，只是把上述 4 个运行字段改成内部可改的 `boolean` / 可选消息 / `Set` / 可选字符串。
- **`AgentMessage`**：**User / Assistant / ToolResult**（pi-ai）与 **coding-agent 自定义四类**（及未来合并扩展）的**联合类型**。


export interface AgentContext {
	/** System prompt included with the request. */
	systemPrompt: string;
	/** Transcript visible to the model. */
	messages: AgentMessage[];
	/** Tools available for this run. */
	tools?: AgentTool<any>[];
}