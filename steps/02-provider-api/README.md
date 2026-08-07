# Step 02 · 流式输出与「绝不 reject」的错误契约

对应系列文章第 2 篇《统一 LLM API 与错误契约》。

step 01 是一次性拿完整回复，出错就抛异常。这一步换成流式，并且立下一条规矩：**调用模型的函数永远不 throw**。所有失败都变成一条带 `stopReason` 的消息还给上层。

## 运行

```bash
export DEEPSEEK_API_KEY=sk-你的key
node agent.mjs "写一个 fib.js 实现斐波那契，并运行验证前 10 项"
```

也支持智谱和 Kimi，设对应的 key 即可，代码一行都不用改：

```bash
export GLM_API_KEY=xxx          # 智谱 GLM
export MOONSHOT_API_KEY=xxx     # 月之暗面 Kimi
LLM_PROVIDER=glm node agent.mjs "任务"
```

不带参数进入交互模式，`exit` 退出。

> 教学用途：`run_command` 会真实执行模型给出的命令，请在专门的空目录里运行。

## 文件结构

目录本身就是这一篇的重点，它照着 pi 的分层拆开：

```
event-stream.mjs           事件流       ← pi: packages/ai/src/utils/event-stream.ts
providers.mjs              服务商配置    ← pi: packages/ai/src/providers/*.ts
api/openai-completions.mjs 协议实现      ← pi: packages/ai/src/api/openai-completions.ts
agent.mjs                  内核循环      ← pi: packages/agent/src/agent-loop.ts
```

三家 provider 共用一份 `api/openai-completions.mjs`。pi 里这个数字是 **20 家 provider 共用一个实现**，因为它们都兼容 OpenAI 的 completions 格式。API（协议格式）和 Provider（服务商）是两个维度，这是 pi 用 11 个实现覆盖 38 家服务商的根本原因。

## 三个可以自己跑一遍的场景

**1. key 写错，agent 不崩溃**

```bash
DEEPSEEK_API_KEY=sk-wrong node agent.mjs "读一下 package.json"
```

输出会是这样，退出码仍然是 0：

```
[出错了] HTTP 401 Authorization Required
{"error":{"message":"Authentication Fails, Your api key: ****rong is invalid", ...}}
```

provider 的原始报错被原样带了上来。排查问题时这句最有用，很多封装会把它吞掉只留一句「请求失败」。

**2. 生成到一半按 Ctrl+C**

`stopReason` 会是 `aborted` 而不是 `error`。用户主动取消和真实故障是两种语义，混在一起上层就没法区分该不该重试。

**3. 中途断网，已经收到的内容还在**

把 wifi 关掉再发一次请求，你会看到：

```
[出错了] fetch failed
[已收到的部分回复仍然保留，共 47 字符]
```

这是 `api/openai-completions.mjs` 里最值得看的一行：`output` 对象在 `try` 之前就构造好了，异常发生时已经解析出来的文本和工具调用都还在里面。如果直接 `throw`，这些内容就全丢了。

## 这一步新增了什么

| 能力 | 实现位置 | pi 对应物 |
|---|---|---|
| 事件流（push/waiting 双队列） | `event-stream.mjs` | `utils/event-stream.ts:4` |
| 同步返回流，异步在后台跑 | `api/openai-completions.mjs` 的 `stream()` | `api/lazy.ts:46` `lazyStream` |
| 所有失败收敛成 `stopReason` | 同上的 `catch` 块 | `openai-completions.ts:583` |
| 五种 `stopReason` | `stop / length / toolUse / error / aborted` | `types.ts:382` |
| 主循环用分支而不是 try/catch | `agent.mjs` 的 `agentLoop` | `agent-loop.ts:196` |
| provider 配置与协议实现分离 | `providers.mjs` | `providers/deepseek.ts`（15 行） |
| 流式工具调用参数拼接 | `appendToolCall` | `openai-completions.ts` 同名逻辑 |
| 临时字段清理 | `finalizeToolCalls` | `openai-completions.ts:584` 的 delete 循环 |

## 和 step 01 比，循环变在哪

step 01：

```javascript
const msg = await chat(messages);        // 出错直接 throw，整个 agent 挂掉
```

step 02：

```javascript
const events = stream(provider, messages, toolSchemas, signal);  // 同步返回，从不 throw
for await (const event of events) { ...边收边打印... }
const message = await events.result();

if (message.stopReason === "error" || message.stopReason === "aborted") {
	...优雅退出，部分内容还在...
	return;
}
```

`stream()` 的返回值不是 Promise，所以调用方**无处 await，也就无处 catch**。契约不是靠注释约定的，是靠函数签名保证的。

## 自测

```bash
node test.mjs
```

26 个用例，不打网络，用假的 SSE 响应覆盖上面三个场景加上截断防御。改完代码跑一遍就知道契约有没有破。

## 练习

1. 加第四家 provider（硅基流动、Together 都是 OpenAI 兼容），看看是不是真的只用改 `providers.mjs`
2. 在请求体里加 `max_tokens: 30`，让模型的工具调用被截断，观察 `stopReason === "length"` 时整批工具调用被作废
3. 在 `EventStream.push` 里打印 `queue.length` 和 `waiting.length`，跑一次就能看清双队列什么时候切换
4. 把 `output` 的构造挪到 `try` 里面，重跑场景 3，对比部分内容是不是丢了
