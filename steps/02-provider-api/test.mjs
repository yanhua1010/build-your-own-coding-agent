// 离线自测：不打网络，验证 EventStream 和 SSE 解析
const BASE = new URL(".", import.meta.url).pathname;
const { createMessageStream } = await import(`${BASE}event-stream.mjs`);

let pass = 0, fail = 0;
const ok = (name, cond) => {
	if (cond) { pass++; console.log(`  ok   ${name}`); }
	else { fail++; console.log(`  FAIL ${name}`); }
};

/** 造一个假的 fetch 响应，按 chunks 逐块吐 SSE；onEnd 可以在读完后抛异常模拟断流 */
function fakeSSE(chunks, onEnd) {
	return async () => ({
		ok: true,
		body: {
			getReader() {
				let i = 0;
				return {
					async read() {
						if (i < chunks.length) {
							return { done: false, value: new TextEncoder().encode(chunks[i++]) };
						}
						if (onEnd) onEnd();
						return { done: true };
					},
				};
			},
		},
	});
}

const FAKE_PROVIDER = { name: "fake", baseUrl: "http://x", apiKey: "k", model: "m" };
let v = 0;
const loadApi = () => import(`${BASE}api/openai-completions.mjs?v=${++v}`);

console.log("\n[1] EventStream: 生产快于消费（走 queue）");
{
	const s = createMessageStream();
	s.push({ type: "text_delta", text: "a" });
	s.push({ type: "text_delta", text: "b" });
	s.push({ type: "done", message: { stopReason: "stop", content: [] } });
	const got = [];
	for await (const e of s) got.push(e.type);
	ok("三个事件都收到", got.length === 3);
	ok("顺序正确", got[0] === "text_delta" && got[2] === "done");
	ok("result() 拿到最终消息", (await s.result()).stopReason === "stop");
}

console.log("\n[2] EventStream: 消费快于生产（走 waiting）");
{
	const s = createMessageStream();
	const got = [];
	const consumer = (async () => { for await (const e of s) got.push(e.type); })();
	await new Promise((r) => setTimeout(r, 10));
	ok("消费者阻塞在 waiting 上", s.waiting.length === 1 && s.queue.length === 0);
	s.push({ type: "text_delta", text: "x" });
	s.push({ type: "done", message: { stopReason: "stop" } });
	await consumer;
	ok("事件送达", got.length === 2);
}

console.log("\n[3] EventStream: error 也算完成，且携带最终结果");
{
	const s = createMessageStream();
	const errMsg = { stopReason: "error", errorMessage: "boom", content: [{ type: "text", text: "半句话" }] };
	s.push({ type: "text_delta", text: "半句话" });
	s.push({ type: "error", error: errMsg });
	const got = [];
	for await (const e of s) got.push(e.type);
	const r = await s.result();
	ok("error 事件结束了流", got[got.length - 1] === "error");
	ok("result() 返回 error 里的消息", r.stopReason === "error");
	ok("部分内容保留在结果里", r.content[0].text === "半句话");
}

console.log("\n[4] EventStream: end() 之后 push 被忽略");
{
	const s = createMessageStream();
	s.push({ type: "done", message: { stopReason: "stop" } });
	s.push({ type: "text_delta", text: "迟到的" });
	const got = [];
	for await (const e of s) got.push(e.type);
	ok("迟到的事件被丢弃", got.length === 1);
}

console.log("\n[5] SSE 解析：文本合并 + 工具调用分片拼接");
{
	globalThis.fetch = fakeSSE([
		`data: {"choices":[{"delta":{"content":"好的"}}]}\n\n`,
		`data: {"choices":[{"delta":{"content":"，我来读"}}]}\n\n`,
		`data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read_file","arguments":""}}]}}]}\n\n`,
		`data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"pa"}}]}}]}\n\n`,
		`data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"th\\":\\"a.txt\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n`,
		`data: {"usage":{"prompt_tokens":10,"completion_tokens":20},"choices":[]}\n\n`,
		`data: [DONE]\n\n`,
	]);
	const { stream } = await loadApi();
	const s = stream(FAKE_PROVIDER, [], [], undefined);
	const events = [];
	for await (const e of s) events.push(e);
	const msg = await s.result();

	ok("finish_reason tool_calls → toolUse", msg.stopReason === "toolUse");
	ok("文本被合并成一个块", msg.content[0].type === "text" && msg.content[0].text === "好的，我来读");
	const call = msg.content.find((c) => c.type === "toolCall");
	ok("工具名正确", call?.name === "read_file");
	ok("分片参数拼接并解析成功", call?.args?.path === "a.txt");
	ok("临时字段已清理", call && !("partialArgs" in call) && !("streamIndex" in call));
	ok("usage 收到", msg.usage.input === 10 && msg.usage.output === 20);
	ok("text_delta 逐个发出", events.filter((e) => e.type === "text_delta").length === 2);
}

console.log("\n[6] 错误契约：断流不 throw，部分内容保留");
{
	globalThis.fetch = fakeSSE(
		[`data: {"choices":[{"delta":{"content":"我正在读取"}}]}\n\n`],
		() => { throw new Error("socket hang up"); },
	);
	const { stream } = await loadApi();
	let threw = false;
	let s;
	try { s = stream(FAKE_PROVIDER, [], [], undefined); } catch { threw = true; }
	ok("stream() 本身没有 throw", !threw);

	const msg = await s.result();
	ok("stopReason 是 error", msg.stopReason === "error");
	ok("错误信息带上了原因", msg.errorMessage.includes("socket hang up"));
	ok("断流前收到的内容还在", msg.content[0]?.text === "我正在读取");
}

console.log("\n[7] 错误契约：HTTP 4xx 走同一条路");
{
	globalThis.fetch = async () => ({
		ok: false, status: 401, statusText: "Unauthorized",
		text: async () => '{"error":"invalid api key"}',
	});
	const { stream } = await loadApi();
	const msg = await stream({ ...FAKE_PROVIDER, apiKey: "bad" }, [], [], undefined).result();
	ok("stopReason 是 error", msg.stopReason === "error");
	ok("带上了 provider 原始报错", msg.errorMessage.includes("401") && msg.errorMessage.includes("invalid api key"));
}

console.log("\n[8] 错误契约：abort 落到 aborted");
{
	globalThis.fetch = async () => { throw new Error("The operation was aborted"); };
	const { stream } = await loadApi();
	const ctrl = new AbortController();
	ctrl.abort();
	const msg = await stream(FAKE_PROVIDER, [], [], ctrl.signal).result();
	ok("stopReason 是 aborted 而不是 error", msg.stopReason === "aborted");
}

console.log("\n[9] 截断防御：length + 残缺参数");
{
	globalThis.fetch = fakeSSE([
		`data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"write_file","arguments":"{\\"path\\":\\"a.txt\\",\\"content\\":\\"很长的内"}}]}}]}\n\n`,
		`data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\n`,
		`data: [DONE]\n\n`,
	]);
	const { stream } = await loadApi();
	const msg = await stream(FAKE_PROVIDER, [], [], undefined).result();
	const call = msg.content.find((c) => c.type === "toolCall");
	ok("stopReason 是 length", msg.stopReason === "length");
	ok("残缺 JSON 被标记为解析失败", call.args === null && !!call.argsError);
	ok("临时字段仍然被清理", !("partialArgs" in call));
}

console.log(`\n${"─".repeat(40)}\n通过 ${pass}，失败 ${fail}\n`);
process.exit(fail ? 1 : 0);
