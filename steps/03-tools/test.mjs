#!/usr/bin/env node
// 离线自测，不打网络。改完代码跑一遍就知道契约有没有破。
// 用法：node test.mjs

import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { validateArguments } from "./validate.mjs";
import { withFileLock } from "./mutation-queue.mjs";
import { runToolCalls, failTruncatedCalls } from "./tool-runner.mjs";

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

const call = (name, args, id = name) => ({ id, name, args });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ——————————————————————————————————————————————
section("参数校验");

const readSchema = {
	type: "object",
	properties: { path: { type: "string" }, limit: { type: "integer" } },
	required: ["path"],
};

{
	const args = validateArguments("read", { path: "a.txt", limit: "10" }, readSchema);
	ok("字符串数字被转成 number", args.limit === 10);
}
{
	const args = validateArguments("read", { path: "a.txt" }, readSchema);
	ok("可选字段缺失不报错", args.path === "a.txt" && args.limit === undefined);
}
{
	let err;
	try {
		validateArguments("read", { limit: 3 }, readSchema);
	} catch (e) {
		err = e;
	}
	ok("缺必填字段报错", !!err && err.message.includes("path"));
	ok("报错里回显了原始参数", !!err && err.message.includes('"limit": 3'));
}
{
	let err;
	try {
		validateArguments("read", { path: 12.5, limit: 1.5 }, readSchema);
	} catch (e) {
		err = e;
	}
	// path 是 number 会被转成字符串，所以只剩 limit 一条错
	ok("整数字段拒绝小数", !!err && err.message.includes("期望整数"));
}
{
	let err;
	try {
		validateArguments("t", { a: 1, b: 2 }, {
			type: "object",
			properties: { a: { type: "string" }, b: { type: "boolean" } },
			required: ["a", "b", "c"],
		});
	} catch (e) {
		err = e;
	}
	// a:1 会被转成 "1" 通过，剩下 b 类型错 + c 缺失
	ok("一次收集多条错误", (err.message.match(/ {2}- /g) ?? []).length === 2, err?.message);
}
{
	const schema = {
		type: "object",
		properties: {
			edits: {
				type: "array",
				minItems: 1,
				items: { type: "object", properties: { oldText: { type: "string" } }, required: ["oldText"] },
			},
		},
		required: ["edits"],
	};
	const args = validateArguments("edit", { edits: '[{"oldText":"a"}]' }, schema);
	ok("数组被序列化成字符串也能还原", Array.isArray(args.edits) && args.edits[0].oldText === "a");

	let err;
	try {
		validateArguments("edit", { edits: [] }, schema);
	} catch (e) {
		err = e;
	}
	ok("minItems 生效", !!err && err.message.includes("至少需要 1 项"));
}
{
	let err;
	try {
		validateArguments("t", { mode: "x" }, { type: "object", properties: { mode: { type: "string", enum: ["a", "b"] } } });
	} catch (e) {
		err = e;
	}
	ok("enum 生效", !!err && err.message.includes("a / b"));
}

// ——————————————————————————————————————————————
section("按文件排队");

{
	const order = [];
	const run = (tag, ms) => async () => {
		order.push(`${tag}-start`);
		await sleep(ms);
		order.push(`${tag}-end`);
	};
	await Promise.all([withFileLock("/tmp/same.txt", run("A", 30)), withFileLock("/tmp/same.txt", run("B", 1))]);
	ok("同一文件串行", order.join(",") === "A-start,A-end,B-start,B-end", order.join(","));
}
{
	const order = [];
	const run = (tag, ms) => async () => {
		order.push(`${tag}-start`);
		await sleep(ms);
		order.push(`${tag}-end`);
	};
	await Promise.all([withFileLock("/tmp/f1.txt", run("A", 30)), withFileLock("/tmp/f2.txt", run("B", 1))]);
	ok("不同文件并行", order.join(",") === "A-start,B-start,B-end,A-end", order.join(","));
}
{
	// 真实场景：两次读改写打到同一个文件，没有锁就会丢一次修改
	const dir = mkdtempSync(join(tmpdir(), "step03-"));
	const file = join(dir, "counter.txt");
	writeFileSync(file, "0");
	const bump = () =>
		withFileLock(file, async () => {
			const n = Number(readFileSync(file, "utf8"));
			await sleep(5); // 模拟读和写之间的间隙
			writeFileSync(file, String(n + 1));
		});
	await Promise.all([bump(), bump(), bump()]);
	ok("并发读改写不丢更新", readFileSync(file, "utf8") === "3", readFileSync(file, "utf8"));
}
{
	let inner = false;
	await withFileLock("/tmp/throw.txt", async () => {
		throw new Error("boom");
	}).catch(() => {});
	await withFileLock("/tmp/throw.txt", async () => {
		inner = true;
	});
	ok("前一个抛异常不会卡死队列", inner);
}

