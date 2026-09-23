/**
 * deepcode Web UI 前端。
 *
 * 原生 ESM，**没有 bundler**：CSP 是 `script-src 'self'`，内联脚本会被拦，
 * 而引入打包器只会让"改了源码忘了重新构建"成为一个新的故障来源。
 *
 * ## 三条必须遵守的约束
 *
 * 1. **不写 `element.style.*`**。CSP 没有 `style-src 'unsafe-inline'`，内联样式
 *    属性同样被拦——写了不会报错，只会静默不生效，是这类页面最难查的 bug。
 *    所有动态外观靠 class 切换。
 * 2. **token 不进 URL**。HTTP 走 `Authorization: Bearer`，WebSocket 走
 *    `POST /api/ws-ticket` 拿一次性 ticket。token 存在 sessionStorage，
 *    关掉标签页即失效。
 * 3. **`replay_complete` 才是"已追平"**。`subscribed` 帧可能排在补发事件之后
 *    （补发是微任务投递的），用它判断会在刷新时过早渲染出半截对话。
 */

const TOKEN_KEY = 'deepcode.token'
const PENDING_KEY_PREFIX = 'deepcode.pending.'

const state = {
  token: sessionStorage.getItem(TOKEN_KEY) ?? '',
  sessions: [],
  sessionId: null,
  lastEventId: null,
  socket: null,
  /** 连接代次；旧 socket 的 close/message 事件不得影响新会话。 */
  connectionGeneration: 0,
  reconnectDelayMs: 500,
  /** sessionId → 是否有 turn 在跑。由事件驱动，不靠请求的返回值猜。 */
  running: new Set(),
  /** 当前 turn 的 id，取消时要用。 */
  turnId: null,
  /** 流式累积的助手文本节点。 */
  liveText: null,
  /** 权限对话框当前展示的 requestId。 */
  approvalRequestId: null,
}

const el = (id) => document.getElementById(id)

// ── HTTP ──────────────────────────────────────────────────────────

/**
 * 带鉴权的 fetch。
 *
 * `idempotencyKey` 只对写操作有意义：服务端要求所有 POST 都带它，
 * 同一个键 + 同样的内容会回放首次结果而不是重跑一遍副作用。
 */
async function api(path, { method = 'GET', body, idempotencyKey } = {}) {
  const headers = { Authorization: `Bearer ${state.token}` }
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey

  const response = await fetch(path, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    // same-origin 也显式写出来：写操作要求带 Origin，浏览器会自动加。
    credentials: 'omit',
  })

  const text = await response.text()
  let payload = null
  if (text !== '') {
    try {
      payload = JSON.parse(text)
    } catch {
      payload = { error: { code: 'INVALID_RESPONSE', message: text.slice(0, 200) } }
    }
  }

  if (response.status === 401) {
    logout('token 无效或已失效，请重新登录。')
    throw new Error('unauthorized')
  }
  if (!response.ok) {
    const message = payload?.error?.message ?? `HTTP ${response.status}`
    const error = new Error(message)
    error.code = payload?.error?.code ?? 'INTERNAL_ERROR'
    error.status = response.status
    throw error
  }
  return payload
}

// ── 登录 ──────────────────────────────────────────────────────────

function logout(message) {
  sessionStorage.removeItem(TOKEN_KEY)
  state.token = ''
  state.connectionGeneration += 1
  state.socket?.close()
  state.socket = null
  el('login').classList.remove('hidden')
  el('app').classList.add('hidden')
  if (message) showError(el('login-error'), message)
}

function showError(node, message) {
  node.textContent = message
  node.classList.remove('hidden')
}

el('login-form').addEventListener('submit', (event) => {
  event.preventDefault()
  const value = el('token-input').value.trim()
  if (value === '') return
  state.token = value
  sessionStorage.setItem(TOKEN_KEY, value)
  el('login-error').classList.add('hidden')
  void enterApp()
})

el('new-session').addEventListener('click', () => {
  void createSession()
})

// ── 会话 ─────────────────────────────────────────────────────────

async function enterApp() {
  try {
    await refreshSessions()
  } catch (error) {
    if (error.message !== 'unauthorized') showError(el('login-error'), error.message)
    return
  }
  el('login').classList.add('hidden')
  el('app').classList.remove('hidden')
  if (state.sessions.length === 0) await createSession()
  else await selectSession(state.sessions[0].id)
}

async function refreshSessions() {
  const payload = await api('/api/sessions')
  state.sessions = payload.sessions ?? []
  renderSessions()
}

