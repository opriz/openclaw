# 技术栈选择：为什么用 TypeScript

## 核心原因

### 1. npm 生态是护城河

项目需要快速接入各种 LLM、渠道 SDK（WhatsApp Web、Telegram、Discord、Slack……）。这些 SDK 几乎都优先发布 npm 包，Python/Go 绑定要么没有、要么滞后。用 TypeScript 能直接 `npm install`。

### 2. 分发方式决定语言

用户通过 `npm install -g openclaw` 安装，Node.js/Bun 运行时是前端开发者机器上的标配。如果用 Go 需要分发编译好的跨平台二进制；用 Python 要处理 venv/pip 环境冲突——这对面向普通用户的 CLI 工具是致命的。

### 3. 插件/扩展架构依赖 JS 运行时

`extensions/*` 是独立的 npm 包，用户可以自己写插件。Node.js 的动态 `import` 天然支持这个设计：

- Go 的 plugin 系统非常受限
- Python 没有 npm workspace 那种成熟的插件分发机制

### 4. 前后端共享类型

macOS/iOS/Android 客户端通过 HTTP/WebSocket 和 Gateway 通信，消息格式的 Zod schema 在前后端之间共享。TypeScript 让这件事天然，Go/Python 需要额外的代码生成工具链（protobuf/OpenAPI）。

### 5. 类型系统成熟度

Python 的类型注解（mypy/pyright）是后来加上去的，工具链支持参差不齐。TypeScript 的类型系统是语言设计核心，IDE 集成和类型推断远比 Python 强。项目也强制要求严格模式：

> Prefer strict typing; avoid `any`. Never add `@ts-nocheck`.

---

## 为什么不用 Go

Go 的优势是高并发网络服务、低内存占用、单二进制部署。但这个 Gateway 的瓶颈不在并发处理能力，而在等 LLM API 返回（IO bound），Node.js 的异步模型完全够用。Go 的优势在这里发挥不出来，反而带来插件系统和 npm 生态不兼容的问题。

## 为什么不用 Python

Python 是"做 AI 研究"的最佳语言，TypeScript 是"做 AI 产品工具"的最佳语言。这个项目不训练模型，只是调用 LLM API，Python 在这个场景没有任何优势，反而带来分发体验差和类型安全弱的劣势。

---

## 一句话总结

> 这个项目是"胶水层"——把 LLM、各种渠道 SDK、用户插件粘在一起。胶水层最重要的是生态兼容性，不是运行时性能。TypeScript + Node.js 是这个场景的最优解。
