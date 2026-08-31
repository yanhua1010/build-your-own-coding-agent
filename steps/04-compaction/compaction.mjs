// Context compaction：token 估算、切割点、摘要生成。
// 对应 pi 的 packages/agent/src/harness/compaction/compaction.ts（880 行）
//
// pi 的实现跨了 7 个文件两个包，这个文件把核心逻辑压进一个模块，
// 做四件事：
//   1. 估算对话占了多少 token
//   2. 判断要不要触发 compaction
//   3. 找切割点：旧消息变摘要，新消息保留原文
//   4. 调 LLM 生成结构化摘要

const CHARS_PER_TOKEN = 4;
const TOOL_RESULT_MAX_CHARS = 2000;

// ————————————————————————————————————————————————
// token 估算
// ————————————————————————————————————————————————

/**
 * 单条消息的 token 估算。字符数除以 4，不精确但够用。
 * 估低了无非晚触发一点，后面溢出检测能兜底。
 * 估高了反而触发太频繁，每次压缩多花一次 LLM 调用。
 */
export function estimateMessageTokens(msg) {
	if (msg.role === "system") {
		return Math.ceil((msg.content?.length ?? 0) / CHARS_PER_TOKEN);
	}

	if (msg.role === "tool") {
		return Math.ceil((msg.content?.length ?? 0) / CHARS_PER_TOKEN);
	}

	if (msg.role === "assistant") {
		let chars = msg.content?.length ?? 0;
		for (const tc of msg.tool_calls ?? []) {
			chars += tc.function?.name?.length ?? 0;
			chars += tc.function?.arguments?.length ?? 0;
		}
		return Math.ceil(chars / CHARS_PER_TOKEN);
	}

	// user
	const content = msg.content;
	if (typeof content === "string") return Math.ceil(content.length / CHARS_PER_TOKEN);
	return Math.ceil(JSON.stringify(content ?? "").length / CHARS_PER_TOKEN);
}

/**
 * 整段 context 的 token 估算。优先用 provider 返回的真实 usage，
 * 只对 usage 之后新增的消息做粗估。
 *
 * pi 在 packages/ai/src/utils/estimate.ts 做了同样的事，
 * 还额外考虑了 timestamp 防止 compaction 插入导致 usage 过时。
 * 教学版省掉那层检查，核心思路一样。
 */
export function estimateContextTokens(messages) {
	let baseTokens = 0;
	let startIndex = 0;

	// 从后往前找最近一条有 _usage 的 assistant message
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant" && msg._usage) {
			// usage.input 是 provider 报的整个 prefix 的 token 数
			// usage.output 是这条 assistant 自己输出的 token 数
			baseTokens = msg._usage.input + msg._usage.output;
			startIndex = i + 1;
			break;
		}
	}

	// 从 usage 之后开始估算新增消息
	let trailingTokens = 0;
	for (let i = startIndex; i < messages.length; i++) {
		trailingTokens += estimateMessageTokens(messages[i]);
	}

	// 没有任何 usage 时全靠估算，baseTokens 是 0
	return baseTokens + trailingTokens;
}

// ————————————————————————————————————————————————
// 触发判断
// ————————————————————————————————————————————————

/**
 * 就这一行。200k 窗口默认 reserveTokens=16384，
 * 也就是 context 超过约 183k 时触发。
 */
export function shouldCompact(contextTokens, contextWindow, settings) {
	if (!settings.enabled) return false;
	return contextTokens > contextWindow - settings.reserveTokens;
}

// ————————————————————————————————————————————————
// 切割点
// ————————————————————————————————————————————————

/**
 * 从后往前扫消息列表，累加 token 数，到 keepRecentTokens 就停。
 * 返回切割点的下标：这个下标之前的消息进摘要，之后的保留原文。
 *
 * 切割要落在合法边界上。toolResult 不能做切割点，
 * 因为它必须紧跟 assistant 的 tool_calls，拆开会让模型
 * 看到一个没有结果的工具调用。
 *
 * 对应 pi 的 findCutPoint（compaction.ts:246）。
 */
