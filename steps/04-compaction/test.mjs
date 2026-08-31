#!/usr/bin/env node
// 离线自测，不打网络。覆盖 compaction 和 overflow 的纯函数逻辑。
// 用法：node test.mjs

import {
	estimateMessageTokens,
	estimateContextTokens,
	shouldCompact,
	findCutPoint,
	serializeConversation,
	extractFileOperations,
	formatFileOperations,
	parseFileOperations,
	rebuildMessages,
	DEFAULT_SETTINGS,
} from "./compaction.mjs";
import { isContextOverflow } from "./overflow.mjs";

let passed = 0;
let failed = 0;

function ok(name, cond, extra = "") {
	if (cond) {
		passed++;
		console.log(`  ✅ ${name}`);
	} else {
		failed++;
		console.log(`  ❌ ${name}${extra ? ` — ${extra}` : ""}`);
	}
}

function section(title) {
	console.log(`\n${title}`);
}

// ——————————————————————————————————————————————
section("token 估算");

{
	const tokens = estimateMessageTokens({ role: "user", content: "hello world" });
	ok("user message: 字符数 / 4", tokens === Math.ceil(11 / 4), `got ${tokens}`);
}
{
	const tokens = estimateMessageTokens({ role: "system", content: "你是助手" });
	ok("system message: 字符数 / 4", tokens === Math.ceil(4 / 4), `got ${tokens}`);
}
{
	const tokens = estimateMessageTokens({
		role: "assistant",
		content: "好的",
		tool_calls: [{ id: "c1", type: "function", function: { name: "read_file", arguments: '{"path":"a.txt"}' } }],
	});
	// "好的" = 2 chars, "read_file" = 9 chars, '{"path":"a.txt"}' = 16 chars → (2+9+16)/4 = 7
	ok("assistant + tool_calls 的 token 估算", tokens === Math.ceil(27 / 4), `got ${tokens}`);
}
{
	const tokens = estimateMessageTokens({ role: "tool", tool_call_id: "c1", content: "file content here" });
	ok("tool result: 字符数 / 4", tokens === Math.ceil(17 / 4), `got ${tokens}`);
}
{
	// content 是 null 或 undefined
	const t1 = estimateMessageTokens({ role: "assistant", content: null });
	const t2 = estimateMessageTokens({ role: "user", content: undefined });
	ok("content 为空不报错", t1 === 0 && t2 >= 0);
}

// ——————————————————————————————————————————————
section("context token 估算（混合模式）");

{
	const msgs = [
		{ role: "system", content: "你是助手" },
		{ role: "user", content: "a".repeat(100) },
		{ role: "assistant", content: "b".repeat(200), _usage: { input: 500, output: 100 } },
		{ role: "user", content: "c".repeat(80) },
	];
	const tokens = estimateContextTokens(msgs);
	// base = 500 + 100 = 600, trailing = ceil(80/4) = 20, total = 620
	ok("有 usage 时用 usage + trailing 估算", tokens === 620, `got ${tokens}`);
}
{
	const msgs = [
		{ role: "system", content: "sys" },
		{ role: "user", content: "a".repeat(40) },
		{ role: "assistant", content: "b".repeat(80) },
	];
	const tokens = estimateContextTokens(msgs);
	// 没有 _usage，全靠估算
	const expected = Math.ceil(3 / 4) + Math.ceil(40 / 4) + Math.ceil(80 / 4);
	ok("无 usage 时全部估算", tokens === expected, `got ${tokens}, expected ${expected}`);
}

// ——————————————————————————————————————————————
section("触发判断");

{
	ok("超过阈值触发", shouldCompact(190000, 200000, { enabled: true, reserveTokens: 16384 }));
	ok("未超过不触发", !shouldCompact(100000, 200000, { enabled: true, reserveTokens: 16384 }));
	ok("刚好在边界不触发", !shouldCompact(183616, 200000, { enabled: true, reserveTokens: 16384 }));
	ok("超过边界一点触发", shouldCompact(183617, 200000, { enabled: true, reserveTokens: 16384 }));
	ok("disabled 不触发", !shouldCompact(999999, 200000, { enabled: false, reserveTokens: 16384 }));
}

// ——————————————————————————————————————————————
section("切割点");

