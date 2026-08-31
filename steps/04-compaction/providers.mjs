// Provider 配置：服务商是什么、怎么鉴权、用哪套协议。
// 对应 pi 的 packages/ai/src/providers/*.ts

/**
 * 注意每一项都只有配置，没有一行解析代码。
 * 三家的 api 字段都是 "openai-completions"，共用同一份流式解析实现。
 * pi 里这个数字是 20 家 provider 共用一个实现。
 */
export const providers = {
	deepseek: {
		name: "DeepSeek",
		baseUrl: "https://api.deepseek.com",
		apiKeyEnv: "DEEPSEEK_API_KEY",
		defaultModel: "deepseek-chat",
		api: "openai-completions",
	},
	glm: {
		name: "智谱 GLM",
		baseUrl: "https://open.bigmodel.cn/api/paas/v4",
		apiKeyEnv: "GLM_API_KEY",
		defaultModel: "glm-4.6",
		api: "openai-completions",
	},
	kimi: {
		name: "月之暗面 Kimi",
		baseUrl: "https://api.moonshot.cn/v1",
		apiKeyEnv: "MOONSHOT_API_KEY",
		defaultModel: "kimi-k2-turbo-preview",
		api: "openai-completions",
	},
};

/**
 * 解析出当前该用哪个 provider。
 * 优先看 LLM_PROVIDER，否则挑第一个配了 key 的。
 */
export function resolveProvider() {
	const wanted = process.env.LLM_PROVIDER;
	if (wanted) {
		const p = providers[wanted];
		if (!p) throw new Error(`未知 provider: ${wanted}，可选：${Object.keys(providers).join(" / ")}`);
		return withKey(p);
	}

	for (const p of Object.values(providers)) {
		if (process.env[p.apiKeyEnv]) return withKey(p);
	}

	const hints = Object.values(providers)
		.map((p) => `  ${p.apiKeyEnv}=xxx   # ${p.name}`)
		.join("\n");
	throw new Error(`没有找到可用的 API key，任选一个设置：\n${hints}`);
}

function withKey(provider) {
	const apiKey = process.env[provider.apiKeyEnv];
	if (!apiKey) throw new Error(`${provider.name} 需要环境变量 ${provider.apiKeyEnv}`);
	return {
		...provider,
		apiKey,
		// 允许单独覆盖模型和地址，方便试别的模型
		model: process.env.LLM_MODEL ?? provider.defaultModel,
		baseUrl: process.env.LLM_BASE_URL ?? provider.baseUrl,
	};
}
