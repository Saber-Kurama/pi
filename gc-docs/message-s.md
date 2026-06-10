`packages/ai` 和 LLM 的**流式交互**可以概括成一条固定管道：**按 `model.api` 选 provider → 发 HTTP（或 SDK）流式请求 → 把各家协议解析成统一的 `AssistantMessageEvent` → 用 `AssistantMessageEventStream` 推给调用方**。

---

## 1. 对外入口：`stream` / `streamSimple`

```25:49:packages/ai/src/stream.ts
export function stream<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: ProviderStreamOptions,
): AssistantMessageEventStream {
	const provider = resolveApiProvider(model.api);
	return provider.stream(model, context, options as StreamOptions);
}

export function streamSimple<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const provider = resolveApiProvider(model.api);
	return provider.streamSimple(model, context, options);
}
```

- `context`：`{ systemPrompt?, messages, tools? }`，即发给模型的对话与工具定义（类型在 `types.ts` 的 `Context`）。
- `options`：`StreamOptions` / `SimpleStreamOptions`（温度、signal、headers、`onPayload` 等）。
- 返回值：**同一个** `AssistantMessageEventStream`，既可 `for await`，也可 `.result()` 拿最终 `AssistantMessage`。

---

## 2. 如何找到「哪个 LLM 实现」：`api-registry`

```17:31:packages/ai/src/api-registry.ts
export function getApiProvider(api: Api): ApiProviderInternal | undefined {
	return apiProvider.get(api)?.provider;
}
```

每个 `Api`（如 `"anthropic-messages"`、`"openai-responses"`）在启动时通过 `registerApiProvider` 挂上一对 **`stream` / `streamSimple`**。`stream.ts` 里 `import "./providers/register-builtins.js"` 会触发各内置 provider 的懒注册。

---

## 3. 懒加载 + 把「异步事件序列」接到统一流上

内置 provider 在 `register-builtins.ts` 里**动态 import**，并把各家的 `AsyncIterable<AssistantMessageEvent>` **转发**进 `AssistantMessageEventStream`：

```129:136:packages/ai/src/providers/register-builtins.ts
function forwardStream(target: AssistantMessageEventStream, source: AsyncIterable<AssistantMessageEvent>): void {
	(async () => {
		for await (const event of source) {
			target.push(event);
		}
		target.end();
	})();
}
```

`createLazySimpleStream` 会先 `new AssistantMessageEventStream()`，模块加载成功后 `forwardStream(outer, inner)`，这样调用方**立刻**拿到 stream，不必等 import 完成。

---

## 4. 流式协议：统一的 `AssistantMessageEvent`

协议定义在 `types.ts` 的 `AssistantMessageEvent`（你之前看过的那串：`start`、`text_delta`、`toolcall_end`、`done`、`error` 等）。

约定（见 `StreamFunction` 注释）：

- 成功结束：`done`，里带最终 `AssistantMessage`（`stopReason` 为 `stop` / `length` / `toolUse`）。
- 失败/取消：`error`，里带 `stopReason` 为 `error` / `aborted` 的 `AssistantMessage`。
- **不要靠 throw 表示请求失败**，应体现在 stream 里。

---

## 5. `AssistantMessageEventStream` 本身怎么工作

```68:81:packages/ai/src/utils/event-stream.ts
export class AssistantMessageEventStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") {
					return event.message;
				} else if (event.type === "error") {
					return event.error;
				}
				throw new Error("Unexpected event type for final result");
			},
		);
	}
}
```

- `push(event)`：把事件交给正在 `for await` 的消费者，或先入队。
- 遇到 `done` / `error`：标记结束并 `resolve` **`result()`** 对应的 `AssistantMessage`。
- 调用方典型写法：`for await (const e of stream) { ... }` 然后 `await stream.result()`（agent-loop 里就是这样）。

---

## 6. 各 provider 里「真正和 LLM 说话」在干什么（概念层）

每个 `packages/ai/src/providers/*.ts` 里的 `streamSimpleXxx` 大致是：

1. 用 `transform-messages` 等把 `Context` 转成该 API 的 JSON body。
2. `fetch` 流式接口（SSE / chunked JSON）或官方 SDK 的 stream。
3. 读字节流，按厂商格式解析 delta。
4. 每解析出一截，就 **yield** 一个 `AssistantMessageEvent`（例如更新 `partial` 里的 `text_delta`）。
5. 流结束组出完整 `AssistantMessage`，yield `done` 或 `error`。

所以 **`packages/ai` 的流式交互 = 厂商协议适配器 + 统一事件流**；上层（`packages/agent`）只消费 `AssistantMessageEventStream`，不关心是 Anthropic 还是 OpenAI。

---

## 小结（一条链）

**`streamSimple(model, context, options)`**  
→ **`getApiProvider(model.api).streamSimple(...)`**  
→ **懒加载对应 provider 模块**  
→ **`AsyncIterable<AssistantMessageEvent>` → `forwardStream` → `AssistantMessageEventStream`**  
→ **消费者 `for await` 增量 + `result()` 拿最终助手消息**。

