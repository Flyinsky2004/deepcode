/**
 * Web 传输层的日志出口。
 *
 * ## 为什么要抽象这一层
 *
 * 两个理由，都不是"为了好看"：
 *
 * 1. **`console` 的使用点必须是可数的**。ESLint 只放行 `console.error` / `console.warn`，
 *    而 Web server 需要在多处输出（token 一次性提示、拒绝原因、关闭报告）。
 *    把这些集中到一个接口后，"哪里会写终端"变成一个可以一眼看全的问题。
 * 2. **测试需要静音**。启动 token、拒绝审计都是**必须发生**的行为，
 *    写进测试输出会淹掉真正的失败信息。注入一个记录数组比 mock `console` 更可靠。
 *
 * ️ 只允许 `error` / `warn` 两个级别，且它们**不是**诊断日志的替代品：
 * 服务端详细诊断应当进结构化事件日志（`parts/09` §1.1：「错误消息应返回稳定的
 * 错误码和用户可读信息，服务端日志再记录详细诊断」）。
 */

/** Web 层可用的日志级别。刻意只有两个——见文件头说明。 */
export interface WebLogger {
  error(message: string): void
  warn(message: string): void
}

/** 默认实现：写终端。token 只显示一次这类提示走这里。 */
export const consoleLogger: WebLogger = {
  error: (message) => {
    console.error(message)
  },
  warn: (message) => {
    console.warn(message)
  },
}

/** 静音实现。测试与嵌入式使用。 */
export const silentLogger: WebLogger = {
  error: () => undefined,
  warn: () => undefined,
}

/** 把日志收集进数组的实现。测试断言用。 */
export class MemoryLogger implements WebLogger {
  readonly errors: string[] = []
  readonly warnings: string[] = []

  error(message: string): void {
    this.errors.push(message)
  }

  warn(message: string): void {
    this.warnings.push(message)
  }

  /** 全部输出（先 error 后 warn），便于断言"某个字符串是否被打印过"。 */
  all(): readonly string[] {
    return [...this.errors, ...this.warnings]
  }
}
