# Step 05 · 权限与安全

对应系列文章第 5 篇。

前四步的 mini-agent 已经能跑、能调工具、能长时间工作。这一步给它加上执行前的审批，并把 bash 这一层的几件工程加固补上。

核心是分清两个词。工具执行前的那道挂载点（`beforeToolCall`）在第 3 步就搭好了，写在 `tool-runner.mjs` 里，这是机制。挂在这道口子上的具体规则是策略。pi 的做法是机制内置、策略默认留空，你要就自己挂。这一步填的就是策略。

## 三档默认姿态

`permission.mjs` 把审批做成三档，对应文章里“能力不等于默认”这一节。

| 姿态 | 行为 | 谁是这个路子 |
|---|---|---|
| `off` | 危险命令也放行，不逐命令拦 | pi 的默认（以你的身份跑，交给外部沙箱或你自己） |
| `ask` | 危险命令先问一句（本 mini-agent 默认） | grok-build 默认 Ask |
| `strict` | 危险命令直接拒 | codex / dsh 的 fail-closed |

危险命令的判定在 `classifyCommand`，是一张提示表，不是黑名单。pi 的 bash 根本没有这一层，grok-build 用的是更复杂的规则 DSL 加命令语义解析。

## 运行

```bash
export DEEPSEEK_API_KEY=sk-你的key
node agent.mjs "把 src 下所有 .js 文件的行数统计出来"
```

调审批姿态：

```bash
AGENT_APPROVAL=strict node agent.mjs "任务"
AGENT_APPROVAL=off node agent.mjs "任务"
```

打开外部沙箱（仅 macOS，bash 命令走 sandbox-exec）：

```bash
AGENT_SANDBOX=on node agent.mjs "任务"
```

也支持智谱和 Kimi：

```bash
GLM_API_KEY=xxx LLM_PROVIDER=glm node agent.mjs "任务"
```

## 不用 API key 也能看的两个演示

```bash
node demo-security.mjs
```

离线跑一遍命令分类、三档姿态、env 清洗、sandbox-exec 包裹，全部不打网络。

```bash
node test.mjs
```

35 个用例覆盖命令分类、三档策略、env 清洗、沙箱包裹。

## 文件结构

```
permission.mjs   审批策略：三档姿态 + 危险命令分类   ← 填 pi 留空的 tool_call 钩子
sandbox.mjs      env 清洗 + 进程树 kill + sandbox-exec 包裹   ← pi 的 bash.ts
trust.mjs        工作区信任门最小版                 ← pi 的 trust-manager.ts
agent.mjs        主循环，把上面三个接起来
demo-security.mjs  离线演示
test.mjs           离线测试
```

其余文件（`tool-runner.mjs`、`compaction.mjs`、`overflow.mjs`、`validate.mjs`、`mutation-queue.mjs`、`event-stream.mjs`、`providers.mjs`、`api/`）和第 4 步一样。`tools.mjs` 只改了 bash：换成清洗 env、独立进程组、可选套沙箱的加固版。

## 机制在哪，策略在哪

| | 位置 | 谁提供 |
|---|---|---|
| 机制，执行前拦一下 | `tool-runner.mjs` 的 `beforeToolCall` | 第 3 步就搭好，pi 内置 |
| 策略，拦什么、怎么问 | `permission.mjs` | 这一步填，pi 默认留空 |

这就是文章的落点：pi 把机制做好、策略留空，是一种诚实。默认拦不拦、拦到什么程度，是你要替自己回答的问题。

## 四个 agent 的安全姿态

| | OS 沙箱 | 审批 | 路径隔离 |
|---|---|---|---|
| pi | 无（外包容器） | 钩子，默认不拦 | 不硬隔离 |
| DeepSeek Harness | 内建，默认只读 | ask / never，headless fail-closed | workspace-write 限 cwd |
| codex | 内建，默认开 | 多档，默认 OnRequest | 内核硬隔离，.git 强制只读 |
| grok-build | 内建，默认关 | 多档，默认 Ask | worktree 独立副本 |

## 和 pi 源码的对照

| 能力 | 这里 | pi |
|---|---|---|
| `beforeToolCall` 挂载点 | `tool-runner.mjs` | `agent-loop.ts` prepareToolCall |
| 审批策略 | `permission.mjs` createPermissionHook | 默认留空，靠扩展挂 tool_call |
| env 清洗 | `sandbox.mjs` cleanEnv | `bash.ts` resolveSpawnContext |
| 进程树 kill | `sandbox.mjs` killTree | `bash.ts` killProcessTree |
| spawnHook 套沙箱 | `sandbox.mjs` wrapWithSandbox | `bash.ts` spawnHook |
| 工作区信任 | `trust.mjs` | `trust-manager.ts` |
| 文件限制在 cwd | `tools.mjs` safePath | pi 不做（文件工具接受绝对路径） |

最后一行是个有意思的分歧。这个 mini-agent 的 `safePath` 把文件读写硬限制在工作目录内，pi 不这么做。谁对没有定论，是不同的默认姿态。

## 可以自己跑的场景

1. 三档姿态对比。让 agent 删点东西，分别用 `off` / `ask` / `strict` 跑一遍，看拦截行为的差别。
2. env 清洗。让 agent 执行 `env | grep KEY`，看它在子进程里拿不到你的 API key。
3. 信任门。在工作目录放一个 `AGENTS.md`，重启 agent，看它加载之前问不问你信任。
4. 外部沙箱。`AGENT_SANDBOX=on`，让 agent 往工作目录外面写文件，看内核层怎么把它拦下来。

## 练习

1. 给 `permission.mjs` 加一档 `auto`，用一个启发式（或再调一次便宜模型）判断命令危不危险，对比 grok-build 的 auto 分类器。
2. 把 `safePath` 的硬拒绝改成“写工作目录外要审批”，体会 pi（不限）、这个 mini-agent（硬限）、codex（内核限）三种路径姿态。
3. 给 `wrapWithSandbox` 加一个 Linux 分支，用 bwrap 或 unshare 做等价隔离，对比 codex 的 Linux 沙箱。
4. 实现 pi 的两遍加载：先在不信任前提下加载最小配置，拿到信任决定后再加载完整的项目配置。
5. 给审批加一条规则 DSL，比如 `bash(git push:*) = ask`，让用户按命令模式配 allow / ask / deny，对比 grok-build 的 PermissionRule。
