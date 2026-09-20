# @earendil-works/pi-telemetry

[English](README.md)

面向 pi 各包的厂商无关遥测契约，以及带类型推导的 schema 工具。

本包提供：

- 显式、基于回调的 `TelemetryContext` / `TelemetrySpan` 契约；
- 共享的 `NOOP_TELEMETRY_CONTEXT`；
- 参考实现 `InMemoryTelemetryContext`；
- 可序列化的 schema 定义，并据此推断 TypeScript 类型；
- 不包含导出器、全局当前 span 状态，也不依赖任何遥测后端。

应用可以使用内存参考实现，也可以为 OpenTelemetry、Sentry、日志或其他后端提供适配器。Pi 各包显式传递遥测上下文，并各自定义领域 schema。

## 目录

- [安装](#安装)
- [遥测概念](#遥测概念)
- [核心 Context API](#核心-context-api)
- [适配器契约](#适配器契约)
- [空操作 Context](#空操作-context)
- [内存参考适配器](#内存参考适配器)
- [适配器一致性套件](#适配器一致性套件)
- [带类型的 Schema](#带类型的-schema)
  - [起始属性与完成属性](#起始属性与完成属性)
- [Schema 元数据](#schema-元数据)
- [与 Pi 各包的集成](#与-pi-各包的集成)
- [安全与可移植性](#安全与可移植性)
- [API 参考](#api-参考)
- [开发](#开发)
- [许可证](#许可证)

## 安装

```bash
npm install @earendil-works/pi-telemetry
```

## 遥测概念

遥测描述程序运行时实际做了什么。本包用 span、属性、事件、状态以及显式 context 来建模这些工作：

| 概念 | 含义 |
|---|---|
| **Span** | 一次操作的计时记录，例如加载账号或发起 AI 请求。工作开始前创建，工作结束时结束。 |
| **父子 Span** | 操作可以包含更小的操作。一次请求 span 里可能包含缓存查找和数据库查询。它们构成一棵树，用来看出时间花在哪里。 |
| **属性（Attribute）** | 挂在 span 上的具名事实，例如 `provider: "openai"`、`cache.hit: true` 或 `item_count: 12`。属性描述这次操作及其结果。 |
| **事件（Event）** | span 期间某个时刻发生的具名事情，例如 `retry.scheduled` 或 `cache.lookup`。事件没有持续时间，也可以带自己的属性。 |
| **状态（Status）** | 操作结果：`ok` 或 `error`。错误状态可以包含错误名称和消息。 |
| **Context** | 标识新工作应挂在 span 树何处的句柄。从某个 context 启动 span，该 span 就会成为它的子 span。 |

例如，加载账号可能产生这样的遥测：

```text
example.account.load                         span
├─ attributes: account.id=123, found=true   span 上的事实
├─ event: example.cache.lookup              span 期间发生的事情
│  └─ attribute: cache.hit=false            事件上的事实
└─ status: ok                               最终结果
```

Span 是诊断数据，不是业务状态。记录 span 不得改变账号加载是否执行、成功、失败或是否落盘。适配器把这些通用概念翻译成 OpenTelemetry、Sentry、日志或其他后端里的对应概念。

## 核心 Context API

`TelemetryContext` 会在回调周围启动一个 span。回调收到的 `TelemetrySpan` 同时也是子 span 的显式父 context。

```typescript
import {
  NOOP_TELEMETRY_CONTEXT,
  type TelemetryContext,
} from '@earendil-works/pi-telemetry';

async function loadAccount(
  accountId: string,
  telemetryContext: TelemetryContext = NOOP_TELEMETRY_CONTEXT,
) {
  return telemetryContext.startSpan(
    {
      name: 'example.account.load',
      attributes: { 'example.account.id': accountId },
    },
    async (span) => {
      const account = await readAccount(accountId);
      span.setAttributes({ 'example.account.found': account !== undefined });
      return account;
    },
  );
}
```

把回调里的 span 传给下层工作，即可形成显式嵌套：

```typescript
return telemetryContext.startSpan({ name: 'example.parent' }, async (parentSpan) => {
  return parentSpan.startSpan({ name: 'example.child' }, async (childSpan) => {
    childSpan.addEvent('example.cache.lookup', { 'example.cache.hit': true });
    return performWork();
  });
});
```

没有公开的 `end()` 方法。`startSpan()` 负责收尾，并在回调的返回值或 Promise settle 之前保持 span 打开。若预期失败以普通返回值表示，需要显式设置状态：

```typescript
return telemetryContext.startSpan({ name: 'example.save' }, async (span) => {
  const result = await save();
  if (!result.ok) {
    span.setStatus({
      status: 'error',
      error: { name: 'SaveError', message: result.reason },
    });
  }
  return result;
});
```

## 适配器契约

适配器实现 `TelemetryContext`，并把通用 API 桥接到后端。它必须：

- 创建子 span，并同步、恰好一次地调用回调；
- 保留回调的返回值和拒绝值；若同步抛出，则返回以同一值拒绝的 Promise；
- 在返回的 Promise settle 之前保持原生 span 打开；
- 将正常完成视为 `ok`，将抛出/拒绝视为错误，除非已显式设置状态；
- 多次 `setStatus()` 以最后一次写入为准；
- 合并 `setAttributes()`：后写入的已定义值覆盖先前值，忽略 `undefined`；
- 记录方法必须同步、被动、且不抛错；
- 忽略 settle 之后的调用；
- 记录失败时原子忽略该次调用、抑制后端失败，并仍恰好执行一次业务回调。

适配器可以在内部激活后端原生的环境 context，供自动埋点使用，但 pi 代码始终通过 `TelemetryContext` 参数传播父级。导出器缓冲、flush、采样、后端 ID 以及后端特有的 context 对象都属于适配器。用[适配器一致性套件](#适配器一致性套件)检查这些可观察语义。

## 空操作 Context

遥测可选时使用 `NOOP_TELEMETRY_CONTEXT`：

```typescript
import { NOOP_TELEMETRY_CONTEXT } from '@earendil-works/pi-telemetry';

const result = await NOOP_TELEMETRY_CONTEXT.startSpan(
  { name: 'example.operation' },
  () => runOperation(),
);
```

空操作 context：

- 同步调用回调；
- 保留返回值和异步拒绝，并把同步抛出转换成以同一值拒绝的 Promise；
- 嵌套 span 也共用同一个冻结的惰性 span；
- 不检查、不保留名称、属性、事件或状态。

## 内存参考适配器

`InMemoryTelemetryContext` 是与后端无关的参考实现。适用于测试、本地诊断，以及有意只做进程内捕获、不接导出器的应用：

```typescript
import { InMemoryTelemetryContext } from '@earendil-works/pi-telemetry';

const telemetry = new InMemoryTelemetryContext();

await telemetry.startSpan(
  { name: 'example.operation', attributes: { input: 'demo' } },
  async (span) => {
    span.addEvent('example.started');
    span.setAttributes({ output_count: 3 });
  },
);

console.log(telemetry.getSpans());
```

`getSpans()` 按 span 启动顺序返回已脱离的快照。每个 `RecordedTelemetrySpan` 包含确定性的数字 ID、父 ID、合并后的属性、有序事件、最终状态、settle 状态，以及确定性的结束序号。它不记录时间戳。

该适配器可以当作普通 `TelemetryContext` 使用，但存储无界且仅限进程内。隔离测试或记录范围时请新建实例；除非调用方的数据策略允许，否则不要记录敏感属性。

## 适配器一致性套件

`@earendil-works/pi-telemetry/testing` 导出一套与测试运行器无关的一致性用例，按组建模。fixture 提供全新的 context，并把后端已完成的 span 转换成规范化的 `RecordedTelemetrySpan` 快照：

```typescript
import {
  createTelemetryAdapterConformance,
  type TelemetryAdapterFixture,
} from '@earendil-works/pi-telemetry/testing';
import { describe, it } from 'vitest';

const conformance = createTelemetryAdapterConformance(async () => {
  const adapter = createMyTelemetryAdapter();
  return {
    context: adapter.context,
    getSpans: async () => adapter.normalizedSpans(),
    async [Symbol.asyncDispose]() {
      await adapter.close();
    },
  } satisfies TelemetryAdapterFixture;
});

for (const group of new Set(conformance.map((testCase) => testCase.group))) {
  describe(group, () => {
    for (const testCase of conformance.filter((candidate) => candidate.group === group)) {
      it(testCase.name, () => testCase.run());
    }
  });
}
```

套件检查：同步且仅一次准入、结果与拒绝值的同一性、自动与显式状态、属性合并、事件顺序、settle 后调用惰性、嵌套与并发时的父子关系，以及对不可读遥测载荷失败的抑制。`getSpans()` 可以在返回前 flush 异步导出器。testing 子路径使用 Node 的断言 API；根遥测包本身保持运行时无关。

## 带类型的 Schema

底层 span API 有意接受开放的名称和属性包，以便适配器保持通用。领域包可以定义封闭、可序列化的 schema，并从中推断精确的 TypeScript 类型。

```typescript
import {
  createTypedSpanStarter,
  defineTelemetrySchema,
} from '@earendil-works/pi-telemetry';

export const EXAMPLE_TELEMETRY_SCHEMA = defineTelemetrySchema({
  version: 1,
  spans: {
    'example.read': {
      description: 'Read one resource',
      parents: { kind: 'any' },
      startAttributes: {
        'example.resource': {
          type: 'string',
          required: true,
          values: ['account', 'project'],
          description: 'Resource kind',
        },
      },
      endAttributes: {
        'example.item_count': {
          type: 'number',
          description: 'Number of returned items',
        },
      },
      events: {
        'example.cache': {
          description: 'Cache lookup result',
          attributes: {
            'example.cache.hit': {
              type: 'boolean',
              required: true,
              description: 'Whether the cache contained the resource',
            },
          },
        },
      },
      status: {
        default: 'ok',
        errorWhen: 'The read throws or returns an error result',
      },
    },
  },
} as const);

const startSpan = createTypedSpanStarter(
  telemetryContext,
  [EXAMPLE_TELEMETRY_SCHEMA],
);
```

starter 为每个 span 暴露一个重载，并在编译期检查名称和属性。联合类型的名称必须先收窄再调用，以保持运行时名称与其属性 schema 的对应关系。回调会收到基于同一批 schema、且已绑定到当前回调 span 的子 starter：

```typescript
await startSpan(
  'example.read',
  { 'example.resource': 'account' },
  async (span, startChildSpan) => {
    span.addEvent('example.cache', { 'example.cache.hit': true });
    const accounts = await readAccounts();
    span.setAttributes({ 'example.item_count': accounts.length });

    await startChildSpan(
      'example.read',
      { 'example.resource': 'project' },
      async (childSpan) => {
        const projects = await readProjects();
        childSpan.setAttributes({ 'example.item_count': projects.length });
      },
    );

    return accounts;
  },
);
```

### 起始属性与完成属性

`startAttributes` 和 `endAttributes` 描述属性通常在何时可知，而不是两套运行时存储：

| Schema 字段 | 如何记录 | 是否必填 |
|---|---|---|
| `startAttributes` | 创建 span 时通过 typed starter 的 `attributes` 参数传入 | 每条定义显式设置 `required: true` 或 `false` |
| `endAttributes` | 之后通过 schema 范围内 span 的 `setAttributes()` 追加 | 始终可选 |

两组属性都会成为同一后端 span 上的普通属性。没有单独的结束属性载荷，也没有结束回调。在上例中，`example.resource` 在 `example.read` 启动时已知，而 `example.item_count` 要等到 `readAccounts()` 返回后才知道：

```typescript
await startSpan(
  'example.read',
  { 'example.resource': 'account' }, // 必填的起始属性
  async (span) => {
    const accounts = await readAccounts();
    span.setAttributes({
      'example.item_count': accounts.length, // 可选的完成属性
    });
    return accounts;
  },
); // 回调 resolve 后 span 才会 settle
```

“End” 指完成阶段的补充：只要回调仍在执行，随时可以设置结束属性；拿不到时也可以省略。调用零次 `setAttributes()` 是合法的。这对提前失败、取消，以及并非每条路径都存在的提供商特定数据很重要。

重复的 `setAttributes()` 会合并进同一属性包。同一 key 的后写入已定义值覆盖先前值，`undefined` 被忽略。schema 范围内的方法只接受当前 span 已声明的结束属性。

属性不会结束 span。回调的返回、resolve、抛出或拒绝控制 settle；真正执行结束操作的是 `startSpan()`。settle 之后的适配器调用是惰性的。

starter 可以组合多个独立版本的 schema：

```typescript
import { AGENT_TELEMETRY_SCHEMAS } from '@earendil-works/pi-agent-core';

const startAgentSpan = createTypedSpanStarter(
  telemetryContext,
  AGENT_TELEMETRY_SCHEMAS,
);
```

内联 schema 数组会自动保留元组类型。单独声明的数组应使用 `as const`。数组中字面量重复的 span 名称会在编译期被拒绝；schema 在运行时不会被合并、检查或保留。

由 schema 推导出的类型会拒绝：缺失的必填属性、未知 key、非法的封闭集合值、未声明的事件，以及空 schema 上的属性。结束属性始终是可选补充；类型系统不要求必须调用 `setAttributes()`。

`defineTelemetrySchema()` 是带类型的恒等函数。它返回普通的可 JSON 序列化数据，不做运行时校验，也不强制父级规则。

## Schema 元数据

支持的属性类型：

- `string`、`number` 和 `boolean`；
- `string[]`、`number[]` 和 `boolean[]`。

属性定义还支持：

- `values`：标量值的封闭集合；
- `elementValues`：数组元素的封闭集合；
- `examples`：文档示例；
- `sensitive`：标记需要特殊处理的数据；
- `cardinality`：记录预期的 `low` 或 `high` 基数。

起始属性和事件属性声明 `required`。结束属性不声明；见[起始属性与完成属性](#起始属性与完成属性)。

父级元数据是描述性 schema 数据：

- `{ kind: 'any' }`：根 span 或任意调用方 span；
- `{ kind: 'root_or_external' }`：根 span，或 schema 之外由调用方拥有的 span；
- `{ kind: 'spans', spans: [...] }`：仅列出的 schema span。

适配器不必理解 schema 对象。埋点辅助函数和测试用它们来保持发出的名称和属性一致。

## 与 Pi 各包的集成

所有权有意拆分：

- `@earendil-works/pi-telemetry` 拥有厂商无关契约、空操作与内存参考 context、schema 工具，以及适配器一致性套件；
- `@earendil-works/pi-ai` 在提供商请求选项中接受并传播 `telemetryContext`，但不拥有遥测 schema；
- `@earendil-works/pi-agent-core` 拥有并导出 pi 的 AI 请求与 harness schema、它们合并后的只读 schema 元组，以及带类型的 span 辅助函数。

```typescript
import {
  AGENT_TELEMETRY_SCHEMAS,
  AI_TELEMETRY_SCHEMA,
  HARNESS_TELEMETRY_SCHEMA,
  startAiSpan,
  startHarnessSpan,
} from '@earendil-works/pi-agent-core';
```

pi schema 使用 pi 自有的 `pi.ai.*`、`pi.harness.*` 和 `pi.session.*` 名称。适配器可以把它们翻译成后端约定，但不应改写已发出的 pi 词汇。

## 安全与可移植性

遥测是进程内诊断，不是持久化的应用状态。不要把 `TelemetryContext`、`TelemetrySpan` 或后端原生的 trace 对象持久化到记录、消息、快照或延迟句柄中。

属性值有意限制为原始标量和数组。领域埋点应避免记录提示词、补全、工具参数或输出、文件内容、提供商载荷、请求头、凭据，以及自由文本错误细节，除非其 schema 和数据策略明确允许。

本包不使用 `AsyncLocalStorage` 或其他运行时特有的环境 context API。它适用于 Node.js、Bun、浏览器和 worker；后端适配器仍需自行保证运行时兼容性。

## API 参考

### 核心类型与值

| 导出 | 用途 |
|---|---|
| `TelemetryContext` | 启动由回调管理的子 span |
| `TelemetrySpan` | 记录属性、事件和状态；同时作为子 context |
| `SpanOptions` | Span 名称和可选起始属性 |
| `SpanAttributes` / `AttributeValue` | 适配器层开放的属性包及支持的值 |
| `SpanStatus` | 显式的 `ok` 或 `error` 状态 |
| `NOOP_TELEMETRY_CONTEXT` | 关闭遥测时使用的共享被动 context |
| `InMemoryTelemetryContext` | 具有确定性进程内记录的参考适配器 |
| `RecordedTelemetrySpan` | 规范化的已捕获 span 快照 |
| `RecordedTelemetryEvent` | 规范化的已捕获事件快照 |

### Schema 定义与推断

| 导出 | 用途 |
|---|---|
| `defineTelemetrySchema()` | 可序列化 schema 数据的带类型恒等辅助函数 |
| `createTypedSpanStarter()` | 将父 context 绑定到一个或多个 schema 词汇 |
| `TypedSpanStarter` | 精确的 starter 类型，回调递归绑定子 starter |
| `TelemetrySchemaDefinition` | 顶层 schema 形状 |
| `TelemetrySpanDefinition` | Span 元数据、父级、属性、事件和状态规则 |
| `TelemetryAttributeType` | 支持的标量与数组类型名 |
| `TelemetryAttributeMetadata` | 描述、敏感性和基数元数据 |
| `TelemetryAttributeDefinition` | 属性类型、允许值、示例和元数据 |
| `TelemetryStartAttributeDefinition` | 带是否必填的起始属性定义 |
| `TelemetryEventAttributeDefinition` | 带是否必填的事件属性定义 |
| `TelemetryEventDefinition` | 事件描述及其属性定义 |
| `TelemetryParentDefinition` | 开放、外部根，或有限 schema 父级规则 |
| `TelemetrySchemaSpanName` | 已声明 span 名称的联合类型 |
| `TelemetrySchemaSpanStartAttributes` | 单个 span 精确推断的起始属性 |
| `TelemetrySchemaSpanEndAttributes` | 单个 span 可选推断的结束属性 |
| `TelemetrySchemaSpanEventName` | 单个 span 已声明事件的联合类型 |
| `TelemetrySchemaSpanEventAttributes` | 单个事件精确推断的属性 |
| `SchemaTelemetrySpan` | 限制为某一个 schema span 的视图 |
| `TelemetrySchemaSpanUnion` | schema 中全部 span 的可辨识联合 |
| `InferStartAttributes` | 从起始定义推断的必填与可选值 |
| `InferOptionalAttributes` | 从结束定义推断的可选值 |
| `InferEventAttributes` | 从事件定义推断的必填与可选值 |
| `InferRequiredAndOptionalAttributes` | 带是否必填定义的共享推断工具 |
| `ExactTelemetryAttributes` | 拒绝期望属性集之外的 key |

### Testing 子路径

| 导出 | 用途 |
|---|---|
| `createTelemetryAdapterConformance()` | 创建与运行器无关的适配器一致性用例 |
| `TelemetryAdapterFixture` | 单个用例的全新 context 与规范化快照读取器 |
| `TelemetryAdapterFixtureFactory` | 创建隔离的 fixture |
| `TelemetryAdapterConformanceCase` | 由测试运行器执行的分组用例 |

## 开发

在本包目录下：

```bash
npm test
npm run build
```

仓库级类型检查、格式化、lint 和冒烟检查：

```bash
npm run check
```

## 许可证

MIT
