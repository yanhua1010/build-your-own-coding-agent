# Step 03 · 一次工具调用从头到尾经过什么

对应系列文章第 3 篇。

第 2 篇立的规矩是**调用模型的函数永远不 throw**。这一步立的是一条方向相反的规矩：**工具函数必须 throw**。

pi 在 `types.ts:388` 写得很直白：

> Execute the tool call. Throw on failure instead of encoding errors in `content`.

两条规则相反，因为错误的接收方不同。模型调用失败，接收方是程序，程序处理不了网络故障，只能优雅退出；工具执行失败，接收方是模型，模型读懂"文件不存在"之后会自己 `ls` 排查。所以工具要把异常抛出来，由流水线接住，变成一条 `isError` 的结果喂回去。

## 运行

```bash
export DEEPSEEK_API_KEY=sk-你的key
node agent.mjs "把 src 下所有 .js 文件的行数统计出来，写进 stats.txt"
```

也支持智谱和 Kimi，代码一行不用改：

```bash
export GLM_API_KEY=xxx          # 智谱 GLM
export MOONSHOT_API_KEY=xxx     # 月之暗面 Kimi
LLM_PROVIDER=glm node agent.mjs "任务"
```

不带参数进入交互模式，`exit` 退出。

> 教学用途：`bash` 工具会真实执行模型给出的命令，请在专门的空目录里运行。加 `PERMISSION=ask` 可以让每条命令都先问你一次。

## 不用 API key 也能看的一幕

```bash
node demo-order.mjs
```

模拟模型一次发出三个调用，耗时 3s / 1s / 2s：

```
模型给出的调用顺序： call_1(3s)  call_2(1s)  call_3(2s)

实时事件（完成顺序）：
  +1.0s  完成  call_2  ← 谁快谁先
  +2.0s  完成  call_3  ← 谁快谁先
  +3.0s  完成  call_1  ← 谁快谁先

喂回模型的 toolResult 顺序：
  call_1  睡了 3 秒
  call_2  睡了 1 秒
  call_3  睡了 2 秒

总耗时 3.0s（串行的话是 6s）
```

完成顺序是 2-3-1，消息顺序还是 1-2-3。**执行是并发的，写进对话历史的顺序是确定的**，重放同一段历史一定得到同一个结果。

## 文件结构

```
tool-runner.mjs      三段式流水线 + 并行执行  ← pi: agent-loop.ts:411-792
tools.mjs            工具定义                ← pi: harness/tools/*.ts
validate.mjs         参数校验                ← pi: ai/utils/validation.ts:278
mutation-queue.mjs   按文件排队              ← pi: harness/tools/file-mutation-queue.ts
agent.mjs            主循环 + 权限钩子        ← pi: agent-loop.ts:155
```

`event-stream.mjs`、`providers.mjs`、`api/` 和 step 02 完全一样，没改一个字。

pi 的 `agent-loop.ts` 一共 792 行，第 375 行往后全是工具执行，418 行，占了一半多。模型那边只有一个 `stream()` 调用，工具这边有这么多，因为工具要真的去动世界。

## 三段式流水线

一次调用被拆成三个函数，各自的失败处理方式不一样。

| 阶段 | 做什么 | 失败了怎么办 |
|---|---|---|
| **prepare** | 找工具 → `prepareArguments` 兼容层 → schema 校验 → `beforeToolCall` 钩子 → 中断检查 | 返回错误结果，工具压根不执行 |
| **execute** | 调 `tool.execute`，收 `onUpdate` 增量 | catch 住异常，转成 `isError` 结果 |
| **finalize** | `afterToolCall` 钩子可以改写结果 | 钩子自己抛异常也被吃掉，不影响主循环 |

**prepare 阶段是串行的**，即使整批要并行执行。因为 `beforeToolCall` 需要按模型给出的顺序看到每一次调用，权限决策不能乱序。

## 这一步新增了什么

