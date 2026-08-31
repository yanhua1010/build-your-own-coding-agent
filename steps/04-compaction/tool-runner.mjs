// 工具执行流水线：prepare → execute → finalize。
// 对应 pi 的 packages/agent/src/agent-loop.ts:411-792
//
// pi 的 agent-loop.ts 一共 792 行，第 375 行往后全是工具执行，418 行，占了一半多。
// 模型那边只有一个 stream() 调用，工具这边有这么多，原因是工具要真的去动世界。
//
// 这个文件里最值得记住的一条规矩，和第 2 篇正好相反：
//   调用模型的函数永远不抛异常   ← 接收方是程序，程序处理不了网络故障
//   工具函数必须抛异常           ← 接收方是模型，模型能读懂"文件不存在"然后自己排查
// 工具抛出的异常在 execute 阶段被 catch，变成一条 isError 的结果喂回模型。

import { validateArguments } from "./validate.mjs";

/**
 * 执行一条 assistant 消息里的全部工具调用。
 *
 * @param toolCalls  模型给出的调用数组，顺序就是模型写下的顺序
 * @param tools      工具表 { name: { description, parameters, execute, executionMode?, prepareArguments? } }
 * @param hooks      { beforeToolCall, afterToolCall, onEvent }
 * @param signal     AbortSignal
 * @returns { results, terminate } results 的顺序 === toolCalls 的顺序
 */
export async function runToolCalls(toolCalls, tools, hooks = {}, signal) {
	// 一批里只要有一个工具声明了 sequential，整批降级为串行。
	// 不是把那一个拎出来单独串行，是全部串行。
	// 代价明显，好处是声明 sequential 的工具能确信执行时没有别的工具在跑
	// （比如"向用户提问"，两个问题同时弹出来会抢终端）。
	const hasSequential = toolCalls.some((c) => tools[c.name]?.executionMode === "sequential");

	const outcomes = hasSequential
		? await runSequential(toolCalls, tools, hooks, signal)
		: await runParallel(toolCalls, tools, hooks, signal);

	return {
		results: outcomes,
		// every 而不是 some：一批工具全部要求终止，循环才停。
		// 模型同时调了"任务完成"和一个 bash，按 some 就会把 bash 的结果丢掉。
		terminate: outcomes.length > 0 && outcomes.every((o) => o.terminate === true),
	};
}

async function runSequential(toolCalls, tools, hooks, signal) {
	const outcomes = [];
	for (const call of toolCalls) {
		hooks.onEvent?.({ type: "tool_start", id: call.id, name: call.name, args: call.args });
		const prepared = await prepare(call, tools, hooks, signal);
		const outcome =
			prepared.kind === "immediate" ? prepared : await finalize(prepared, await execute(prepared, hooks, signal), hooks, signal);
		hooks.onEvent?.({ type: "tool_end", id: call.id, name: call.name, ...outcome });
		outcomes.push(outcome);
		if (signal?.aborted) break;
	}
	return outcomes;
}

async function runParallel(toolCalls, tools, hooks, signal) {
	// 数组里塞两种东西：准备阶段就失败的直接塞结果对象，
	// 准备成功的塞一个待执行的函数。下面统一展开。
	const entries = [];

	// 准备阶段是串行的，即使整批要并行执行。
	// 因为 beforeToolCall 钩子需要按模型给出的顺序看到每一次调用，
	// 权限决策不能乱序（"允许这次 bash"和"允许下一次 bash"是两回事）。
	for (const call of toolCalls) {
		hooks.onEvent?.({ type: "tool_start", id: call.id, name: call.name, args: call.args });
		const prepared = await prepare(call, tools, hooks, signal);

		if (prepared.kind === "immediate") {
			hooks.onEvent?.({ type: "tool_end", id: call.id, name: call.name, ...prepared });
			entries.push(prepared);
		} else {
			entries.push(async () => {
				const outcome = await finalize(prepared, await execute(prepared, hooks, signal), hooks, signal);
				// 完成顺序：谁先跑完谁先发这个事件
				hooks.onEvent?.({ type: "tool_end", id: call.id, name: call.name, ...outcome });
				return outcome;
			});
		}
		if (signal?.aborted) break;
	}

	// 并发真正发生在这一行。
	// Promise.all 按下标保序，所以不管谁先跑完，返回数组的顺序永远是模型给出的顺序。
	// 这是并行执行能成立的前提：UI 上看到的是乱序完成，写进对话历史的是确定性顺序，
	// 重放同一段历史一定得到同一个结果。
	return Promise.all(entries.map((e) => (typeof e === "function" ? e() : Promise.resolve(e))));
}

