#!/usr/bin/env node
// 离线演示 compaction 过程，不需要 API key。
// 用法：node demo-compaction.mjs
//
// 构造一段长对话历史，展示三件事：
// 1. token 估算和切割点在哪
// 2. 序列化后旧消息长什么样
// 3. 压缩后 context 的结构

import {
	estimateMessageTokens,
	estimateContextTokens,
	shouldCompact,
	findCutPoint,
	serializeConversation,
	extractFileOperations,
	formatFileOperations,
} from "./compaction.mjs";

// ——————————————————————————————————————————————
// 构造一段 agent 工作的对话历史
// ——————————————————————————————————————————————

const messages = [
	{
		role: "system",
		content: "你是一个 coding agent，工作目录是用户当前目录。",
	},

	// 第 1 轮：用户提需求
	{ role: "user", content: "帮我重构 src/auth.ts，现在的登录逻辑太乱了，把 session 管理拆出来" },
	{
		role: "assistant",
		content: "好的，先看一下现有代码。",
		tool_calls: [
			{ id: "c1", type: "function", function: { name: "read_file", arguments: '{"path":"src/auth.ts"}' } },
		],
	},
	{
		role: "tool",
		tool_call_id: "c1",
		content:
			'import express from "express";\n' +
			"// 200 行混在一起的登录逻辑...\n" +
			"export function login(req, res) {\n" +
			"  const user = db.findUser(req.body.email);\n" +
			"  if (!user) return res.status(401).json({ error: 'not found' });\n" +
			"  const valid = bcrypt.compare(req.body.password, user.hash);\n" +
			"  if (!valid) return res.status(401).json({ error: 'wrong password' });\n" +
			"  req.session.userId = user.id;\n" +
			"  req.session.role = user.role;\n" +
			"  // ... session 过期检查、刷新、注销全在这个文件里 ...\n" +
			"}\n" +
			"export function logout(req, res) { req.session.destroy(); }\n" +
			"export function checkSession(req, res, next) { /* 60 行 */ }\n" +
			"export function refreshToken(req, res) { /* 40 行 */ }\n",
	},
	{
		role: "assistant",
		content:
			"看完了。这个文件把认证、session 管理和中间件全混在一起。我的计划：\n" +
			"1. 新建 src/session.ts，把 checkSession / refreshToken / logout 搬过去\n" +
			"2. auth.ts 只保留 login，session 相关的改为 import\n" +
			"3. 跑一下现有测试确保没改坏\n\n" +
			"先读一下测试文件看覆盖了什么。",
		tool_calls: [
			{ id: "c2", type: "function", function: { name: "read_file", arguments: '{"path":"test/auth.test.ts"}' } },
			{ id: "c3", type: "function", function: { name: "read_file", arguments: '{"path":"src/routes.ts"}' } },
		],
	},
	{
		role: "tool",
		tool_call_id: "c2",
		content:
			'describe("auth", () => {\n' +
			'  it("login success", async () => { /* ... */ });\n' +
			'  it("login wrong password", async () => { /* ... */ });\n' +
			'  it("session expiry", async () => { /* ... */ });\n' +
			"});\n// 共 45 行，覆盖登录和 session 过期",
	},
	{
		role: "tool",
		tool_call_id: "c3",
		content:
			'import { login, checkSession } from "./auth";\n' +
			"router.post('/login', login);\n" +
			"router.use(checkSession);\n" +
			"// routes.ts 依赖 auth.ts 的导出",
	},

	// 第 2 轮：执行重构
	{
		role: "assistant",
		content: "测试覆盖了登录和 session 过期，routes.ts 用了 login 和 checkSession。开始拆分。",
		tool_calls: [
			{
				id: "c4",
				type: "function",
				function: {
					name: "write_file",
					arguments: JSON.stringify({
						path: "src/session.ts",
						content:
							"// Session 管理模块\n" +
							"export function checkSession(req, res, next) {\n" +
							"  if (!req.session?.userId) return res.status(401).end();\n" +
							"  if (isExpired(req.session)) return refreshOrReject(req, res);\n" +
							"  next();\n" +
							"}\n" +
							"export function refreshToken(req, res) { /* ... */ }\n" +
							"export function logout(req, res) { req.session.destroy(); res.json({ ok: true }); }\n" +
							"function isExpired(session) { return Date.now() > session.expiresAt; }\n" +
							"function refreshOrReject(req, res) { /* ... */ }\n",
					}),
				},
			},
			{
				id: "c5",
				type: "function",
				function: {
					name: "edit_file",
					arguments: JSON.stringify({
						path: "src/auth.ts",
						edits: [
							{
								oldText: "export function checkSession",
								newText: "// Moved to src/session.ts\n// export function checkSession",
							},
						],
					}),
				},
			},
			{
				id: "c6",
				type: "function",
				function: {
					name: "edit_file",
					arguments: JSON.stringify({
						path: "src/routes.ts",
						edits: [
							{
								oldText: 'import { login, checkSession } from "./auth"',
								newText:
									'import { login } from "./auth";\nimport { checkSession } from "./session"',
							},
						],
					}),
				},
			},
		],
	},
	{ role: "tool", tool_call_id: "c4", content: "已写入 src/session.ts（312 字符）" },
	{ role: "tool", tool_call_id: "c5", content: "已完成 1 处替换：src/auth.ts" },
	{ role: "tool", tool_call_id: "c6", content: "已完成 1 处替换：src/routes.ts" },

	// 第 3 轮：跑测试
	{
		role: "assistant",
		content: "拆分完成，跑一下测试。",
		tool_calls: [
			{ id: "c7", type: "function", function: { name: "bash", arguments: '{"command":"npm test"}' } },
		],
	},
	{
		role: "tool",
		tool_call_id: "c7",
		content:
			"PASS test/auth.test.ts\n" +
			"  auth\n" +
			"    ✓ login success (12ms)\n" +
			"    ✓ login wrong password (8ms)\n" +
			"    ✓ session expiry (15ms)\n\n" +
			"Test Suites: 1 passed, 1 total\n" +
			"Tests:       3 passed, 3 total",
	},
	{
		role: "assistant",
		content:
			"3 个测试全部通过。重构完成：\n" +
			"- src/session.ts: 新建，包含 checkSession / refreshToken / logout\n" +
			"- src/auth.ts: 只保留 login，session 相关代码移除\n" +
			"- src/routes.ts: import 路径更新\n" +
			"- 测试全部通过",
	},

	// 第 4 轮：用户提新需求
	{ role: "user", content: "再加一个 OAuth 登录，支持 GitHub 和 Google" },
	{
		role: "assistant",
		content: "需要安装 passport 和对应策略包。",
		tool_calls: [
			{
				id: "c8",
				type: "function",
				function: { name: "bash", arguments: '{"command":"npm install passport passport-github2 passport-google-oauth20"}' },
			},
		],
	},
	{
		role: "tool",
		tool_call_id: "c8",
		content: "added 47 packages in 3.2s\n\n+ passport@0.7.0\n+ passport-github2@0.1.12\n+ passport-google-oauth20@2.0.0",
	},
	{
		role: "assistant",
		content: "依赖装好了。接下来创建 OAuth 配置和路由...",
		tool_calls: [
			{
				id: "c9",
				type: "function",
				function: {
					name: "write_file",
					arguments: JSON.stringify({
						path: "src/oauth.ts",
						content: "import passport from 'passport';\nimport { Strategy as GitHubStrategy } from 'passport-github2';\n// ... OAuth 配置 ...\n",
					}),
				},
			},
		],
	},
	{ role: "tool", tool_call_id: "c9", content: "已写入 src/oauth.ts（145 字符）" },
	{
		role: "assistant",
		content: "OAuth 模块初始结构创建完成。还需要配置回调 URL 和环境变量...",
	},
];

