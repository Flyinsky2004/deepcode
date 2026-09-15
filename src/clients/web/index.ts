/**
 * Web UI 表现层的公开出口。
 *
 * 与 `src/app` 的关系：`src/clients/web` → `src/app` → `src/runtime`。
 * 反向依赖不存在——`src/app` 不认识 Web，只认识 `EventSink` / `EventPublisher`
 * 这样的端口。这保证了"Web UI 不得复制 QueryEngine、ToolExecutor 或
 * PermissionEngine"（`parts/09` §1.1）。
 */

export * from './logger.js'
export * from './listen-policy.js'
export * from './auth.js'
export * from './origin.js'
export * from './rate-limit.js'
export * from './dto.js'
export * from './static-files.js'
export * from './http-router.js'
export * from './ws-stream.js'
export * from './server.js'