function renderSessions() {
  const list = el('session-list')
  list.replaceChildren()
  for (const session of state.sessions) {
    const item = document.createElement('li')
    const button = document.createElement('button')
    button.type = 'button'
    button.className =
      'w-full truncate rounded-md px-2 py-1 text-left hover:bg-slate-800 ' +
      (session.id === state.sessionId ? 'bg-slate-800 text-sky-300' : 'text-slate-300')
    button.textContent = session.title || session.id
    button.addEventListener('click', () => {
      void selectSession(session.id)
    })
    item.append(button)
    list.append(item)
  }
}

async function createSession() {
  const payload = await api('/api/sessions', {
    method: 'POST',
    body: { title: 'Web 会话' },
    idempotencyKey: crypto.randomUUID(),
  })
  await refreshSessions()
  await selectSession(payload.sessionId)
}

async function selectSession(sessionId) {
  // 先使旧连接失效，再异步加载新会话历史，避免切换期间旧事件污染新视图。
  state.connectionGeneration += 1
  state.socket?.close()
  state.socket = null
  if (state.sessionId !== null && state.sessionId !== sessionId) {
    // 换会话必须重置锚点：lastEventId 只在**同一会话内**有意义，
    // 带到另一个会话会被服务端判为无效锚点并要求重建视图。
    state.lastEventId = null
  }
  state.sessionId = sessionId
  const session = state.sessions.find((item) => item.id === sessionId)
  el('session-title').textContent = session?.title ?? sessionId
  el('session-meta').textContent = `turn ${session?.currentTurn ?? 0} · ${session?.status ?? ''}`
  renderSessions()

  await loadHistory()
  await refreshPending()
  connect()
}

/** 从消息历史重建视图。这是 `resync_required` 之后必须走的路。 */
async function loadHistory() {
  if (state.sessionId === null) return
  const payload = await api(`/api/sessions/${state.sessionId}/messages`)
  const container = el('messages')
  container.replaceChildren()
  state.liveText = null
  for (const message of payload.messages ?? []) renderMessage(message)
  container.scrollTop = container.scrollHeight
}

function renderMessage(message) {
  const container = el('messages')
  const wrap = document.createElement('div')

  if (message.role === 'user') {
    wrap.className = 'flex justify-end'
    const bubble = document.createElement('div')
    bubble.className = 'max-w-[85%] whitespace-pre-wrap rounded-lg bg-sky-900/60 px-3 py-2'
    bubble.textContent = message.content
    wrap.append(bubble)
  } else if (message.role === 'assistant') {
    wrap.className = 'whitespace-pre-wrap text-slate-200'
    wrap.textContent = message.content
    wrap.dataset.turnId = message.turnId ?? ''
  } else {
    // tool / system：审计类内容，弱化展示。
    wrap.className = 'rounded-md bg-slate-900 px-3 py-2 text-xs text-slate-400'
    const label = document.createElement('span')
    label.className = 'mr-2 text-slate-500'
    label.textContent = `[${message.subtype}]`
    const body = document.createElement('span')
    body.className = 'break-all'
    body.textContent = message.content
    wrap.append(label, body)
  }

  container.append(wrap)
  container.scrollTop = container.scrollHeight
}

// ── 提交 ──────────────────────────────────────────────────────────

el('composer').addEventListener('submit', (event) => {
  event.preventDefault()
  void submit()
})

el('prompt').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault()
    void submit()
  }
})

el('cancel-turn').addEventListener('click', () => {
  void cancelTurn()
})

function pendingKey(sessionId) {
  return `${PENDING_KEY_PREFIX}${sessionId}`
}

