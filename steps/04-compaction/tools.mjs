// 工具定义。对应 pi 的 packages/agent/src/harness/tools/
//
// 每个工具四件套：description / parameters(JSON Schema) / execute / 可选的
// executionMode 和 prepareArguments。
//
// 最重要的一条约定写在 pi 的 types.ts:388：
//   Execute the tool call. Throw on failure instead of encoding errors in content.
//   失败就抛，不要把错误编码进返回内容。
// 因为抛出来的异常会被流水线接住，变成 isError 的结果喂回模型，模型看得懂并且
// 会自己想办法。工具自己吞掉错误返回一句"操作失败"，模型反而不知道发生了什么。

import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname, sep } from "node:path";
import readline from "node:readline/promises";

import { withFileLock } from "./mutation-queue.mjs";

const BASH_THROTTLE_MS = 100;

function safePath(p) {
	const abs = resolve(process.cwd(), p);
	if (abs !== process.cwd() && !abs.startsWith(process.cwd() + sep)) {
		throw new Error(`拒绝访问工作目录之外的路径：${p}`);
	}
	return abs;
}

export const tools = {
	read_file: {
		description: "读取文本文件内容。可用 offset / limit 只读一段。",
		parameters: {
			type: "object",
			properties: {
				path: { type: "string", description: "文件路径，相对或绝对" },
				offset: { type: "integer", description: "起始行号，从 1 开始" },
				limit: { type: "integer", description: "最多读多少行" },
			},
			required: ["path"],
		},
		// 直接让 readFileSync 抛。ENOENT 的原始信息里带着完整路径，
		// 模型看到之后通常会自己 ls 一下找对的文件名。
		execute: ({ path, offset, limit }) => {
			const lines = readFileSync(safePath(path), "utf8").split("\n");
			const start = offset ? Math.max(0, offset - 1) : 0;
			if (start >= lines.length) {
				throw new Error(`offset ${offset} 超出文件末尾（共 ${lines.length} 行）`);
			}
			const end = limit === undefined ? lines.length : Math.min(start + limit, lines.length);
			return lines.slice(start, end).join("\n");
		},
	},

	write_file: {
		description: "写入文本文件，必要时自动创建目录。",
		parameters: {
			type: "object",
			properties: { path: { type: "string" }, content: { type: "string" } },
			required: ["path", "content"],
		},
		execute: ({ path, content }) => {
			const abs = safePath(path);
			// 锁挂在文件上，不是挂在工具上。写不同文件照样并行。
			return withFileLock(abs, async () => {
				mkdirSync(dirname(abs), { recursive: true });
				writeFileSync(abs, content);
				return `已写入 ${path}（${content.length} 字符）`;
			});
		},
	},

	edit_file: {
		description:
			"精确文本替换。每条 edits[].oldText 必须在原文件中唯一出现，多条替换互不重叠。",
		parameters: {
			type: "object",
			properties: {
				path: { type: "string" },
				edits: {
					type: "array",
					minItems: 1,
					items: {
						type: "object",
						properties: { oldText: { type: "string" }, newText: { type: "string" } },
						required: ["oldText", "newText"],
					},
				},
			},
			required: ["path", "edits"],
		},

		// 兼容层，在 schema 校验之前跑。处理模型最常见的两种传法：
		//   1. 把 edits 数组序列化成了 JSON 字符串（validate.mjs 里也兜了一层）
		//   2. 用旧版的顶层 oldText / newText 字段
		// 这一层不做校验，只做形状转换。pi 的 edit.ts:48 是同一个套路。
		prepareArguments: (args) => {
			if (!args || typeof args !== "object") return args;
			const out = { ...args };
			if (typeof out.oldText === "string" && typeof out.newText === "string") {
				out.edits = [...(Array.isArray(out.edits) ? out.edits : []), { oldText: out.oldText, newText: out.newText }];
				delete out.oldText;
				delete out.newText;
			}
			return out;
		},

		execute: ({ path, edits }) => {
			const abs = safePath(path);
			return withFileLock(abs, async () => {
				// 锁保证了这次读到的内容不会被另一个 edit 在中途改掉
				let content = readFileSync(abs, "utf8");
				for (const [i, { oldText, newText }] of edits.entries()) {
					const first = content.indexOf(oldText);
					if (first === -1) throw new Error(`edits[${i}] 的 oldText 在文件中找不到`);
					if (content.indexOf(oldText, first + 1) !== -1) {
						throw new Error(`edits[${i}] 的 oldText 在文件中出现多次，请加上下文让它唯一`);
					}
					content = content.slice(0, first) + newText + content.slice(first + oldText.length);
				}
				writeFileSync(abs, content);
				return `已完成 ${edits.length} 处替换：${path}`;
			});
		},
	},

	bash: {
		description: "在当前目录执行 shell 命令，返回 stdout 和 stderr。",
		parameters: {
			type: "object",
			properties: {
				command: { type: "string" },
				timeout: { type: "number", description: "超时秒数，默认 60" },
			},
			required: ["command"],
		},
		// 唯一一个用 onUpdate 的工具：命令跑 30 秒，用户不该盯着空屏幕。
		// 100ms 节流，避免刷屏时事件把主线程压死（pi 的 bash.ts:9 是同一个值）。
		execute: ({ command, timeout = 60 }, { signal, onUpdate }) =>
			new Promise((resolveExec, rejectExec) => {
				const child = spawn("bash", ["-c", command], { cwd: process.cwd() });
				let output = "";
				let dirty = false;
				let lastAt = 0;
				let timer;

				const flush = () => {
					if (!dirty) return;
					dirty = false;
					lastAt = Date.now();
					onUpdate?.({ content: output });
				};
				const schedule = () => {
					dirty = true;
					const delay = BASH_THROTTLE_MS - (Date.now() - lastAt);
					if (delay <= 0) {
						clearTimeout(timer);
						timer = undefined;
						flush();
						return;
					}
					timer ??= setTimeout(() => {
						timer = undefined;
						flush();
					}, delay);
				};

				const collect = (chunk) => {
					output += chunk;
					schedule();
				};
				child.stdout.on("data", collect);
				child.stderr.on("data", collect);

				const killTimer = setTimeout(() => child.kill("SIGKILL"), timeout * 1000);
				const onAbort = () => child.kill("SIGTERM");
				signal?.addEventListener("abort", onAbort, { once: true });

				child.on("error", (err) => {
					cleanup();
					rejectExec(err);
				});
				child.on("close", (code) => {
					cleanup();
					flush();
					// 非零退出码是错误，抛出去让模型看到 stderr 自己修
					if (signal?.aborted) return rejectExec(new Error(`${output}\n\n命令被中断`));
					if (code !== 0) return rejectExec(new Error(`${output}\n\n命令退出码 ${code}`));
					resolveExec(output || "(命令执行成功，无输出)");
				});

				function cleanup() {
					clearTimeout(killTimer);
					clearTimeout(timer);
					signal?.removeEventListener("abort", onAbort);
				}
			}),
	},

	ask_user: {
		description: "需要用户拍板时提问。会打断执行等待输入，请只在真的必要时使用。",
		parameters: {
			type: "object",
			properties: { question: { type: "string" } },
			required: ["question"],
		},
		// 这一个声明会把整批工具调用拖成串行。
		// 两个问题同时弹出来会抢终端，所以提问类工具必须独占。
		executionMode: "sequential",
		execute: async ({ question }) => {
			const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
			try {
				const answer = await rl.question(`\n❓ ${question}\n> `);
				return `用户回答：${answer}`;
			} finally {
				rl.close();
			}
		},
	},
};

/** 工具表 → OpenAI function calling 的 schema 数组 */
export const toolSchemas = Object.entries(tools).map(([name, t]) => ({
	type: "function",
	function: { name, description: t.description, parameters: t.parameters },
}));