// ——————————————————————————————————————————————
section("三段式流水线");

const echoTool = {
	description: "echo",
	parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
	execute: ({ text }) => `echo:${text}`,
};

{
	const { results } = await runToolCalls([call("nope", {})], { echo: echoTool });
	ok("未知工具直接给错误结果", results[0].isError && results[0].content.includes("未知工具"));
}
{
	const { results } = await runToolCalls([{ id: "1", name: "echo", args: null, argsError: "坏 JSON" }], { echo: echoTool });
	ok("参数不是合法 JSON 直接给错误结果", results[0].isError && results[0].content.includes("坏 JSON"));
}
{
	let executed = false;
	const tools = { echo: { ...echoTool, execute: () => (executed = true) } };
	const { results } = await runToolCalls([call("echo", { text: 42, wrong: 1 })], tools);
	// text:42 会被转成 "42"，所以这个用例应该通过
	ok("类型强转后放行", !results[0].isError && executed);
}
{
	let executed = false;
	const tools = { echo: { ...echoTool, execute: () => (executed = true) } };
	const { results } = await runToolCalls([call("echo", {})], tools);
	ok("校验失败不执行工具", results[0].isError && executed === false);
}
{
	const { results } = await runToolCalls([call("echo", { text: "hi" })], { echo: echoTool }, {
		beforeToolCall: () => ({ block: true, reason: "不许" }),
	});
	ok("beforeToolCall 能拦截", results[0].isError && results[0].content === "不许");
}
{
	const seen = [];
	await runToolCalls(
		[call("echo", { text: "a" }, "1"), call("echo", { text: "b" }, "2")],
		{ echo: echoTool },
		{ beforeToolCall: ({ call }) => void seen.push(call.id) },
	);
	ok("prepare 按模型给出的顺序串行", seen.join(",") === "1,2");
}
{
	const boom = { ...echoTool, execute: () => { throw new Error("磁盘满了"); } };
	const { results } = await runToolCalls([call("echo", { text: "x" })], { echo: boom });
	ok("工具抛异常转成 isError 结果", results[0].isError && results[0].content === "磁盘满了");
}
{
	const { results } = await runToolCalls([call("echo", { text: "x" })], { echo: echoTool }, {
		afterToolCall: () => ({ content: "被改写了" }),
	});
	ok("afterToolCall 能改写结果", results[0].content === "被改写了");
}
{
	const { results } = await runToolCalls([call("echo", { text: "x" })], { echo: echoTool }, {
		afterToolCall: () => { throw new Error("钩子炸了"); },
	});
	ok("afterToolCall 抛异常不影响主循环", results[0].isError && results[0].content === "钩子炸了");
}

// ——————————————————————————————————————————————
section("并行的三个顺序");

const slow = {
	description: "slow",
	parameters: { type: "object", properties: { ms: { type: "number" } }, required: ["ms"] },
	execute: async ({ ms }) => {
		await sleep(ms);
		return `done-${ms}`;
	},
};

