#!/usr/bin/env node
// 一个最小可用的 coding agent：一个 while 循环 + 三个工具，零依赖。
// 用法：DEEPSEEK_API_KEY=sk-xxx node agent.mjs "任务描述"
//       不带参数则进入交互模式。

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname, sep } from "node:path";
import readline from "node:readline/promises";

const API_URL = process.env.LLM_BASE_URL ?? "https://api.deepseek.com/chat/completions";
const MODEL = process.env.LLM_MODEL ?? "deepseek-chat";
const API_KEY = process.env.DEEPSEEK_API_KEY;
if (!API_KEY) {
	console.error("请先设置环境变量 DEEPSEEK_API_KEY");
	process.exit(1);
}

// —— 工具：名字、给模型看的描述和参数 schema、真正的执行函数 ——
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

// 最简陋的"沙箱"：只允许操作当前工作目录内的文件
function safePath(p) {
	const abs = resolve(process.cwd(), p);
	if (abs !== process.cwd() && !abs.startsWith(process.cwd() + sep)) {
		throw new Error(`拒绝访问工作目录之外的路径: ${p}`);
	}
	return abs;
}

// —— 调 LLM：DeepSeek 是 OpenAI 兼容接口，一个 fetch 就够 ——
async function chat(messages) {
	const res = await fetch(API_URL, {
		method: "POST",
		headers: { "content-type": "application/json", authorization: `Bearer ${API_KEY}` },
		body: JSON.stringify({
			model: MODEL,
			messages,
			tools: Object.entries(tools).map(([name, t]) => ({
				type: "function",
				function: { name, description: t.description, parameters: t.parameters },
			})),
		}),
	});
	if (!res.ok) throw new Error(`LLM HTTP ${res.status}: ${await res.text()}`);
	return (await res.json()).choices[0].message;
}

// —— 核心：agent loop。整个"智能"就在这个循环里 ——
async function agentLoop(messages) {
	while (true) {
		const msg = await chat(messages); // 1. 把对话发给模型
		messages.push(msg);
		if (msg.content) console.log(`\n🤖 ${msg.content}`);
		if (!msg.tool_calls?.length) return; // 2. 模型不再要工具 → 本轮结束

		for (const call of msg.tool_calls) {
			// 3. 执行模型要求的工具
			const { name } = call.function;
			let result;
			try {
				console.log(`  ⚙️  ${name} ${call.function.arguments.slice(0, 120)}`);
				const args = JSON.parse(call.function.arguments);
				result = String(tools[name] ? tools[name].run(args) : `未知工具: ${name}`);
			} catch (err) {
				result = `错误: ${err.message}`; // 错误不抛出——还给模型，让它自己修
			}
			// 4. 结果塞回对话，回到第 1 步
			messages.push({ role: "tool", tool_call_id: call.id, content: result.slice(0, 8000) });
		}
	}
}

// —— 入口：单任务模式（命令行参数）或交互模式 ——
const messages = [
	{ role: "system", content: "你是一个 coding agent，工作目录是用户当前目录。用工具完成任务，完成后简短总结。" },
];
const task = process.argv[2];
if (task) {
	messages.push({ role: "user", content: task });
	await agentLoop(messages);
} else {
	const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
	// 外层循环：一轮干完接着聊（对应 pi 的 follow-up 消息）
	while (true) {
		const input = await rl.question("\n你: ");
		if (!input.trim() || input.trim() === "exit") break;
		messages.push({ role: "user", content: input });
		await agentLoop(messages);
	}
	rl.close();
}
