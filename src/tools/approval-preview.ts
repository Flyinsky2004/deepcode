import { isSensitiveKey, redactValueShapes } from '../observability/sanitize.js'
import type { ApprovalPresentation } from '../core/tool.js'

/**
 * 给审批人看的文本。逐行处理，避免多行配置中一个凭据让整份文件都消失。
 * 常见凭据值仍需隐藏，其他内容必须可见，否则无法做知情审批。
 */
export function redactApprovalText(value: string): string {
  return value
    .split('\n')
    .map((line) => redactValueShapes(line))
    .join('\n')
    .replace(/(Authorization:\s*)(?:Bearer\s+)?[^\s'";]+/giu, '$1[redacted]')
    .replace(
      /\b((?:[\w-]*(?:token|secret|password|passwd|api[_-]?key|access[_-]?key|private[_-]?key|credential|authorization|cookie)[\w-]*)["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,#}\r\n]+)/giu,
      '$1[redacted]',
    )
    .replace(
      /(--(?:token|secret|password|passwd|api[_-]?key|access[_-]?key|authorization|cookie)(?:=|\s+))(?:"[^"]*"|'[^']*'|[^\s]+)/giu,
      '$1[redacted]',
    )
}

export function approvalCommandPreview(command: string): string {
  return redactApprovalText(command)
}

function sanitizeApprovalInput(value: unknown, key = '', depth = 0): unknown {
  if (depth > 12 || key.toLowerCase() === 'key' || (key !== '' && isSensitiveKey(key)))
    return '[redacted]'
  if (typeof value === 'string') return redactApprovalText(value)
  if (Array.isArray(value)) return value.map((item) => sanitizeApprovalInput(item, '', depth + 1))
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([name, item]) => [
        name,
        sanitizeApprovalInput(item, name, depth + 1),
      ]),
    )
  return value
}

/** 原始参数只在内存里转换；落盘和广播仍使用 argsPreview。 */
export function approvalPresentation(
  toolName: string,
  input: Readonly<Record<string, unknown>>,
): ApprovalPresentation {
  if (toolName === 'bash' && typeof input['command'] === 'string')
    return { label: '待执行命令', text: approvalCommandPreview(input['command']) }

  if (
    toolName === 'file_write' &&
    typeof input['path'] === 'string' &&
    typeof input['content'] === 'string'
  ) {
    const mode = input['overwrite'] === false ? '仅在文件不存在时创建' : '写入或覆盖'
    const expectedHash =
      typeof input['expected_hash'] === 'string'
        ? `\n预期原文件 SHA-256：${input['expected_hash']}`
        : ''
    return {
      label: '拟写入内容',
      text: `目标文件：${redactApprovalText(input['path'])}\n方式：${mode}\n创建父目录：${input['create_dirs'] === false ? '否' : '是'}${expectedHash}\n\n文件内容：\n${redactApprovalText(input['content'])}`,
    }
  }

  if (
    toolName === 'file_edit' &&
    typeof input['file_path'] === 'string' &&
    typeof input['old_string'] === 'string' &&
    typeof input['new_string'] === 'string'
  )
    return {
      label: '拟修改内容',
      text: `目标文件：${redactApprovalText(input['file_path'])}\n替换范围：${input['replace_all'] === true ? '所有匹配' : '单处匹配'}\n\n查找：\n${redactApprovalText(input['old_string'])}\n\n替换为：\n${redactApprovalText(input['new_string'])}`,
    }

  return {
    label: '待执行参数',
    text: JSON.stringify(sanitizeApprovalInput(input), null, 2),
  }
}
