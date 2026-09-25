/** @jsxRuntime automatic @jsxImportSource react */
/** Render Markdown tokens as Ink components; never pass model text through a shell or HTML renderer. */
import { Box, Text } from 'ink'
import { marked, type MarkedToken, type Token, type Tokens } from 'marked'
import { memo, type ReactElement, type ReactNode } from 'react'

import { COLORS } from './theme.js'

function inline(tokens: readonly Token[]): ReactNode[] {
  return tokens.map((token, index) => {
    // The default lexer has no custom token extensions. Keep a raw fallback below.
    const known = token as MarkedToken
    const key = `${index}-${token.type}`
    switch (known.type) {
      case 'strong':
        return (
          <Text key={key} bold>
            {inline(known.tokens)}
          </Text>
        )
      case 'em':
        return (
          <Text key={key} italic>
            {inline(known.tokens)}
          </Text>
        )
      case 'del':
        return (
          <Text key={key} strikethrough>
            {inline(known.tokens)}
          </Text>
        )
      case 'codespan':
        return (
          <Text key={key} color={COLORS.logo}>
            {known.text}
          </Text>
        )
      case 'link':
        return (
          <Text key={key} color={COLORS.logo} underline>
            {inline(known.tokens)}
            {known.href !== known.text ? ` (${known.href})` : ''}
          </Text>
        )
      case 'image':
        return <Text key={key} color={COLORS.muted}>{`[image: ${known.text || known.href}]`}</Text>
      case 'br':
        return '\n'
      case 'text':
        return known.tokens ? <Text key={key}>{inline(known.tokens)}</Text> : known.text
      case 'escape':
        return known.text
      case 'html':
        return known.text
      default:
        return known.raw
    }
  })
}

function block(token: Token, key: string): ReactElement | null {
  switch (token.type) {
    case 'space':
    case 'def':
      return null
    case 'heading':
      return (
        <Text key={key} color={COLORS.logo} bold>
          {inline(token.tokens ?? [])}
        </Text>
      )
    case 'paragraph':
    case 'text':
      return (
        <Text key={key} color={COLORS.screenText}>
          {token.tokens ? inline(token.tokens) : token.text}
        </Text>
      )
    case 'code':
      return (
        <Box key={key} borderStyle="single" borderColor={COLORS.menuBorder} paddingX={1}>
          <Text color={COLORS.screenText}>{token.text || ' '}</Text>
        </Box>
      )
    case 'list': {
      const list = token as Tokens.List
      return (
        <Box key={key} flexDirection="column">
          {list.items.map((item, index) => (
            <Box key={index} flexDirection="row">
              <Text color={COLORS.muted}>
                {item.task
                  ? item.checked
                    ? '☑ '
                    : '☐ '
                  : list.ordered
                    ? `${Number(list.start || 1) + index}. `
                    : '• '}
              </Text>
              <Box flexDirection="column" flexGrow={1}>
                {item.tokens.map((child, childIndex) => block(child, `${index}-${childIndex}`))}
              </Box>
            </Box>
          ))}
        </Box>
      )
    }
    case 'blockquote':
      return (
        <Box key={key} flexDirection="row">
          <Text color={COLORS.muted}>│ </Text>
          <Box flexDirection="column" flexGrow={1}>
            {(token.tokens ?? []).map((child, index) => block(child, `${key}-${index}`))}
          </Box>
        </Box>
      )
    case 'hr':
      return (
        <Text key={key} color={COLORS.muted}>
          ────────────────────────
        </Text>
      )
    case 'table': {
      const table = token as Tokens.Table
      return (
        <Box key={key} flexDirection="column">
          <Text bold color={COLORS.logo}>
            {table.header.map((cell, index) => (
              <Text key={index}>
                {index > 0 ? ' │ ' : ''}
                {inline(cell.tokens)}
              </Text>
            ))}
          </Text>
          {table.rows.map((row, index) => (
            <Text key={index} color={COLORS.screenText}>
              {row.map((cell, cellIndex) => (
                <Text key={cellIndex}>
                  {cellIndex > 0 ? ' │ ' : ''}
                  {inline(cell.tokens)}
                </Text>
              ))}
            </Text>
          ))}
        </Box>
      )
    }
    case 'html':
      return (
        <Text key={key} color={COLORS.screenText}>
          {token.text}
        </Text>
      )
    default:
      return (
        <Text key={key} color={COLORS.screenText}>
          {token.raw}
        </Text>
      )
  }
}

export const MarkdownText = memo(function MarkdownText({
  source,
}: {
  readonly source: string
}): ReactElement {
  const tokens = marked.lexer(source, { gfm: true, breaks: true })
  const blocks = tokens.flatMap((token, index) => {
    const rendered = block(token, String(index))
    return rendered ? [rendered] : []
  })
  return (
    <Box flexDirection="column" rowGap={1}>
      {blocks}
    </Box>
  )
})
