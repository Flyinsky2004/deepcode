import { redactValueShapes } from '../observability/sanitize.js'

/**
 * 给审批人看的 bash 命令。它只存在于待审批内存队列，不进入审计记录或事件日志。
 * 常见凭据值仍需隐藏，但命令和普通参数必须可见，否则无法做知情审批。
 */
export function approvalCommandPreview(command: string): string {
  return redactValueShapes(command)
    .replace(
      /\b((?:[\w-]*(?:token|secret|password|passwd|api[_-]?key|access[_-]?key|private[_-]?key)[\w-]*)=)(?:"[^"]*"|'[^']*'|[^\s]+)/giu,
      '$1[redacted]',
    )
    .replace(
      /(--(?:token|secret|password|passwd|api[_-]?key|access[_-]?key|authorization|cookie)(?:=|\s+))(?:"[^"]*"|'[^']*'|[^\s]+)/giu,
      '$1[redacted]',
    )
    .replace(/(Authorization:\s*)(?:Bearer\s+)?[^\s'";]+/giu, '$1[redacted]')
}