async function submit() {
  const input = el('prompt')
  const text = input.value.trim()
  if (text === '' || state.sessionId === null) return

  // 以 `/` 开头走命令通道，其余是普通消息。
  const isCommand = text.startsWith('/')

  // ⚠️ 刷新页面后重复提交的防线。
  //
  // 幂等键存在 sessionStorage 里：刷新会丢掉内存中的一切，但丢不掉它。
  // 若会话仍在跑（事件流会告诉我们）且上次提交的就是同样这段文本，
  // 就复用同一个键——服务端回放首次结果，而不是再跑一次 turn。
  const stored = sessionStorage.getItem(pendingKey(state.sessionId))
  let idempotencyKey = crypto.randomUUID()
  if (stored !== null) {
    try {
      const previous = JSON.parse(stored)
      if (previous.text === text && state.running.has(state.sessionId))
        idempotencyKey = previous.key
    } catch {
      /* 存坏了就当没有，重新生成 */
    }
  }
  sessionStorage.setItem(pendingKey(state.sessionId), JSON.stringify({ key: idempotencyKey, text }))

  input.value = ''
  setBusy(true)

  try {
    if (isCommand) {
      const result = await api('/api/commands', {
        method: 'POST',
        body: { command: text, sessionId: state.sessionId },
        idempotencyKey,
      })
      appendNote(result.text ?? '命令已执行')
      await loadHistory()
    } else {
      const payload = await api(`/api/sessions/${state.sessionId}/turns`, {
        method: 'POST',
        body: { prompt: text },
        idempotencyKey,
      })
      // `state: 'running'` 是并发同键请求得到的 202 —— turn 已经在跑，
      // 结果会经事件流到达，这里不做任何渲染。
      if (payload.state === 'done' && payload.result) finishTurn(payload.result)
    }
  } catch (error) {
    appendNote(`提交失败：${error.message}`, true)
    if (error.code !== 'SESSION_BUSY') sessionStorage.removeItem(pendingKey(state.sessionId))
  } finally {
    setBusy(false)
  }
}

async function cancelTurn() {
  if (state.sessionId === null || state.turnId === null) return
  try {
    await api(`/api/turns/${encodeURIComponent(state.turnId)}/cancel`, {
      method: 'POST',
      body: { sessionId: state.sessionId },
      idempotencyKey: crypto.randomUUID(),
    })
  } catch (error) {
    appendNote(`取消失败：${error.message}`, true)
  }
}

function setBusy(busy) {
  el('send').disabled = busy
  el('cancel-turn').classList.toggle('hidden', !busy && !state.running.has(state.sessionId))
}

function appendNote(text, isError = false) {
  const container = el('messages')
  const node = document.createElement('div')
  node.className = isError
    ? 'rounded-md bg-rose-950/60 px-3 py-2 text-xs text-rose-200'
    : 'rounded-md bg-slate-900 px-3 py-2 text-xs text-slate-400'
  node.textContent = text
  container.append(node)
  container.scrollTop = container.scrollHeight
}

// ── 权限与提问 ────────────────────────────────────────────────────

async function refreshPending() {
  if (state.sessionId === null) return
  const payload = await api('/api/pending')
  const mine = (payload.approvals ?? []).filter((item) => item.sessionId === state.sessionId)
  const questions = (payload.userInputs ?? []).filter((item) => item.sessionId === state.sessionId)

  if (mine.length > 0) {
    showApproval(mine[0])
  } else if (state.approvalRequestId !== null) {
    hideApproval()
  }
  renderQuestions(questions)
}

function showApproval(view) {
  state.approvalRequestId = view.requestId
  el('approval-tool').textContent = view.toolName
  el('approval-risk').textContent = view.riskLevel
  el('approval-reason').textContent = view.reason ?? ''
  el('approval-args').textContent = view.argsPreview ?? ''
  el('approval-error').classList.add('hidden')
  el('approval-modal').classList.remove('hidden')
  el('approval-modal').classList.add('flex')
}

function hideApproval() {
  state.approvalRequestId = null
  el('approval-modal').classList.add('hidden')
  el('approval-modal').classList.remove('flex')
}

async function resolveApproval(decision, grantScope) {
  const requestId = state.approvalRequestId
  if (requestId === null) return
  try {
    await api(`/api/permissions/${encodeURIComponent(requestId)}`, {
      method: 'POST',
      body: { decision, ...(grantScope ? { grantScope } : {}) },
      idempotencyKey: crypto.randomUUID(),
    })
    hideApproval()
  } catch (error) {
    showError(el('approval-error'), error.message)
  }
}

el('approval-allow').addEventListener('click', () => {
  void resolveApproval('allow')
})
el('approval-allow-once').addEventListener('click', () => {
  void resolveApproval('allow', 'once')
})
el('approval-deny').addEventListener('click', () => {
  void resolveApproval('deny')
})

