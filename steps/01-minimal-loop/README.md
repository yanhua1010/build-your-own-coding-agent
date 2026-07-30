# Step 01 · 最小可用的 coding agent

**一个文件、约 110 行、零依赖。** 对应系列文章第 1 篇《Agent 的本质是一个 while 循环》。

它已经是一个"真"的 coding agent：能读文件、写文件、跑命令，自己决定用哪个工具、用几次。

## 运行

```bash
export DEEPSEEK_API_KEY=sk-你的key   # 也支持 LLM_BASE_URL / LLM_MODEL 换其他兼容 OpenAI 协议的模型
node agent.mjs "写一个 fib.js 实现斐波那契，并运行验证前 10 项"
```

不带参数进入交互模式，`exit` 退出。

> ⚠️ 教学用途：`run_command` 会真实执行模型给出的命令，请在专门的空目录里运行。

## 这 110 行里对应了 pi 的什么

| 本文件 | pi 对应物 | 差距 |
|---|---|---|
| `agentLoop` 的 while | `runLoop` 内层循环 | pi 有 steering 插话、事件流、钩子 |
| 交互模式的外层 while | follow-up 外层循环 | pi 是消息队列，非阻塞 |
| `catch` 后把错误塞回对话 | `createErrorToolResult` | 一致（这是 agent 的关键直觉） |
| `safePath` | 权限钩子 `beforeToolCall` | pi 是可插拔的策略层 |
| 无 | 流式输出、token 截断防御、并行工具执行 | 后续 step 逐个补上 |

## 练习

1. 加一个 `list_dir` 工具，看模型什么时候会主动用它
2. 把 `run_command` 改成执行前需要用户按回车确认——你就实现了权限系统的雏形
3. 故意把一个工具的 JSON schema 写错，观察模型怎么反复重试（错误回喂的价值）