export function findCutPoint(messages, keepRecentTokens = 20000) {
	let accum = 0;
	let rawCut = messages.length;

	// 从末尾往前走
	for (let i = messages.length - 1; i >= 0; i--) {
		accum += estimateMessageTokens(messages[i]);
		if (accum >= keepRecentTokens) {
			rawCut = i;
			break;
		}
	}

	// 走完了整个列表都没到 keepRecentTokens，说明全部消息都够短，不需要压缩
	if (rawCut === messages.length) return 1;

	// 跳过 system message（下标 0），至少保留一轮对话进摘要
	if (rawCut <= 1) return 1;

	// 往前调整到合法边界：不能切在 tool result 上
	// 原因：tool result 必须跟在对应的 assistant tool_calls 后面
	let cut = rawCut;
	while (cut > 1 && messages[cut]?.role === "tool") {
		cut--;
	}

	// 极端情况：一直往前退到了 system message 后面一条
	if (cut <= 1) return 1;

	return cut;
}

// ————————————————————————————————————————————————
// 对话序列化
// ————————————————————————————————————————————————

/**
 * 把消息数组转成纯文本，喂给摘要模型。
 * 对应 pi 的 serializeConversation（utils.ts:28）。
 */
export function serializeConversation(messages) {
	const lines = [];

	for (const msg of messages) {
		if (msg.role === "system") continue; // system prompt 不进摘要

		if (msg.role === "user") {
			const text = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
			lines.push(`[User]: ${text}`);
		}

		if (msg.role === "assistant") {
			if (msg.content) lines.push(`[Assistant]: ${msg.content}`);
			for (const tc of msg.tool_calls ?? []) {
				const args = tc.function?.arguments ?? "{}";
				const brief = briefArgs(args);
				lines.push(`[Assistant tool calls]: ${tc.function?.name}(${brief})`);
			}
		}

		if (msg.role === "tool") {
			const text = msg.content ?? "";
			const truncated = text.length > TOOL_RESULT_MAX_CHARS ? text.slice(0, TOOL_RESULT_MAX_CHARS) + "..." : text;
			lines.push(`[Tool result]: ${truncated}`);
		}
	}

	return lines.join("\n");
}

/**
 * 把 JSON 参数字符串缩写成 key=value 的形式，方便阅读。
 * 太长的值截断。
 */
function briefArgs(argsJson) {
	try {
		const obj = typeof argsJson === "string" ? JSON.parse(argsJson) : argsJson;
		return Object.entries(obj)
			.map(([k, v]) => {
				const s = typeof v === "string" ? v : JSON.stringify(v);
				return `${k}=${s.length > 60 ? s.slice(0, 60) + "..." : s}`;
			})
			.join(", ");
	} catch {
		return argsJson;
	}
}

// ————————————————————————————————————————————————
// 文件操作追踪
// ————————————————————————————————————————————————

/**
 * 从消息列表中提取所有文件操作的路径。
 * 信息来源是 assistant 的 tool_calls 参数，不靠模型记忆。
 *
 * 对应 pi 的 extractFileOperations + computeFileLists（utils.ts:55-97）。
 */
export function extractFileOperations(messages) {
	const readFiles = new Set();
	const modifiedFiles = new Set();

	for (const msg of messages) {
		if (msg.role !== "assistant" || !msg.tool_calls) continue;

		for (const tc of msg.tool_calls) {
			const name = tc.function?.name;
			let args;
			try {
				args = typeof tc.function?.arguments === "string" ? JSON.parse(tc.function.arguments) : tc.function?.arguments;
			} catch {
				continue;
			}
			if (!args?.path) continue;

			if (name === "read_file") readFiles.add(args.path);
			if (name === "write_file" || name === "edit_file") modifiedFiles.add(args.path);
		}
	}

	// 被修改的文件从 readFiles 里移除，只保留"只读过没改过"的
	for (const f of modifiedFiles) readFiles.delete(f);

	return {
		readFiles: [...readFiles].sort(),
		modifiedFiles: [...modifiedFiles].sort(),
	};
}

