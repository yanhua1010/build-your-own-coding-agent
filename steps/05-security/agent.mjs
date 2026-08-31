#!/usr/bin/env node
// Step 05：权限与安全。给 mini-agent 填上 pi 留空的那道审批策略。
// 对应系列文章第 5 篇。
//
// 机制在 tool-runner.mjs（beforeToolCall 挂载点，第 3 步就搭好了），
// 这一步补的是策略和 bash 加固：
//   1. permission.mjs —— 三档默认姿态（off / ask / strict），填 pi 留空的钩子
//   2. sandbox.mjs   —— bash 清洗 env、进程树 kill、可选套 sandbox-exec
//   3. trust.mjs     —— 加载项目 AGENTS.md 之前先问信任
//
// 用法：DEEPSEEK_API_KEY=sk-xxx node agent.mjs "任务描述"
//      AGENT_APPROVAL=strict node agent.mjs "任务"    危险命令直接拒（默认 ask，可选 off）
//      AGENT_SANDBOX=on node agent.mjs "任务"          bash 走 sandbox-exec（仅 macOS）
//      CONTEXT_WINDOW=8192 node agent.mjs "任务"       小窗口测试 compaction

import readline from "node:readline/promises";
import { readFileSync } from "node:fs";

import { stream } from "./api/openai-completions.mjs";
import { resolveProvider } from "./providers.mjs";
import { tools, toolSchemas, bashConfig } from "./tools.mjs";
import { runToolCalls, failTruncatedCalls } from "./tool-runner.mjs";
import { createPermissionHook } from "./permission.mjs";
import { checkProjectTrust } from "./trust.mjs";
import {
	estimateContextTokens,
	shouldCompact,
	compact,
	rebuildMessages,
	DEFAULT_SETTINGS,
} from "./compaction.mjs";
import { isContextOverflow } from "./overflow.mjs";

// —— 权限钩子：机制在 tool-runner.mjs，这里挂策略（见 permission.mjs） ——
// 默认姿态从 AGENT_APPROVAL 读：off / ask（默认）/ strict。
const approvalMode = ["off", "ask", "strict"].includes(process.env.AGENT_APPROVAL)
	? process.env.AGENT_APPROVAL
	: "ask";
const beforeToolCall = createPermissionHook({ mode: approvalMode });

// bash 的外部沙箱开关：AGENT_SANDBOX=on 打开（默认关，仅 macOS 有效）。
bashConfig.sandbox = process.env.AGENT_SANDBOX === "on";

