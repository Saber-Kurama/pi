# 从零手写一个 Agent —— 学习进度与路线图

> 这个练习包的目标：**从零开始、一阶段一阶段地复刻 `packages/agent`（`@earendil-works/pi-agent-core`）**，
> 直到完整实现内置工具、session 持久化、compaction、skills。
>
> 每个阶段都是一个**能独立跑通的里程碑**，后一阶段在前一阶段上叠加，不推倒重来。
> 全程用 pi-ai 的 **faux provider（假模型）**，离线、不花钱、结果确定。有真 API key 时换成真模型即可，循环逻辑不变。

---

## 全景地图：这个 agent 包到底是什么

它**不是** LLM 调用层（那是 `pi-ai`），而是建立在 `pi-ai` 之上的两层：

```
┌─ Harness 层（开箱即用的编程助手）──────────────┐
│  system-prompt · 内置工具(read/bash/edit) ·      │
│  session 持久化 · compaction 压缩 · skills        │  ← packages/agent/src/harness/*
├─ 核心 Agent 层（通用 agent 引擎）─────────────────┤
│  Agent 类(有状态) ← agent-loop(无状态循环)        │  ← agent.ts / agent-loop.ts / types.ts
├─ pi-ai（统一 LLM 层，见 gc-docs/pi-ai.md）────────┤
│  stream/complete · Context · Tool · 事件流        │
└──────────────────────────────────────────────────┘
```

三个决定设计的核心洞察：

1. **无状态循环 vs 有状态封装分离**。`agent-loop.ts` 是纯函数 `runLoop`，不持有状态，只 `emit` 事件；
   `agent.ts` 的 `Agent` 类订阅事件、累积 `messages`。这是整个设计的骨架。
2. **`AgentMessage` ≠ LLM `Message`**。agent 内部用 `AgentMessage`（可含自定义消息类型），
   只在调 LLM 那一刻用 `convertToLlm` 转成 pi-ai 的 `Message[]`。
3. **一切皆事件**。`agent_start / turn_start / message_* / tool_execution_* / turn_end / agent_end`，
   UI、持久化、状态全靠订阅事件驱动。

---

## 爬坡路线图（对照官方包逐阶段实现）

| 阶段 | 状态 | 加什么 | 脚本文件 | 对照官方文件 |
|---|---|---|---|---|
| **0** | ✅ 完成 | 裸循环：手写 `while(toolUse)` | `src/stage0-bare-loop.ts` | 文档例子 3 |
| **1** | ⬜ 待做 | 抽出无状态 `runLoop` + **流式** `stream()` + `emit` 事件 | `src/stage1-stream-loop.ts` | `agent-loop.ts` |
| **2** | ⬜ | 固化类型协议：`AgentEvent` / `AgentTool` / `AgentContext` / `AgentToolResult` | `src/stage2-types.ts` | `types.ts` |
| **3** | ⬜ | 有状态 `Agent` 类：`state` / `subscribe` / `prompt()` / `processEvents` | `src/stage3-agent.ts` | `agent.ts` |
| **4** | ⬜ | 工具执行进阶：并行执行、`before/afterToolCall` 钩子、`terminate` | `src/stage4-tools.ts` | `agent-loop.ts` |
| **5** | ⬜ | 交互控制：steering/follow-up 队列、`continue()`、`abort()` 中断 | `src/stage5-control.ts` | `agent.ts` |
| **6** | ⬜ | Harness：system-prompt 构建、`convertToLlm`、内置 `read/write/edit/bash/grep`、`ExecutionEnv` | `src/stage6-harness/` | `harness/*` |
| **7** | ⬜ | session 持久化（jsonl 存储、事件落盘、恢复续聊） | `src/stage7-session/` | `harness/session/*` |
| **8** | ⬜ | compaction 上下文压缩（token 估算、摘要、branch summary） | `src/stage8-compaction/` | `harness/compaction/*` |
| **9** | ⬜ | skills / prompt-templates / hooks / 观测 | `src/stage9-*` | `harness/skills.ts` 等 |

**0→5 = 通用 agent 引擎；6→9 = 编程助手 harness。**

---

## 怎么运行

```bash
# 在 monorepo 根目录 /Users/saber/coding/mygithub/pi 下：

# 跑某个阶段（npm 脚本）
npm run -w learn-agent stage0

# 或直接用 tsx 跑任意脚本
node_modules/.bin/tsx packages/learn-agent/src/stage0-bare-loop.ts
```

> 每完成一个阶段，就在 `package.json` 的 `scripts` 里加一行 `"stageN": "tsx src/stageN-xxx.ts"`。

环境说明：
- monorepo 用 **npm workspaces**；`learn-agent` 已通过 workspace 软链依赖 `@earendil-works/pi-ai`。
- 全程用 **faux provider**，无需 API key。要用真模型：把 `registerFauxProvider()` 换成
  `getModel('anthropic', 'claude-sonnet-4-...')` 并设好 `ANTHROPIC_API_KEY` 等环境变量。
- ⚠️ 不要跑 `npm install --package-lock-only`，它会把 `tsx` 从 `node_modules` 里裁掉。
  如果 `tsx` 丢了，在根目录跑一次 `npm install --ignore-scripts` 即可恢复。

---

## 已完成阶段笔记

### 阶段 0 — 裸循环 ✅

文件：`src/stage0-bare-loop.ts`

这是整个 agent 的"原子核"。它只做 4 件事，后面每一阶段都是在外面包东西：

```
1. 拼 Context（systemPrompt + messages + tools）
2. complete() 请求模型
3. while (stopReason === "toolUse")：
     ├ validateToolArguments 校验参数（失败→错误塞回让模型重试）
     ├ 执行工具
     └ toolResult 塞回 context，再 complete()
4. stopReason === "stop" → 退出，模型给出最终答案
```

关键点：
- `complete(model, context)` 是 pi-ai 的非流式入口，返回完整 `AssistantMessage`。
- `stopReason === "toolUse"` 是循环继续的信号。
- 工具的"决定调用"由模型负责，"执行"由我们的代码负责 —— 这是 agent 与纯聊天的根本区别。
- 参数校验失败不抛给用户，而是包成 `isError: true` 的 toolResult 还给模型，让它自我纠正。

**练习建议**（继续前可自己玩一玩）：
- 再加一个工具（如 `list_files`），让模型连续调两个工具。
- 在 `setResponses` 里排程一条参数错误的 toolCall，观察校验失败如何被塞回。

---

## 下次如何继续

1. 打开这个文件，看"路线图"表格，找到第一个 ⬜ 的阶段（当前是 **阶段 1**）。
2. 告诉 Claude：**"继续阶段 1"**（或对应阶段号）。Claude 会：
   - 先带你读官方对应文件（如 `packages/agent/src/agent-loop.ts`），讲清它多处理了哪些边界；
   - 在 `src/` 下新建该阶段脚本，叠加到上一阶段；
   - 跑通 demo，并回来更新本文件的进度表 + "已完成阶段笔记"。
3. 阶段 1 的核心升级：从一次性 `complete()` 换成**流式 `stream()` + 事件驱动**——
   这是后面能做打字机效果、实时显示工具参数、UI 订阅的关键转折点。

> 如果忘了上下文，直接对 Claude 说："读 packages/learn-agent/PROGRESS.md，我们继续。"
