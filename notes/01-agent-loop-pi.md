# 研读笔记 01：pi 的 agent loop

> 源码：[packages/agent/src/agent-loop.ts](https://github.com/earendil-works/pi/blob/main/packages/agent/src/agent-loop.ts)（793 行）
> 版本：pi-agent-core 0.82.1，commit `5bc1c2c`（2026-07-25）。文中行号以该 commit 为准。

## 一句话总结

pi 把"agent"实现为一个**双层 while 循环 + 事件流**：内层循环处理工具调用和用户插话，外层循环处理"agent 本该停下但用户又排队了新消息"的续跑；整个过程中 loop 不直接操作 UI，只往外 emit 事件。

## 核心结构（runLoop, L155-275）

```
外层 while(true)                        ← 处理 follow-up 消息（排队的后续任务）
  内层 while(有工具调用 || 有插话消息)
    1. 注入 pending 的 steering 消息      ← 用户在 agent 干活时插的话
    2. streamAssistantResponse()          ← 唯一一次 LLM 调用/轮
    3. 收集 message 里的 toolCall
    4. executeToolCalls()                 ← 串行或并行执行
    5. 工具结果 push 回 context
    6. prepareNextTurn / shouldStopAfterTurn 钩子
    7. 再取一次 steering 消息
  内层退出 → 取 follow-up 消息，有就 continue，没有就 break
emit(agent_end)
```

## 值得写进文章的 6 个设计点

### 1. Agent = 循环，不是框架魔法
最小本质就是：调 LLM → 有 toolCall 就执行 → 结果塞回消息列表 → 再调 LLM，直到模型不再要求调工具。pi 的实现证明这件事 800 行写完。

### 2. 事件流解耦 UI（L25, emit sink）
`runLoop` 只接受一个 `emit: (event) => void`。`agent_start / turn_start / message_update / tool_execution_start...` 全部事件化。TUI、Web、无头模式都是这些事件的不同消费者。**教学价值：初学者最容易把 print 写进 loop 里，pi 展示了正确的边界。**

### 3. Steering messages：用户插话（L166-167, L181-190, L259）
每轮结束后调 `config.getSteeringMessages?.()`，把用户在 agent 干活期间输入的内容注入到下一次 LLM 调用之前。"能被打断/引导"是好用 agent 和玩具 agent 的分水岭。

### 4. 工具执行的三段式流水线：prepare → execute → finalize
- `prepareToolCall`（L600）：找工具 + 参数校验 + `beforeToolCall` 钩子（**权限拦截就挂在这**，返回 block 即拒绝）
- `executePreparedToolCall`（L666）：真正执行，支持 partialResult 流式更新
- `finalizeExecutedToolCall`（L709）：`afterToolCall` 钩子可改写结果
串行/并行两种模式（L411-426）：任一工具声明 `executionMode: "sequential"` 则整批降级为串行。

### 5. 错误不抛出，变成 ToolResultMessage 喂回模型
工具不存在、参数校验失败、执行抛异常——全部变成 `isError: true` 的工具结果消息返回给模型，让模型自己重试/纠正。**Agent 的健壮性来自"把错误还给模型"而不是"把错误抛给用户"。**

### 6. 被 token 上限截断的防御（L208-214, L381）
`stopReason === "length"` 时，消息里所有 toolCall 的参数都可能被截断——流式 JSON 用了 salvage parser，截断的参数可能"看起来合法"。pi 的做法：**全部标记失败，一个都不执行**，让模型重发。这是典型的"只有真踩过坑才会写的代码"。

## 其他线索（后续文章用）

- `transformContext` 钩子（L290）= context 压缩/裁剪的挂载点 → 文章 4
- `convertToLlm`（L295）：AgentMessage → Message 只在 LLM 调用边界发生 → 文章 2（pi-ai 统一 API）
- `getApiKey` 每轮解析（L305）：支持会过期的 token
- AbortSignal 贯穿所有层：随时可取消