{
	// 构造消息：system + 10 条 user/assistant 交替
	const msgs = [{ role: "system", content: "sys" }];
	for (let i = 0; i < 10; i++) {
		msgs.push({ role: "user", content: "u".repeat(100) }); // 25 tokens each
		msgs.push({ role: "assistant", content: "a".repeat(100) }); // 25 tokens each
	}
	// 每对 user+assistant = 50 tokens，10 对 = 500 tokens
	// keepRecentTokens=100 → 保留最后 2 对（100 tokens）→ cutIndex 应该在倒数第 4 条
	const cut = findCutPoint(msgs, 100);
	ok("切割点保留了足够的最近消息", cut > 0 && cut < msgs.length, `cut=${cut}`);

	// 保留的消息 token 数应该 >= keepRecentTokens
	let kept = 0;
	for (let i = cut; i < msgs.length; i++) kept += estimateMessageTokens(msgs[i]);
	ok("保留的 token 数达到 keepRecentTokens", kept >= 100, `kept=${kept}`);
}
{
	// 切割点不能落在 tool result 上
	const msgs = [
		{ role: "system", content: "sys" },
		{ role: "user", content: "u".repeat(200) },
		{
			role: "assistant",
			content: null,
			tool_calls: [{ id: "c1", type: "function", function: { name: "bash", arguments: '{"command":"ls"}' } }],
		},
		{ role: "tool", tool_call_id: "c1", content: "result".repeat(100) }, // 很长的 tool result
		{ role: "user", content: "u2".repeat(10) },
		{ role: "assistant", content: "done" },
	];
	const cut = findCutPoint(msgs, 50);
	ok("切割点不在 tool result 上", msgs[cut]?.role !== "tool", `cut=${cut}, role=${msgs[cut]?.role}`);
}
{
	// 极端：只有 system + 一条 user
	const msgs = [
		{ role: "system", content: "sys" },
		{ role: "user", content: "hello" },
	];
	const cut = findCutPoint(msgs, 20000);
	ok("消息太少时 cutIndex=1（不压 system）", cut === 1, `cut=${cut}`);
}

// ——————————————————————————————————————————————
section("对话序列化");

{
	const msgs = [
		{ role: "system", content: "sys" }, // 应该被跳过
		{ role: "user", content: "读一下 a.txt" },
		{
			role: "assistant",
			content: null,
			tool_calls: [{ id: "c1", type: "function", function: { name: "read_file", arguments: '{"path":"a.txt"}' } }],
		},
		{ role: "tool", tool_call_id: "c1", content: "file content" },
		{ role: "assistant", content: "这个文件是..." },
	];
	const text = serializeConversation(msgs);
	ok("序列化跳过 system", !text.includes("sys"));
	ok("序列化包含 user", text.includes("[User]: 读一下 a.txt"));
	ok("序列化包含 tool call", text.includes("[Assistant tool calls]: read_file(path=a.txt)"));
	ok("序列化包含 tool result", text.includes("[Tool result]: file content"));
	ok("序列化包含 assistant", text.includes("[Assistant]: 这个文件是..."));
}
{
	// tool result 截断
	const msgs = [
		{ role: "tool", tool_call_id: "c1", content: "x".repeat(3000) },
	];
	const text = serializeConversation(msgs);
	ok("长 tool result 被截断", text.length < 3000 && text.includes("..."));
}

// ——————————————————————————————————————————————
section("文件操作提取");

{
	const msgs = [
		{
			role: "assistant",
			content: null,
			tool_calls: [
				{ id: "c1", type: "function", function: { name: "read_file", arguments: '{"path":"src/a.ts"}' } },
				{ id: "c2", type: "function", function: { name: "read_file", arguments: '{"path":"src/b.ts"}' } },
				{ id: "c3", type: "function", function: { name: "write_file", arguments: '{"path":"src/c.ts","content":"..."}' } },
				{ id: "c4", type: "function", function: { name: "edit_file", arguments: '{"path":"src/a.ts","edits":[]}' } },
			],
		},
	];
	const ops = extractFileOperations(msgs);
	ok("read-only 文件正确", ops.readFiles.length === 1 && ops.readFiles[0] === "src/b.ts", JSON.stringify(ops.readFiles));
	ok("modified 文件正确", ops.modifiedFiles.length === 2, JSON.stringify(ops.modifiedFiles));
	ok("被修改的文件从 readFiles 移除", !ops.readFiles.includes("src/a.ts"));
}
{
	// user 和 tool 消息不提取文件
	const msgs = [
		{ role: "user", content: "读 src/x.ts" },
		{ role: "tool", tool_call_id: "c1", content: "file content" },
	];
	const ops = extractFileOperations(msgs);
	ok("只从 assistant tool_calls 提取", ops.readFiles.length === 0 && ops.modifiedFiles.length === 0);
}

