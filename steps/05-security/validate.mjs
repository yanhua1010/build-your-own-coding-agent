// 参数校验：够用的 JSON Schema 子集。
// 对应 pi 的 packages/ai/src/utils/validation.ts:278 validateToolArguments
//
// pi 用 typebox，这里手写一个只支持 object / string / number / boolean / array
// 的版本，为的是把两件事讲清楚：
//   1. 校验之前先做类型强转（模型经常把数字传成字符串）
//   2. 报错信息是写给模型看的，必须回显它自己传的参数

/** 按 schema 尝试把值转成期望的类型。转不了就原样返回，交给校验去报错。 */
function convert(value, schema) {
	if (!schema || value === undefined || value === null) return value;

	switch (schema.type) {
		case "number":
		case "integer":
			if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
				return Number(value);
			}
			return value;
		case "boolean":
			if (value === "true") return true;
			if (value === "false") return false;
			return value;
		case "string":
			return typeof value === "number" || typeof value === "boolean" ? String(value) : value;
		case "array": {
			// 模型时常把数组序列化成 JSON 字符串再传过来
			let arr = value;
			if (typeof arr === "string") {
				try {
					const parsed = JSON.parse(arr);
					if (Array.isArray(parsed)) arr = parsed;
				} catch {}
			}
			if (!Array.isArray(arr)) return arr;
			return arr.map((item) => convert(item, schema.items));
		}
		case "object": {
			if (typeof value !== "object" || Array.isArray(value)) return value;
			const out = {};
			for (const [key, val] of Object.entries(value)) {
				out[key] = convert(val, schema.properties?.[key]);
			}
			return out;
		}
		default:
			return value;
	}
}

/** 收集全部错误，而不是遇到第一个就返回。模型一次改完比来回三轮省 token。 */
function collectErrors(value, schema, path, errors) {
	if (!schema) return;

	if (schema.type === "object") {
		if (typeof value !== "object" || value === null || Array.isArray(value)) {
			errors.push(`${path || "参数"}: 期望 object，实际是 ${describe(value)}`);
			return;
		}
		for (const key of schema.required ?? []) {
			if (value[key] === undefined) errors.push(`${path}${key}: 缺少必填字段`);
		}
		for (const [key, sub] of Object.entries(schema.properties ?? {})) {
			if (value[key] !== undefined) collectErrors(value[key], sub, `${path}${key}.`, errors);
		}
		return;
	}

	if (schema.type === "array") {
		if (!Array.isArray(value)) {
			errors.push(`${trimDot(path)}: 期望 array，实际是 ${describe(value)}`);
			return;
		}
		if (schema.minItems !== undefined && value.length < schema.minItems) {
			errors.push(`${trimDot(path)}: 至少需要 ${schema.minItems} 项，实际 ${value.length} 项`);
		}
		value.forEach((item, i) => collectErrors(item, schema.items, `${trimDot(path)}[${i}].`, errors));
		return;
	}

	const expected = schema.type === "integer" ? "number" : schema.type;
	if (typeof value !== expected) {
		errors.push(`${trimDot(path)}: 期望 ${schema.type}，实际是 ${describe(value)}`);
		return;
	}
	if (schema.type === "integer" && !Number.isInteger(value)) {
		errors.push(`${trimDot(path)}: 期望整数，实际是 ${value}`);
	}
	if (schema.enum && !schema.enum.includes(value)) {
		errors.push(`${trimDot(path)}: 必须是 ${schema.enum.join(" / ")} 之一，实际是 ${JSON.stringify(value)}`);
	}
}

const trimDot = (path) => path.replace(/\.$/, "") || "参数";
const describe = (v) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);

/**
 * 校验并返回转换后的参数。失败时 throw。
 *
 * 抛出来的这条 Error 最终会原样喂回模型，所以格式很讲究：
 * 先列出每一条错在哪，再把模型自己传的原始参数回显出来，让它对照着改。
 * pi 的 validation.ts:307 是同一个思路。
 */
export function validateArguments(toolName, args, schema) {
	const converted = convert(args, schema);
	const errors = [];
	collectErrors(converted, schema, "", errors);

	if (errors.length > 0) {
		throw new Error(
			`工具 "${toolName}" 的参数校验失败：\n` +
				errors.map((e) => `  - ${e}`).join("\n") +
				`\n\n收到的参数：\n${JSON.stringify(args, null, 2)}`,
		);
	}
	return converted;
}
