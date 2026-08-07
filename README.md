# Build Your Own Coding Agent

对照三个开源 coding agent 项目，把 agent 的内核一层层拆开，同时动手写一个能跑的 mini-agent：

- [pi](https://github.com/earendil-works/pi)（TypeScript / MIT / ~78k star）作为主线教材
- [codex](https://github.com/openai/codex)（Rust / Apache-2.0 / ~101k star）用于架构对比
- [grok-build](https://github.com/xai-org/grok-build)（Rust / Apache-2.0 / ~23k star）用于架构对比

全程使用国产模型 API（DeepSeek / GLM / Kimi），代码可以直接在本地运行。

## 系列文章

| # | 主题 | 状态 | 解析笔记 | 对应代码 |
|---|---|---|---|---|
| 01 | Agent 的本质是一个 while 循环 | 本周发布 | [notes/01](notes/01-agent-loop-pi.md) | [steps/01](steps/01-minimal-loop/)（可运行） |
| 02 | 统一 LLM API 与错误契约 | 本周发布 | [notes/02](notes/02-provider-api-pi.md) | [steps/02](steps/02-provider-api/)（可运行） |
| 03 | 一次工具调用从头到尾经过什么 | 计划中 | — | `steps/03-tools/` |
| 04 | Context 管理与压缩 | 计划中 | — | `steps/04-context/` |
| 05 | Codex 架构对比：Session/Task/Turn | 计划中 | — | — |
| 06 | grok-build：工业级 TUI 的取舍 | 计划中 | — | — |

完整长文在公众号和 X 同步发布，本仓库放要点版解析（结构图、行号引用、设计点清单）和可运行代码。

## mini-agent 路线图

每篇文章对应 `steps/` 下一个可以独立运行的阶段，从 100 行的最小循环开始，逐步加入工具执行、上下文管理、TUI 等能力。

```bash
# 环境要求：Node.js 20+，一个 DeepSeek 或 GLM 的 API Key
export DEEPSEEK_API_KEY=sk-...
cd steps/01-minimal-loop && npm install && npm start
```

## License

本仓库代码采用 MIT License。引用的第三方项目源码片段遵循其原始协议（pi: MIT；codex / grok-build: Apache-2.0），版权归原作者所有。