// ——————————————————————————————————————————————
// 演示开始
// ——————————————————————————————————————————————

console.log("=== Context Compaction 演示 ===\n");

// 1. token 估算
console.log("📊 各消息的 token 估算：\n");
let total = 0;
for (let i = 0; i < messages.length; i++) {
	const msg = messages[i];
	const tokens = estimateMessageTokens(msg);
	total += tokens;
	const label =
		msg.role === "system"
			? "system"
			: msg.role === "user"
				? `user: ${msg.content.slice(0, 40)}${msg.content.length > 40 ? "..." : ""}`
				: msg.role === "assistant"
					? `assistant${msg.tool_calls ? ` (${msg.tool_calls.length} tool calls)` : ""}`
					: `tool_result (${msg.tool_call_id})`;
	console.log(`  [${String(i).padStart(2)}] ${String(tokens).padStart(5)} tokens  ${label}`);
}

const contextTokens = estimateContextTokens(messages);
console.log(`\n  纯估算合计: ${total} tokens`);
console.log(`  混合估算: ${contextTokens} tokens（没有 _usage 时和纯估算一样）`);

// 2. 触发判断
// 800 token 的窗口，让这段对话（约 799 tokens）刚好触发 compaction
const SMALL_WINDOW = 800;
const smallSettings = {
	enabled: true,
	reserveTokens: Math.floor(SMALL_WINDOW * 0.15),
	keepRecentTokens: Math.floor(SMALL_WINDOW * 0.3),
};

