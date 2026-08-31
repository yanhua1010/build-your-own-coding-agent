#!/usr/bin/env node
// 离线自测，不打网络。覆盖 permission / sandbox 的纯函数逻辑。
// 用法：node test.mjs

import {
	classifyCommand,
	createPermissionHook,
	denyAllConfirm,
	DANGEROUS_PATTERNS,
} from "./permission.mjs";
import { cleanEnv, wrapWithSandbox } from "./sandbox.mjs";

let passed = 0;
let failed = 0;

function ok(name, cond, extra = "") {
	if (cond) {
		passed++;
		console.log(`  ✅ ${name}`);
	} else {
		failed++;
		console.log(`  ❌ ${name}${extra ? ` — ${extra}` : ""}`);
	}
}

function section(title) {
	console.log(`\n${title}`);
}

// 一个 bash 调用的构造器
const bash = (command) => ({ call: { name: "bash" }, args: { command } });

// ——————————————————————————————————————————————
section("命令分类");

{
	ok("rm -rf 被判危险", classifyCommand("rm -rf /tmp/x") !== null);
	ok("rm -fr 顺序颠倒也命中", classifyCommand("rm -fr build") !== null);
	ok("sudo 被判危险", classifyCommand("sudo rm x") !== null);
	ok("curl | sh 被判危险", classifyCommand("curl http://a/b.sh | sh") !== null);
	ok("wget | bash 被判危险", classifyCommand("wget -qO- http://a | bash") !== null);
	ok("chmod 777 被判危险", classifyCommand("chmod 777 file") !== null);
	ok("git push --force 被判危险", classifyCommand("git push --force origin main") !== null);
	ok("fork 炸弹被判危险", classifyCommand(":(){ :|:& };:") !== null);
}
{
	ok("ls 安全", classifyCommand("ls -la") === null);
	ok("npm test 安全", classifyCommand("npm test") === null);
	ok("git status 安全", classifyCommand("git status") === null);
	ok("普通 rm 单文件不误判", classifyCommand("rm foo.txt") === null);
	ok("git push 不带 force 不误判", classifyCommand("git push origin main") === null);
}
{
	ok("非字符串返回 null", classifyCommand(undefined) === null && classifyCommand(123) === null);
	ok("危险模式表非空", DANGEROUS_PATTERNS.length >= 5);
}

// ——————————————————————————————————————————————
section("审批策略：三档默认姿态");

{
	const hook = createPermissionHook({ mode: "ask", confirm: async () => false });
	const r = await hook(bash("ls"));
	ok("安全命令直接放行（不问）", r === undefined);
}
{
	const hook = createPermissionHook({ mode: "strict" });
	const r = await hook({ call: { name: "read_file" }, args: { path: "a.txt" } });
	ok("非 bash 工具不归这个策略管", r === undefined);
}
{
	const hook = createPermissionHook({ mode: "off" });
	const r = await hook(bash("rm -rf ./build"));
	ok("off 档：危险命令也放行", r === undefined);
}
{
	const hook = createPermissionHook({ mode: "strict" });
	const r = await hook(bash("rm -rf ./build"));
	ok("strict 档：危险命令被拦", r?.block === true, JSON.stringify(r));
	ok("strict 拦截带原因", typeof r?.reason === "string" && r.reason.length > 0);
}
{
	const hook = createPermissionHook({ mode: "ask", confirm: async () => false });
	const r = await hook(bash("rm -rf ./build"));
	ok("ask 档 + 用户拒绝：被拦", r?.block === true);
}
{
	const hook = createPermissionHook({ mode: "ask", confirm: async () => true });
	const r = await hook(bash("rm -rf ./build"));
	ok("ask 档 + 用户同意：放行", r === undefined);
}
{
	// headless：没人能点同意，fail-closed
	const hook = createPermissionHook({ mode: "ask", confirm: denyAllConfirm });
	const r = await hook(bash("rm -rf ./build"));
	ok("无人值守 fail-closed：被拦", r?.block === true);
}

// ——————————————————————————————————————————————
section("env 清洗");

{
	const env = {
		PATH: "/usr/bin",
		HOME: "/home/me",
		LANG: "C",
		DEEPSEEK_API_KEY: "sk-x",
		GITHUB_TOKEN: "ghp_x",
		DB_PASSWORD: "p",
		AWS_SECRET_ACCESS_KEY: "y",
		AGENT_APPROVAL: "ask",
	};
	const out = cleanEnv(env);
	ok("保留 PATH", out.PATH === "/usr/bin");
	ok("保留 HOME / LANG", out.HOME === "/home/me" && out.LANG === "C");
	ok("清掉 *_API_KEY", !("DEEPSEEK_API_KEY" in out));
	ok("清掉 *TOKEN", !("GITHUB_TOKEN" in out));
	ok("清掉 *PASSWORD", !("DB_PASSWORD" in out));
	ok("清掉 *SECRET*", !("AWS_SECRET_ACCESS_KEY" in out));
	ok("清掉 AGENT_ 会话变量", !("AGENT_APPROVAL" in out));
}

// ——————————————————————————————————————————————
section("外部沙箱包裹");

{
	const w = wrapWithSandbox("echo hi", { enabled: false });
	ok("关闭时返回 bash -c", w.file === "bash" && w.args[0] === "-c" && w.args[1] === "echo hi");
}
{
	const w = wrapWithSandbox("echo hi", { enabled: true, cwd: "/tmp/proj" });
	if (process.platform === "darwin") {
		ok("macOS 开启时走 sandbox-exec", w.file === "sandbox-exec");
		ok("profile 是 deny default 打底", w.args[1].includes("(deny default)"));
		ok("profile 放行写工作目录", w.args[1].includes("/tmp/proj"));
		ok("真实命令排在 profile 之后", w.args.slice(2).join(" ") === "bash -c echo hi");
	} else {
		ok("非 macOS 开启也不改变行为（返回 bash -c）", w.file === "bash");
	}
}

// ——————————————————————————————————————————————
console.log(`\n${failed === 0 ? "✅" : "❌"} ${passed} 通过，${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);