/**
 * 把文件列表格式化成 XML 标签附加到摘要末尾。
 * 下次 compaction 时继承旧列表再累加新的。
 */
export function formatFileOperations(readFiles, modifiedFiles) {
	const parts = [];
	if (readFiles.length > 0) parts.push(`<read-files>\n${readFiles.join("\n")}\n</read-files>`);
	if (modifiedFiles.length > 0) parts.push(`<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>`);
	return parts.join("\n\n");
}

/**
 * 从已有的 compaction summary 中解析出旧的文件列表。
 */
export function parseFileOperations(summaryText) {
	const readFiles = new Set();
	const modifiedFiles = new Set();

	const readMatch = summaryText.match(/<read-files>\n?([\s\S]*?)\n?<\/read-files>/);
	if (readMatch) readMatch[1].split("\n").filter(Boolean).forEach((f) => readFiles.add(f.trim()));

	const modMatch = summaryText.match(/<modified-files>\n?([\s\S]*?)\n?<\/modified-files>/);
	if (modMatch) modMatch[1].split("\n").filter(Boolean).forEach((f) => modifiedFiles.add(f.trim()));

	return { readFiles, modifiedFiles };
}

// ————————————————————————————————————————————————
// 摘要生成
// ————————————————————————————————————————————————

const SUMMARY_SYSTEM_PROMPT = [
	"You are a context summarization assistant.",
	"Your task is to read a conversation between a user and an AI coding assistant,",
	"then produce a structured summary following the exact format specified.",
	"Do NOT continue the conversation. Do NOT respond to any questions in the conversation.",
	"ONLY output the structured summary.",
].join(" ");

const SUMMARIZATION_PROMPT = `Summarize the following conversation into this exact structure:

## Goal
State the user's main objective in one sentence.

## Constraints & Preferences
List any constraints, preferences, or requirements the user has stated.

## Progress
### Done
- [x] Completed items
### In Progress
- [ ] Items currently being worked on
### Blocked
- [ ] Items that are stuck and why

## Key Decisions
List important decisions that were made and their rationale.

## Next Steps
What should happen next to continue the work.

## Critical Context
Any other context that would be lost if the conversation were deleted.

<conversation>
{conversation}
</conversation>`;

const UPDATE_PROMPT = `Here is a previous summary of an earlier part of this conversation:

<previous-summary>
{previousSummary}
</previous-summary>

Now update this summary with the new conversation below. Follow these rules:
- PRESERVE information from the previous summary that is still relevant
- ADD new progress, decisions, and context from the new conversation
- UPDATE the Progress section (move completed items from In Progress to Done)
- REMOVE information that is no longer relevant

Keep the same structure (Goal, Constraints, Progress, Key Decisions, Next Steps, Critical Context).

<conversation>
{conversation}
</conversation>`;

/**
 * 调 LLM 生成摘要。这是一个独立的非流式请求，和主对话分开。
 * pi 用 cacheRetention:"none" + 全新 sessionId 做请求隔离。
 * 教学版只用非流式请求，效果一样。
 */
export async function generateSummary(serialized, previousSummary, provider) {
	const userPrompt = previousSummary
		? UPDATE_PROMPT.replace("{previousSummary}", previousSummary).replace("{conversation}", serialized)
		: SUMMARIZATION_PROMPT.replace("{conversation}", serialized);

	const res = await fetch(`${provider.baseUrl}/chat/completions`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			authorization: `Bearer ${provider.apiKey}`,
		},
		body: JSON.stringify({
			model: provider.model,
			messages: [
				{ role: "system", content: SUMMARY_SYSTEM_PROMPT },
				{ role: "user", content: userPrompt },
			],
			stream: false,
			// 0.8 * reserveTokens，给摘要留够空间但不要太长
			max_tokens: 13107,
		}),
	});

	if (!res.ok) {
		const body = await res.text();
		throw new Error(`摘要 LLM 调用失败: HTTP ${res.status}\n${body}`);
	}

	const data = await res.json();
	return data.choices?.[0]?.message?.content ?? "";
}