console.log(`\n\n📏 触发判断（窗口 = ${SMALL_WINDOW}）：\n`);
console.log(`  reserveTokens = ${smallSettings.reserveTokens}`);
console.log(`  阈值 = ${SMALL_WINDOW} - ${smallSettings.reserveTokens} = ${SMALL_WINDOW - smallSettings.reserveTokens}`);
console.log(`  当前 context ≈ ${contextTokens} tokens`);
console.log(`  shouldCompact = ${shouldCompact(contextTokens, SMALL_WINDOW, smallSettings)}`);

// 3. 切割点
const cutIndex = findCutPoint(messages, smallSettings.keepRecentTokens);
console.log(`\n\n✂️  切割点：第 ${cutIndex} 条消息\n`);

const toSummarize = messages.slice(1, cutIndex); // 跳过 system
const retained = messages.slice(cutIndex);

console.log(`  进入摘要: ${toSummarize.length} 条（下标 1 到 ${cutIndex - 1}）`);
console.log(`  保留原文: ${retained.length} 条（下标 ${cutIndex} 到 ${messages.length - 1}）`);

let retainedTokens = 0;
for (const msg of retained) retainedTokens += estimateMessageTokens(msg);
console.log(`  保留部分 ≈ ${retainedTokens} tokens`);

// 4. 序列化
const serialized = serializeConversation(toSummarize);
console.log("\n\n📝 序列化后的旧消息（喂给摘要模型）：\n");
console.log("  " + serialized.split("\n").join("\n  "));

// 5. 文件操作提取
const fileOps = extractFileOperations(toSummarize);
console.log("\n\n📂 文件操作（从 tool_calls 参数提取，不靠模型记忆）：\n");
console.log(`  只读过: ${fileOps.readFiles.join(", ") || "（无）"}`);
console.log(`  改过:   ${fileOps.modifiedFiles.join(", ") || "（无）"}`);

// 6. 模拟压缩后的 context
const fakeSummary =
	"## Goal\n" +
	"重构 auth 模块，把 session 管理拆到独立文件，之后加上 OAuth 登录（GitHub + Google）\n\n" +
	"## Progress\n" +
	"### Done\n" +
	"- [x] session 管理拆分完成（src/session.ts），测试通过\n" +
	"- [x] routes.ts import 路径更新\n" +
	"### In Progress\n" +
	"- [ ] OAuth 集成（passport 已安装，oauth.ts 初始结构已创建）\n\n" +
	"## Key Decisions\n" +
	"- checkSession / refreshToken / logout 放 session.ts，auth.ts 只留 login\n" +
	"- 使用 passport + passport-github2 + passport-google-oauth20\n\n" +
	"## Next Steps\n" +
	"- 配置 OAuth 回调 URL 和环境变量\n" +
	"- 实现 GitHub 和 Google 策略的完整流程";

const fileOpsText = formatFileOperations(fileOps.readFiles, fileOps.modifiedFiles);
const fullSummary = `${fakeSummary}\n\n${fileOpsText}`;

console.log("\n\n📦 压缩后的 context 结构：\n");
console.log("  [0] system: 你是一个 coding agent...");
console.log(`  [1] user (compaction summary):`);
for (const line of fullSummary.split("\n")) {
	console.log(`       ${line}`);
}
for (let i = 0; i < retained.length; i++) {
	const msg = retained[i];
	const brief =
		msg.role === "user"
			? `user: ${msg.content.slice(0, 50)}`
			: msg.role === "assistant"
				? `assistant${msg.tool_calls ? ` (${msg.tool_calls.length} tool calls)` : ""}: ${(msg.content ?? "").slice(0, 50)}`
				: `tool_result (${msg.tool_call_id}): ${(msg.content ?? "").slice(0, 50)}`;
	console.log(`  [${i + 2}] ${brief}${brief.length > 50 ? "..." : ""}`);
}

const summaryTokens = estimateMessageTokens({ role: "user", content: fullSummary });
console.log(`\n  摘要 ≈ ${summaryTokens} tokens + 保留 ${retainedTokens} tokens = ${summaryTokens + retainedTokens} tokens`);
console.log(`  压缩前 ${contextTokens} tokens → 压缩后 ${summaryTokens + retainedTokens} tokens`);
console.log(`  释放了 ${contextTokens - summaryTokens - retainedTokens} tokens 的空间`);

console.log("\n\n—————————————————————————————————————————");
console.log("以上全部离线完成，不需要 API key。");
console.log("跑 agent.mjs 加上 CONTEXT_WINDOW=8192 可以在真实对话中触发 compaction。");