// —— 第一段：prepare ——
// 四件事按顺序做，任何一步失败都返回 immediate，也就是"不执行了，直接给一条错误结果"。
async function prepare(call, tools, hooks, signal) {
	const tool = tools[call.name];
	if (!tool) return fail(call, `未知工具 ${call.name}`);

	// 模型把参数拼错到 JSON 都解析不了，在第 2 篇的流式解析里就已经标记了
	if (call.args === null) return fail(call, `参数不是合法 JSON：${call.argsError ?? "解析失败"}`);

	try {
		// ① 兼容层：在校验之前把脏数据捏成 schema 期望的形状。
		//    pi 的 edit 工具用它处理两种情况：edits 数组被序列化成字符串、模型用了旧字段名。
		const raw = tool.prepareArguments ? tool.prepareArguments(call.args) : call.args;

		// ② schema 校验，失败抛出的错误信息会原样喂回模型
		const args = validateArguments(call.name, raw, tool.parameters);

		// ③ 权限钩子。返回 { block: true, reason } 就能拦下这次调用。
		//    这是权限系统唯一的挂载点。
		if (hooks.beforeToolCall) {
			const decision = await hooks.beforeToolCall({ call, args, tool }, signal);
			if (signal?.aborted) return fail(call, "已中断");
			if (decision?.block) return fail(call, decision.reason || "工具执行被拦截");
		}

		// ④ 中断检查
		if (signal?.aborted) return fail(call, "已中断");

		return { kind: "prepared", call, tool, args };
	} catch (err) {
		return fail(call, err.message);
	}
}

const fail = (call, text) => ({ kind: "immediate", call, content: text, isError: true });

// —— 第二段：execute ——
// 工具抛出的异常在这里落地，转成 isError 的结果。整个 agent 不会因为工具失败而崩溃。
async function execute(prepared, hooks, signal) {
	const updates = [];
	let accepting = true;

	// 工具拿到的 onUpdate 是有生命周期的：execute 返回之后再调用就被忽略。
	// 防的是工具内部有定时器忘了清，在下一次调用期间乱发事件。
	const onUpdate = (partial) => {
		if (!accepting) return;
		updates.push(
			Promise.resolve(
				hooks.onEvent?.({ type: "tool_update", id: prepared.call.id, name: prepared.call.name, partial }),
			),
		);
	};

	try {
		const result = await prepared.tool.execute(prepared.args, { signal, onUpdate });
		accepting = false;
		// 等所有增量事件投递完，保证 tool_end 一定排在全部 tool_update 之后。
		// onEvent 可能是异步的（写日志、推 UI），不等就会乱序。
		await Promise.all(updates);
		return typeof result === "string" ? { content: result, isError: false } : { isError: false, ...result };
	} catch (err) {
		accepting = false;
		await Promise.all(updates); // 异常路径同样要等
		return { content: err.message, isError: true };
	} finally {
		accepting = false;
	}
}

// —— 第三段：finalize ——
// afterToolCall 可以改写结果，逐字段覆盖，没有深合并。
// 钩子自己抛异常也被吃掉：这一层的任何失败都不许影响主循环。
async function finalize(prepared, executed, hooks, signal) {
	let outcome = { kind: "done", call: prepared.call, ...executed };

	if (hooks.afterToolCall) {
		try {
			const patch = await hooks.afterToolCall(
				{ call: prepared.call, args: prepared.args, ...executed },
				signal,
			);
			if (patch) {
				outcome = {
					...outcome,
					content: patch.content ?? outcome.content,
					isError: patch.isError ?? outcome.isError,
					terminate: patch.terminate ?? outcome.terminate,
				};
			}
		} catch (err) {
			outcome = { ...outcome, content: err.message, isError: true };
		}
	}
	return outcome;
}

/**
 * 输出被 token 上限截断时，这批调用的参数可能都是残缺的，全部作废。
 *
 * 为什么不靠"参数 JSON 解析失败"来判断：截断的 JSON 有可能恰好解析成功
 * （少了后面几个字段而已），所以只能看 stopReason。第 2 篇讲过这一点。
 *
 * 注意这条错误也是写给模型看的，末尾直接给出行动指令。
 */
export function failTruncatedCalls(toolCalls) {
	return toolCalls.map((call) => ({
		kind: "immediate",
		call,
		content: `工具调用 "${call.name}" 未执行：模型输出触及 token 上限，参数可能不完整。请重新发起这次调用，带上完整参数。`,
		isError: true,
	}));
}
