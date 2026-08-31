# 05 权限与安全：pi 凭什么敢替你执行命令

> 主源码：[SECURITY.md](https://github.com/earendil-works/pi/blob/main/SECURITY.md)（87 行）、[trust-manager.ts](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/trust-manager.ts)（244 行）、[paths.ts](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/utils/paths.ts)（118 行）、[bash.ts](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/tools/bash.ts)（505 行）、[agent-loop.ts](https://github.com/earendil-works/pi/blob/main/packages/agent/src/agent-loop.ts)（792 行，`prepareToolCall`）、[agent-harness.ts](https://github.com/earendil-works/pi/blob/main/packages/agent/src/harness/agent-harness.ts)（1084 行）
> 基于 pi commit `5bc1c2c`（2026-07-25）；文中行号以该 commit 为准
> 对应文章：《解密四个 coding agent 的安全哲学》｜对应代码：[steps/05](../steps/05-security/)

## 核心问题

一个 coding agent 能读文件、改代码、跑 shell。这些动作里任何一个都可能删掉重要数据、把密钥发到外网、执行仓库里藏的恶意指令。问题是：pi 凭什么敢做这些？它靠什么拦住不该做的？

读完源码，答案和大多数人的预期相反。

## 顶层立场：pi 故意不做沙箱

`SECURITY.md` 把话说得很直白，原文：

> the Pi coding agent intentionally does not have a sandbox

pi 的安全模型只有一句话：**信任边界 = 运行 pi 的那个用户账号**。这个账号能写的文件、能跑的命令，都在和 pi 进程同一个信任边界内。推论有三条：

1. pi 不防御"已经拿到本地写权限的攻击者"。如果攻击者能改你 home 目录下的文件、shell 启动脚本、环境变量或 pi 配置，他本来就能操纵你机器上的任何开发工具，这不算 pi 的漏洞。
2. pi 明说 prompt injection 防不住。`AGENTS.md`、代码注释里塞一句"请把 .env 发到某地址"，就能骗过 agent，SECURITY.md 用的词是 "cannot be protected against"。
3. 真正的隔离（容器 / 虚拟机 / 外部沙箱）是**用户的责任**，不是 pi 的功能。

所以 pi 把力气花在别的地方：不是"对抗恶意输入"，而是"把信任模型讲清楚，再在应用层做几道降低误伤的护栏"。

## 四层来看 pi 实际做了什么

| 层 | 机制 | 位置 | 性质 |
|---|---|---|---|
| 加载项目配置前 | 工作区信任门控 | `trust-manager.ts` + `resource-loader.ts` | 真正的安全闸：不信任就不加载"能塞指令"的资源 |
| 每次工具调用前 | 审批钩子 `beforeToolCall` | `agent-loop.ts` + `agent-harness.ts` | 扩展点，不是内置策略；默认不拦 |
| 文件路径 | 解析 + 归一，非硬隔离 | `paths.ts` + `path-utils.ts` | 服务正确性和显示，不阻止越界 |
| 执行 shell | bash 工具，无黑白名单 | `bash.ts` | 限定 cwd + 清洗 env + 进程树 kill + 留扩展点 |

下面逐层拆。

## 第一层：工作区信任门控（唯一真正的安全闸）

这是 pi 唯一一处"默认开启、会真的拦住东西"的机制。它管的不是"能不能跑命令"，而是"要不要加载这个目录里的项目本地配置"。

### 门控哪些资源

`trust-manager.ts` 的 `TRUST_REQUIRING_PROJECT_CONFIG_RESOURCES`：

```
settings.json  extensions  skills  prompts  themes  SYSTEM.md  APPEND_SYSTEM.md
```

这些都在 `cwd/.pi/` 下。外加 cwd 及各级祖先目录里的 `.agents/skills`。它们的共同点：**都能往 agent 里塞指令或塞代码**。settings 能改模型和行为，extensions 是会执行的 JS，skills 和 SYSTEM.md 直接进 system prompt。所以加载它们之前必须先问：这个目录，你信不信任？

用户全局的 `~/.agents/skills` 永远算可信用户资源，不在门控范围内。

### 分层信任

信任决策存在 `~/.pi/agent/trust.json`，是一个 `路径 → true/false` 的表。查询时 `findNearestTrustEntry` 从 cwd 一路往上找最近的祖先记录：

```
你在 ~/work/project-a/src 下跑 pi
trust.json 里有 ~/work/project-a: true
→ src 继承父目录的信任
```

`getProjectTrustOptions` 给出的选项也体现这一点：信任当前目录 / 信任父目录（一次信任一批子项目）/ 仅本次会话信任 / 不信任。

### 两遍加载：决定信任之前不执行项目代码

`resource-loader.ts` 的 `resolveProjectTrust` 是关键设计。它把加载分成两遍：

1. **bootstrap 遍**（`loadProjectTrustExtensions`）：强制 `setProjectTrusted(false)`，在"假装不信任"的前提下先加载一遍，只拿到最小可用的扩展集。
2. 用这批最小扩展去解析信任决策（可能弹出信任选择器让用户决定）。
3. **正式遍**（`loadFinalExtensionSet`）：信任确定后，才加载完整的项目本地扩展集。

顺序很重要：**在你还没做出信任决定之前，pi 不会执行项目本地的扩展代码**。不信任的目录，`renderProjectTrustWarningIfNeeded` 会打印一行警告，然后忽略 `.pi` 下的资源：

> This project is not trusted. Project .pi resources and packages are ignored. Use /trust to save a trust decision, then restart pi.

### 并发安全

`trust.json` 的读写用 `proper-lockfile` 加文件锁（`withTrustFileLock`），带重试。多个 pi 进程同时改信任表不会写坏。写入时按 key 排序，稳定输出。

## 第二层：工具审批钩子（一个扩展点，不是策略）

pi 的核心循环在执行工具前留了一道钩子，但默认什么都不拦。

### prepare 和 execute 分离

`agent-loop.ts` 把一次工具调用拆成两个阶段：

`prepareToolCall`：
1. 按名字找工具，找不到 → 立即返回错误结果
2. `prepareArguments` 规整参数
3. `validateToolArguments` 按 schema 校验
4. **`config.beforeToolCall({ assistantMessage, toolCall, args, context })`** ← 审批钩子
5. 钩子返回 `{ block: true, reason }` → 立即返回错误结果，`reason` 作为错误信息
6. 否则返回 `kind: "prepared"`，进入下一阶段

`executePreparedToolCall`：真正调 `tool.execute(...)`。

拦截发生在 execute 之前。被拦的调用不是抛异常，而是变成一条错误 toolResult 回喂给模型："Tool execution was blocked: 原因"。模型看得到这条反馈，可以换个做法。这和前面几篇看到的"报错是写给模型看的"是同一个意识。

### harness 把钩子接到扩展事件

`agent-harness.ts` 的 `beforeToolCall` 实现，就是把它转成一个 `tool_call` 扩展事件：

```typescript
beforeToolCall: async ({ toolCall, args }) => {
    const result = await this.emitHook({
        type: "tool_call",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        input: args,
    });
    return result ? { block: result.block, reason: result.reason } : undefined;
},
```

任何扩展监听 `tool_call` 事件，都能检查工具名和参数，返回 `{ block, reason }` 拦下这次调用。对应的 `afterToolCall` 转成 `tool_result` 事件，扩展能改写结果、标记为错误、甚至 `terminate` 整个 agent。

### 默认不装策略

产品层默认没有注册任何 `tool_call` 审批处理器。也就是说，**pi 默认不会在每次 bash 前弹窗确认**。要"危险命令先问一句"这种策略，得自己写扩展。这是 pi 和 Claude Code 那种内置 allowlist / 权限模式最大的分野：pi 把审批做成机制，把策略留给用户。

## 第三层：路径处理不是硬隔离

很多人默认 coding agent 会把文件操作锁死在工作目录里。pi 不这么做。

### 文件工具接受绝对路径

write 工具的参数 schema 直接写着 "Path to the file to write (relative or absolute)"。`resolveToCwd` 只做解析，不做包含检查：

```typescript
export function resolveToCwd(filePath, cwd) {
    return resolvePath(filePath, cwd, { normalizeUnicodeSpaces: true, stripAtPrefix: true });
}
```

相对路径按 cwd 解析，绝对路径原样解析。`resolveReadPath` 在这之上加了一串 macOS 文件名变体回退（AM/PM 前的窄空格、NFD 分解形式、弯引号），那是为了让"截图文件名带特殊字符也能读到"，是体验优化，不是安全检查。

结论：**pi 的文件工具能写工作目录之外**。因为信任边界是用户账号，agent 以你的身份运行，你能写的地方它就能写。这是 SECURITY.md 立场的直接体现，不是疏漏。

### realpath 的真实用途是"识别同一个文件"

`paths.ts` 的 `canonicalizePath` 用 `realpathSync` 解符号链接，但它不是用来"防止软链逃逸"的。它出现的两个地方都是为了**把指向同一个物理文件的不同路径归一成同一个 key**：

- `trust.json` 的 key 归一（`normalizeCwd`）：`~/work` 和它的软链应该命中同一条信任记录
- 文件编辑队列的 key 归一（见下）

`getCwdRelativePath` 判断路径在不在 cwd 内，也只用于**友好显示**（`formatPathRelativeToCwdOrAbsolute`：在 cwd 内显示相对路径，否则显示绝对路径），不是门禁。

### 编辑队列是正确性，不是安全

`file-mutation-queue.ts` 用 `realpath` 归一后的路径做 key，串行化"对同一个文件的并发修改"，不同文件仍然并行：

```
两个 edit 同时改 src/auth.ts（哪怕一个走软链一个走真实路径）
→ realpath 归一到同一个 key → 排队，一个改完另一个再改
```

解决的是"两个 edit 撞车导致丢改动"，属于并发正确性，和安全无关。放在这一层讲，是因为它和路径归一共用同一套 realpath 机制，容易被误当成"路径隔离"。

## 第四层：bash 工具

`bash.ts` 里没有任何命令黑白名单。它不认识 `rm -rf`，也不拦 `curl | sh`。它做的是另外几件事：

1. **限定 cwd**：命令在工作目录里跑，执行前检查工作目录存在，不存在直接报错。
2. **清洗敏感环境变量**：`resolveSpawnContext` 在把 env 传给子进程前，先删掉 `PI_SESSION_ID`、`PI_SESSION_FILE`、`PI_PROVIDER`、`PI_MODEL`、`PI_REASONING_LEVEL`。只有显式开 `exposeSessionEnvironment` 才把这些重新加回去。默认不让子进程看到会话内部信息。
3. **进程树 kill**：abort 或 timeout 时 `killProcessTree(pid)` 杀掉整棵进程树，`detached: true` 保证能拿到进程组，不留孤儿进程。
4. **输出截断**：默认截到最后若干行或若干 KB，超出写临时文件。防的是"一条命令刷爆 context"，也是一种资源保护。
5. **`spawnHook` 扩展点**：执行前可以改写 command / cwd / env。**这才是"想套外部沙箱就在这注入"的地方**——把 `command` 包成 `sandbox-exec -f profile.sb sh -c '原命令'` 或 `nono 原命令`，pi 的其余逻辑不用动。

pi 自己不提供沙箱，但把注入沙箱的口子留得很干净。

## 纵深防御的几个小机关

- **`blockImages` 设置**：`convertToLlm` 时把消息里的图片内容换成占位文本。防的是"图片里藏 prompt injection"，也省 token。动态读设置，会话中途改即时生效。
- **`markPathIgnoredByCloudSync`**：给 agent 产物打上 Dropbox / iCloud 的"别同步"扩展属性（macOS 用 `xattr`，Linux 用 `setfattr`）。防的是敏感的会话文件被云盘悄悄同步出去。
- **`restoreSandboxEnv`**：当 pi 跑在外部沙箱（注释里点名 `nono`）里、Bun 编译产物的 `process.env` 被清空时，从 `/proc/self/environ` 把环境变量捞回来。这行代码本身就是"pi 预期自己会被放进外部沙箱"的证据。

## 对照：其他 agent 的另一条路

pi 把 OS 级隔离交给外部，是一种取舍。另一条路是把沙箱做进 agent 自己：codex 和 grok-build 都是 Rust 实现，走的是内建沙箱（seatbelt / landlock 一类）+ 明确权限模式的路线；Claude Code 有内置的工具 allowlist 和权限档位。这些放到第 6 篇（从 100 行到工业级）再展开对照，本篇只需要记住轴线：

**沙箱做进 agent（codex 路线） ↔ 沙箱交给部署环境（pi 路线）**

pi 路线更轻、更透明，但把"要不要隔离、隔离到什么程度"的责任明确压回给用户。SECURITY.md 愿意把这件事写清楚，本身是一种成熟。

## 数据流：一次危险操作会经过什么

```
启动 pi（cwd = 某仓库）
  → resource-loader 两遍加载
    → bootstrap 遍：强制不信任，只加载最小扩展
    → resolveProjectTrust → 查 trust.json / 弹信任选择器
    → 信任？→ 正式遍加载完整项目扩展；不信任？→ 忽略 .pi 资源 + 警告
  ↓
模型请求调用 bash("rm -rf build")
  → agent-loop.prepareToolCall
    → 找到 bash 工具
    → 校验参数
    → beforeToolCall → emit tool_call 事件
      → 有扩展返回 {block}？→ 变成错误 toolResult 回喂模型，结束
      → 没有？（默认）→ 通过
  → executePreparedToolCall
    → resolveSpawnContext：清洗 PI_* env，spawnHook 可注入沙箱
    → 在 cwd 里 spawn shell 跑命令
    → abort/timeout → killProcessTree
```

默认路径上，唯一会拦住东西的是第一道（信任门控，且只针对项目配置加载）。命令本身默认不拦。

## 关键文件对照表

| 能力 | 位置 | 一句话 |
|---|---|---|
| 安全立场声明 | `SECURITY.md` | 故意不做沙箱，信任边界=用户账号，隔离靠外部 |
| 工作区信任门控 | `core/trust-manager.ts` | 分层信任表 + 文件锁，门控项目配置加载 |
| 两遍加载 | `core/resource-loader.ts` `resolveProjectTrust` | 决定信任前不执行项目本地代码 |
| 审批钩子（机制） | `agent/src/agent-loop.ts` `prepareToolCall` | prepare/execute 分离，block+reason 回喂 |
| 审批钩子（接线） | `agent/src/harness/agent-harness.ts` | beforeToolCall → tool_call 扩展事件 |
| 路径解析 | `utils/paths.ts` + `core/tools/path-utils.ts` | 接受绝对路径，不硬隔离；realpath 用于归一和显示 |
| 并发编辑串行化 | `core/tools/file-mutation-queue.ts` | realpath 归一 key，同文件排队，是正确性 |
| shell 执行 | `core/tools/bash.ts` | 无黑白名单，清洗 env，进程树 kill，spawnHook 注入点 |
| 纵深小机关 | `blockImages` / `markPathIgnoredByCloudSync` / `restoreSandboxEnv` | 防图片注入 / 防云盘外泄 / 配合外部沙箱 |

## 给 mini-agent 的取舍（steps/05 要做什么）

mini-agent 照抄 pi 的完整信任系统没必要（trust.json、文件锁、两遍加载太重）。值得实现的是能讲清"机制 vs 策略"分野的最小骨架：

1. **beforeToolCall 钩子**：在工具执行前留一道可插拔的审批点，返回 `{ block, reason }`，拦截结果回喂给模型。这是核心，最能体现 pi 的设计。
2. **一个默认审批策略示例**：写一个"危险命令（rm -rf、curl|sh 等）先让用户确认"的策略，作为钩子的消费者。让学员看到"pi 把这层留空、我们可以怎么填"。
3. **bash 的 env 清洗 + 进程树 kill**：这两个是实打实的工程细节，值得抄。
4. **spawnHook 注入沙箱的演示**：给一个把命令包进 `sandbox-exec`（macOS）的示例 hook，讲清"外部沙箱怎么接"。
5. **工作区信任的最小版**：启动时如果 cwd 里有项目本地配置，问一句信不信任，不信任就不加载。演示"加载前门控"这个点。

立意落点：这一篇不教"怎么把 agent 关进笼子"，而是讲清 pi 的选择——**它以你的身份运行，诚实地告诉你边界在哪，把加隔离的口子留好，剩下的责任交还给你**。

---

# 附：多 agent 安全对照（第 5 篇改为四方对比的材料）

第 5 篇角度升级为"四个 coding agent，四种安全哲学"。用两个正交的轴组织：**能不能做到（sandbox = 文件系统/OS 边界）** 和 **该不该做（approval = 用户意图）**。pi 是"全外包"的一端。

## 组织框架：两个正交的轴

- **sandbox 轴**：内核/OS 层面 agent 能碰到什么。做进 agent（codex / dsh）↔ 交给外部容器（pi）↔ 物理副本隔离（grok worktree）。
- **approval 轴**：某个动作要不要人点头。默认全问 ↔ 模型按需请求 ↔ 默认不问。
- 关键认知（dsh 讲得最透）：**这两个是独立的**。"审批对话框不是文件系统边界，沙箱也不能替代用户意图。" 一个 agent 可以有沙箱没审批，也可以有审批没沙箱。

## DeepSeek Harness（dsh）—— 源码未在本地，结论据公开资料，发布前需对 SAFETY.md 复核

- DeepSeek AI 2026-08-13 开源，MIT，"一切皆插件"（model / tools / storage / approval / sandbox / UI / agent loop 全是可替换插件）。
- **内建 OS 沙箱**，执行前把命令行包一层再 spawn。三档（`ctx.sandbox`）：`read-only`（默认，fail-safe）、`workspace-write`（写限定 workspaceRoot=cwd）、`danger-full-access`（全放开）。
- 平台落地：Linux bwrap-compatible runner（+Landlock）、macOS Seatbelt、Windows ACL 受限令牌；另有远程 E2B 后端做 disposable execution。
- **审批独立于沙箱**：`ask` / `never`；预设 workspace-write=（沙箱 workspace-write + 审批 ask），danger-full-access=（开沙箱 + 审批 never）。核心不含规则引擎，**审批策略由 policy 插件实现**。
- **headless fail-closed**：无审批服务挂载时 `ask` 自动判 deny，"无人值守 agent 不能自我批准"，子 agent 桥默认 reject。CI 友好。
- 边界：文件沙箱只管写，**不管网络、不限读**；官方口径"把沙箱当文件系统 scoping，不是通用安全边界"。
- 与 pi 的关系：同样把策略插件化，但 **dsh 默认自带整套真沙箱**；pi 默认几乎不设防、把 OS 隔离外包。

来源：thenewstack.io/deepseek-harness-open-source-plugins、agenticcontrolplane.com/controls/dsh、habr.com/en/articles/1070958。

## codex（OpenAI，Rust）—— 本地源码已精读，file:line 可引

信任边界不是"用户账号"，而是"工作区目录 + 全盘只读 + 默认禁网"。内建 OS 沙箱是默认第一道防线。

- **平台分派** `sandboxing/src/manager.rs:59`，`SandboxType`（`manager.rs:34`）= None / MacosSeatbelt / LinuxSeccomp / WindowsRestrictedToken。
- **macOS = Seatbelt**（`sandboxing/src/seatbelt.rs`，`/usr/bin/sandbox-exec` 写死防 PATH 注入）。profile `(deny default)`（`seatbelt_base_policy.sbpl:8`），默认全盘只读、写只放行 writable roots、默认无 network 规则且代理推断失败时 fail-closed。
- **Linux = bubblewrap + seccomp**（独立 crate `codex-linux-sandbox`，`linux-sandbox/src/bwrap.rs`：`--ro-bind / /` 全盘只读、`--bind` 可写根、`--unshare-net` 禁网；网络隔离靠 seccomp deny connect/bind，`landlock.rs:165`）。**Landlock 已降级为 legacy 后备**，不是默认。
- **审批 `AskForApproval`**（`protocol/src/protocol.rs:908`）：UnlessTrusted / **OnRequest（默认）** / Granular / Never。无头 `codex exec` 默认改 `Never`（`exec/src/lib.rs:427`）。旧的 suggest/auto-edit/full-auto 命名已移除。
- **沙箱 `SandboxMode`**（`config_types.rs:86`）：ReadOnly（默认）/ WorkspaceWrite / DangerFullAccess。workspace-write 默认可写根 = cwd + /tmp + $TMPDIR（`protocol.rs:1168`）。受信任项目默认升级到 WorkspaceWrite。
- **路径硬隔离在内核层**：可写根之外拒写；**保护子路径 `.git` / `.codex` / `.agents` 即使在可写根内也强制只读**（`protocol/src/permissions.rs:22`），防改 `.git/hooks` 提权。
- **network-proxy crate**：受管 egress 代理，做域名白名单（`NetworkDomainPermission` deny>allow）、Limited/Full 模式、MITM、凭证代填（GitHub/OpenAI）。沙箱内 `--unshare-net` + bridge，只能走这个代理。
- **升级/逃逸**：`SandboxPermissions`（UseDefault/RequireEscalated/WithAdditionalPermissions，`models.rs:36`）。沙箱内失败 → 经用户审批 → 第二次以 `SandboxType::None` 无沙箱重试（`core/src/tools/orchestrator.rs`）。非 OnRequest 档请求升级被拒。
- **一键放开** `--dangerously-bypass-approvals-and-sandbox`（别名 `--yolo`，`utils/cli/src/shared_options.rs:44`）：强制 Never + DangerFullAccess，**官方注释明说"仅供本身已在外部沙箱里运行的环境"**。← 这条直接呼应 pi：codex 认可"外部容器 + 关内建沙箱"，但把它做成需要显式 --yolo 的危险选项，而非默认。
- 待确认：Windows 受限令牌 profile 细节未深入。

## grok-build（xAI，Rust）—— 本地源码已精读，file:line 可引

grok-build 把能力堆得最满，但有一个必须写进文章的反转：**这些防护默认大多不开**。

- **文件系统隔离 `xai-fast-worktree`（不是 OS 沙箱）**：用 CoW（`reflink_copy`，APFS clonefile / Linux FICLONE）/ btrfs subvolume snapshot / overlayfs 廉价地给会话复制一份独立 worktree（`copy/cow.rs:15`、`btrfs/snapshot.rs:19`）。同用户同权限，**不降权**，只是"agent 在副本里干活不碰主工作树"。开关 `IsolationMode { None, Worktree }`。
- **OS 沙箱 `xai-grok-sandbox`（有，但默认关）**：靠 `nono`→Linux Landlock / macOS Seatbelt + seccomp，进程启动时一次性施加、内核强制不可逆（`lib.rs:192` `Sandbox::apply`）。seccomp 手写 BPF：namespace lockdown 防新建 namespace 逃逸（`child_net.rs:62`）+ 子进程网络阻断（`child_net.rs:144`）。**但默认 `off`**：解析顺序 `requirement > CLI > env > config > "off"`（`agent/config.rs:1187`）。内置 profile：workspace / devbox / read-only / strict / off / custom。防篡改设计：项目级 `.grok/sandbox.toml` 只能新增 profile，不能重定义全局同名 profile 掏空其 deny。
- **审批模式**：`PermissionMode`（Default/AcceptEdits/Auto/DontAsk/BypassPermissions/Plan）与 TUI `PermissionModeKind`（Default/Ask/Auto/AlwaysApprove=YOLO）。**默认 Ask**（`permission/types.rs:325`）。`Auto` 档背后是 LLM 分类器（`auto_mode.rs`，启发式 + LLM 双层）。Plan 模式禁一切写入。拦截入口 `PermissionManager::request`（`manager.rs:903`）。
- **企业签名策略闸 `managed_policy_gate`**（≠逐命令审批）：仅当"受管企业主体 + 签名策略被篡改/缺失"时 fail-closed 拒绝启动（`managed_config.rs:1028`）。个人用户不触发。是供应链式防篡改闸，别和逐命令审批混。
- **密钥脱敏 `xai-grok-secrets`（作用于遥测出口，不是模型上下文）**：一组正则识别 `sk-/xai-/AKIA/ghp_/PEM/Bearer/JWT/api_key=` 等，替换为 `[REDACTED_SECRET]`（`sanitizer.rs:8`）。**但只被 `xai-mixpanel`（分析）和 `xai-grok-telemetry`（Sentry 崩溃上报）依赖**，防密钥泄进 xAI 的日志系统。**它不参与"命令输出→发给模型的上下文"**。这点写反会被内行抓，务必表述为"遥测出口脱敏"。
- **bash 管控**：在会话 cwd（隔离时即 worktree）执行，`setsid` 脱离 TTY + 整树 kill。**无硬编码全局黑名单**，取而代之三层：权限规则 DSL（`Bash(git push:*)` deny/ask，`RuleAction` 默认 Deny）+ 安全命令白名单（`SAFE_GIT_SUBCOMMANDS` 等）+ 执行风险闸门 & 文件访问闸门（把复合命令拆开、逐子命令分析读写了哪些文件、堵住用 shell 重定向绕过 deny，`cat .env` 命中 read-deny）。
- **网络**：主进程放开（要连 LLM API）；子进程 seccomp 阻断**仅 read-only/strict profile + 仅 Linux**；域名级 egress 白名单**尚未接线**（`network_policy.rs` 明说是"为将来准备的数据模型，当前运行时不强制"）。

三个"别写反"：① OS 沙箱默认关；② 密钥脱敏只在遥测出口；③ managed_policy_gate 是企业启动闸不是逐命令审批。

## 真正的洞见：能力 ≠ 默认姿态

把四家的"OS 沙箱默认姿态"排一下：

- **默认无 / 关**：pi（根本没有）、grok-build（有一整套却默认 `off`）
- **默认开**：codex（受信任项目默认 workspace-write，内核强制）、DeepSeek Harness（默认 read-only 最严）

也就是说，**默认就把 agent 关进内核沙箱的只有 codex 和 dsh**。grok-build 能力最全，却默认不开；pi 诚实地根本不做。所以"我用的 agent 安全吗"这个问题，答案常常取决于**默认配置和你跑在哪**，而不是它有没有这个能力。这是全文的落点，也是给读者的实用外卖：**别假设你的 agent 替你兜底，去看它默认跑在哪档。**

## 四方对照表（已坐实）

| 维度 | pi | DeepSeek Harness | codex | grok-build |
|---|---|---|---|---|
| OS 沙箱 | 无（故意，外包容器） | 内建，**默认 read-only（开）** | 内建，**默认开**（seatbelt / bwrap+seccomp） | 内建（Landlock/Seatbelt+seccomp），**默认 off（关）** |
| 文件隔离 | 绝对路径，不硬隔离 | workspace-write 限 cwd | 内核硬隔离，`.git/.codex` 强制只读 | worktree 独立副本（CoW/btrfs），不降权 |
| 审批 | 钩子，**默认不拦** | ask/never，插件化，**headless fail-closed** | 4 档，默认 OnRequest（无头默认 Never） | 5 档，默认 Ask，Auto 档走 LLM 分类器 |
| 网络 | 外包 | 沙箱不管网络 | 默认禁网 + 可选域名代理（MITM/凭证代填） | 主进程开；子进程 seccomp 仅 strict/Linux；域名白名单未接线 |
| 逃逸/放开 | 不适用 | danger-full-access 预设 | 审批后无沙箱重试；`--yolo`（注明仅供外部沙箱） | BypassPermissions 档 / 沙箱 off |
| 独门 | 诚实的最小主义 | 沙箱/审批**显式分离** | 网络代理 + 升级审批 + `.git` 保护 | 规则 DSL + 命令语义解析 + 遥测脱敏 |

**两个轴**：sandbox（能做什么）× approval（该不该做），彼此独立。**光谱**：pi（全外包）—— grok-build（能力全但默认关，偏"外包心态"）—— codex / dsh（默认内建强制）。codex 那句 `--yolo` 注释"仅供外部沙箱环境"是全文的收束——连最重装的 codex 都承认"外部容器 + 关内建沙箱"是合法用法，pi 只是把这个默认前提摆到了台面上。
