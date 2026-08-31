# Step 04 · Context Compaction

对应系列文章第 4 篇。

前三步的 agent 已经能跑了，但对话越来越长时 context window 会满，API 直接报错。这一步加入 compaction：旧对话用 LLM 总结成摘要，最近的消息保留原文，用摘要替代更早的历史。

## 运行

```bash
export DEEPSEEK_API_KEY=sk-你的key
node agent.mjs "把 src 下所有 .js 文件的行数统计出来"
```

也支持智谱和 Kimi：

```bash
export GLM_API_KEY=xxx
export MOONSHOT_API_KEY=xxx
LLM_PROVIDER=glm node agent.mjs "任务"
```

设一个小窗口可以更快触发 compaction：

```bash
CONTEXT_WINDOW=8192 node agent.mjs "任务"
```

不带参数进入交互模式，`exit` 退出。

## 不用 API key 也能看的两个演示

```bash
node demo-compaction.mjs
```

用预置的长对话模拟 compaction 过程，看切割点怎么选、序列化长什么样、压缩后的 context 结构。

```bash
node test.mjs
```

30 个用例覆盖 token 估算、触发判断、切割点、序列化、文件操作提取、overflow 检测。

## 文件结构

```
compaction.mjs        token 估算 + 切割点 + 摘要生成  ← pi: harness/compaction/compaction.ts
overflow.mjs          overflow 检测                  ← pi: ai/utils/overflow.ts
agent.mjs             主循环 + compaction 集成        ← pi: coding-agent/agent-session.ts
demo-compaction.mjs   离线演示
test.mjs              离线测试
```

`event-stream.mjs`、`providers.mjs`、`tools.mjs`、`tool-runner.mjs`、`validate.mjs`、`mutation-queue.mjs`、`api/` 和 step 03 完全一样。

## 这一步新增了什么

| 能力 | 实现位置 | pi 对应物 |
|---|---|---|
| token 估算（字符/4 + 真实 usage） | `compaction.mjs` 的 `estimateMessageTokens` / `estimateContextTokens` | `compaction.ts:59` + `estimate.ts:44` |
| 阈值触发 | `shouldCompact` | `compaction.ts:182` |
| 切割点算法 | `findCutPoint` | `compaction.ts:246` |
| 对话序列化 | `serializeConversation` | `utils.ts:28` |
| 文件操作追踪 | `extractFileOperations` / `formatFileOperations` | `utils.ts:55-97` |
| 结构化摘要生成 | `generateSummary` | `compaction.ts:395` |
| 增量更新（旧摘要 + 新对话） | `UPDATE_PROMPT` + `<previous-summary>` | `compaction.ts:140` |
| overflow 检测 | `isContextOverflow` | `overflow.ts:45` |
| 溢出恢复（compact + 自动重试） | `agent.mjs` overflow 分支 | `agent-session.ts:2047` |
| 溢出恢复只尝试一次 | `overflowRecoveryAttempted` | `agent-session.ts:2083` |

## 两种触发路径

| | 阈值触发 | 溢出恢复 |
|---|---|---|
| 条件 | `contextTokens > window - reserveTokens` | API 返回 overflow 错误 |
| 时机 | 每轮对话结束后检查 | 收到 assistant message 时 |
| 事后处理 | 压缩完等用户下一条消息 | 删除失败消息，压缩后自动重试 |
| 重试 | 不重试 | 最多重试一次 |

## 关键数字

| 参数 | 默认值 | 环境变量覆盖 |
|---|---|---|
| contextWindow | 200000 | `CONTEXT_WINDOW` |
| reserveTokens | 16384 | |
| keepRecentTokens | 20000 | |
| 字符/token | 4 | |
| 摘要 max_tokens | 13107 (0.8 * reserveTokens) | |

小窗口模式下 reserveTokens 和 keepRecentTokens 会自动按比例缩小。

## 可以自己跑一遍的场景

**1. 设一个小窗口**

```bash
CONTEXT_WINDOW=8192 node agent.mjs
```

让 agent 做几轮对话就会触发压缩。观察压缩前后 context 的变化。

**2. 让 agent 连续读很多文件**

```bash
node agent.mjs "把当前目录下所有 .mjs 文件逐个读一遍，总结每个文件的职责"
```

到快满时观察摘要里的 `<read-files>` 和 `<modified-files>` 列表。

**3. 改阈值看效果**

在 `agent.mjs` 里把 `CONTEXT_WINDOW` 改成 4096，每一轮对话都会触发压缩，能清楚看到增量更新的摘要。

## 练习

1. 给 `findCutPoint` 加一个检查：如果切割点落在 assistant 的 tool_calls 和对应 tool results 之间，把整组挪到保留区。对比 pi 的 split turn 处理
2. 在 `generateSummary` 里把 provider 换成一个更便宜的模型（比如 DeepSeek 的 deepseek-chat 做摘要，主对话用 deepseek-reasoner），对比 pi 的 `custom-compaction.ts` 示例
3. 给 compaction 加计时日志，统计摘要生成花了多少 token 和多少毫秒，算一下每次压缩的成本
4. 实现手动触发：在交互模式下输入 `/compact` 立即执行一次压缩，不等阈值
5. 给 `extractFileOperations` 加上 `bash` 工具的文件操作检测（解析 `cat`、`mkdir`、`touch` 等命令里的路径）
