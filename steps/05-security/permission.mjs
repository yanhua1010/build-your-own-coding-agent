// 审批策略：填 pi 留空的那道钩子。
// 对应系列文章第 5 篇。
//
// 分清两个词，这是这一步的核心：
//   机制 —— tool-runner.mjs 里的 beforeToolCall 挂载点。工具执行前留的那道口子，
//           返回 { block, reason } 就能拦下一次调用，拦截结果会喂回给模型。
//   策略 —— 挂在那道口子上的具体规则。这个文件就是策略。
//
// pi 的做法是：机制（tool_call 钩子）内置，策略默认留空，你要就自己挂。
// 这个文件演示怎么挂一个策略，以及"默认挂哪一档"这件事本身有多要紧。
//
// 三个模式，对应文章"能力不等于默认"这一节：
//   off    —— 全放行，不逐命令拦（pi 的默认姿态：以你的身份跑，你能干的它就能干）
//   ask    —— 危险命令先问一句（这个 mini-agent 的默认）
//   strict —— 危险命令直接拒（codex / dsh 那种 fail-closed 姿态）

import readline from "node:readline/promises";

// 危险命令模式。注意这不是"禁止这些命令"的黑名单，是"这些先确认一下"的提示表。
// pi 的 bash 根本没有这一层（无黑白名单）；grok-build 用的是更复杂的规则 DSL
// 加命令语义解析。这里取一个够用的中间量，够讲清策略长什么样。
export const DANGEROUS_PATTERNS = [
	{ re: /\brm\s+-[a-z]*[rf]/i, why: "递归或强制删除" },
	{ re: /\bsudo\b/i, why: "提权执行" },
	{ re: /\bmkfs\b/i, why: "格式化文件系统" },
	{ re: /\bdd\b[^\n]*\bof=/i, why: "裸盘写入" },
	{ re: />\s*\/dev\/[sh]d/i, why: "直接写块设备" },
	{ re: /\bchmod\s+-?R?\s*777\b/i, why: "开放全部权限" },
	{ re: /\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(ba)?sh\b/i, why: "下载内容直接执行" },
	{ re: /:\s*\(\s*\)\s*\{[^}]*\}\s*;/, why: "疑似 fork 炸弹" },
	{ re: /\bgit\s+push\b[^\n]*\s(-f|--force)\b/i, why: "强制推送" },
];

/**
 * 命令分类：命中危险模式就返回原因字符串，否则返回 null。
 * 只看命令文本，不执行任何东西。
 */
export function classifyCommand(command) {
	if (typeof command !== "string") return null;
	const hit = DANGEROUS_PATTERNS.find((p) => p.re.test(command));
	return hit ? hit.why : null;
}

// 默认确认器：终端问一句 y/N。测试和无人值守场景可以换掉它。
async function terminalConfirm(promptText) {
	const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
	try {
		const answer = await rl.question(promptText);
		return answer.trim().toLowerCase() === "y";
	} finally {
		rl.close();
	}
}

// 无人值守时用的确认器：永远返回 false。
// 对应 dsh 的 headless fail-closed —— 没人能点同意，就判成拒绝。
export const denyAllConfirm = async () => false;

/**
 * 造一个 beforeToolCall 钩子，挂到 tool-runner 的机制上。
 *
 * @param {object} opts
 * @param {"off"|"ask"|"strict"} [opts.mode="ask"] 默认姿态
 * @param {(text:string)=>Promise<boolean>} [opts.confirm] 确认器。
 *        默认终端 y/N；无人值守传 denyAllConfirm。
 * @returns {(ctx:{call:object,args:object,tool:object})=>Promise<{block:boolean,reason:string}|void>}
 */
export function createPermissionHook({ mode = "ask", confirm = terminalConfirm } = {}) {
	return async function beforeToolCall({ call, args }) {
		// 这个策略只审 bash 的命令。文件读写的边界由 tools.mjs 的 safePath 管
		// （那是另一层默认姿态：这个 mini-agent 把文件操作硬限制在工作目录内，pi 不这么做）。
		if (call.name !== "bash") return;

		const why = classifyCommand(args.command);
		if (!why) return; // 不危险，放行

		if (mode === "off") return; // 不拦，交给外部沙箱或用户自己负责
		if (mode === "strict") {
			return { block: true, reason: `命令被拦截（${why}）。这个操作不可逆，换一个更安全的做法。` };
		}

		// mode === "ask"
		const ok = await confirm(`\n🔐 这条命令有风险（${why}）\n   ${args.command}\n   允许执行吗? [y/N] `);
		if (!ok) return { block: true, reason: `用户拒绝了这次执行（${why}）` };
		// 允许：返回 undefined，放行
	};
}
