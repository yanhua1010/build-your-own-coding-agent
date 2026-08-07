#!/usr/bin/env node
// Step 02：流式输出 + 绝不 reject 的错误契约。
// 对应系列文章第 2 篇《统一 LLM API 与错误契约》。
//
// 和 step 01 最大的区别：整个主循环里没有一处 try/catch 包裹模型调用。
// 失败不再是异常，只是 stopReason 的一个取值。
//
// 用法：DEEPSEEK_API_KEY=sk-xxx node agent.mjs "任务描述"

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname, sep } from "node:path";
import readline from "node:readline/promises";

import { stream } from "./api/openai-completions.mjs";
import { resolveProvider } from "./providers.mjs";

// —— 工具：和 step 01 完全一样 ——
const tools = {
	read_file: {
		description: "读取文本文件内容",
		parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
		run: ({ path }) => readFileSync(safePath(path), "utf8"),
	},
	write_file: {
		description: "写入文本文件，必要时自动创建目录",
		parameters: {
			type: "object",
			properties: { path: { type: "string" }, content: { type: "string" } },
			required: ["path", "content"],
		},
		run: ({ path, content }) => {
			const abs = safePath(path);
			mkdirSync(dirname(abs), { recursive: true });
			writeFileSync(abs, content);
			return `已写入 ${path}（${content.length} 字符）`;
		},
	},
	run_command: {
		description: "在当前目录执行 shell 命令，返回输出",
		parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
		run: ({ command }) => execSync(command, { encoding: "utf8", timeout: 30_000 }) || "(命令执行成功，无输出)",
	},
};

function safePath(p) {
	const abs = resolve(process.cwd(), p);
	if (abs !== process.cwd() && !abs.startsWith(process.cwd() + sep)) {
		throw new Error(`拒绝访问工作目录之外的路径: ${p}`);
	}
	return abs;
}

const toolSchemas = Object.entries(tools).map(([name, t]) => ({
	type: "function",
	function: { name, description: t.description, parameters: t.parameters },
}));

// —— 核心循环 ——
async function agentLoop(provider, messages) {
	while (true) {
		const controller = new AbortController();
		const onSigint = () => controller.abort();
		process.once("SIGINT", onSigint);

		// 这一行不会 throw，也不需要 await。它同步返回一个流。
		const events = stream(provider, messages, toolSchemas, controller.signal);

		// 边收边打印，这就是流式的意义
		process.stdout.write("\n🤖 ");
		for await (const event of events) {
			if (event.type === "text_delta") process.stdout.write(event.text);
			else if (event.type === "toolcall_start") process.stdout.write(`\n  ⚙️  ${event.name} `);
		}

		const message = await events.result();
		process.off("SIGINT", onSigint);
		messages.push(toApiMessage(message));

		// 失败在这里只是一个普通分支，不是 catch
		if (message.stopReason === "error" || message.stopReason === "aborted") {
			const label = message.stopReason === "aborted" ? "已中断" : "出错了";
			console.error(`\n\n[${label}] ${message.errorMessage ?? ""}`);

			// 关键：已经收到的内容还在。output 是在 try 之前构造的，不会因为异常丢掉
			const partial = message.content.filter((c) => c.type === "text").map((c) => c.text).join("");
			if (partial) console.error(`[已收到的部分回复仍然保留，共 ${partial.length} 字符]`);
			return;
		}

		const toolCalls = message.content.filter((c) => c.type === "toolCall");
		if (toolCalls.length === 0) {
			console.log();
			return; // 模型不再要工具，本轮结束
		}

		// 输出被 token 上限截断时，这批工具调用的参数可能都是残缺的。
		// 全部作废，一个都不执行。（第 1 篇讲过的截断防御）
		const truncated = message.stopReason === "length";
		if (truncated) console.warn(`\n[输出被截断，${toolCalls.length} 个工具调用全部作废]`);

		for (const call of toolCalls) {
			messages.push({
				role: "tool",
				tool_call_id: call.id,
				content: truncated ? "错误: 模型输出被截断，参数不完整，未执行" : String(runTool(call)).slice(0, 8000),
			});
		}
	}
}

function runTool(call) {
	try {
		if (!tools[call.name]) return `错误: 未知工具 ${call.name}`;
		if (call.args === null) return `错误: 参数解析失败 ${call.argsError}`;
		return tools[call.name].run(call.args);
	} catch (err) {
		return `错误: ${err.message}`; // 工具的错误也还给模型，让它自己修
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
	{ role: "system", content: "你是一个 coding agent，工作目录是用户当前目录。用工具完成任务，完成后简短总结。" },
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
