// 工作区信任门的最小版。对应 pi 的 trust-manager.ts + resource-loader.ts。
// 对应系列文章第 5 篇里 pi 那道"加载项目配置前先问信任"的门。
//
// 道理很简单：项目本地的 AGENTS.md 会被拼进 system prompt，等于让这个仓库往
// agent 里塞任意指令。在一个陌生仓库里第一次跑，加载它之前先问一句信不信任。
// 不信任就不读它。信任决定记在 ~/.myagent/trust.json，下次同一个目录不再问。
//
// pi 做得更细（分层信任、文件锁、两遍加载），这里只保留最能说明问题的骨架。

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import readline from "node:readline/promises";

const AGENT_DIR = join(homedir(), ".myagent");
const TRUST_FILE = join(AGENT_DIR, "trust.json");

// 项目本地、能往 agent 里塞指令的资源。这里用 AGENTS.md 举例，
// pi 门控的是 .pi 下的 settings / extensions / skills / SYSTEM.md 等一整批。
const PROJECT_CONFIG = "AGENTS.md";

function readTrust() {
	try {
		return JSON.parse(readFileSync(TRUST_FILE, "utf8"));
	} catch {
		return {};
	}
}

function writeTrust(data) {
	mkdirSync(AGENT_DIR, { recursive: true });
	writeFileSync(TRUST_FILE, `${JSON.stringify(data, null, 2)}\n`);
}

async function terminalConfirm(promptText) {
	const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
	try {
		return (await rl.question(promptText)).trim().toLowerCase() === "y";
	} finally {
		rl.close();
	}
}

/**
 * 检查工作目录里的项目配置该不该加载。
 *
 * @param {string} cwd
 * @param {object} [opts]
 * @param {(text:string)=>Promise<boolean>} [opts.confirm] 确认器，默认终端 y/N
 * @returns {Promise<{ load: boolean, path?: string }>}
 *          load=false 时调用方不要去读 AGENTS.md。
 */
export async function checkProjectTrust(cwd = process.cwd(), { confirm = terminalConfirm } = {}) {
	const configPath = join(resolve(cwd), PROJECT_CONFIG);
	if (!existsSync(configPath)) return { load: false }; // 没有项目配置，谈不上信任

	const key = resolve(cwd);
	const trust = readTrust();
	if (key in trust) {
		return { load: trust[key] === true, path: trust[key] === true ? configPath : undefined };
	}

	// 没记录过，问一次并记下来
	const ok = await confirm(
		`\n🚪 这个目录有 ${PROJECT_CONFIG}，它会被加进 agent 的指令里。信任并加载吗? [y/N] `,
	);
	trust[key] = ok;
	writeTrust(trust);
	return { load: ok, path: ok ? configPath : undefined };
}
