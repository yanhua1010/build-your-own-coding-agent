# 04 Context Compaction：pi 怎么在有限窗口里保持长记忆

> 主源码：[compaction.ts](https://github.com/earendil-works/pi/blob/main/packages/agent/src/harness/compaction/compaction.ts)（880 行）、[utils.ts](https://github.com/earendil-works/pi/blob/main/packages/agent/src/harness/compaction/utils.ts)（132 行）、[agent-session.ts](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/agent-session.ts)（3324 行，`_checkCompaction` / `_runAutoCompaction`）、[estimate.ts](https://github.com/earendil-works/pi/blob/main/packages/ai/src/utils/estimate.ts)（143 行）、[overflow.ts](https://github.com/earendil-works/pi/blob/main/packages/ai/src/utils/overflow.ts)（168 行）
> 基于 pi commit `5bc1c2c`（2026-07-25）；文中行号以该 commit 为准
> 对应文章：《Pi 上下文压缩的那些事》｜对应代码：[steps/04](../steps/04-compaction/)

## 核心问题

LLM 的 context window 是有限的（Claude 200k，GPT-4o 128k）。一个 coding agent 在长时间工作中会不断积累对话、工具调用结果、thinking 内容。当 context 快满的时候，agent 需要一种机制来"压缩"历史，同时保留足够的上下文让工作能继续。

pi 的解决方案是 **compaction**——用 LLM 把旧对话总结成结构化摘要，保留最近的消息原文，用摘要替代更早的历史。

## 架构分层

compaction 的代码跨两个包：

| 层 | 位置 | 职责 |
|---|---|---|
| 核心算法 | `pi-agent-core/harness/compaction/compaction.ts` | 纯函数：估算 token、判断是否触发、找切割点、生成摘要 |
| 工具函数 | `pi-agent-core/harness/compaction/utils.ts` | 文件操作提取、对话序列化 |
| 分支摘要 | `pi-agent-core/harness/compaction/branch-summarization.ts` | session tree 切换分支时的摘要 |
| 触发调度 | `pi-coding-agent/core/agent-session.ts` | `_checkCompaction` 决策 + `_runAutoCompaction` 执行 |
| Harness 封装 | `pi-agent-core/harness/agent-harness.ts` | `compact()` 方法，暴露给外部调用和扩展钩子 |
| token 估算 | `pi-ai/utils/estimate.ts` | context 级别估算，考虑 system prompt + tools 占用 |
| overflow 检测 | `pi-ai/utils/overflow.ts` | 多 provider 溢出错误模式匹配 |

## 两种触发路径

`_checkCompaction` 在两个时机被调用：
1. **agent_end 之后**（`handleAgentEnd` → `_checkCompaction(msg)`）——每轮对话结束时检查
2. **prompt 提交之前**（`prompt()` → `_checkCompaction(lastAssistant, false)`）——用户发新消息前兜底

两种触发原因，处理方式不同：

### Case 1: Overflow（溢出恢复）

条件：`isContextOverflow(assistantMessage, contextWindow)` 返回 true

`isContextOverflow` 的检测逻辑（`overflow.ts`）：
- **错误匹配**：stopReason === "error" 且 errorMessage 匹配 OVERFLOW_PATTERNS（约 25 种正则，覆盖 Anthropic / OpenAI / Google / xAI / Groq / 国产模型等）
- **静默溢出**：stopReason === "stop" 但 usage.input > contextWindow（z.ai 风格）
- **截断溢出**：stopReason === "length" + output === 0 + input ≥ 99% contextWindow（小米 MiMo 风格）
- **排除项**：NON_OVERFLOW_PATTERNS 过滤 throttling/rate-limit 误匹配

overflow 的处理：
1. 从 agent state 删除错误的 assistant message（不进 context，但保留在 session 历史里）
2. 设 `_overflowRecoveryAttempted = true`（防止无限循环，只允许一次 compact-and-retry）
3. `_runAutoCompaction("overflow", willRetry=true)` 执行 compaction
4. compaction 完成后自动重试用户的请求（`agent.continue()`）

如果 overflow 后 compaction 又溢出，就放弃重试，通知用户换更大 context 模型。

### Case 2: Threshold（阈值触发）

条件：`shouldCompact(contextTokens, contextWindow, settings)` 返回 true

```typescript
function shouldCompact(contextTokens, contextWindow, settings) {
  if (!settings.enabled) return false;
  return contextTokens > contextWindow - settings.reserveTokens;
}
```

默认 `reserveTokens = 16384`，也就是在距离 context window 顶还剩约 16k token 时触发。

threshold 触发后 **不自动重试**——compaction 完成，等用户下一条消息。

## token 估算机制

这是 compaction 决策的基础设施。两层估算：

### 消息级估算（`estimateTokens`）

简单粗暴：字符数 / 4。分角色处理：
- user：正文字符 / 4，图片按 4800 字符算
- assistant：text + thinking + toolCall(name + JSON.stringify(arguments)) 字符 / 4
- toolResult：字符 / 4
- bashExecution：command + output 字符 / 4
- compactionSummary / branchSummary：summary 字符 / 4

### Context 级估算（`estimateContextTokens`）

核心思路：**优先用 provider 返回的真实 usage，只对 usage 之后新增的消息做估算**。

```
估算 tokens = lastUsage.totalTokens + sum(trailing messages estimate)
```

如果没有任何 usage 数据（比如全新 session），退化为纯估算。

Context 级估算（`pi-ai/utils/estimate.ts`）还考虑了 system prompt 和 tools 定义占用的 token（新增的工具定义需要估算）。

一个微妙的细节：`getLastAssistantUsageInfo` 检查 timestamp 顺序——如果 compaction summary 插入在 assistant message 之后（timestamp 更新），那个 assistant 的 usage 就不再适用于当前 prefix，会被跳过。

## 切割点算法

`findCutPoint(entries, startIndex, endIndex, keepRecentTokens)` 决定保留多少最近内容。

默认 `keepRecentTokens = 20000`，算法从后往前累加消息 token 数：

1. 从 entries 末尾往前扫描，累加每条消息的 estimateTokens
2. 累加到 ≥ keepRecentTokens 时停下
3. 找到这个位置附近的合法切割点（user message / assistant / custom_message / branch_summary 等，但不含 toolResult）
4. 如果切割点落在一轮对话中间（不是 user message 开头），标记为 "split turn"
5. 往前退让，跳过 compaction entry 和非 message entry

切割点之前的消息进摘要，切割点之后的消息保持原文。

### Split Turn 处理

当切割点落在一轮对话的中间（比如 assistant 的工具调用序列太长），compaction 做两轮 LLM 调用：
1. 第一轮：摘要 history（切割点之前的所有消息）
2. 第二轮：摘要 turn prefix（切割点所在 turn 的前半段），用专门的 `TURN_PREFIX_SUMMARIZATION_PROMPT`

两段摘要拼接，用 `---` 和 `**Turn Context (split turn):**` 分隔。

## 摘要生成

### System Prompt

固定不变：
> You are a context summarization assistant. Your task is to read a conversation between a user and an AI assistant, then produce a structured summary following the exact format specified.
> Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.

### 两种 User Prompt

**首次摘要**（`SUMMARIZATION_PROMPT`）：
```
## Goal
## Constraints & Preferences
## Progress
### Done / In Progress / Blocked
## Key Decisions
## Next Steps
## Critical Context
```

**迭代更新**（`UPDATE_SUMMARIZATION_PROMPT`）：
如果之前已有 compaction summary，用 `<previous-summary>` 包裹旧摘要，要求模型在旧摘要基础上增量更新：
- PRESERVE 旧信息
- ADD 新进展
- UPDATE 进度（In Progress → Done）
- 移除不再相关的内容

### 输入格式

对话被 `serializeConversation` 序列化为纯文本：
```
[User]: ...
[Assistant thinking]: ...
[Assistant]: ...
[Assistant tool calls]: edit(path=..., edits=...); read(path=...)
[Tool result]: ... (截断到 2000 字符)
```

用 `<conversation>` 标签包裹送给摘要模型。

### 输出约束

`maxTokens = min(0.8 * reserveTokens, model.maxTokens)`

首次摘要用 80% 的 reserveTokens（约 13k tokens），split turn 的前缀摘要用 50%。

### 文件操作追踪

compaction 完成后，摘要末尾附加 `<read-files>` 和 `<modified-files>` 标签，记录被压缩区间内所有文件操作。下次 compaction 时，从上一次的 compaction entry 继承旧的文件列表，再累加新的。

```typescript
extractFileOperations → 从 assistant tool calls 提取 read/write/edit 操作
computeFileLists → 区分 read-only 和 modified
formatFileOperations → 格式化为 XML 标签附加到摘要末尾
```

## Provider 请求隔离

`completeSimpleWithRetries` 为 compaction 的 LLM 调用设置了特殊选项：
- `cacheRetention: "none"`——不使用也不写入提示缓存，因为摘要请求是一次性的
- `sessionId: uuidv7()`——全新的 session ID，路由隔离，避免影响主对话

## 扩展机制

两个扩展钩子：

### `session_before_compact`

在 compaction 执行前触发。扩展可以：
- `cancel: true` 取消 compaction
- 返回自定义 `compaction` 对象覆盖默认行为（自定义摘要内容/使用不同模型）

示例：`custom-compaction.ts` 用 Gemini Flash 做摘要（更便宜/更快）

### `session_compact`

compaction 完成后触发，携带 compaction entry。只读通知。

### 手动触发

`trigger-compact.ts` 示例展示了在 `turn_end` 事件中监控 token 数，超过阈值时调用 `ctx.compact()` 主动触发。

## 分支摘要（Branch Summarization）

session tree 允许用户在对话分支间切换。切换时，pi 为离开的分支生成摘要：

1. `collectEntriesForBranchSummary`：找到旧分支和新分支的最近公共祖先，收集旧分支独有的 entries
2. `prepareBranchEntries`：从后往前选择消息，控制在 token 预算内
3. `generateBranchSummary`：用 LLM 生成摘要，附加文件操作列表
4. 摘要以 `branch_summary` entry 写入 session tree，并以 user message 形式注入到新分支的对话历史

摘要前缀：
> The user explored a different conversation branch before returning here.
> Summary of that exploration:

## 边界情况处理

### 1. Model 切换后的溢出检查
`_checkCompaction` 检查 `sameModel`——如果用户从小窗口模型切换到大窗口模型，旧模型的 overflow 错误不应该触发新模型的 compaction。

### 2. 无限循环防护
`_overflowRecoveryAttempted` 标志位：overflow compaction 只尝试一次。如果 compact 后仍然溢出，放弃重试，通知用户。agent_end 成功时或新 prompt 时重置该标志。

### 3. Compaction 之前的 stale usage
两处防护：
- `assistantIsFromBeforeCompaction`：如果 assistant message 的 timestamp 早于最新 compaction entry，跳过检查
- `estimate.ts` 里 `getLastAssistantUsageInfo` 的 timestamp 检查：prefix 消息的 usage 不适用于 compaction 后重建的 context

### 4. 错误和零 usage 消息
`_checkCompaction` 对 `stopReason === "error"` 或 `directContextTokens === 0` 的消息，退化为 `estimateContextTokens(messages)` 全局估算，但验证 usage 来源不是 compaction 前的。

### 5. Session 最后条目是 compaction
`prepareCompaction` 开头检查：如果 session 最后一条就是 compaction entry，返回 undefined（没必要再 compact）。

### 6. 多 provider 溢出模式
`overflow.ts` 维护了约 25 种正则模式覆盖主流和国产 provider 的溢出错误格式，还有 NON_OVERFLOW_PATTERNS 排除 throttling / rate-limit 误匹配。

## 数据流总结

```
agent_end
  → _checkCompaction(assistantMessage)
    → isContextOverflow? → overflow path
    → shouldCompact? → threshold path
      → _runAutoCompaction(reason, willRetry)
        → prepareCompaction(entries, settings)
          → findCutPoint → 切割点
          → 分离 messagesToSummarize / retainedTail
        → extension hook: session_before_compact
        → compact(preparation, model, ...)
          → generateSummaryWithUsage → LLM call
          → (split turn?) generateTurnPrefixSummary → LLM call
          → 附加 file operations
        → sessionManager.appendCompaction(summary, ...)
        → 重建 agent.state.messages
        → extension hook: session_compact
        → (overflow + willRetry?) → agent.continue() 自动重试
```

## 关键数字

| 参数 | 默认值 | 含义 |
|---|---|---|
| reserveTokens | 16384 | context window 末尾预留的安全区，触发阈值 = window - reserve |
| keepRecentTokens | 20000 | compaction 后保留多少最近消息的 token |
| CHARS_PER_TOKEN | 4 | 字符到 token 的估算比率 |
| ESTIMATED_IMAGE_CHARS | 4800 | 每张图片估算的字符数 |
| TOOL_RESULT_MAX_CHARS | 2000 | 序列化时 tool result 截断长度 |
| maxTokens (summary) | 0.8 * reserveTokens ≈ 13107 | 摘要 LLM 输出上限 |
| maxTokens (turn prefix) | 0.5 * reserveTokens ≈ 8192 | split turn 前缀摘要输出上限 |
