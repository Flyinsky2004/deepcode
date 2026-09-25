import { createElement } from 'react'
import { render } from 'ink-testing-library'
import { describe, expect, it } from 'vitest'

import { formatResultContent, messageToDisplay } from '../../src/clients/tui/format.js'
import { MarkdownText } from '../../src/clients/tui/markdown.js'
import type { Message } from '../../src/core/models.js'

function frame(source: string): string {
  return render(createElement(MarkdownText, { source })).lastFrame() ?? ''
}

describe('TUI Markdown rendering', () => {
  it('renders headings, emphasis, links, lists, quotes and tables without source markers', () => {
    const rendered = frame(
      '## Result\n\n**Bold** and *italic* with `code` and [docs](https://example.com)\n\n- first\n- second\n\n> quoted\n\n| Name | Value |\n| --- | --- |\n| **CPU** | `8` |',
    )
    expect(rendered).toContain('Result')
    expect(rendered).toContain('Bold and italic with code and docs (https://example.com)')
    expect(rendered).toContain('• first')
    expect(rendered).toContain('• second')
    expect(rendered).toContain('│ quoted')
    expect(rendered).toContain('Name │ Value')
    expect(rendered).toContain('CPU │ 8')
    expect(rendered).not.toContain('**CPU**')
    expect(rendered).not.toContain('## Result')
    expect(rendered).not.toContain('**Bold**')
    expect(rendered).not.toContain('| --- |')
  })

  it('keeps code and shell output literal while hiding the fence', () => {
    const rendered = frame(formatResultContent('file **raw**\n```inside output'))
    expect(rendered).toContain('file **raw**')
    expect(rendered).toContain('```inside output')
    expect(rendered).not.toContain('````')
  })

  it('renders the formatted assistant thinking and tool call from persisted blocks', () => {
    const content = JSON.stringify([
      { type: 'thinking', thinking: 'a **literal** note', signature: '' },
      { type: 'tool_use', id: 't1', name: 'bash', input: { command: 'df -h' } },
      { type: 'text', text: 'Done **successfully**.' },
    ])
    const rendered = frame(messageToDisplay({ content } as Message))
    expect(rendered).toContain('💭 thinking')
    expect(rendered).toContain('a **literal** note')
    expect(rendered).toContain('🔧 bash')
    expect(rendered).toContain('• command: df -h')
    expect(rendered).toContain('Done successfully.')
    expect(rendered).not.toContain('**thinking**')
    expect(rendered).not.toContain('```')
  })
})