// —— 事件渲染 ——
const startedAt = new Map();
function onEvent(event) {
	switch (event.type) {
		case "tool_start":
			startedAt.set(event.id, Date.now());
			console.log(`  ⚙️  ${event.name} ${preview(event.args)}`);
			break;
		case "tool_update":
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

// —— compaction 设置 ——
const contextWindow = Number(process.env.CONTEXT_WINDOW) || 200_000;
const compactionSettings = {
	...DEFAULT_SETTINGS,
	// 小窗口时按比例缩小保留量，否则 8k 窗口保留 20k 就没法压了
	keepRecentTokens: Math.min(DEFAULT_SETTINGS.keepRecentTokens, Math.floor(contextWindow * 0.3)),
	reserveTokens: Math.min(DEFAULT_SETTINGS.reserveTokens, Math.floor(contextWindow * 0.15)),
};

// —— 主循环 ——
async function agentLoop(provider, messages) {
	// 溢出恢复只允许一次，防止无限循环
	let overflowRecoveryAttempted = false;

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

		// —— 新增：overflow 检测 ——
		if (isContextOverflow(message, contextWindow)) {
			if (overflowRecoveryAttempted) {
				console.error("\n\n[压缩后仍然溢出，请换一个 context window 更大的模型]");
				return;
			}
			console.log("\n\n📦 检测到 context overflow，正在压缩...");
			overflowRecoveryAttempted = true;

			const result = await compact(messages, compactionSettings, provider);
			if (!result) {
				console.error("[没有可压缩的内容，放弃]");
				return;
			}
			messages.length = 0;
			messages.push(...rebuildMessages(result));
			logCompaction(result.stats);

			// 不 push 失败的 assistant message，直接重试
			console.log("🔄 压缩完成，自动重试...\n");
			continue;
		}

		// push assistant message，带上 usage 信息供 token 估算使用
		const apiMsg = toApiMessage(message);
		messages.push(apiMsg);

		if (message.stopReason === "error" || message.stopReason === "aborted") {
			console.error(`\n\n[${message.stopReason === "aborted" ? "已中断" : "出错了"}] ${message.errorMessage ?? ""}`);
			return;
		}

		// 成功收到回复，重置溢出恢复标志
		overflowRecoveryAttempted = false;

		const toolCalls = message.content.filter((c) => c.type === "toolCall");
		if (toolCalls.length === 0) {
			console.log();

			// —— 新增：阈值触发的 compaction ——
			// 模型回复完毕、没有工具调用、轮到用户说话之前检查一次
			await checkAndCompact(messages, provider);
			return;
		}
		console.log();

		const batch =
			message.stopReason === "length"
				? { results: failTruncatedCalls(toolCalls), terminate: false }
				: await runToolCalls(toolCalls, tools, { beforeToolCall, onEvent }, controller.signal);

		for (const outcome of batch.results) {
			messages.push({
				role: "tool",
				tool_call_id: outcome.call.id,
				content: String(outcome.content ?? "").slice(0, 8000) || "(无输出)",
			});
		}

		if (batch.terminate) {
			console.log("\n[全部工具都要求终止，本轮结束]");
			await checkAndCompact(messages, provider);
			return;
		}

		// —— 新增：每轮工具执行完也检查一次 ——
		// 工具结果可能很长（比如读了一个大文件），可能直接把 context 推过阈值
		await checkAndCompact(messages, provider);
	}
}

/**
 * 检查是否需要 compaction，需要就执行。
 * 阈值触发后不重试（和 overflow 恢复不同），因为上一轮回复用户已经看到了。
 */
async function checkAndCompact(messages, provider) {
	const tokens = estimateContextTokens(messages);
	if (!shouldCompact(tokens, contextWindow, compactionSettings)) return;

	console.log(`\n📦 context ≈ ${tokens} tokens，接近窗口上限 ${contextWindow}，正在压缩...`);

	const result = await compact(messages, compactionSettings, provider);
	if (!result) {
		console.log("[没有可压缩的内容]");
		return;
	}

	messages.length = 0;
	messages.push(...rebuildMessages(result));
	logCompaction(result.stats);
}

function logCompaction(stats) {
	console.log(
		`  压缩了 ${stats.messagesCompacted} 条消息，保留 ${stats.messagesRetained} 条` +
			(stats.hadPreviousSummary ? "（增量更新）" : "（首次摘要）"),
	);
	if (stats.readFiles.length) console.log(`  📖 读过: ${stats.readFiles.join(", ")}`);
	if (stats.modifiedFiles.length) console.log(`  ✏️  改过: ${stats.modifiedFiles.join(", ")}`);
	const after = estimateContextTokens(messages);
	console.log(`  压缩后 context ≈ ${after} tokens\n`);
}

/** 内部消息格式 → OpenAI API 消息格式，保留 _usage 供 token 估算 */
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
	// _usage 是内部字段，不会被发给 API（API 忽略下划线开头的字段）
	// 但 estimateContextTokens 会用它来提高估算精度
	if (message.usage) {
		api._usage = { input: message.usage.input, output: message.usage.output };
	}
	return api;
}

// —— 全局消息数组，agentLoop 和 logCompaction 都要访问 ——
const messages = [
	{
		role: "system",
		content:
			"你是一个 coding agent，工作目录是用户当前目录。用工具完成任务。" +
			"互不依赖的操作请在同一条消息里一次性发出，它们会并行执行。完成后简短总结。",
	},
];

// —— 入口 ——
let provider;
try {
	provider = resolveProvider();
} catch (err) {
	console.error(err.message);
	process.exit(1);
}
console.log(`使用 ${provider.name} · ${provider.model}`);
if (contextWindow !== 200_000) {
	console.log(`Context window: ${contextWindow}（compaction 会更快触发）`);
}
console.log(
	`审批姿态: ${approvalMode}` +
		(approvalMode === "ask"
			? "（危险命令会先问你）"
			: approvalMode === "strict"
				? "（危险命令直接拒）"
				: "（不逐命令拦，交给外部沙箱或你自己负责）"),
);
if (bashConfig.sandbox) console.log("外部沙箱: 开（bash 命令走 sandbox-exec）");

// —— 工作区信任门：加载项目本地 AGENTS.md 之前先问信任 ——
const trust = await checkProjectTrust(process.cwd());
if (trust.load) {
	messages[0].content += `\n\n以下是项目说明（来自 ${trust.path}）\n${readFileSync(trust.path, "utf8")}`;
	console.log("已加载并信任项目 AGENTS.md");
}

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
