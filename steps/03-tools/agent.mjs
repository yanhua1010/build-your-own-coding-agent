#!/usr/bin/env node
// Step 03：一次工具调用从头到尾经过什么。
// 对应系列文章第 3 篇。
//
// 和 step 02 的区别全在工具那一侧。step 02 的 runTool 是十行的 for 循环加一个
// try/catch，这一步换成三段式流水线（prepare / execute / finalize），加上并行执行、
// 权限钩子和按文件排队。
//
// 用法：DEEPSEEK_API_KEY=sk-xxx node agent.mjs "任务描述"
//      PERMISSION=ask node agent.mjs "任务"     每次 bash 都要人确认

import readline from "node:readline/promises";

import { stream } from "./api/openai-completions.mjs";
import { resolveProvider } from "./providers.mjs";
import { tools, toolSchemas } from "./tools.mjs";
import { runToolCalls, failTruncatedCalls } from "./tool-runner.mjs";

// —— 权限钩子：挂在 prepare 阶段，唯一的拦截点 ——
const DANGEROUS = [/\brm\s+-[rf]/, /\bsudo\b/, /\bmkfs\b/, />\s*\/dev\/[sh]d/, /\bchmod\s+777\b/];

async function beforeToolCall({ call, args }) {
	if (call.name !== "bash") return;

	const hit = DANGEROUS.find((re) => re.test(args.command));
	if (hit) {
		// 拦截理由会变成工具结果喂回模型，所以写清楚为什么，
		// 模型才能换一个安全的做法而不是原样重试。
		return { block: true, reason: `命令被安全策略拦截（匹配 ${hit}）。请换一个不会造成不可逆破坏的做法。` };
	}

	if (process.env.PERMISSION === "ask") {
		const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
		const ok = await rl.question(`\n🔐 执行 ${JSON.stringify(args.command)} ? [y/N] `);
		rl.close();
		if (ok.trim().toLowerCase() !== "y") return { block: true, reason: "用户拒绝了这次执行" };
	}
}

// —— 事件渲染：三个事件对应三个时刻 ——
const startedAt = new Map();

function onEvent(event) {
	switch (event.type) {
		case "tool_start":
			startedAt.set(event.id, Date.now());
			console.log(`  ⚙️  ${event.name} ${preview(event.args)}`);
			break;
		case "tool_update":
			// bash 跑到一半的输出。真实 TUI 会原地刷新，这里只提示还活着
			process.stdout.write(".");
			break;
		case "tool_end": {
			const ms = Date.now() - (startedAt.get(event.id) ?? Date.now());
			startedAt.delete(event.id);
			const icon = event.isError ? "❌" : "✅";
			console.log(`  ${icon} ${event.name} (${ms}ms) ${preview(event.content)}`);
			break;
		}
	}
}

const preview = (v) => {
	const s = typeof v === "string" ? v : JSON.stringify(v ?? {});
	const oneLine = s.replace(/\s+/g, " ");
	return oneLine.length > 80 ? `${oneLine.slice(0, 80)}…` : oneLine;
};

// —— 主循环 ——
async function agentLoop(provider, messages) {
	while (true) {
		const controller = new AbortController();
		const onSigint = () => controller.abort();
		process.once("SIGINT", onSigint);

		const events = stream(provider, messages, toolSchemas, controller.signal);
		process.stdout.write("\n🤖 ");
		for await (const event of events) {
			if (event.type === "text_delta") process.stdout.write(event.text);
		}
		const message = await events.result();
		process.off("SIGINT", onSigint);
		messages.push(toApiMessage(message));

		// 第 2 篇的契约：失败只是一个分支，不是 catch
		if (message.stopReason === "error" || message.stopReason === "aborted") {
			console.error(`\n\n[${message.stopReason === "aborted" ? "已中断" : "出错了"}] ${message.errorMessage ?? ""}`);
			return;
		}

		const toolCalls = message.content.filter((c) => c.type === "toolCall");
		if (toolCalls.length === 0) {
			console.log();
			return;
		}
		console.log();

		// 输出被截断 → 整批作废，一个都不执行
		const batch =
			message.stopReason === "length"
				? { results: failTruncatedCalls(toolCalls), terminate: false }
				: await runToolCalls(toolCalls, tools, { beforeToolCall, onEvent }, controller.signal);

		// results 的顺序 === 模型给出的顺序，哪怕执行是乱序完成的
		for (const outcome of batch.results) {
			messages.push({
				role: "tool",
				tool_call_id: outcome.call.id,
				content: String(outcome.content ?? "").slice(0, 8000) || "(无输出)",
			});
		}

		if (batch.terminate) {
			console.log("\n[全部工具都要求终止，本轮结束]");
			return;
		}
	}
}

/** 内部消息格式 → OpenAI API 的消息格式 */
function toApiMessage(message) {
	const text = message.content.filter((c) => c.type === "text").map((c) => c.text).join("");
	const calls = message.content.filter((c) => c.type === "toolCall");

	const api = { role: "assistant", content: text || null };
	if (calls.length > 0) {
		api.tool_calls = calls.map((c) => ({
			id: c.id,
			type: "function",
			function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) },
		}));
	}
	return api;
}

// —— 入口 ——
let provider;
try {
	provider = resolveProvider();
} catch (err) {
	console.error(err.message);
	process.exit(1);
}
console.log(`使用 ${provider.name} · ${provider.model}`);

const messages = [
	{
		role: "system",
		content:
			"你是一个 coding agent，工作目录是用户当前目录。用工具完成任务。" +
			"互不依赖的操作请在同一条消息里一次性发出，它们会并行执行。完成后简短总结。",
	},
];

const task = process.argv[2];
if (task) {
	messages.push({ role: "user", content: task });
	await agentLoop(provider, messages);
} else {
	const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
	while (true) {
		const input = await rl.question("\n你: ");
		if (!input.trim() || input.trim() === "exit") break;
		messages.push({ role: "user", content: input });
		await agentLoop(provider, messages);
	}
	rl.close();
}