若要继续深挖，在仓库里打开任意一个 `streamSimple*.ts`（例如 `anthropic.ts` 或 `openai-responses.ts`），从 `fetch`/SSE 循环追到 `yield { type: "text_delta", ... }` 即可对上整条链路。


这个文件实现了一个**通用的「生产者 push / 消费者 async 迭代」桥**，专门给 LLM 流式事件用；下面分 `EventStream` 和 `AssistantMessageEventStream` 说。

---

## `EventStream<T, R>`（第 4–66 行）

**角色**：把同步/异步的 `push(event)` 和 `for await...of stream` 对齐，并额外提供 **`result(): Promise<R>`**，在流「完成」时解析出一个最终值 `R`（可以和 `T` 不同）。

### 类型参数

- **`T`**：流里逐项吐出的元素类型（例如 `AssistantMessageEvent`）。
- **`R`**：最终聚合结果类型（默认等于 `T`）；对助手流来说是 `AssistantMessage`。

### 内部状态

| 成员 | 作用 |
|------|------|
| `queue` | 生产者比消费者快时，先把事件排队 |
| `waiting` | 消费者比生产者快时，每个「等下一条」的 `resolve` 回调排队 |
| `done` | 流已结束，不再接受新事件（`push` 直接忽略） |
| `finalResultPromise` / `resolveFinalResult` | **`result()` 只 resolve 一次**，表示整次流业务上结束 |

### 构造函数里的两个回调

- **`isComplete(event)`**：某条 `event` 是否表示「流在协议上结束」（例如 `done` / `error`）。
- **`extractResult(event)`**：从这条「完成事件」里抽出 `R`（例如从 `done` 里取出 `message`）。

一旦 `isComplete` 为真，会 **`done = true`** 并 **`resolveFinalResult(extractResult(event))`**，这样只等 `result()` 的调用方也能结束。

### `push(event)`

1. 若已 `done`，直接 return（防止结束后再写入）。
2. 若是完成事件：置 `done`、resolve `finalResultPromise`。
3. 否则或（完成事件也要被消费者看到）：  
   - 若有消费者在 `waiting` 里等，立刻把这一条 `IteratorResult` 交给队首 waiter；  
   - 否则 `queue.push(event)`。

注意：**完成事件也会尝试交给 waiter 或进队**，所以消费者仍能 `yield` 到最后的 `done`/`error`，再在下一次循环发现 `done` 退出。

### `end(result?: R)`

用于**没有**通过 `isComplete` 那条路径结束的情况（例如上游 iterable 正常耗尽后 `forwardStream` 调 `target.end()`）：

- 强制 `done = true`。
- 若传了 `result`，用这个值 resolve `finalResultPromise`（否则若从未 `push` 过完成事件，`result()` 可能一直挂起——调用方需保证协议一致；`forwardStream` 在 iterable 结束后会 `end()` 且不带参数，此时通常已完成事件已 `push` 过）。

然后唤醒所有还在 `await next` 的 waiter，给 **`{ done: true }`**，让 async iterator 退出。

### `async *[Symbol.asyncIterator]()`

标准 **AsyncIterable** 消费侧逻辑：

1. 队列非空 → `yield` 出一条。
2. 已 `done` 且无积压 → `return` 结束迭代。
3. 否则 → `new Promise`，把 `resolve` 推进 `waiting`，等 `push` 或 `end` 唤醒。

这样 **producer 和 consumer 速度任意**，不会出现「只能全缓冲完再读」或「丢事件」的简单 bug。

### `result()`

返回构造时就创建好的 **`Promise<R>`**，在第一次「完成语义」出现时 resolve（要么来自 `push` 的完成事件，要么来自 `end(result)`）。

---

## `AssistantMessageEventStream`（第 68–81 行）

`EventStream` 的特化：

- **`T = AssistantMessageEvent`**
- **`R = AssistantMessage`**
- **`isComplete`**：`type === "done" || type === "error"`
- **`extractResult`**：从 `done` 取 `message`，从 `error` 取 `error`（失败时仍是完整 `AssistantMessage`，带 `stopReason` 等）

这就是 `packages/ai` 里所有 `stream` / `streamSimple` 返回类型的核心：**边收事件边迭代，最后用 `result()` 拿定稿助手消息**。

---

## 设计上的一个小点（读代码时心里有数）

`end()` 里 `waiter({ value: undefined as any, done: true })` 用了 `as any`，因为完成时并不再 yield 一条「值」，只通知迭代器结束；类型上 `IteratorResult<T>` 的 `value` 在 `done: true` 时往往被忽略。

---

## 一句话

**`EventStream` = 带缓冲的手写 async channel + 单次完成的 `Promise<R>`；`AssistantMessageEventStream` = 把 LLM 流式协议事件流收敛成最终 `AssistantMessage` 的专用版本。**