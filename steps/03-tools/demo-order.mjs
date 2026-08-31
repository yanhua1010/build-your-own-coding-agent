#!/usr/bin/env node
// 并行执行的三个顺序，不需要 API key。
// 用法：node demo-order.mjs
//
// 模拟模型一次发出三个 bash 调用，耗时分别是 3s / 1s / 2s。
// 看两件事：终端上谁先完成，以及最后喂回模型的数组是什么顺序。

import { runToolCalls } from "./tool-runner.mjs";

const sleepTool = {
	description: "假装干活",
	parameters: { type: "object", properties: { seconds: { type: "number" } }, required: ["seconds"] },
	execute: async ({ seconds }) => {
		await new Promise((r) => setTimeout(r, seconds * 1000));
		return `睡了 ${seconds} 秒`;
	},
};

// 模型给出的顺序：慢的在前
const toolCalls = [
	{ id: "call_1", name: "sleep", args: { seconds: 3 } },
	{ id: "call_2", name: "sleep", args: { seconds: 1 } },
	{ id: "call_3", name: "sleep", args: { seconds: 2 } },
];

console.log("模型给出的调用顺序：", toolCalls.map((c) => `${c.id}(${c.args.seconds}s)`).join("  "));
console.log("\n实时事件（完成顺序）：");

const t0 = Date.now();
const stamp = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`;

const { results } = await runToolCalls(toolCalls, { sleep: sleepTool }, {
	onEvent: (e) => {
		if (e.type === "tool_start") console.log(`  ${stamp()}  开始  ${e.id}`);
		if (e.type === "tool_end") console.log(`  ${stamp()}  完成  ${e.id}  ← 谁快谁先`);
	},
});

console.log("\n喂回模型的 toolResult 顺序：");
for (const r of results) console.log(`  ${r.call.id}  ${r.content}`);

console.log(`\n总耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s（串行的话是 6s）`);
console.log("完成顺序 2-3-1，消息顺序还是 1-2-3。执行是并发的，历史是确定的。");
