// openai-completions 协议的流式实现。
// 对应 pi 的 packages/ai/src/api/openai-completions.ts（1504 行，这里是教学简化版）
//
// 这个文件是整个 step 02 的核心。它只做一件事：
// 把一次 HTTP 流式请求，变成一个「永远不会 throw」的事件流。

import { createMessageStream } from "../event-stream.mjs";

/** provider 返回的 finish_reason → 我们统一的 stopReason */
const STOP_REASON = {
	stop: "stop",
	length: "length", // 输出被 token 上限截断
	tool_calls: "toolUse",
	function_call: "toolUse",
	content_filter: "error",
};

/**
 * 关键点全在函数签名上：返回的是 EventStream，不是 Promise。
 * 调用方无处 await，也就无处 try/catch。契约由签名本身保证。
 */
export function stream(provider, messages, tools, signal) {
	const out = createMessageStream();

	// 注意这个 async 立即执行函数没有被 await，异常冒泡不出这个函数
	(async () => {
		// output 在 try 之前构造。出错时已经收到的内容都还在里面，不会丢。
		const output = {
			role: "assistant",
			content: [],
			provider: provider.id ?? provider.name,
			model: provider.model,
			usage: { input: 0, output: 0 },
			stopReason: "stop",
			timestamp: Date.now(),
		};

		try {
			const res = await fetch(`${provider.baseUrl}/chat/completions`, {
				method: "POST",
				signal,
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${provider.apiKey}`,
				},
				body: JSON.stringify({
					model: provider.model,
					messages,
					tools,
					stream: true,
					stream_options: { include_usage: true },
				}),
			});

			if (!res.ok) {
				// 把 provider 的原始报错带上，排查问题时这句最有用
				throw new Error(`HTTP ${res.status} ${res.statusText}\n${await res.text()}`);
			}

			await parseSSE(res, output, out);

			if (!output.stopReason) throw new Error("流结束了但没收到 finish_reason");

			finalizeToolCalls(output);
			out.push({ type: "done", reason: output.stopReason, message: output });
			out.end();
		} catch (error) {
			// 所有失败都收敛到这里：网络断了、key 错了、JSON 崩了、用户 Ctrl+C
			finalizeToolCalls(output);
			output.stopReason = signal?.aborted ? "aborted" : "error";
			output.errorMessage = error instanceof Error ? error.message : String(error);
			out.push({ type: "error", reason: output.stopReason, error: output });
			out.end();
		}
	})();

	return out; // 同步返回。这个函数从不 throw
}

/** 逐块读 SSE，把增量累积进 output.content */
async function parseSSE(res, output, out) {
	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";

	while (true) {
		const { done, value } = await reader.read();
		if (done) break;

		buffer += decoder.decode(value, { stream: true });
		const lines = buffer.split("\n");
		buffer = lines.pop(); // 最后一段可能不完整，留到下一轮

		for (const line of lines) {
			if (!line.startsWith("data:")) continue;
			const data = line.slice(5).trim();
			if (!data || data === "[DONE]") continue;

			const chunk = JSON.parse(data);

			if (chunk.usage) {
				output.usage.input = chunk.usage.prompt_tokens ?? 0;
				output.usage.output = chunk.usage.completion_tokens ?? 0;
			}

			const choice = chunk.choices?.[0];
			if (!choice) continue;

			if (choice.finish_reason) {
				output.stopReason = STOP_REASON[choice.finish_reason] ?? "error";
			}

			const delta = choice.delta;
			if (!delta) continue;

			if (delta.content) {
				appendText(output, delta.content);
				out.push({ type: "text_delta", text: delta.content });
			}

			for (const tc of delta.tool_calls ?? []) {
				appendToolCall(output, tc, out);
			}
		}
	}
}

function appendText(output, text) {
	const last = output.content[output.content.length - 1];
	if (last?.type === "text") last.text += text;
	else output.content.push({ type: "text", text });
}

/**
 * 工具调用是分片到达的，按 index 累积：
 *   {"index":0,"id":"call_x","function":{"name":"read_file","arguments":""}}
 *   {"index":0,"function":{"arguments":"{\"pa"}}
 *   {"index":0,"function":{"arguments":"th\":\"a.txt\"}"}}
 * partialArgs 和 streamIndex 是解析期间的临时脚手架，最后必须清掉。
 */
function appendToolCall(output, delta, out) {
	let block = output.content.find((c) => c.type === "toolCall" && c.streamIndex === delta.index);

	if (!block) {
		block = {
			type: "toolCall",
			id: delta.id ?? "",
			name: delta.function?.name ?? "",
			partialArgs: "",
			streamIndex: delta.index,
		};
		output.content.push(block);
	}

	if (delta.id) block.id = delta.id;
	if (delta.function?.name) {
		block.name = delta.function.name;
		out.push({ type: "toolcall_start", name: block.name, id: block.id });
	}
	if (delta.function?.arguments) block.partialArgs += delta.function.arguments;
}

/**
 * 收尾：把累积的字符串解析成参数，删掉临时字段。
 * 正常路径和异常路径都要走一遍，否则脏字段会被写进对话历史。
 * 对应 pi 的 openai-completions.ts:584 那段 delete 循环。
 */
function finalizeToolCalls(output) {
	for (const block of output.content) {
		if (block.type !== "toolCall") continue;

		try {
			block.args = JSON.parse(block.partialArgs || "{}");
		} catch (err) {
			// 截断的参数会在这里失败。但注意：截断的 JSON 也可能刚好能解析成功，
			// 所以判断参数是否可信要看 stopReason === "length"，不能只看这里有没有报错。
			block.args = null;
			block.argsError = err.message;
		}

		delete block.partialArgs;
		delete block.streamIndex;
	}
}