// ————————————————————————————————————————————————
// 主入口
// ————————————————————————————————————————————————

/**
 * 执行一次 compaction。
 *
 * @param messages     当前对话消息数组（含 system message）
 * @param settings     { reserveTokens, keepRecentTokens, enabled }
 * @param provider     provider 配置（用于调 LLM）
 * @returns { summaryMessage, retainedMessages, stats }
 */
export async function compact(messages, settings, provider) {
	const cutIndex = findCutPoint(messages, settings.keepRecentTokens);
	const systemMessage = messages[0]; // system prompt 总在第一条

	// 切割点在第 1 条或者没有可压缩的内容
	if (cutIndex <= 1) return null;

	const messagesToSummarize = messages.slice(1, cutIndex); // 跳过 system
	const retainedMessages = messages.slice(cutIndex);

	// 序列化要压缩的消息
	const serialized = serializeConversation(messagesToSummarize);

	// 提取文件操作
	const newFileOps = extractFileOperations(messagesToSummarize);

	// 检查是否有旧的 compaction summary，继承旧的文件列表
	let previousSummary = null;
	const firstRetained = messagesToSummarize[0];
	if (firstRetained?.role === "user" && firstRetained?.content?.includes("<summary>")) {
		// 旧 summary 在被压缩的范围里，提取出来做增量更新
		const match = firstRetained.content.match(/<summary>\n?([\s\S]*?)\n?<\/summary>/);
		if (match) previousSummary = match[1];
	}

	// 合并文件列表（旧 + 新）
	const mergedReadFiles = new Set(newFileOps.readFiles);
	const mergedModifiedFiles = new Set(newFileOps.modifiedFiles);
	if (previousSummary) {
		const oldOps = parseFileOperations(previousSummary);
		for (const f of oldOps.readFiles) mergedReadFiles.add(f);
		for (const f of oldOps.modifiedFiles) mergedModifiedFiles.add(f);
	}
	// 被修改过的不重复列在 read 里
	for (const f of mergedModifiedFiles) mergedReadFiles.delete(f);

	// 调 LLM 生成摘要
	const summaryText = await generateSummary(serialized, previousSummary, provider);

	// 拼装文件操作标签
	const fileOpsText = formatFileOperations([...mergedReadFiles].sort(), [...mergedModifiedFiles].sort());
	const fullSummary = fileOpsText ? `${summaryText}\n\n${fileOpsText}` : summaryText;

	// 组装 compaction 消息
	const summaryMessage = {
		role: "user",
		content:
			"The conversation history before this point was compacted into the following summary:\n\n" +
			`<summary>\n${fullSummary}\n</summary>`,
	};

	return {
		summaryMessage,
		retainedMessages,
		systemMessage,
		stats: {
			messagesCompacted: messagesToSummarize.length,
			messagesRetained: retainedMessages.length,
			cutIndex,
			hadPreviousSummary: !!previousSummary,
			readFiles: [...mergedReadFiles].sort(),
			modifiedFiles: [...mergedModifiedFiles].sort(),
		},
	};
}

/**
 * 用 compaction 结果重建消息数组。
 */
export function rebuildMessages(compactionResult) {
	return [compactionResult.systemMessage, compactionResult.summaryMessage, ...compactionResult.retainedMessages];
}

// 默认设置
export const DEFAULT_SETTINGS = {
	enabled: true,
	reserveTokens: 16384,
	keepRecentTokens: 20000,
};