| 能力 | 实现位置 | pi 对应物 |
|---|---|---|
| 三段式流水线 | `tool-runner.mjs` 的 `prepare` / `execute` / `finalize` | `agent-loop.ts:600` / `:666` / `:709` |
| 并行执行 + 结果保序 | `runParallel` 的 `Promise.all` | `agent-loop.ts:540` |
| 串行降级的传染性 | `hasSequential` | `agent-loop.ts:419` |
| 权限钩子 | `agent.mjs` 的 `beforeToolCall` | `agent-loop.ts:619` |
| 参数校验与报错回显 | `validate.mjs` | `ai/utils/validation.ts:307` |
| 兼容层 `prepareArguments` | `tools.mjs` 里 `edit_file` 的那个 | `harness/tools/edit.ts:48` |
| 按文件排队 | `mutation-queue.mjs` | `file-mutation-queue.ts:29` |
| `onUpdate` 生命周期闸门 | `execute` 里的 `accepting` | `agent-loop.ts:672` |
| `terminate` 全票才生效 | `runToolCalls` 的 `every` | `agent-loop.ts:582` |
| 截断整批作废 | `failTruncatedCalls` | `agent-loop.ts:381` |

## 四个可以自己跑一遍的场景

**1. 报错是写给模型看的**

```bash
node agent.mjs "读一下 confg.json 的内容"
```

故意把 `config` 拼错。工具抛出的 ENOENT 原样喂回去，模型看到路径不对，自己 `ls` 一遍再重读。这就是第 1 篇实测到的"错误回喂自愈"，机制就在 `tool-runner.mjs` 的 `execute` 那个 catch 里。

把 catch 改成 `throw err`，整个 agent 会当场崩掉。

**2. 权限钩子拦截**

```bash
node agent.mjs "清空当前目录下所有临时文件"
```

模型多半会给一条 `rm -rf`。`agent.mjs` 里的 `DANGEROUS` 正则会拦下来，拦截理由喂回模型之后它通常会换成逐个删。

`PERMISSION=ask` 则是每条 bash 都先问你 y/N。这两种都挂在同一个钩子上，pi 的权限系统也是这个位置。

**3. 校验失败不执行**

参数不合 schema 时，工具一次都不会跑，模型收到的是一条列清楚哪里错了、并且回显它自己传了什么的报错。`validate.mjs` 会一次收集全部错误，让模型一轮改完而不是来回三次。

**4. 同一个文件被并发修改**

```bash
node agent.mjs "在 notes.md 末尾追加三行不同的内容，一次性发出三个 edit"
```

没有 `mutation-queue.mjs`，三个 edit 并行读到的都是同一份原始内容，最后写回去只剩一条。锁挂在文件的规范路径上，所以改不同文件照样并行，只有打到同一个文件才排队。

## 自测

```bash
node test.mjs
```

34 个用例，不打网络。覆盖参数校验、按文件排队（含并发读改写不丢更新）、三段式各阶段的失败路径、三个顺序、`onUpdate` 生命周期、`terminate` 的 `every` 语义、截断作废。

## 练习

1. 把 `runParallel` 里的 `Promise.all` 换成 `Promise.allSettled` 之后自己按完成顺序收集结果，跑 `demo-order.mjs` 看消息顺序怎么变，再想清楚这对模型意味着什么
2. 给 `ask_user` 去掉 `executionMode: "sequential"`，让模型一次问两个问题，看终端怎么打架
3. 在 `finalize` 里加一个 `afterToolCall`，把超过 2000 字符的工具输出截断并附上"完整内容见 /tmp/xxx"，这是 pi `truncate.ts` 干的事
4. `shouldTerminate` 改成 `some`，构造一个"任务完成 + bash"的批次，观察 bash 的结果是怎么丢的
5. 给 `bash` 加一个白名单模式（只允许 `ls` / `cat` / `node`），比较它和正则黑名单各自漏在哪
