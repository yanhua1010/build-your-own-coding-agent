// Context overflow 检测：判断 LLM 的错误是不是"context 满了"。
// 对应 pi 的 packages/ai/src/utils/overflow.ts（169 行，约 25 种正则）
//
// agent 不能让"context 满了"和"网络超时"走同一条路。
// 前者要做 compaction 然后重试，后者应该直接报错退出。
// 这个文件的全部工作就是区分这两种情况。

/**
 * 主流 provider 的 context overflow 报错格式。
 * pi 维护了约 25 种正则，这里保留最常见的几种。
 *
 * 测试方法：找到 provider 的 error message，用这些正则匹配。
 * 新增 provider 只需要加一条正则就能接入 compaction 能力。
 */
const OVERFLOW_PATTERNS = [
	// Anthropic
	/prompt is too long/i,
	/exceeds the maximum number of tokens/i,

	// OpenAI
	/maximum context length/i,
	/context_length_exceeded/i,
	/exceeds? the (model'?s )?context window/i,
	/Please reduce the length/i,

	// Google / Gemini
	/exceeds? the maximum (number of )?input tokens/i,

	// 通用
	/too many tokens/i,
	/token limit/i,
	/request too large/i,
];

/**
 * 排除项：这些报错不是 overflow，是限流或计费。
 * 不排除的话会把 rate limit 错误当成 overflow 做 compaction，
 * 没有意义还浪费了一次 LLM 调用。
 */
const NON_OVERFLOW_PATTERNS = [/rate.?limit/i, /throttl/i, /quota/i, /billing/i];

/**
 * 判断一条 assistant message 是不是因为 context overflow 失败的。
 *
 * 三种检测路径（对应 pi 的 isContextOverflow）：
 * 1. 错误信息匹配 overflow 正则
 * 2. 静默溢出：有的 provider 不报错，但 usage.input > contextWindow
 * 3. 截断溢出：输出 0 token + 输入 ≥ 99% context window
 *
 * @param message  内部 assistant message（带 stopReason / errorMessage / usage）
 * @param contextWindow  当前模型的 context window 大小
 */
export function isContextOverflow(message, contextWindow) {
	// 路径 1：错误信息匹配
	if (message.stopReason === "error" && message.errorMessage) {
		// 先排除 rate limit 类错误
		if (NON_OVERFLOW_PATTERNS.some((p) => p.test(message.errorMessage))) return false;
		if (OVERFLOW_PATTERNS.some((p) => p.test(message.errorMessage))) return true;
	}

	// 路径 2：静默溢出
	// 有的 provider（尤其是国产的）不报错而是静默截断输入
	if (message.usage?.input > contextWindow) return true;

	// 路径 3：截断溢出
	// output 是 0 但 input 已经占满窗口 → 模型连第一个 token 都来不及输出
	if (
		message.stopReason === "length" &&
		message.usage?.output === 0 &&
		message.usage?.input >= contextWindow * 0.99
	) {
		return true;
	}

	return false;
}
