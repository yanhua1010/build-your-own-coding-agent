// bash 的两件工程加固 + 一个外部沙箱注入点。
// 对应系列文章第 5 篇里 pi 的 bash 做法。
//
// pi 自己不做 OS 沙箱（见文章），但它把 bash 这一层的几件小事做得很扎实：
//   1. 执行前清洗敏感环境变量，不让子进程看到会话密钥
//   2. 进程树 kill，abort / 超时时连整棵子进程一起收掉，不留孤儿
//   3. 留一个 spawnHook，想套外部沙箱就在这里注入
//
// 这个文件把这三件事实现出来。codex / grok-build 是内建 OS 沙箱；这里是 pi 那种
// "把口子留好、真正的隔离交给外部"的路子，wrapWithSandbox 就是那个口子。

// 明显是密钥的环境变量名，不该带进子进程。
const SECRET_ENV_RE = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)/i;
// 这个 agent 自己的会话配置变量，也不该泄漏给命令。pi 删的是 PI_SESSION_* 一类。
const SESSION_ENV_RE = /^(AGENT_|DEEPSEEK_|GLM_|MOONSHOT_|OPENAI_)/;

/**
 * 复制一份环境变量，去掉密钥类和本 agent 的会话类变量。
 * 默认防泄漏：一条 `env | grep KEY` 在子进程里应当什么也查不到。
 */
export function cleanEnv(env = process.env) {
	const out = {};
	for (const [k, v] of Object.entries(env)) {
		if (SECRET_ENV_RE.test(k)) continue;
		if (SESSION_ENV_RE.test(k)) continue;
		out[k] = v;
	}
	return out;
}

/**
 * 把命令包进 macOS 的 sandbox-exec，这是"外部沙箱怎么接"的最小演示。
 * 返回 { file, args }，交给 spawn 用。
 *
 * enabled=false 或非 macOS 时，返回原始的 bash -c，不改变任何行为
 * （对应 grok-build：能力在，默认不开）。
 *
 * 生成的 seatbelt profile 是 (deny default) 打底，只放行读全盘、写工作目录、
 * 基本执行。codex 内建做的就是这件事（见文章），这里手动接一层给你看它长什么样。
 * 这个 profile 是演示级的，不同 macOS 版本可能要微调，真要用请以 codex 的 profile 为准。
 */
export function wrapWithSandbox(command, { cwd = process.cwd(), enabled = false } = {}) {
	if (!enabled || process.platform !== "darwin") {
		return { file: "bash", args: ["-c", command] };
	}
	const profile = [
		"(version 1)",
		"(deny default)",
		"(allow process-exec)",
		"(allow process-fork)",
		"(allow signal (target self))",
		"(allow sysctl-read)",
		"(allow mach-lookup)",
		"(allow file-read*)",
		`(allow file-write* (subpath ${quote(cwd)}))`,
		'(allow file-write* (subpath "/dev"))',
		'(allow file-write* (subpath "/private/tmp"))',
		'(allow file-write* (subpath "/private/var/folders"))',
	].join("\n");
	return { file: "sandbox-exec", args: ["-p", profile, "bash", "-c", command] };
}

// seatbelt profile 里的路径要用双引号包起来。
function quote(p) {
	return `"${String(p).replace(/(["\\])/g, "\\$1")}"`;
}

/**
 * 收掉一棵子进程树。
 * 子进程用 detached 起，会独占一个进程组；对 -pid 发信号就是对整组发。
 * 这样命令里 spawn 出来的孙子进程也会被一起收掉，不留孤儿。
 */
export function killTree(child, signal = "SIGTERM") {
	if (child.pid === undefined) return;
	try {
		process.kill(-child.pid, signal); // 负号 = 整个进程组
	} catch {
		try {
			child.kill(signal);
		} catch {
			// 进程可能已经退出，忽略
		}
	}
}