function renderQuestions(views) {
  const container = el('pending')
  container.replaceChildren()
  if (views.length === 0) {
    container.classList.add('hidden')
    return
  }
  container.classList.remove('hidden')

  for (const view of views) {
    const box = document.createElement('div')
    box.className = 'space-y-2'
    const title = document.createElement('p')
    title.className = 'text-sm text-amber-200'
    title.textContent = `模型提问（${view.toolName}）`
    box.append(title)

    const inputs = []
    for (const [index, question] of (view.questions ?? []).entries()) {
      const label = document.createElement('label')
      label.className = 'block text-xs text-slate-300'
      label.textContent = question.question ?? question.header ?? `问题 ${index + 1}`
      const input = document.createElement('input')
      input.type = 'text'
      input.className =
        'mt-1 w-full rounded-md border border-slate-700 bg-slate-900 px-2 py-1 text-sm'
      label.append(input)
      box.append(label)
      inputs.push(input)
    }

    const actions = document.createElement('div')
    actions.className = 'flex justify-end gap-2'
    const skip = document.createElement('button')
    skip.type = 'button'
    skip.className = 'rounded-md border border-slate-600 px-3 py-1 text-xs hover:bg-slate-800'
    skip.textContent = '放弃作答'
    skip.addEventListener('click', () => {
      void answerQuestions(view.requestId, null)
    })
    const send = document.createElement('button')
    send.type = 'button'
    send.className = 'rounded-md bg-sky-600 px-3 py-1 text-xs hover:bg-sky-500'
    send.textContent = '提交'
    send.addEventListener('click', () => {
      void answerQuestions(
        view.requestId,
        inputs.map((input) => (input.value.trim() === '' ? [] : [input.value.trim()])),
      )
    })
    actions.append(skip, send)
    box.append(actions)
    container.append(box)
  }
}

async function answerQuestions(requestId, answers) {
  try {
    await api(`/api/user-inputs/${encodeURIComponent(requestId)}`, {
      method: 'POST',
      body: { answers },
      idempotencyKey: crypto.randomUUID(),
    })
  } catch (error) {
    appendNote(`作答失败：${error.message}`, true)
  }
  el('pending').classList.add('hidden')
}

// ── WebSocket ─────────────────────────────────────────────────────

function setConnectionState(text) {
  el('connection-state').textContent = text
}

async function connect() {
  if (state.sessionId === null) return
  const generation = ++state.connectionGeneration
  state.socket?.close()
  state.socket = null

  let ticket
  try {
    // ticket 是唯一允许出现在 URL 里的凭据：一次性、30 秒、绑定 Origin。
    const payload = await api('/api/ws-ticket', {
      method: 'POST',
      idempotencyKey: crypto.randomUUID(),
    })
    ticket = payload.ticket
  } catch (error) {
    if (generation !== state.connectionGeneration) return
    setConnectionState(`获取 ticket 失败：${error.message}`)
    return
  }

  if (generation !== state.connectionGeneration || state.sessionId === null) return

  const scheme = location.protocol === 'https:' ? 'wss' : 'ws'
  const socket = new WebSocket(`${scheme}://${location.host}/api/stream?ticket=${ticket}`)
  state.socket = socket
  setConnectionState('连接中…')

  socket.addEventListener('open', () => {
    if (generation !== state.connectionGeneration || state.socket !== socket) return
    setConnectionState('已连接')
    state.reconnectDelayMs = 500
  })

  socket.addEventListener('message', (event) => {
    if (generation !== state.connectionGeneration || state.socket !== socket) return
    let frame
    try {
      frame = JSON.parse(event.data)
    } catch {
      return
    }
    handleFrame(frame)
  })

  socket.addEventListener('close', () => {
    if (generation !== state.connectionGeneration || state.socket !== socket) return
    setConnectionState('已断开，重连中…')
    state.socket = null
    // 指数退避，但保留 `lastEventId`——重连要靠它补齐断线期间的事件。
    const delay = state.reconnectDelayMs
    state.reconnectDelayMs = Math.min(delay * 2, 10_000)
    setTimeout(() => {
      if (generation !== state.connectionGeneration || state.sessionId === null) return
      void connect()
    }, delay)
  })
}

function handleFrame(frame) {
  switch (frame.type) {
    case 'ready':
      sendFrame({ type: 'subscribe', sessionId: state.sessionId, lastEventId: state.lastEventId })
      return
    case 'subscribed':
      setConnectionState(`已订阅（补发 ${frame.replayed} 条）`)
      return
    case 'replay_complete':
      // 只有到这里才算追平。用它结束任何 loading 态。
      setConnectionState('已同步')
      void refreshPending()
      return
    case 'resync_required':
      // 锚点失效：**重建视图**再重订阅，而不是请求全量补发。
      appendNote('事件锚点已失效，正在重建视图…')
      state.lastEventId = null
      void loadHistory().then(() => {
        sendFrame({ type: 'subscribe', sessionId: state.sessionId })
      })
      return
    case 'error':
      appendNote(`事件流错误：${frame.message}`, true)
      return
    case 'event':
      handleEvent(frame.event)
      return
    default:
      return
  }
}

