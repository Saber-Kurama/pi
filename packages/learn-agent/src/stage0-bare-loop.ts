/**
 * 阶段 0：裸循环（Bare Loop）
 * ===========================
 *
 * 目标：不依赖任何 agent 封装，只用 pi-ai 的 complete() 手写出
 *       "模型调工具 → 我执行 → 结果塞回去 → 模型继续" 这个核心循环。
 *
 * 这就是 gc-docs/pi-ai.md 里 "例子 3 / Agent 循环" 那段手写代码。
 * 后面所有阶段做的事，本质上都是把这段循环工业化、加状态、加事件、加边界处理。
 *
 * 运行：  npm run -w learn-agent stage0
 *
 * 为了离线、确定性地演示，这里用 pi-ai 自带的 "faux provider"（假模型）：
 * 它不连网、不花钱，而是按我们预先排程好的脚本依次返回回复。
 * 把 model / streamFn 换成真的 getModel('anthropic', ...) + 真 key，
 * 这段循环逻辑一行都不用改 —— 这正是 pi-ai "统一调用层" 的意义。
 */

import {
	type Context,
	complete,
	fauxAssistantMessage,
	fauxText,
	fauxToolCall,
	type Message,
	registerFauxProvider,
	type Tool,
	type ToolResultMessage,
	Type,
	validateToolArguments,
} from "@earendil-works/pi-ai";

// ───────────────────────────────────────────────────────────────────────────
// 1. 定义工具（我们自己负责"执行"，模型只负责"决定调用"）
// ───────────────────────────────────────────────────────────────────────────

// 工具的参数 schema 用 TypeBox 写，pi-ai 会把它转成各家 provider 的 function schema。
const readFileTool: Tool = {
	name: "read_file",
	description: "读取一个文件的内容",
	parameters: Type.Object({
		path: Type.String({ description: "文件路径" }),
	}),
};

// 一份假的"文件系统"，纯粹为了让 demo 自给自足。
const FAKE_FS: Record<string, string> = {
	"package.json": '{ "name": "learn-agent", "dependencies": { "typebox": "1.x" } }',
};

// 真正执行工具的地方。返回的字符串会被包成 toolResult 塞回对话。
function executeTool(name: string, args: Record<string, unknown>): { text: string; isError: boolean } {
	if (name === "read_file") {
		const path = String(args.path);
		const content = FAKE_FS[path];
		if (content === undefined) {
			return { text: `ENOENT: 找不到文件 ${path}`, isError: true };
		}
		return { text: content, isError: false };
	}
	return { text: `未知工具: ${name}`, isError: true };
}

// ───────────────────────────────────────────────────────────────────────────
// 2. 注册假模型，并排程它的回复脚本
// ───────────────────────────────────────────────────────────────────────────

const faux = registerFauxProvider();
const model = faux.getModel();

// 假模型会按这个数组依次返回（每调用一次 complete()，弹出一条）：
faux.setResponses([
	// 第 1 轮：模型决定调用 read_file，并在等待结果（stopReason: "toolUse"）
	fauxAssistantMessage(
		[fauxText("我先读一下 package.json。"), fauxToolCall("read_file", { path: "package.json" }, { id: "call_1" })],
		{ stopReason: "toolUse" },
	),
	// 第 2 轮：模型拿到工具结果后，给出最终回答（stopReason: "stop"）
	fauxAssistantMessage("你的项目依赖了 typebox。", { stopReason: "stop" }),
]);

// ───────────────────────────────────────────────────────────────────────────
// 3. 手写 agent 循环
// ───────────────────────────────────────────────────────────────────────────

async function main() {
	// Context = 这次请求带给模型的一切：系统提示 + 对话历史 + 可用工具
	const context: Context = {
		systemPrompt: "你是编程助手，必要时用工具读文件后再回答。",
		tools: [readFileTool],
		messages: [{ role: "user", content: "package.json 里有哪些依赖？", timestamp: Date.now() }],
	};

	printMessage(context.messages[0]);

	// 第一轮请求
	let reply = await complete(model, context);
	context.messages.push(reply);
	printMessage(reply);

	// 核心循环：只要模型还在等工具结果，就执行工具、塞回结果、再请求一次。
	while (reply.stopReason === "toolUse") {
		const toolCalls = reply.content.filter((block) => block.type === "toolCall");

		for (const call of toolCalls) {
			// 3a. 参数校验：pi-ai 提供 validateToolArguments，按 schema 校验/补全。
			//     校验失败时我们把错误当成 toolResult 还回去，让模型自己重试。
			let validated: Record<string, unknown>;
			try {
				validated = validateToolArguments(readFileTool, call) as Record<string, unknown>;
			} catch (error) {
				context.messages.push(
					makeToolResult(call.id, call.name, error instanceof Error ? error.message : String(error), true),
				);
				continue;
			}

			// 3b. 真正执行工具
			const { text, isError } = executeTool(call.name, validated);
			const toolResult = makeToolResult(call.id, call.name, text, isError);
			context.messages.push(toolResult);
			printMessage(toolResult);
		}

		// 拿到工具结果后，再请求一次，让模型基于结果继续
		reply = await complete(model, context);
		context.messages.push(reply);
		printMessage(reply);
	}

	// 循环退出时 stopReason === "stop"，模型已经给出完整回答。
	console.log("\n=== 循环结束 ===");
	console.log("总消息数:", context.messages.length);
}

// ───────────────────────────────────────────────────────────────────────────
// 工具函数
// ───────────────────────────────────────────────────────────────────────────

function makeToolResult(toolCallId: string, toolName: string, text: string, isError: boolean): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text }],
		isError,
		timestamp: Date.now(),
	};
}

// 把一条消息漂亮地打印出来，方便观察循环每一步发生了什么。
function printMessage(message: Message): void {
	if (message.role === "user") {
		console.log(`\n[用户] ${textOf(message.content)}`);
		return;
	}
	if (message.role === "toolResult") {
		const tag = message.isError ? "工具结果✗" : "工具结果✓";
		console.log(`  [${tag}] ${message.toolName} → ${textOf(message.content)}`);
		return;
	}
	// assistant
	console.log(`\n[助手] (stopReason=${message.stopReason})`);
	for (const block of message.content) {
		if (block.type === "text") console.log(`  └ 文本: ${block.text}`);
		else if (block.type === "thinking") console.log(`  └ 思考: ${block.thinking}`);
		else if (block.type === "toolCall") console.log(`  └ 调工具: ${block.name}(${JSON.stringify(block.arguments)})`);
	}
}

function textOf(content: string | Array<{ type: string; text?: string }>): string {
	if (typeof content === "string") return content;
	return content
		.filter((block) => block.type === "text")
		.map((block) => block.text ?? "")
		.join("");
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