// ——————————————————————————————————————————————
section("文件操作格式化与解析");

{
	const formatted = formatFileOperations(["src/a.ts", "src/b.ts"], ["src/c.ts"]);
	ok("格式化包含 read-files 标签", formatted.includes("<read-files>") && formatted.includes("src/a.ts"));
	ok("格式化包含 modified-files 标签", formatted.includes("<modified-files>") && formatted.includes("src/c.ts"));

	// 解析回来
	const parsed = parseFileOperations(formatted);
	ok("解析还原 readFiles", parsed.readFiles.has("src/a.ts") && parsed.readFiles.has("src/b.ts"));
	ok("解析还原 modifiedFiles", parsed.modifiedFiles.has("src/c.ts"));
}
{
	// 空列表
	const formatted = formatFileOperations([], []);
	ok("空列表不输出标签", formatted === "");
}

// ——————————————————————————————————————————————
section("rebuildMessages");

{
	const result = {
		systemMessage: { role: "system", content: "sys" },
		summaryMessage: { role: "user", content: "<summary>...</summary>" },
		retainedMessages: [
			{ role: "user", content: "recent question" },
			{ role: "assistant", content: "recent answer" },
		],
	};
	const rebuilt = rebuildMessages(result);
	ok("重建后第一条是 system", rebuilt[0].role === "system");
	ok("重建后第二条是 summary", rebuilt[1].content.includes("<summary>"));
	ok("重建后保留了最近消息", rebuilt.length === 4 && rebuilt[3].content === "recent answer");
}

// ——————————————————————————————————————————————
section("overflow 检测");

{
	const msg = { stopReason: "error", errorMessage: "prompt is too long for this model" };
	ok("Anthropic overflow 格式", isContextOverflow(msg, 200000));
}
{
	const msg = { stopReason: "error", errorMessage: "maximum context length exceeded" };
	ok("OpenAI overflow 格式", isContextOverflow(msg, 128000));
}
{
	const msg = { stopReason: "error", errorMessage: "context_length_exceeded" };
	ok("OpenAI error code 格式", isContextOverflow(msg, 128000));
}
{
	const msg = { stopReason: "error", errorMessage: "exceeds the context window" };
	ok("generic overflow 格式", isContextOverflow(msg, 200000));
}
{
	// 静默溢出：input > contextWindow
	const msg = { stopReason: "stop", usage: { input: 210000, output: 50 } };
	ok("静默溢出检测", isContextOverflow(msg, 200000));
}
{
	// 截断溢出：output=0 + input >= 99% window
	const msg = { stopReason: "length", usage: { input: 198500, output: 0 } };
	ok("截断溢出检测", isContextOverflow(msg, 200000));
}
{
	// rate limit 不是 overflow
	const msg = { stopReason: "error", errorMessage: "Rate limit exceeded, please retry" };
	ok("rate limit 不误判为 overflow", !isContextOverflow(msg, 200000));
}
{
	// 正常错误不是 overflow
	const msg = { stopReason: "error", errorMessage: "Internal server error" };
	ok("普通错误不误判为 overflow", !isContextOverflow(msg, 200000));
}
{
	// 正常完成不是 overflow
	const msg = { stopReason: "stop", usage: { input: 5000, output: 200 } };
	ok("正常完成不误判为 overflow", !isContextOverflow(msg, 200000));
}
{
	// quota 限制不是 overflow
	const msg = { stopReason: "error", errorMessage: "You have exceeded your billing quota" };
	ok("billing/quota 不误判为 overflow", !isContextOverflow(msg, 200000));
}

// ——————————————————————————————————————————————
console.log(`\n${failed === 0 ? "✅" : "❌"} ${passed} 通过，${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);