function sendFrame(frame) {
  if (state.socket?.readyState === WebSocket.OPEN) state.socket.send(JSON.stringify(frame))
}

function handleEvent(event) {
  state.lastEventId = event.eventId
  const data = event.data ?? {}

  switch (event.type) {
    case 'turn_start':
      state.turnId = event.turnId
      state.running.add(event.sessionId)
      setBusy(true)
      startLiveText(event.turnId)
      return
    case 'text':
      appendLiveText(data.content ?? '')
      return
    case 'thinking':
      // 思考过程只做进度提示；历史重绘时从消息里读完整内容。
      setConnectionState(`思考中… ${String(data.preview ?? '').slice(0, 80)}`)
      return
    case 'tool_use':
      appendNote(`→ 调用工具 ${data.name ?? ''}`)
      return
    case 'tool_result':
      appendNote(`${data.ok ? '✓' : '✗'} ${data.name ?? ''} ${data.error_code ?? ''}`.trim())
      return
    case 'permission_required':
      showApproval({
        requestId: data.request_id,
        toolName: data.tool_name,
        riskLevel: data.risk_level,
        reason: data.reason,
        argsPreview: data.args_preview,
      })
      return
    case 'permission_resolved':
      if (data.request_id === state.approvalRequestId) hideApproval()
      return
    case 'user_input_required':
      void refreshPending()
      return
    case 'compact_start':
      appendNote('上下文压缩中…')
      return
    case 'compact_end':
      appendNote(data.applied ? '已压缩上下文' : '无需压缩')
      return
    case 'cancel_requested':
      appendNote('已请求取消…')
      return
    case 'model_route_changed': {
      const from = `${data.from_provider ?? ''}/${data.from_model ?? ''}`
      const to = `${data.to_provider ?? ''}/${data.to_model ?? ''}`
      const reason = data.reason ? `（${data.reason}）` : ''
      appendNote(`模型路由已切换：${from} → ${to}${reason}`)
      return
    }
    case 'turn_end':
      finishTurn(data, event.sessionId)
      return
    case 'error':
      // ⚠️ `error` 同样是**终止信号**。只认 `turn_end` 的客户端会在这里挂住。
      appendNote(`错误：${data.message ?? ''}`, true)
      endTurn(event.sessionId)
      return
    default:
      return
  }
}

function startLiveText(turnId) {
  const container = el('messages')
  const node = document.createElement('div')
  node.className = 'whitespace-pre-wrap text-slate-200'
  node.dataset.turnId = turnId ?? ''
  container.append(node)
  container.scrollTop = container.scrollHeight
  state.liveText = { node, text: '' }
}

function appendLiveText(chunk) {
  if (state.liveText === null) startLiveText(state.turnId)
  if (state.liveText === null) return
  state.liveText.text += chunk
  state.liveText.node.textContent = state.liveText.text
  const container = el('messages')
  container.scrollTop = container.scrollHeight
}

function finishTurn(result, sessionId) {
  const running = sessionId ?? state.sessionId
  // `final_text` 是权威产出。流式增量可能是空的（例如全部内容都在工具调用里
  // 走完），所以两边取更完整的那个，而不是无条件相信流式累积。
  if (state.liveText !== null) {
    const finalText = typeof result?.finalText === 'string' ? result.finalText : ''
    if (finalText !== '' && finalText.length > state.liveText.text.length)
      state.liveText.node.textContent = finalText
    if (state.liveText.text === '' && finalText === '') state.liveText.node.remove()
    state.liveText = null
  }

  if (result?.cancelled === true) appendNote('已取消')
  else if (result?.status && result.status !== 'completed')
    appendNote(`turn 结束：${result.status}${result.error ? ` — ${result.error}` : ''}`, true)

  endTurn(running)
  void refreshSessions().catch(() => undefined)
}

function endTurn(sessionId) {
  if (sessionId) state.running.delete(sessionId)
  state.turnId = null
  sessionStorage.removeItem(pendingKey(sessionId ?? state.sessionId))
  setBusy(false)
}

// ── 启动 ──────────────────────────────────────────────────────────

if (state.token !== '') {
  void enterApp()
} else {
  el('login').classList.remove('hidden')
}
