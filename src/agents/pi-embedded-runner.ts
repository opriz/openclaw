// Embedded Pi runner 的聚合导出入口（barrel file）。
// 把运行 embedded Pi agent 相关的工具函数和类型统一从一个地方 re-export，
// 方便调用方只从本文件导入，而不用逐个引用子模块。

// 工具调用层的消息发送工具类型
export type { MessagingToolSend } from "./pi-embedded-messaging.js";
// 对 embedded Pi 会话做压缩/精简（用于持久化或传输）
export { compactEmbeddedPiSession } from "./pi-embedded-runner/compact.js";
// 解析并应用额外参数到 agent 配置上
export { applyExtraParamsToAgent, resolveExtraParams } from "./pi-embedded-runner/extra-params.js";

// 修正 Google 相关的轮次排序问题（兼容 provider 返回顺序）
export { applyGoogleTurnOrderingFix } from "./pi-embedded-runner/google.js";
// 计算/限制历史消息条数（含 DM 单独上限）
export {
  getDmHistoryLimitFromSessionKey,
  getHistoryLimitFromSessionKey,
  limitHistoryTurns,
} from "./pi-embedded-runner/history.js";
// 根据 session key / 配置解析当前 embedded 会话所在 lane
export { resolveEmbeddedSessionLane } from "./pi-embedded-runner/lanes.js";
// 执行一次 embedded Pi agent 运行（核心入口）
export { runEmbeddedPiAgent } from "./pi-embedded-runner/run.js";
// 管理一次运行的生命周期：排队、状态、终止、等待结束等
export {
  abortEmbeddedPiRun,
  isEmbeddedPiRunActive,
  isEmbeddedPiRunStreaming,
  queueEmbeddedPiMessage,
  waitForEmbeddedPiRunEnd,
} from "./pi-embedded-runner/runs.js";
// 构造 sandbox 相关的信息（用于隔离执行环境）
export { buildEmbeddedSandboxInfo } from "./pi-embedded-runner/sandbox-info.js";
// 覆盖/生成系统提示词，用于控制 agent 行为
export { createSystemPromptOverride } from "./pi-embedded-runner/system-prompt.js";
// 拆分 SDK tools：哪些给模型，哪些在本地处理
export { splitSdkTools } from "./pi-embedded-runner/tool-split.js";
// Embedded Pi 相关的运行元信息和结果类型
export type {
  EmbeddedPiAgentMeta,
  EmbeddedPiCompactResult,
  EmbeddedPiRunMeta,
  EmbeddedPiRunResult,
} from "./pi-embedded-runner/types.js";
