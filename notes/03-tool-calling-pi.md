# 研读笔记 03：一次工具调用从头到尾经过什么

> 主源码：[agent-loop.ts](https://github.com/earendil-works/pi/blob/main/packages/agent/src/agent-loop.ts)（792 行，其中 375-792 行全是工具执行）、[types.ts](https://github.com/earendil-works/pi/blob/main/packages/agent/src/types.ts)（437 行）、[harness/tools/](https://github.com/earendil-works/pi/tree/main/packages/agent/src/harness/tools)（bash / edit / read / write 四个内置工具）、[utils/validation.ts](https://github.com/earendil-works/pi/blob/main/packages/ai/src/utils/validation.ts)（310 行）
> 基于 pi commit `5bc1c2c`（2026-07-25）；文中行号以该 commit 为准
> 对应代码：[steps/03](../steps/03-tools/)

## 一句话总结

第 2 篇的结论是**调用模型的函数永远不抛异常**。这一篇的核心是一条方向完全相反的规则：**工具函数必须抛异常**。

`types.ts:388` 对 `AgentTool.execute` 的注释写得很直白：

> Execute the tool call. Throw on failure instead of encoding errors in `content`.

两条规则相反，是因为错误的接收方不同。模型调用失败，接收方是程序，程序处理不了网络故障，只能优雅退出，所以降级成 `stopReason`；工具执行失败，接收方是模型，模型读懂"文件不存在"之后会自己 `ls` 排查，所以要抛出来，由内核 catch 成一条 `isError: true` 的 toolResult 喂回去。

第 1 篇实测到的"读不存在的文件 → 自己 ls → 回来提问"，机制就在这里。三篇连成一条线。

## 数字全景

| 维度 | 数字 |
|---|---|
| `agent-loop.ts` 总行数 | 792 |
| 其中工具执行相关（375-792） | 418 行，53% |
| 主循环本体（`runLoop`，155-280） | 126 行 |
| 内置工具 | 4 个（bash / edit / read / write） |
| 三段式流水线的三个函数 | 65 + 42 + 46 = 153 行 |
| 工具执行相关的事件类型 | 3 个（start / update / end） |

一半的内核代码在处理工具调用。这个比例本身就是文章的钩子：模型那边只有一个 `stream()` 调用，工具这边有 418 行。

## 核心一：三段式流水线

一次工具调用被拆成三个独立函数，各自的失败处理方式都不一样。

### prepare（`agent-loop.ts:600`，65 行）

四件事按顺序做，任何一步失败都返回 `kind: "immediate"`，也就是"不执行了，直接给一条错误结果"。

```typescript
async function prepareToolCall(...): Promise<PreparedToolCall | ImmediateToolCallOutcome> {
	const tool = currentContext.tools?.find((t) => t.name === toolCall.name);
	if (!tool) {
		return { kind: "immediate", result: createErrorToolResult(`Tool ${toolCall.name} not found`), isError: true };
	}

	try {
		const preparedToolCall = prepareToolCallArguments(tool, toolCall);   // ① 兼容层
		const validatedArgs = validateToolArguments(tool, preparedToolCall);  // ② schema 校验
		if (config.beforeToolCall) {                                          // ③ 权限钩子
			const beforeResult = await config.beforeToolCall({...}, signal);
			if (beforeResult?.block) {
				return { kind: "immediate", result: createErrorToolResult(beforeResult.reason || "..."), isError: true };
			}
		}
		if (signal?.aborted) { ... }                                          // ④ 中断检查
		return { kind: "prepared", toolCall, tool, args: validatedArgs };
	} catch (error) {
		return { kind: "immediate", result: createErrorToolResult(...), isError: true };
	}
}
```

**① `prepareArguments` 兼容层**（`types.ts:387`）。模型经常按旧格式传参，这个钩子在校验之前把参数捏成新格式。`edit.ts:48` 的 `prepareEditArguments` 是最好的例子，它处理两种脏数据：`edits` 字段被传成 JSON 字符串（模型把数组序列化了）；模型用了旧的 `oldText`/`newText` 顶层字段（老版本 schema）。这一层不做校验，只做形状转换，校验交给下一步。

**② schema 校验**（`ai/src/utils/validation.ts:278`）。typebox 的 `Value.Convert` 先做类型强转（字符串 `"3"` → 数字 `3`），再 `validator.Check`。失败时抛出的错误信息包含了完整的原始参数：

```typescript
const errorMessage = `Validation failed for tool "${toolCall.name}":\n${errors}\n\nReceived arguments:\n${JSON.stringify(toolCall.arguments, null, 2)}`;
throw new Error(errorMessage);
```

这条错误信息最终会原样喂回模型。**校验失败的报错是写给模型看的**，所以要把它自己传的参数回显出来，让它对照着改。

**③ `beforeToolCall` 钩子**。返回 `{ block: true, reason }` 就能拦下这次调用。这是权限系统唯一的挂载点，`agent-harness.ts:455` 和 `agent-session.ts:469` 各挂了一个，都是转发给扩展系统。

注意 `prepare` 阶段有意做成**串行**的，即使整批是并行执行。因为钩子需要按模型给出的顺序看到每一次调用，权限决策不能乱序。

### execute（`agent-loop.ts:666`，42 行）

```typescript
async function executePreparedToolCall(prepared, signal, emit): Promise<ExecutedToolCallOutcome> {
	const updateEvents: Promise<void>[] = [];
	let acceptingUpdates = true;

	try {
		const result = await prepared.tool.execute(
			prepared.toolCall.id, prepared.args as never, signal,
			(partialResult) => {
				if (!acceptingUpdates) return;
				updateEvents.push(Promise.resolve(emit({ type: "tool_execution_update", ... })));
			},
		);
		acceptingUpdates = false;
		await Promise.all(updateEvents);
		return { result, isError: false };
	} catch (error) {
		acceptingUpdates = false;
		await Promise.all(updateEvents);
		return { result: createErrorToolResult(error.message), isError: true };   // 异常在这里落地
	} finally {
		acceptingUpdates = false;
	}
}
```

两个细节：

**`acceptingUpdates` 闸门**。工具拿到的 `onUpdate` 回调是有生命周期的，`execute` 的 promise settle 之后再调用就被忽略。防的是工具内部有定时器忘了清，在下一次调用期间乱发事件。`types.ts:374` 把这条写进了注释。

**`await Promise.all(updateEvents)`**。emit 可能是异步的（写日志、推 UI），工具执行完了但增量事件还没投递完。这里等一次，保证 `tool_execution_end` 一定排在所有 `tool_execution_update` 之后。异常路径也要等，所以 catch 里重复了一遍。

`bash.ts:92` 是 `onUpdate` 的典型消费者，它用 100ms 节流把 shell 输出推给 UI：

```typescript
const scheduleOutputUpdate = (): void => {
	if (!onUpdate) return;
	updateDirty = true;
	const delay = BASH_UPDATE_THROTTLE_MS - (Date.now() - lastUpdateAt);
	if (delay <= 0) { clearUpdateTimer(); emitOutputUpdate(); return; }
	updateTimer ??= setTimeout(() => { updateTimer = undefined; emitOutputUpdate(); }, delay);
};
```

### finalize（`agent-loop.ts:709`，46 行）

`afterToolCall` 钩子可以改写结果，五个字段逐个覆盖（`types.ts:66` 明确写了"没有深合并"）：

```typescript
result = {
	...result,
	content: afterResult.content ?? result.content,
	details: afterResult.details ?? result.details,
	usage: afterResult.usage ?? result.usage,
	terminate: afterResult.terminate ?? result.terminate,
};
isError = afterResult.isError ?? isError;
```

钩子自己抛异常也被 catch 掉，转成错误结果。**这一层的任何失败都不许影响主循环**。

## 核心二：并行执行的三个顺序

`executeToolCallsParallel`（`agent-loop.ts:489`）里同时存在三个顺序，容易看混。

| 顺序 | 定义者 | 体现在 |
|---|---|---|
| 准备顺序 | 模型给出的 toolCall 数组顺序 | `for` 循环里的 `prepareToolCall`，串行 |
| 完成顺序 | 谁先跑完谁先 | `tool_execution_end` 事件 |
| 消息顺序 | 又回到模型给出的顺序 | `Promise.all` 保序，toolResult 消息按下标 push |

实现上的技巧是往同一个数组里塞两种东西：

```typescript
type FinalizedToolCallEntry = FinalizedToolCallOutcome | (() => Promise<FinalizedToolCallOutcome>);
```

准备阶段失败的（`kind: "immediate"`）直接把结果对象塞进去，准备成功的塞一个待执行的函数。最后统一展开：

```typescript
const orderedFinalizedCalls = await Promise.all(
	finalizedCalls.map((entry) => (typeof entry === "function" ? entry() : Promise.resolve(entry))),
);
```

`Promise.all` 保下标顺序，所以**不管谁先跑完，写进对话历史的顺序永远是模型给出的顺序**。

这一条是并行执行能成立的前提。UI 上你看到三个工具乱序完成，但下一轮发给模型的消息数组是确定性的，重放同一段历史一定得到同一个结果。

## 核心三：串行降级的传染性

```typescript
const hasSequentialToolCall = toolCalls.some(
	(tc) => currentContext.tools?.find((t) => t.name === tc.name)?.executionMode === "sequential",
);
if (config.toolExecution === "sequential" || hasSequentialToolCall) {
	return executeToolCallsSequential(...);
}
return executeToolCallsParallel(...);
```

一批里只要有一个工具声明了 `executionMode: "sequential"`，**整批降级为串行**。不是把那一个拎出来单独串行，是全部串行。

代价明显，好处是语义简单：声明 sequential 的工具能确信自己执行时没有任何别的工具在跑。`examples/extensions/question.ts:50`（向用户提问）和 `tic-tac-toe.ts:875` 都用了这个。提问类工具必须独占，否则两个问题会同时弹出来抢终端。

## 核心四：按文件排队，而不是全局串行

`edit` 和 `write` 都没有声明 `executionMode: "sequential"`。改文件这么危险的操作凭什么并行？

答案在 `harness/tools/file-mutation-queue.ts`，56 行：

```typescript
export async function withFileMutationQueue<T>(env: ExecutionEnv, path: string, fn: () => Promise<T>): Promise<T> {
	const state = getState(env);
	const registration = state.registration.then(async () => {
		const key = await getMutationQueueKey(env, path);
		const currentQueue = state.queues.get(key) ?? Promise.resolve();
		let releaseNext = () => {};
		const nextQueue = new Promise<void>((resolve) => { releaseNext = resolve; });
		const chainedQueue = currentQueue.then(() => nextQueue);
		state.queues.set(key, chainedQueue);
		return { key, currentQueue, chainedQueue, releaseNext };
	});
	...
	await currentQueue;              // 等前一个改同一文件的操作
	try { return await fn(); }
	finally {
		releaseNext();
		if (state.queues.get(key) === chainedQueue) state.queues.delete(key);
	}
}
```

锁的粒度是**单个文件的 canonical path**，不是整个工具。改 `a.ts` 和改 `b.ts` 照样并行，只有两次调用打到同一个文件才排队。

`getMutationQueueKey` 用 `env.canonicalPath` 解 symlink，所以 `./src/a.ts` 和 `/abs/src/a.ts` 和一个指向它的软链接，三条路径会落到同一把锁上。文件不存在时（`not_found`）退回绝对路径，因为 write 工具要创建新文件。

`state.queues.delete(key)` 那个条件判断是防内存泄漏的：只有当前队列还是自己挂上去的那条时才删，否则会误删后来者的队列。

这是全篇最工业级的一段代码。100 行的教程版 agent 绝不会写这个，但它解决的是真实事故——模型一次发两个 edit 改同一个文件，第二个读到的是第一个写之前的内容，改完覆盖回去，第一个的修改就没了。

## 核心五：截断的整批作废

```typescript
const executedToolBatch =
	message.stopReason === "length"
		? await failToolCallsFromTruncatedMessage(toolCalls, emit)
		: await executeToolCalls(currentContext, message, config, signal, emit);
```

`stopReason === "length"` 意味着输出被 token 上限砍断，这批工具调用的参数可能是残缺的。全部作废，每个都回一条固定文案：

```
Tool call "xxx" was not executed: the response hit the output token limit,
so its arguments may be truncated. Re-issue the tool call with complete arguments.
```

第 2 篇讲过为什么不能信任截断后的参数：SSE 流式解析里 tool call 的 arguments 是分片到达的，最后拼起来 `JSON.parse`，**截断的 JSON 有可能恰好解析成功**（比如少了后面几个字段），所以不能靠 parse 失败来判断，只能看 `stopReason`。

注意这条错误也是写给模型看的，末尾直接给出行动指令"重发一次完整参数"。

## 核心六：terminate 的全票原则

```typescript
function shouldTerminateToolBatch(finalizedCalls: FinalizedToolCallOutcome[]): boolean {
	return finalizedCalls.length > 0 && finalizedCalls.every((finalized) => finalized.result.terminate === true);
}
```

`every` 而不是 `some`。一批工具**全部**要求终止，循环才停。

场景是这样的：模型同时调了一个"任务完成"工具和一个 `bash`。如果按 `some`，任务完成会把 bash 的结果一起丢掉。按 `every`，只要还有一个普通工具在跑，循环就继续，让模型看到全部结果再决定。

## 完整链路（画图用）

```
AssistantMessage.content 里的 toolCall[]
  │
  ├─ stopReason === "length"？ → 整批作废，回"参数可能截断，请重发"
  │
  ├─ 有工具声明 sequential？ → 整批串行
  │
  └─ 并行路径：
       for (逐个，串行)
         emit tool_execution_start
         prepare ──┬─ 找不到工具        → immediate 错误结果
                   ├─ prepareArguments  兼容层
                   ├─ validateArguments → 抛错则 immediate 错误结果
                   ├─ beforeToolCall    → block 则 immediate 错误结果
                   └─ 通过 → 存一个待执行函数
       Promise.all(全部展开)          ← 并发在这里发生
         execute ──┬─ tool.execute() + onUpdate 节流推送
                   └─ 抛异常 → catch 成 isError 结果
         finalize ─── afterToolCall 可改写五个字段
         emit tool_execution_end       ← 完成顺序
       按数组下标生成 toolResult 消息   ← 恢复模型给出的顺序
  │
  └─ push 进 context.messages，下一轮原样发回模型
```

## 值得写进文章的设计点

### A. 主线（文章 3 的骨架）

1. **两条相反的错误契约** —— 模型层永不抛，工具层必须抛。判断标准是"错误的接收方是程序还是模型"。这是全文的钩子
2. **报错是写给模型看的** —— 校验失败回显原始参数、截断作废附带行动指令，都是同一个意识
3. **三段式流水线** —— prepare 串行（权限要有序）/ execute 并行 / finalize 各自完成后立刻做
4. **并行的三个顺序** —— 执行乱序，历史有序，`Promise.all` 保下标
5. **按文件排队** —— 锁在 canonical path 上，不是在工具上

### B. 细节控向（短推或番外）

- `acceptingUpdates` 闸门与 `await Promise.all(updateEvents)` 的事件时序保证
- `executionMode: sequential` 的传染性，一个拖累一批
- `terminate` 用 `every` 不用 `some`
- `prepareArguments` 处理的两种模型脏数据（数组被序列化成字符串、旧字段名）
- `file-mutation-queue` 里 `delete` 前那个身份判断

## mini-agent 实现清单（steps/03）

从 steps/02 往上加：

- [ ] `AgentTool` 接口：name / description / parameters(JSON Schema) / execute
- [ ] 三段式拆分：prepare / execute / finalize 三个独立函数
- [ ] 参数校验（不引 typebox，手写一个够用的 JSON Schema 校验），失败信息回显原始参数
- [ ] `beforeToolCall` 钩子，演示一个"危险命令需要确认"的权限拦截
- [ ] 并行执行 + `Promise.all` 保序，打印证明"完成顺序 ≠ 消息顺序"
- [ ] 两个内置工具：`read_file` 和 `bash`（够演示错误回喂就行）
- [ ] 按文件排队的简化版 mutation queue
- [ ] 实测：让模型读一个不存在的文件，看它自己 ls 排查

**演示脚本**：并行发起三个 bash（`sleep 3` / `sleep 1` / `sleep 2`），终端上看到完成顺序是 2-3-1，但打印出来的 toolResult 数组顺序还是 1-2-3。这是视频里最直观的一幕。

## 其他线索（后续文章用）

- `addedToolNames`：工具执行结果可以往对话里注册新工具，动态工具集怎么和历史重放共存
- `harness/skills.ts`（375 行）：skill 系统怎么变成工具
- `edit-diff.ts`（500 行）：多处替换的冲突检测和 unified patch 生成，够单独写一篇
- `utils/truncate.ts`（350 行）：工具输出截断策略，和 context 管理那篇合并讲
- `shell-output.ts`：流式捕获 shell 输出同时做行数和字节数双限制
