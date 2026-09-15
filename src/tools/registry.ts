import { AgentError, ErrorCode } from '../core/errors.js'
import { type Tool, type ToolDescriptor } from '../core/tool.js'

export class ToolRegistry {
  readonly #tools = new Map<string, Tool>()
  register(tool: Tool): void {
    if (this.#tools.has(tool.descriptor.name))
      throw new AgentError({
        code: ErrorCode.VALIDATION_FAILED,
        message: `duplicate tool: ${tool.descriptor.name}`,
        source: 'tools',
      })
    this.#tools.set(tool.descriptor.name, tool)
  }
  replace(tool: Tool): void {
    this.#tools.set(tool.descriptor.name, tool)
  }
  get(name: string): Tool | undefined {
    return this.#tools.get(name)
  }
  require(name: string): Tool {
    const tool = this.get(name)
    if (!tool)
      throw new AgentError({
        code: ErrorCode.TOOL_NOT_FOUND,
        message: `tool not found: ${name}`,
        source: 'tools',
      })
    return tool
  }
  descriptors(): readonly ToolDescriptor[] {
    return [...this.#tools.values()].map((tool) => tool.descriptor)
  }
  names(): readonly string[] {
    return [...this.#tools.keys()]
  }
}