{
	const finishOrder = [];
	const calls = [call("slow", { ms: 40 }, "A"), call("slow", { ms: 5 }, "B"), call("slow", { ms: 20 }, "C")];
	const t0 = Date.now();
	const { results } = await runToolCalls(calls, { slow }, {
		onEvent: (e) => e.type === "tool_end" && finishOrder.push(e.id),
	});
	const elapsed = Date.now() - t0;

	ok("完成顺序是快的先完成", finishOrder.join(",") === "B,C,A", finishOrder.join(","));
	ok("结果顺序仍然是模型给出的顺序", results.map((r) => r.call.id).join(",") === "A,B,C");
	ok("总耗时接近最慢的那个而不是三者之和", elapsed < 60, `${elapsed}ms`);
}
{
	// 一个 sequential 工具把整批拖成串行
	const seqTool = { ...slow, executionMode: "sequential" };
	const calls = [call("slow", { ms: 20 }, "A"), call("seq", { ms: 20 }, "B"), call("slow", { ms: 20 }, "C")];
	const t0 = Date.now();
	await runToolCalls(calls, { slow, seq: seqTool });
	ok("sequential 传染给整批", Date.now() - t0 >= 55, `${Date.now() - t0}ms`);
}

// ——————————————————————————————————————————————
section("事件时序与 onUpdate 生命周期");

{
	const streamTool = {
		description: "s",
		parameters: { type: "object", properties: {}, required: [] },
		execute: async (_args, { onUpdate }) => {
			onUpdate({ content: "1" });
			onUpdate({ content: "2" });
			await sleep(5);
			onUpdate({ content: "3" });
			return "final";
		},
	};
	const log = [];
	await runToolCalls([call("s", {})], { s: streamTool }, { onEvent: (e) => log.push(e.type) });
	ok("事件序列 start → update* → end", log.join(",") === "tool_start,tool_update,tool_update,tool_update,tool_end", log.join(","));
}
{
	// 工具留了个定时器在 execute 返回之后还调 onUpdate
	let leaked = 0;
	const leaky = {
		description: "l",
		parameters: { type: "object", properties: {}, required: [] },
		execute: async (_args, { onUpdate }) => {
			setTimeout(() => onUpdate({ content: "迟到的" }), 20);
			return "ok";
		},
	};
	await runToolCalls([call("l", {})], { l: leaky }, {
		onEvent: (e) => e.type === "tool_update" && leaked++,
	});
	await sleep(40);
	ok("execute 返回后的 onUpdate 被忽略", leaked === 0, `漏了 ${leaked} 条`);
}
{
	// onEvent 是异步的，tool_end 必须排在全部 update 之后
	const order = [];
	const streamTool = {
		description: "s",
		parameters: { type: "object", properties: {}, required: [] },
		execute: async (_args, { onUpdate }) => {
			onUpdate({ content: "x" });
			return "ok";
		},
	};
	await runToolCalls([call("s", {})], { s: streamTool }, {
		onEvent: async (e) => {
			if (e.type === "tool_update") await sleep(20);
			order.push(e.type);
		},
	});
	ok("异步 onEvent 下 end 仍排在 update 之后", order.join(",") === "tool_start,tool_update,tool_end", order.join(","));
}

// ——————————————————————————————————————————————
section("终止与截断");

const terminating = { ...echoTool, execute: () => ({ content: "完成", terminate: true }) };

{
	const { terminate } = await runToolCalls([call("done", { text: "a" }, "1")], { done: terminating });
	ok("全部要求终止则终止", terminate === true);
}
{
	const { terminate } = await runToolCalls(
		[call("done", { text: "a" }, "1"), call("echo", { text: "b" }, "2")],
		{ done: terminating, echo: echoTool },
	);
	ok("有一个普通工具就不终止（every 不是 some）", terminate === false);
}
{
	const { terminate } = await runToolCalls([], {});
	ok("空批次不终止", terminate === false);
}
{
	const results = failTruncatedCalls([call("echo", { text: "a" }, "1"), call("echo", { text: "b" }, "2")]);
	ok("截断时整批作废", results.length === 2 && results.every((r) => r.isError));
	ok("作废信息里带行动指令", results[0].content.includes("重新发起"));
}

// ——————————————————————————————————————————————
console.log(`\n${failed === 0 ? "✅" : "❌"} ${passed} 通过，${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);
