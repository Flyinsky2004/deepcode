import { marked } from '/vendor/marked.js'

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
 *    状态外观靠 class 切换，动效由 Web Animations API 合成。
 * 2. **token 不进 URL**。启用认证时 HTTP 走 `Authorization: Bearer`，
 *    WebSocket 走 `POST /api/ws-ticket` 拿一次性 ticket。token 存在
 *    sessionStorage，关掉标签页即失效。
 * 3. **`replay_complete` 才是"已追平"**。`subscribed` 帧可能排在补发事件之后
 *    （补发是微任务投递的），用它判断会在刷新时过早渲染出半截对话。
 */

const TOKEN_KEY = 'deepcode.token'
const PENDING_KEY_PREFIX = 'deepcode.pending.'
const MODEL_KEY_PREFIX = 'deepcode.model.'
const PROJECT_KEY = 'deepcode.project.path'
const THEME_KEY = 'deepcode.theme'
const VIEW_KEY = 'deepcode.chat.view'

const initialTheme = localStorage.getItem(THEME_KEY)
document.documentElement.dataset.theme =
  initialTheme === 'light' || initialTheme === 'dark'
    ? initialTheme
    : window.matchMedia('(prefers-color-scheme: dark)').matches
      ? 'dark'
      : 'light'

const state = {
  token: sessionStorage.getItem(TOKEN_KEY) ?? '',
  projectId: null,
  projectPath: null,
  projects: [],
  commands: [],
  commandMatches: [],
  commandIndex: -1,
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
  permissionMode: 'normal',
  modelOverride: null,
  availableModels: [],
  automaticModelLabel: '自动选择模型',
  routeGeneration: 0,
  viewMode: localStorage.getItem(VIEW_KEY) === 'advanced' ? 'advanced' : 'normal',
  messages: [],
  traceEvents: new Map(),
  traceObservations: new Map(),
  traceRefreshTimer: null,
}

const el = (id) => document.getElementById(id)

// GSAP 只驱动普通对象的时间进度；视觉帧由 Web Animations API 合成。
// 这样不会写入 element.style，仍可保留严格的 style-src 'self' CSP。
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')
const activeMotion = new WeakMap()

function stopMotion(node) {
  const current = activeMotion.get(node)
  if (!current) return
  current.tween.kill()
  current.animation.cancel()
  activeMotion.delete(node)
}

function motion(node, keyframes, { duration = 0.28, delay = 0, ease = 'power2.out', done } = {}) {
  if (!node) return
  stopMotion(node)
  if (reducedMotion.matches || !node.animate || !window.gsap) {
    done?.()
    return
  }
  const animation = node.animate(keyframes, {
    duration: duration * 1000,
    easing: 'linear',
    fill: 'both',
  })
  animation.pause()
  animation.currentTime = 0
  const progress = { value: 0 }
  const tween = window.gsap.to(progress, {
    value: 1,
    duration,
    delay,
    ease,
    onUpdate: () => {
      animation.currentTime = progress.value * duration * 1000
    },
    onComplete: () => {
      animation.cancel()
      activeMotion.delete(node)
      done?.()
    },
  })
  activeMotion.set(node, { tween, animation })
}

function appear(node, delay = 0, distance = 10) {
  motion(
    node,
    [
      { opacity: 0, transform: `translateY(${distance}px)` },
      { opacity: 1, transform: 'translateY(0)' },
    ],
    { delay },
  )
}

function animateRoute(page) {
  const root = el(`${page}-page`)
  const heading = root.querySelector('.page-heading, .chat-header')
  appear(heading, 0, 8)
  const cards = root.querySelectorAll('.project-card, .overview-session, .command-card, .stat-card')
  for (const [index, card] of [...cards].slice(0, 8).entries()) appear(card, 0.04 + index * 0.035)
  if (page === 'chat') appear(root.querySelector('.composer'), 0.07, 12)
}

const permissionModes = [
  { value: 'normal', label: '常规' },
  { value: 'auto_edit', label: '自动编辑' },
  { value: 'yolo', label: '完全访问（高风险仍确认）' },
  { value: 'plan', label: '计划与澄清' },
]
const choiceMenus = [
  { trigger: el('permission-mode'), menu: el('permission-menu') },
  { trigger: el('composer-model'), menu: el('model-menu') },
]

function closeChoiceMenu(choice, restoreFocus = false) {
  if (choice.trigger.getAttribute('aria-expanded') !== 'true') return
  choice.trigger.setAttribute('aria-expanded', 'false')
  choice.menu.inert = true
  motion(
    choice.menu,
    [
      { opacity: 1, transform: 'translateY(0) scale(1)' },
      { opacity: 0, transform: 'translateY(6px) scale(0.985)' },
    ],
    {
      duration: 0.14,
      ease: 'power2.in',
      done: () => {
        choice.menu.classList.add('hidden')
        choice.menu.inert = false
      },
    },
  )
  if (restoreFocus) choice.trigger.focus()
}

function openChoiceMenu(choice, focusLast = false) {
  if (choice.trigger.disabled) return
  for (const other of choiceMenus) if (other !== choice) closeChoiceMenu(other)
  choice.menu.inert = false
  choice.menu.classList.remove('hidden')
  choice.trigger.setAttribute('aria-expanded', 'true')
  motion(
    choice.menu,
    [
      { opacity: 0, transform: 'translateY(7px) scale(0.985)' },
      { opacity: 1, transform: 'translateY(0) scale(1)' },
    ],
    { duration: 0.2, ease: 'power2.out' },
  )
  const options = [...choice.menu.querySelectorAll('[role="menuitemradio"]')]
  const selected = options.find((option) => option.getAttribute('aria-checked') === 'true')
  const focused = focusLast ? options.at(-1) : (selected ?? options[0])
  focused?.focus()
}

function renderChoiceMenu(choice, items, selectedValue, onSelect) {
  const hadFocus = choice.menu.contains(document.activeElement)
  choice.menu.replaceChildren()
  for (const item of items) {
    const option = document.createElement('button')
    option.type = 'button'
    option.className = 'composer-choice-option'
    option.setAttribute('role', 'menuitemradio')
    option.setAttribute('aria-checked', String(item.value === selectedValue))
    option.tabIndex = -1
    option.dataset.value = item.value
    const text = document.createElement('span')
    text.className = 'composer-choice-option-text'
    text.textContent = item.label
    option.append(text)
    if (item.detail) {
      const detail = document.createElement('span')
      detail.className = 'composer-choice-option-detail'
      detail.textContent = item.detail
      option.append(detail)
    }
    const marker = document.createElement('span')
    marker.className = 'composer-choice-marker'
    marker.setAttribute('aria-hidden', 'true')
    option.append(marker)
    option.addEventListener('click', () => {
      onSelect(item.value)
      closeChoiceMenu(choice, true)
    })
    choice.menu.append(option)
  }
  if (hadFocus) choice.menu.querySelector('[role="menuitemradio"][aria-checked="true"]')?.focus()
}

for (const choice of choiceMenus) {
  choice.trigger.addEventListener('click', () => {
    if (choice.trigger.getAttribute('aria-expanded') !== 'true') openChoiceMenu(choice)
    else closeChoiceMenu(choice, true)
  })
  choice.trigger.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    event.preventDefault()
    openChoiceMenu(choice, event.key === 'ArrowUp')
  })
  choice.menu.addEventListener('keydown', (event) => {
    const options = [...choice.menu.querySelectorAll('[role="menuitemradio"]')]
    if (options.length === 0) return
    const current = options.indexOf(document.activeElement)
    if (event.key === 'Escape') {
      event.preventDefault()
      closeChoiceMenu(choice, true)
      return
    }
    if (event.key === 'Tab') {
      closeChoiceMenu(choice)
      return
    }
    let next
    if (event.key === 'ArrowDown') next = (current + 1) % options.length
    else if (event.key === 'ArrowUp') next = (current - 1 + options.length) % options.length
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = options.length - 1
    else return
    event.preventDefault()
    options[next]?.focus()
  })
}

document.addEventListener('pointerdown', (event) => {
  for (const choice of choiceMenus) {
    if (
      choice.trigger.getAttribute('aria-expanded') === 'true' &&
      !choice.menu.parentElement.contains(event.target)
    )
      closeChoiceMenu(choice)
  }
})

function setPermissionMode(value) {
  state.permissionMode = value
  el('permission-mode').closest('.composer-mode').dataset.mode = value
  const label = permissionModes.find((mode) => mode.value === value)?.label ?? '常规'
  el('permission-mode-value').textContent = label
  el('permission-mode').setAttribute('aria-label', `审批模式：${label}`)
  renderChoiceMenu(choiceMenus[0], permissionModes, value, setPermissionMode)
}

function setModelOverride(value) {
  state.modelOverride = value || null
  const key = `${MODEL_KEY_PREFIX}${state.sessionId}`
  if (state.sessionId !== null) {
    if (state.modelOverride === null) sessionStorage.removeItem(key)
    else sessionStorage.setItem(key, state.modelOverride)
  }
  renderComposerModelChoice()
}

setPermissionMode(state.permissionMode)

// marked 负责 Markdown 语法；渲染时只重建允许的 DOM 节点，不把模型输出直接
// 放进页面的 innerHTML。原始 HTML、事件属性、危险链接和图片请求都不能进入页面。
const MARKDOWN_TAGS = new Set([
  'p',
  'br',
  'strong',
  'em',
  'del',
  'code',
  'pre',
  'blockquote',
  'ul',
  'ol',
  'li',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
  'table',
  'thead',
  'tbody',
  'tr',
  'th',
  'td',
  'a',
  'input',
  'sup',
  'sub',
])
const DROP_MARKDOWN_TAGS = new Set([
  'script',
  'style',
  'iframe',
  'object',
  'embed',
  'svg',
  'math',
  'form',
  'template',
])

function safeMarkdownHref(value) {
  try {
    const url = new window.URL(value, location.href)
    return ['http:', 'https:', 'mailto:'].includes(url.protocol) ? url.href : null
  } catch {
    return null
  }
}

function copySafeMarkdownNode(parent, source) {
  if (source.nodeType === window.Node.TEXT_NODE) {
    parent.append(document.createTextNode(source.textContent ?? ''))
    return
  }
  if (source.nodeType !== window.Node.ELEMENT_NODE) return
  const tag = source.localName
  if (DROP_MARKDOWN_TAGS.has(tag)) return
  if (tag === 'img') {
    parent.append(document.createTextNode(source.getAttribute('alt') ?? '[图片]'))
    return
  }
  if (!MARKDOWN_TAGS.has(tag)) {
    for (const child of source.childNodes) copySafeMarkdownNode(parent, child)
    return
  }
  if (tag === 'input' && source.getAttribute('type') !== 'checkbox') return
  const clean = document.createElement(tag)
  if (tag === 'a') {
    const href = safeMarkdownHref(source.getAttribute('href') ?? '')
    if (href) {
      clean.setAttribute('href', href)
      clean.setAttribute('target', '_blank')
      clean.setAttribute('rel', 'noopener noreferrer')
    }
  }
  if (tag === 'code') {
    const language = source.className.match(/^language-([a-zA-Z0-9_+#.-]+)$/)?.[1]
    if (language) clean.className = `language-${language}`
  }
  if (tag === 'ol' && /^\d+$/.test(source.getAttribute('start') ?? ''))
    clean.setAttribute('start', source.getAttribute('start'))
  if (tag === 'input') {
    clean.setAttribute('type', 'checkbox')
    clean.disabled = true
    clean.checked = source.hasAttribute('checked')
  }
  for (const child of source.childNodes) copySafeMarkdownNode(clean, child)
  parent.append(clean)
}

function renderMarkdown(node, source) {
  try {
    const html = marked.parse(source, { gfm: true, breaks: true })
    const documentTree = new window.DOMParser().parseFromString(html, 'text/html')
    const fragment = document.createDocumentFragment()
    for (const child of documentTree.body.childNodes) copySafeMarkdownNode(fragment, child)
    node.replaceChildren(fragment)
  } catch {
    node.textContent = source
  }
}

function updateThemeButton() {
  const dark = document.documentElement.dataset.theme === 'dark'
  el('theme-toggle').setAttribute('aria-pressed', String(dark))
  el('theme-toggle').setAttribute('aria-label', dark ? '切换到浅色模式' : '切换到暗色模式')
  el('theme-label').textContent = dark ? '浅色模式' : '暗色模式'
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', dark ? '#181818' : '#ffffff')
}
updateThemeButton()
el('theme-toggle').addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'
  document.documentElement.dataset.theme = next
  localStorage.setItem(THEME_KEY, next)
  updateThemeButton()
})

// ── HTTP ──────────────────────────────────────────────────────────

/**
 * 带鉴权的 fetch。
 *
 * `idempotencyKey` 只对写操作有意义：服务端要求所有 POST 都带它，
 * 同一个键 + 同样的内容会回放首次结果而不是重跑一遍副作用。
 */
async function api(path, { method = 'GET', body, idempotencyKey } = {}) {
  const headers = state.token === '' ? {} : { Authorization: `Bearer ${state.token}` }
  if (state.projectId !== null) headers['X-Deepcode-Project'] = state.projectId
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
    logout(state.token === '' ? undefined : 'token 无效或已失效，请重新登录。')
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
  el('app').classList.remove('flex')
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
el('overview-new-session').addEventListener('click', () => void createSession())

// ── 会话 ─────────────────────────────────────────────────────────

async function enterApp() {
  try {
    await refreshProjects()
    const preferred = localStorage.getItem(PROJECT_KEY)
    const project = state.projects.find((item) => item.path === preferred) ?? state.projects[0]
    if (project === undefined) throw new Error('没有可打开的项目')
    await switchProject(project)
  } catch (error) {
    el('login').classList.remove('hidden')
    if (error.message !== 'unauthorized') showError(el('login-error'), error.message)
    return
  }
  el('login').classList.add('hidden')
  el('app').classList.remove('hidden')
  await renderRoute().catch(showRouteError)
}

async function refreshProjects() {
  const payload = await api('/api/projects')
  state.projects = payload.projects ?? []
  const select = el('project-select')
  select.replaceChildren()
  for (const project of state.projects) {
    const option = document.createElement('option')
    option.value = project.path
    option.textContent = project.name
    select.append(option)
  }
  if (state.projectPath !== null) select.value = state.projectPath
  renderProjects()
}

async function switchProject(project) {
  const opened = await api('/api/projects/open', {
    method: 'POST',
    body: { path: project.path },
    idempotencyKey: crypto.randomUUID(),
  })
  state.connectionGeneration += 1
  state.socket?.close()
  state.socket = null
  state.projectId = opened.id
  state.projectPath = opened.path
  state.sessionId = null
  state.lastEventId = null
  state.turnId = null
  state.running.clear()
  state.liveText = null
  resetTrace()
  localStorage.setItem(PROJECT_KEY, opened.path)
  el('project-path').textContent = opened.path
  el('project-path').title = opened.path
  el('project-select').value = opened.path
  el('topbar-project').textContent = project.name ?? opened.path.split('/').filter(Boolean).at(-1)
  el('messages').replaceChildren()
  el('session-title').textContent = '未选择会话'
  el('session-meta').textContent = ''
  await refreshSessions()
  const commands = await api('/api/commands')
  state.commands = commands.commands ?? []
  hideCommandMenu()
  renderOverview()
  renderCommands()
}

el('project-select').addEventListener('change', (event) => {
  const project = state.projects.find((item) => item.path === event.target.value)
  if (project)
    void switchProject(project)
      .then(() => navigate(`/projects/${state.projectId}`))
      .catch((error) => appendNote(`打开项目失败：${error.message}`, true))
})

function routeFromPath(pathname) {
  const parts = pathname.split('/').filter(Boolean)
  if (parts.length === 0 || (parts.length === 1 && parts[0] === 'projects'))
    return { page: 'projects' }
  if (parts.length === 1 && ['settings', 'commands'].includes(parts[0])) return { page: parts[0] }
  if (parts[0] === 'projects' && /^[a-f0-9]{24}$/.test(parts[1] ?? '')) {
    if (parts.length === 2) return { page: 'overview', projectId: parts[1] }
    if (parts.length === 4 && parts[2] === 'chats' && /^[A-Za-z0-9_-]+$/.test(parts[3]))
      return { page: 'chat', projectId: parts[1], sessionId: parts[3] }
  }
  return { page: 'projects' }
}

function chatPath(sessionId) {
  return `/projects/${state.projectId}/chats/${encodeURIComponent(sessionId)}`
}

function navigate(path, replace = false) {
  if (location.pathname !== path)
    window.history[replace ? 'replaceState' : 'pushState']({}, '', path)
  void renderRoute().catch((error) => showRouteError(error))
}

function showRouteError(error) {
  const page = document.querySelector('.route-page:not(.hidden)')
  if (page?.id === 'chat-page') appendNote(`页面加载失败：${error.message}`, true)
  else if (page?.id === 'settings-page') settingsStatus(`设置加载失败：${error.message}`, true)
  else if (page) {
    const note = document.createElement('p')
    note.className = 'empty-state'
    note.textContent = `页面加载失败：${error.message}`
    page.append(note)
  }
}

async function renderRoute() {
  const generation = ++state.routeGeneration
  const route = routeFromPath(location.pathname)
  if (route.page !== 'chat') for (const choice of choiceMenus) closeChoiceMenu(choice)
  if (location.pathname === '/') {
    window.history.replaceState({}, '', '/projects')
  } else if (route.page === 'projects' && location.pathname !== '/projects') {
    window.history.replaceState({}, '', '/projects')
  }
  if (route.projectId && route.projectId !== state.projectId) {
    const project = state.projects.find((item) => item.id === route.projectId)
    if (!project) {
      navigate('/projects', true)
      return
    }
    await switchProject(project)
    if (generation !== state.routeGeneration) return
  }
  if (route.page !== 'chat') {
    state.connectionGeneration += 1
    state.socket?.close()
    state.socket = null
    state.sessionId = null
    setConnectionState('未连接')
    renderSessions()
  }
  for (const page of ['projects', 'overview', 'chat', 'commands', 'settings'])
    el(`${page}-page`).classList.toggle('hidden', page !== route.page)
  for (const link of document.querySelectorAll('[data-nav]')) {
    const active =
      link.dataset.nav ===
      (route.page === 'overview' || route.page === 'chat' ? 'projects' : route.page)
    if (active) link.setAttribute('aria-current', 'page')
    else link.removeAttribute('aria-current')
  }
  const labels = {
    projects: '项目',
    overview: '项目概览',
    chat: '对话',
    commands: '命令',
    settings: '设置',
  }
  el('page-label').textContent = labels[route.page]
  document.title = `${labels[route.page]} · deepcode`
  if (route.page === 'projects') renderProjects()
  if (route.page === 'overview') renderOverview()
  if (route.page === 'commands') renderCommands()
  if (route.page === 'settings') {
    el('settings-status').classList.add('hidden')
    await loadSettings()
  }
  if (route.page === 'chat') {
    if (!state.sessions.some((item) => item.id === route.sessionId)) {
      navigate(`/projects/${state.projectId}`, true)
      return
    }
    el('chat-back').href = `/projects/${state.projectId}`
    await selectSession(route.sessionId)
  }
  if (generation === state.routeGeneration) animateRoute(route.page)
}

document.addEventListener('click', (event) => {
  const anchor = event.target.closest('a[data-route]')
  if (!anchor || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
  event.preventDefault()
  navigate(anchor.pathname)
})
window.addEventListener('popstate', () => void renderRoute().catch(showRouteError))

function renderProjects() {
  const list = el('project-card-list')
  list.replaceChildren()
  el('project-count').textContent = `${state.projects.length} 个项目`
  if (state.projects.length === 0) {
    const empty = document.createElement('p')
    empty.className = 'empty-state'
    empty.textContent = '还没有项目。打开一个本机文件夹开始。'
    list.append(empty)
  }
  for (const project of state.projects) {
    const card = document.createElement('button')
    card.type = 'button'
    card.className = 'project-card'
    const icon = document.createElement('span')
    icon.className = 'project-card-icon'
    icon.setAttribute('aria-hidden', 'true')
    const folder = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    folder.setAttribute('viewBox', '0 0 24 24')
    folder.setAttribute('fill', 'none')
    folder.setAttribute('stroke', 'currentColor')
    folder.setAttribute('stroke-width', '1.7')
    folder.setAttribute('stroke-linecap', 'round')
    folder.setAttribute('stroke-linejoin', 'round')
    const outline = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    outline.setAttribute(
      'd',
      'M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
    )
    folder.append(outline)
    icon.append(folder)
    const name = document.createElement('strong')
    name.textContent = project.name
    const path = document.createElement('small')
    path.textContent = project.path
    card.append(icon, name, path)
    card.addEventListener('click', () => navigate(`/projects/${project.id}`))
    list.append(card)
  }
}

function renderOverview() {
  const project = state.projects.find((item) => item.id === state.projectId)
  el('project-overview-name').textContent = project?.name ?? '项目概览'
  el('project-overview-path').textContent = state.projectPath ?? ''
  el('project-overview-count').textContent = String(state.sessions.length)
  const list = el('overview-session-list')
  list.replaceChildren()
  if (state.sessions.length === 0) {
    const empty = document.createElement('p')
    empty.className = 'empty-state'
    empty.textContent = '这个项目还没有对话。新建对话后会显示在这里。'
    list.append(empty)
  }
  for (const session of state.sessions) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'overview-session'
    const body = document.createElement('span')
    const title = document.createElement('strong')
    title.textContent = session.title || session.id
    const meta = document.createElement('small')
    meta.textContent = `${session.currentTurn ?? 0} 轮 · ${session.status ?? '已保存'}`
    body.append(title, meta)
    const arrow = document.createElement('span')
    arrow.className = 'arrow'
    arrow.textContent = '→'
    button.append(body, arrow)
    button.addEventListener('click', () => navigate(chatPath(session.id)))
    list.append(button)
  }
}

function renderCommands() {
  const query = el('commands-search').value.trim().toLowerCase()
  const list = el('commands-list')
  list.replaceChildren()
  const commands = state.commands.filter((command) =>
    [command.name, command.description, ...(command.aliases ?? [])]
      .join(' ')
      .toLowerCase()
      .includes(query),
  )
  if (commands.length === 0) {
    const empty = document.createElement('p')
    empty.className = 'empty-state'
    empty.textContent = state.commands.length === 0 ? '当前没有可用命令。' : '没有匹配的命令。'
    list.append(empty)
  }
  for (const command of commands) {
    const card = document.createElement('button')
    card.type = 'button'
    card.className = 'command-card'
    const name = document.createElement('code')
    name.textContent = `/${command.name}`
    const description = document.createElement('span')
    description.textContent = command.description
    card.append(name, description)
    card.addEventListener('click', async () => {
      if (state.sessions.length === 0) await createSession()
      else navigate(chatPath(state.sessions[0].id))
      chooseCommand(command)
    })
    list.append(card)
  }
}
el('commands-search').addEventListener('input', renderCommands)

const dialogTriggers = new WeakMap()

function toggleDialog(id, open) {
  const dialog = el(id)
  const panel = dialog.firstElementChild
  if (open) {
    const wasHidden = dialog.classList.contains('hidden')
    if (!wasHidden && !dialog.inert) return
    dialogTriggers.set(dialog, document.activeElement)
    dialog.inert = false
    dialog.classList.remove('hidden')
    dialog.classList.add('flex')
    motion(dialog, [{ opacity: 0 }, { opacity: 1 }], { duration: 0.2 })
    motion(
      panel,
      [
        { opacity: 0, transform: 'translateY(14px) scale(0.98)' },
        { opacity: 1, transform: 'translateY(0) scale(1)' },
      ],
      { duration: 0.26 },
    )
    const first = dialog.querySelector('input, button:not([disabled])')
    first?.focus()
    return
  }
  if (dialog.classList.contains('hidden') || dialog.inert) return
  dialog.inert = true
  motion(
    panel,
    [
      { opacity: 1, transform: 'translateY(0) scale(1)' },
      { opacity: 0, transform: 'translateY(8px) scale(0.985)' },
    ],
    { duration: 0.16, ease: 'power2.in' },
  )
  motion(dialog, [{ opacity: 1 }, { opacity: 0 }], {
    duration: 0.17,
    ease: 'power2.in',
    done: () => {
      dialog.classList.add('hidden')
      dialog.classList.remove('flex')
      dialog.inert = false
    },
  })
  const trigger = dialogTriggers.get(dialog)
  if (trigger?.isConnected) trigger.focus()
}

document.addEventListener('keydown', (event) => {
  const dialog = document.querySelector('[role="dialog"]:not(.hidden):not([inert])')
  if (!dialog) return
  if (event.key === 'Escape' && dialog.id === 'project-modal') {
    event.preventDefault()
    toggleDialog('project-modal', false)
  }
  if (event.key !== 'Tab') return
  const focusable = [
    ...dialog.querySelectorAll(
      'button:not([disabled]), input:not([disabled]), select:not([disabled])',
    ),
  ].filter((node) => node.getClientRects().length > 0)
  if (focusable.length === 0) return
  const first = focusable[0]
  const last = focusable.at(-1)
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first.focus()
  }
})

el('open-project').addEventListener('click', () => {
  toggleDialog('project-modal', true)
  void browseDirectory(state.projectPath).then(() => el('directory-path').focus())
})
el('projects-open').addEventListener('click', () => el('open-project').click())
el('close-project').addEventListener('click', () => toggleDialog('project-modal', false))
el('project-modal').addEventListener('click', (event) => {
  if (event.target === event.currentTarget) toggleDialog('project-modal', false)
})

async function browseDirectory(path) {
  const query = path ? `?path=${encodeURIComponent(path)}` : ''
  try {
    const payload = await api(`/api/directories${query}`)
    el('directory-error').classList.add('hidden')
    el('directory-path').value = payload.path
    el('directory-parent').disabled = payload.parent === null
    el('directory-parent').dataset.path = payload.parent ?? ''
    const list = el('directory-list')
    list.replaceChildren()
    for (const name of payload.directories ?? []) {
      const item = document.createElement('li')
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'command-option'
      button.textContent = name
      button.addEventListener(
        'click',
        () => void browseDirectory(`${payload.path.replace(/\/$/, '')}/${name}`),
      )
      item.append(button)
      list.append(item)
    }
  } catch (error) {
    showError(el('directory-error'), error.message)
  }
}

el('directory-form').addEventListener('submit', (event) => {
  event.preventDefault()
  void browseDirectory(el('directory-path').value.trim())
})
el('directory-parent').addEventListener('click', () => {
  void browseDirectory(el('directory-parent').dataset.path)
})
el('select-directory').addEventListener('click', () => {
  const path = el('directory-path').value.trim()
  void switchProject({ path })
    .then(async () => {
      toggleDialog('project-modal', false)
      await refreshProjects()
      navigate(`/projects/${state.projectId}`)
    })
    .catch((error) => showError(el('directory-error'), error.message))
})

// ── 配置管理 ──────────────────────────────────────────────────────

let settingsConfig = null

function settingsStatus(message, error = false) {
  const node = el('settings-status')
  node.textContent = message
  node.classList.remove('hidden')
  node.classList.toggle('text-rose-300', error)
  node.classList.toggle('text-emerald-300', !error)
}

async function loadSettings() {
  settingsConfig = await api('/api/config')
  const config = settingsConfig
  const list = el('provider-list')
  list.replaceChildren()
  if (config.providers.length === 0) {
    const empty = document.createElement('p')
    empty.className = 'text-slate-400'
    empty.textContent = '尚未添加供应商。'
    list.append(empty)
  }
  for (const provider of config.providers) {
    const card = document.createElement('div')
    card.className = 'rounded-lg border border-slate-700 p-3'
    const title = document.createElement('p')
    title.className = 'font-medium'
    title.textContent = `${provider.name} · ${provider.enabled ? '已启用' : '已停用'}`
    const detail = document.createElement('p')
    detail.className = 'break-all text-xs text-slate-400'
    detail.textContent = provider.baseUrl
    const models = document.createElement('p')
    models.className = 'mt-2 text-xs text-slate-300'
    models.textContent =
      config.models
        .filter((model) => model.providerId === provider.id)
        .map((model) => model.id)
        .join('、') || '暂无模型'
    const toggle = document.createElement('button')
    toggle.type = 'button'
    toggle.className =
      'mt-2 rounded-lg border border-slate-600 px-3 py-2 text-xs hover:bg-slate-800'
    toggle.textContent = provider.enabled ? '停用供应商' : '启用供应商'
    toggle.addEventListener(
      'click',
      () =>
        void saveSettings(
          {
            action: 'provider_toggle',
            id: provider.id,
            enabled: !provider.enabled,
          },
          '供应商状态已保存。',
        ),
    )
    card.append(title, detail, models, toggle)
    list.append(card)
  }

  const modelProvider = el('model-provider')
  modelProvider.replaceChildren()
  for (const provider of config.providers) {
    const option = document.createElement('option')
    option.value = provider.id
    option.textContent = provider.name
    modelProvider.append(option)
  }

  const tierSelect = el('tier-name')
  tierSelect.replaceChildren()
  for (const tier of config.availableTiers) {
    const option = document.createElement('option')
    option.value = tier
    option.textContent = tier
    tierSelect.append(option)
  }
  const modelSelect = el('tier-model')
  modelSelect.replaceChildren()
  for (const model of config.models.filter(
    (item) =>
      item.enabled &&
      config.providers.some((provider) => provider.id === item.providerId && provider.enabled),
  )) {
    const provider = config.providers.find((item) => item.id === model.providerId)
    const option = document.createElement('option')
    option.value = `${model.providerId}/${model.id}`
    option.textContent = `${provider?.name ?? model.providerId}/${model.id}`
    modelSelect.append(option)
  }
  const selectedTier = config.tiers.find((item) => item.tier === tierSelect.value)
  if (selectedTier) modelSelect.value = `${selectedTier.providerId}/${selectedTier.modelId}`
  el('settings-language').value = config.language
  const policySelect = el('policy-key')
  policySelect.replaceChildren()
  for (const key of config.policySettingKeys) {
    const option = document.createElement('option')
    option.value = key
    option.textContent = key
    policySelect.append(option)
  }
  el('policy-value').value = config.policySettings[`policy.${policySelect.value}`] ?? ''
  const mcpList = el('mcp-list')
  mcpList.replaceChildren()
  if (config.mcpServers.length === 0) {
    const empty = document.createElement('p')
    empty.className = 'text-slate-400'
    empty.textContent = '尚未配置 MCP 服务。'
    mcpList.append(empty)
  }
  for (const server of config.mcpServers) {
    const row = document.createElement('div')
    row.className = 'flex items-center justify-between gap-2 rounded-lg border border-slate-700 p-3'
    const label = document.createElement('span')
    label.textContent = `${server.name} · ${server.transport} · ${server.enabled ? '已启用' : '已停用'}`
    const toggle = document.createElement('button')
    toggle.type = 'button'
    toggle.className =
      'shrink-0 rounded-lg border border-slate-600 px-3 py-2 text-xs hover:bg-slate-800'
    toggle.textContent = server.enabled ? '停用' : '启用'
    toggle.addEventListener(
      'click',
      () =>
        void saveSettings(
          {
            action: 'mcp_toggle',
            name: server.name,
            enabled: !server.enabled,
          },
          'MCP 设置已保存，重启 DeepCode 后生效。',
        ),
    )
    row.append(label, toggle)
    mcpList.append(row)
  }
}

async function saveSettings(body, success) {
  try {
    settingsConfig = await api('/api/config', {
      method: 'POST',
      body,
      idempotencyKey: crypto.randomUUID(),
    })
    await loadSettings()
    settingsStatus(success)
  } catch (error) {
    settingsStatus(error.message, true)
  }
}

el('tier-name').addEventListener('change', () => {
  const tier = settingsConfig?.tiers.find((item) => item.tier === el('tier-name').value)
  if (tier) el('tier-model').value = `${tier.providerId}/${tier.modelId}`
})
el('policy-key').addEventListener('change', () => {
  el('policy-value').value =
    settingsConfig?.policySettings[`policy.${el('policy-key').value}`] ?? ''
})

el('provider-form').addEventListener('submit', (event) => {
  event.preventDefault()
  const form = new globalThis.FormData(event.currentTarget)
  void saveSettings(
    {
      action: 'provider_add',
      name: form.get('name'),
      baseUrl: form.get('baseUrl'),
      apiKeySource: form.get('apiKeySource'),
      apiKeyKey: form.get('apiKeyKey'),
      modelId: form.get('modelId'),
      contextWindow: Number(form.get('contextWindow')),
      maxOutputTokens: Number(form.get('maxOutputTokens')),
      supportsTools: form.has('supportsTools'),
    },
    '供应商与模型已添加。',
  )
})
el('model-form').addEventListener('submit', (event) => {
  event.preventDefault()
  const form = new globalThis.FormData(event.currentTarget)
  void saveSettings(
    {
      action: 'model_add',
      providerId: el('model-provider').value,
      modelId: form.get('modelId'),
      contextWindow: Number(form.get('contextWindow')),
      maxOutputTokens: Number(form.get('maxOutputTokens')),
      supportsTools: form.has('supportsTools'),
    },
    '模型已添加。',
  )
})
el('tier-form').addEventListener('submit', (event) => {
  event.preventDefault()
  const value = el('tier-model').value
  const model = settingsConfig?.models.find((item) => `${item.providerId}/${item.id}` === value)
  if (!model) return settingsStatus('请选择模型。', true)
  void saveSettings(
    {
      action: 'tier_set',
      tier: el('tier-name').value,
      providerId: model.providerId,
      modelId: model.id,
    },
    '模型档位已保存。',
  )
})
el('language-form').addEventListener('submit', (event) => {
  event.preventDefault()
  void saveSettings(
    { action: 'language', language: el('settings-language').value },
    '语言设置已保存。',
  )
})
el('policy-form').addEventListener('submit', (event) => {
  event.preventDefault()
  void saveSettings(
    { action: 'policy_set', key: el('policy-key').value, value: el('policy-value').value },
    '运行阈值已保存，重启 DeepCode 后生效。',
  )
})
el('mcp-form').addEventListener('submit', (event) => {
  event.preventDefault()
  const form = new globalThis.FormData(event.currentTarget)
  void saveSettings(
    {
      action: 'mcp_add',
      name: form.get('name'),
      transport: form.get('transport'),
      target: form.get('target'),
      args: String(form.get('args') ?? '')
        .split('\n')
        .map((item) => item.trim())
        .filter(Boolean),
    },
    'MCP 服务已添加，重启 DeepCode 后生效。',
  )
})

async function refreshSessions() {
  const payload = await api('/api/sessions')
  state.sessions = payload.sessions ?? []
  renderSessions()
  renderOverview()
  if (state.sessionId !== null) renderSessionHeader()
}

function renderSessionHeader() {
  const session = state.sessions.find((item) => item.id === state.sessionId)
  if (state.sessionId === null) return
  el('session-title').textContent = session?.title || state.sessionId
  el('session-meta').textContent = `turn ${session?.currentTurn ?? 0} · ${session?.status ?? ''}`
}

function renderSessions() {
  const list = el('session-list')
  list.replaceChildren()
  for (const session of state.sessions) {
    const item = document.createElement('li')
    const button = document.createElement('button')
    button.type = 'button'
    button.className = `session-link${session.id === state.sessionId ? ' active' : ''}`
    button.textContent = session.title || session.id
    button.addEventListener('click', () => {
      navigate(chatPath(session.id))
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
  navigate(chatPath(payload.sessionId))
}

async function selectSession(sessionId) {
  for (const choice of choiceMenus) closeChoiceMenu(choice)
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
  resetTrace()
  state.modelOverride = sessionStorage.getItem(`${MODEL_KEY_PREFIX}${sessionId}`)
  state.availableModels = []
  state.automaticModelLabel = '加载模型…'
  renderComposerModelChoice()
  const projectId = state.projectId
  renderSessionHeader()
  renderSessions()

  await loadComposerModels(sessionId)
  if (state.sessionId !== sessionId || state.projectId !== projectId) return
  await loadHistory()
  if (state.sessionId !== sessionId || state.projectId !== projectId) return
  await refreshPending()
  if (state.sessionId !== sessionId || state.projectId !== projectId) return
  connect()
}

async function loadComposerModels(sessionId) {
  const config = await api('/api/config')
  if (state.sessionId !== sessionId) return
  const enabledProviders = new Map(
    config.providers
      .filter((provider) => provider.enabled)
      .map((provider) => [provider.id, provider]),
  )
  state.availableModels = config.models
    .filter((model) => model.enabled && enabledProviders.has(model.providerId))
    .map((model) => ({
      key: JSON.stringify([model.providerId, model.id]),
      providerId: model.providerId,
      modelId: model.id,
      label: model.displayName,
      providerName: enabledProviders.get(model.providerId).name,
    }))

  const assigned = config.tiers.find((tier) => tier.tier === 'implementation' && tier.enabled)
  const defaultModel = state.availableModels.find(
    (model) => model.providerId === assigned?.providerId && model.modelId === assigned?.modelId,
  )
  state.automaticModelLabel = defaultModel ? `${defaultModel.label} · 自动` : '自动选择模型'
  if (
    state.modelOverride &&
    !state.availableModels.some((model) => model.key === state.modelOverride)
  ) {
    state.modelOverride = null
    sessionStorage.removeItem(`${MODEL_KEY_PREFIX}${sessionId}`)
  }
  renderComposerModelChoice()
}

function renderComposerModelChoice() {
  const selected = state.availableModels.find((model) => model.key === state.modelOverride)
  const automaticLabel = state.automaticModelLabel
  const label = selected ? `${selected.label} · ${selected.providerName}` : automaticLabel
  const trigger = el('composer-model')
  el('composer-model-value').textContent = label
  trigger.setAttribute('aria-label', `当前模型：${label}`)
  trigger.title = `${label} · 选择已配置的模型`
  trigger.disabled = state.availableModels.length === 0
  renderChoiceMenu(
    choiceMenus[1],
    [
      { value: '', label: automaticLabel },
      ...state.availableModels.map((model) => ({
        value: model.key,
        label: model.label,
        detail: model.providerName,
      })),
    ],
    state.modelOverride ?? '',
    setModelOverride,
  )
}

/** 从消息历史重建视图。这是 `resync_required` 之后必须走的路。 */
async function loadHistory() {
  if (state.sessionId === null) return
  const sessionId = state.sessionId
  const projectId = state.projectId
  const payload = await api(`/api/sessions/${sessionId}/messages`)
  if (state.sessionId !== sessionId || state.projectId !== projectId) return
  state.messages = payload.messages ?? []
  const container = el('messages')
  container.replaceChildren()
  state.liveText = null
  for (const message of state.messages) renderMessage(message)
  if (container.childElementCount === 0) renderChatEmptyState()
  container.scrollTop = container.scrollHeight
  if (state.viewMode === 'advanced') {
    renderTraceMessages()
    await loadTrace()
  }
}

function renderChatEmptyState() {
  const container = el('messages')
  const empty = document.createElement('div')
  empty.className = 'chat-empty'
  const mark = document.createElement('span')
  mark.className = 'chat-empty-mark'
  mark.setAttribute('aria-hidden', 'true')
  mark.textContent = '>_'
  const heading = document.createElement('h2')
  const projectName = state.projects.find((item) => item.id === state.projectId)?.name ?? 'deepcode'
  heading.textContent = `想在 ${projectName} 中构建什么？`
  empty.append(mark, heading)
  container.append(empty)
}

function hideChatEmptyState() {
  el('messages').querySelector('.chat-empty')?.remove()
}

function renderMessage(message) {
  const container = el('messages')
  const wrap = document.createElement('div')
  const bodyMarkdown = message.displayMarkdown ?? message.content
  if (bodyMarkdown === '') return
  hideChatEmptyState()

  if (message.role === 'user') {
    wrap.className = 'message-user'
    const bubble = document.createElement('div')
    bubble.className = 'message-user-bubble markdown-body'
    renderMarkdown(bubble, bodyMarkdown)
    wrap.append(bubble)
  } else if (message.role === 'assistant') {
    wrap.className = 'message-assistant markdown-body'
    renderMarkdown(wrap, bodyMarkdown)
    wrap.dataset.turnId = message.turnId ?? ''
  } else {
    // tool / system：审计类内容，弱化展示。
    wrap.className = 'message-system'
    const label = document.createElement('span')
    label.className = 'message-label'
    label.textContent = `[${message.subtype}]`
    const body = document.createElement('div')
    body.className = 'markdown-body'
    renderMarkdown(body, bodyMarkdown)
    wrap.append(label, body)
  }

  container.append(wrap)
  container.scrollTop = container.scrollHeight
}

// ── 高级对话视图 ────────────────────────────────────────────────────

const traceEventNames = {
  turn_start: '任务开始',
  thinking: '模型思考',
  text: '文本增量',
  tool_use: '工具调用',
  tool_result: '工具结果',
  skill_resolved: '技能选择',
  compact_start: '开始压缩',
  compact_end: '压缩完成',
  auto_continue: '自动续跑',
  permission_required: '等待审批',
  permission_resolved: '审批完成',
  user_input_required: '等待用户输入',
  turn_end: '任务结束',
  model_route_changed: '模型切换',
  cancel_requested: '请求取消',
  error: '运行错误',
  'model.route.selected': '模型路由',
  'model.call.started': '模型请求开始',
  'model.call.completed': '模型请求完成',
  'model.call.failed': '模型请求失败',
  'model.retry': '模型重试',
  'model.fallback': '模型回退',
  'tool.execution.started': '工具执行开始',
  'tool.execution.completed': '工具执行完成',
  'permission.requested': '请求审批',
  'permission.decided': '审批决定',
  'permission.resolved': '审批处理完成',
  'compact.completed': '压缩统计',
  'subagent.queued': '子代理排队',
  'subagent.started': '子代理开始',
  'subagent.completed': '子代理完成',
  'subagent.resume.requested': '子代理恢复',
  'turn.completed': '任务统计',
}

const traceFieldNames = {
  eventId: '事件 ID',
  observationId: '观测 ID',
  sequence: '序号',
  type: '类型',
  timestamp: '发生时间',
  createdAt: '创建时间',
  sessionId: '会话 ID',
  turnId: '任务 ID',
  toolCallId: '工具调用 ID',
  subagentSessionId: '子代理会话 ID',
  policyId: '策略 ID',
  elapsedMs: '耗时（毫秒）',
  data: '事件数据',
  meta: '附加信息',
  content: '内容',
  displayMarkdown: '渲染内容',
  role: '角色',
  subtype: '子类型',
  agentType: '代理类型',
}

function resetTrace() {
  if (state.traceRefreshTimer !== null) clearTimeout(state.traceRefreshTimer)
  state.traceRefreshTimer = null
  state.messages = []
  state.traceEvents.clear()
  state.traceObservations.clear()
  el('trace-messages').replaceChildren()
  el('trace-activity').replaceChildren()
  renderTraceStats()
}

function setViewMode(mode) {
  state.viewMode = mode
  localStorage.setItem(VIEW_KEY, mode)
  el('view-normal').setAttribute('aria-pressed', String(mode === 'normal'))
  el('view-advanced').setAttribute('aria-pressed', String(mode === 'advanced'))
  el('messages').classList.toggle('hidden', mode !== 'normal')
  el('trace-view').classList.toggle('hidden', mode !== 'advanced')
  if (mode === 'advanced') {
    renderTraceMessages()
    renderTraceActivity()
    if (state.sessionId !== null) void loadTrace()
  }
}

el('view-normal').addEventListener('click', () => setViewMode('normal'))
el('view-advanced').addEventListener('click', () => setViewMode('advanced'))
setViewMode(state.viewMode)

function traceTime(value) {
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? String(value ?? '') : parsed.toLocaleString('zh-CN')
}

function fieldValue(value, depth = 0) {
  const node = document.createElement('div')
  node.className = 'trace-field-value'
  if (value === null) {
    node.textContent = '空值'
    node.classList.add('trace-null')
  } else if (Array.isArray(value)) {
    if (value.length === 0) node.textContent = '空列表'
    else {
      const list = document.createElement('ol')
      list.className = 'trace-array'
      for (const item of value) {
        const row = document.createElement('li')
        row.append(fieldValue(item, depth + 1))
        list.append(row)
      }
      node.append(list)
    }
  } else if (typeof value === 'object') {
    if (depth > 16) node.textContent = '层级过深'
    else if (Object.keys(value).length === 0) node.textContent = '空对象'
    else node.append(fieldList(value, depth + 1))
  } else if (typeof value === 'boolean') {
    node.textContent = value ? '是 · true' : '否 · false'
    node.classList.add(value ? 'trace-true' : 'trace-false')
  } else {
    node.textContent = String(value)
    if (typeof value === 'string' && value.includes('\n')) node.classList.add('trace-multiline')
  }
  return node
}

function fieldList(record, depth = 0) {
  const list = document.createElement('dl')
  list.className = 'trace-fields'
  for (const [key, value] of Object.entries(record)) {
    const row = document.createElement('div')
    row.className = 'trace-field'
    const label = document.createElement('dt')
    label.textContent = traceFieldNames[key] ?? key
    if (traceFieldNames[key]) {
      const original = document.createElement('small')
      original.textContent = key
      label.append(original)
    }
    const content = document.createElement('dd')
    content.append(fieldValue(value, depth + 1))
    row.append(label, content)
    list.append(row)
  }
  return list
}

function traceDetails(record, initiallyOpen = false) {
  const details = document.createElement('details')
  details.className = 'trace-details'
  details.open = initiallyOpen
  const summary = document.createElement('summary')
  summary.textContent = '查看全部字段'
  details.append(summary)
  let populated = false
  const populate = () => {
    if (!details.open || populated) return
    details.append(fieldList(record))
    populated = true
  }
  details.addEventListener('toggle', populate)
  populate()
  return details
}

function renderTraceStats() {
  const stats = el('trace-stats')
  stats.replaceChildren()
  for (const [label, value] of [
    ['消息', state.messages.length],
    ['事件', state.traceEvents.size],
    ['观测', state.traceObservations.size],
  ]) {
    const pill = document.createElement('span')
    pill.textContent = `${value} ${label}`
    stats.append(pill)
  }
}

function renderTraceMessages() {
  const container = el('trace-messages')
  const expanded = new Set(
    [...container.querySelectorAll('.trace-card')]
      .filter((card) => card.querySelector('.trace-details')?.open)
      .map((card) => card.dataset.traceId),
  )
  container.replaceChildren()
  for (const message of state.messages) {
    const card = document.createElement('article')
    card.className = 'trace-card trace-message'
    card.dataset.traceId = message.id
    const heading = document.createElement('div')
    heading.className = 'trace-card-heading'
    const title = document.createElement('strong')
    title.textContent =
      { user: '用户', assistant: '助手', tool: '工具' }[message.role] ?? message.role
    const time = document.createElement('time')
    time.dateTime = message.createdAt
    time.textContent = traceTime(message.createdAt)
    heading.append(title, time)
    const body = document.createElement('div')
    body.className = 'trace-message-body markdown-body'
    const markdown = message.displayMarkdown ?? message.content
    if (markdown) renderMarkdown(body, markdown)
    else body.textContent = '无正文'
    card.append(heading, body, traceDetails(message, expanded.has(message.id)))
    container.append(card)
  }
  if (state.messages.length === 0) container.textContent = '暂无消息记录。'
  renderTraceStats()
}

async function refreshTraceMessages() {
  if (state.viewMode !== 'advanced' || state.sessionId === null) return
  const sessionId = state.sessionId
  const projectId = state.projectId
  const payload = await api(`/api/sessions/${sessionId}/messages`)
  if (state.sessionId !== sessionId || state.projectId !== projectId) return
  state.messages = payload.messages ?? []
  renderTraceMessages()
}

function traceSummary(record, kind) {
  const data = record.data ?? {}
  if (kind === 'event') {
    if (record.type === 'text' || record.type === 'thinking')
      return String(data.preview ?? data.content ?? '').slice(0, 120)
    if (record.type === 'tool_use' || record.type === 'tool_result')
      return [data.name, data.error_code].filter(Boolean).join(' · ')
    if (record.type === 'turn_end') return String(data.status ?? '')
    if (record.type === 'error') return String(data.message ?? '')
    if (record.type === 'model_route_changed')
      return `${data.from_provider ?? ''}/${data.from_model ?? ''} → ${data.to_provider ?? ''}/${data.to_model ?? ''}`
  } else {
    if (record.type.startsWith('model.')) {
      const model = [data.provider_id, data.model_id].filter(Boolean).join(' / ')
      const usage =
        record.type === 'model.call.completed'
          ? ` · ${data.input_tokens ?? 0} 入 / ${data.output_tokens ?? 0} 出 token`
          : ''
      return `${model}${usage}`
    }
    if (record.type.startsWith('tool.'))
      return `${data.tool_name ?? ''}${data.ok === false ? ' · 失败' : ''}`
  }
  return String(data.name ?? data.tool_name ?? data.status ?? data.reason ?? '')
}

function traceActivityCard(record, kind, expanded = false) {
  const card = document.createElement('article')
  card.className = `trace-card trace-${kind}`
  card.dataset.traceId = record.eventId ?? record.observationId
  if (record.type === 'error' || record.data?.ok === false) card.classList.add('trace-error')
  const heading = document.createElement('div')
  heading.className = 'trace-card-heading'
  const title = document.createElement('strong')
  title.textContent = traceEventNames[record.type] ?? record.type.replaceAll('_', ' ')
  const time = document.createElement('time')
  time.dateTime = record.timestamp
  time.textContent = traceTime(record.timestamp)
  heading.append(title, time)
  const type = document.createElement('div')
  type.className = 'trace-type'
  type.textContent = `${kind === 'event' ? '运行事件' : '本地观测'} · ${record.type}`
  const summary = traceSummary(record, kind)
  card.append(heading, type)
  if (summary) {
    const preview = document.createElement('p')
    preview.className = 'trace-summary'
    preview.textContent = summary
    card.append(preview)
  }
  const ids = [
    record.turnId,
    record.toolCallId,
    record.elapsedMs !== undefined ? `${record.elapsedMs} ms` : null,
  ].filter(Boolean)
  if (ids.length) {
    const context = document.createElement('div')
    context.className = 'trace-context'
    for (const value of ids) {
      const chip = document.createElement('span')
      chip.textContent = value
      context.append(chip)
    }
    card.append(context)
  }
  card.append(traceDetails(record, expanded))
  return card
}

function renderTraceActivity() {
  const container = el('trace-activity')
  const expanded = new Set(
    [...container.querySelectorAll('.trace-card')]
      .filter((card) => card.querySelector('.trace-details')?.open)
      .map((card) => card.dataset.traceId),
  )
  container.replaceChildren()
  const records = [
    ...[...state.traceEvents.values()].map((value) => ({ kind: 'event', value })),
    ...[...state.traceObservations.values()].map((value) => ({ kind: 'observation', value })),
  ].sort((a, b) => {
    const time = String(a.value.timestamp).localeCompare(String(b.value.timestamp))
    return time || (a.value.sequence ?? 0) - (b.value.sequence ?? 0)
  })
  for (const record of records)
    container.append(
      traceActivityCard(
        record.value,
        record.kind,
        expanded.has(record.value.eventId ?? record.value.observationId),
      ),
    )
  if (records.length === 0) container.textContent = '暂无运行记录。发送消息后可在此追踪过程。'
  renderTraceStats()
}

async function loadTrace() {
  if (state.sessionId === null) return
  const sessionId = state.sessionId
  const projectId = state.projectId
  try {
    const payload = await api(`/api/sessions/${sessionId}/trace`)
    if (state.sessionId !== sessionId || state.projectId !== projectId) return
    for (const event of payload.events ?? []) state.traceEvents.set(event.eventId, event)
    for (const record of payload.observations ?? [])
      state.traceObservations.set(record.observationId, record)
    if (state.viewMode === 'advanced') renderTraceActivity()
  } catch (error) {
    if (state.sessionId === sessionId && state.viewMode === 'advanced')
      el('trace-activity').textContent = `读取过程记录失败：${error.message}`
  }
}

function scheduleTraceRefresh() {
  if (state.viewMode !== 'advanced' || state.traceRefreshTimer !== null) return
  state.traceRefreshTimer = setTimeout(() => {
    state.traceRefreshTimer = null
    void loadTrace()
  }, 350)
}

// ── 提交 ──────────────────────────────────────────────────────────

function hideCommandMenu() {
  state.commandMatches = []
  state.commandIndex = -1
  el('command-menu').classList.add('hidden')
  el('prompt').setAttribute('aria-expanded', 'false')
  el('prompt').removeAttribute('aria-activedescendant')
}

function showCommandMenu() {
  const value = el('prompt').value
  if (!value.startsWith('/') || /\s/.test(value.slice(1))) {
    hideCommandMenu()
    return
  }
  const query = value.slice(1).toLowerCase()
  state.commandMatches = state.commands
    .filter(
      (item) =>
        item.name.toLowerCase().startsWith(query) ||
        item.aliases?.some((alias) => alias.toLowerCase().startsWith(query)),
    )
    .slice(0, 12)
  state.commandIndex = state.commandMatches.some((item) => item.name.toLowerCase() === query)
    ? -1
    : 0
  renderCommandMenu()
}

function renderCommandMenu() {
  const menu = el('command-menu')
  const wasHidden = menu.classList.contains('hidden')
  menu.replaceChildren()
  menu.classList.toggle('hidden', state.commandMatches.length === 0)
  if (wasHidden && state.commandMatches.length > 0) appear(menu, 0, 6)
  el('prompt').setAttribute('aria-expanded', state.commandMatches.length > 0 ? 'true' : 'false')
  state.commandMatches.forEach((command, index) => {
    const option = document.createElement('button')
    option.type = 'button'
    option.id = `command-option-${index}`
    option.setAttribute('role', 'option')
    option.setAttribute('aria-selected', String(index === state.commandIndex))
    option.className = `command-option${index === state.commandIndex ? ' active' : ''}`
    const label = document.createElement('span')
    label.className = 'font-medium'
    label.textContent = `/${command.name}`
    const description = document.createElement('span')
    description.className = 'command-option-description'
    description.textContent = command.description
    option.append(label, description)
    option.addEventListener('click', () => chooseCommand(command))
    menu.append(option)
  })
  if (state.commandIndex >= 0)
    el('prompt').setAttribute('aria-activedescendant', `command-option-${state.commandIndex}`)
  else el('prompt').removeAttribute('aria-activedescendant')
}

function chooseCommand(command) {
  el('prompt').value = `/${command.name}${command.parameters?.length ? ' ' : ''}`
  el('prompt').focus()
  hideCommandMenu()
}

el('prompt').addEventListener('input', showCommandMenu)
el('prompt').addEventListener('focus', showCommandMenu)

el('composer').addEventListener('submit', (event) => {
  event.preventDefault()
  void submit()
})

el('prompt').addEventListener('keydown', (event) => {
  if (event.isComposing) return
  if (event.key === 'Escape' && state.commandMatches.length > 0) {
    event.preventDefault()
    hideCommandMenu()
    return
  }
  if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && state.commandMatches.length > 0) {
    event.preventDefault()
    const delta = event.key === 'ArrowDown' ? 1 : -1
    state.commandIndex =
      (state.commandIndex + delta + state.commandMatches.length) % state.commandMatches.length
    renderCommandMenu()
    return
  }
  if (event.key === 'Tab' && state.commandMatches.length > 0) {
    event.preventDefault()
    chooseCommand(state.commandMatches[Math.max(0, state.commandIndex)])
    return
  }
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault()
    if (state.commandMatches.length > 0 && state.commandIndex >= 0) {
      chooseCommand(state.commandMatches[state.commandIndex])
      return
    }
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
  const mode = state.permissionMode
  const modelKey = state.modelOverride
  const model = state.availableModels.find((item) => item.key === modelKey)

  // 以 `/` 开头走命令通道，其余是普通消息。
  const isCommand = text.startsWith('/')
  hideCommandMenu()

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
      if (
        previous.text === text &&
        previous.mode === mode &&
        previous.modelKey === modelKey &&
        state.running.has(state.sessionId)
      )
        idempotencyKey = previous.key
    } catch {
      /* 存坏了就当没有，重新生成 */
    }
  }
  sessionStorage.setItem(
    pendingKey(state.sessionId),
    JSON.stringify({ key: idempotencyKey, text, mode, modelKey }),
  )

  input.value = ''
  setBusy(true)

  try {
    if (isCommand) {
      const result = await api('/api/commands', {
        method: 'POST',
        body: { command: text, sessionId: state.sessionId },
        idempotencyKey,
      })
      await loadHistory()
      await showCommandResult(result)
    } else {
      const payload = await api(`/api/sessions/${state.sessionId}/turns`, {
        method: 'POST',
        body: {
          prompt: text,
          mode,
          ...(model === undefined
            ? {}
            : { override: { providerId: model.providerId, modelId: model.modelId } }),
        },
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

async function showCommandResult(result) {
  if (result.data?.kind === 'switch_session' && result.data.sessionId) {
    await refreshSessions()
    navigate(chatPath(result.data.sessionId))
    return
  }
  if (result.data?.kind === 'session_select' && Array.isArray(result.data.sessions)) {
    await refreshSessions()
    const container = el('messages')
    const panel = document.createElement('div')
    panel.className = 'message-note'
    for (const session of result.data.sessions) {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'command-option'
      const title = state.sessions.find((item) => item.id === session.id)?.title ?? session.title
      button.textContent = `${title}（${session.current_turn} 轮）`
      button.addEventListener('click', () => navigate(chatPath(session.id)))
      panel.append(button)
    }
    container.append(panel)
    container.scrollTop = container.scrollHeight
    return
  }
  appendNote(result.text ?? '命令已执行')
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
  hideChatEmptyState()
  const node = document.createElement('div')
  node.className = `message-note${isError ? ' error' : ''}`
  node.textContent = text
  container.append(node)
  appear(node, 0, 5)
  container.scrollTop = container.scrollHeight
}

// ── 权限与提问 ────────────────────────────────────────────────────

async function refreshPending() {
  if (state.sessionId === null) return
  const sessionId = state.sessionId
  const projectId = state.projectId
  const payload = await api('/api/pending')
  if (state.sessionId !== sessionId || state.projectId !== projectId) return
  const mine = (payload.approvals ?? []).filter((item) => item.sessionId === sessionId)
  const questions = (payload.userInputs ?? []).filter((item) => item.sessionId === sessionId)

  if (mine.length > 0) {
    showApproval(mine[0])
  } else if (state.approvalRequestId !== null) {
    hideApproval()
  }
  renderQuestions(questions)
}

function showApproval(view) {
  state.approvalRequestId = view.requestId
  const isBash = view.toolName === 'bash'
  el('approval-always').textContent = isBash ? '始终允许此命令' : '始终允许此工具'
  const detail = view.approvalPreview
  const hasDetail =
    typeof detail?.text === 'string' &&
    detail.text.trim() !== '' &&
    detail.text.trim() !== '[redacted]'
  el('approval-tool').textContent = view.toolName
  el('approval-risk').textContent =
    { low: '低', medium: '中', high: '高', critical: '极高' }[view.riskLevel] ?? view.riskLevel
  el('approval-reason').textContent =
    isBash && view.reason === 'command requires approval'
      ? '此命令需要批准才能执行。'
      : view.reason === 'tool requires approval'
        ? '此工具调用需要批准才能执行。'
        : (view.reason ?? '')
  el('approval-detail-label').textContent = hasDetail ? detail.label : '待执行内容'
  el('approval-detail-label').classList.remove('hidden')
  el('approval-args').textContent = hasDetail ? detail.text : (view.argsPreview ?? '')
  el('approval-allow').disabled = !hasDetail
  el('approval-always').disabled = !hasDetail
  el('approval-allow-once').disabled = !hasDetail
  el('approval-error').textContent = !hasDetail ? '无法读取待执行内容，请刷新页面后重试。' : ''
  el('approval-error').classList.toggle('hidden', hasDetail)
  toggleDialog('approval-modal', true)
}

function hideApproval() {
  state.approvalRequestId = null
  toggleDialog('approval-modal', false)
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
    void refreshPending().catch(() => undefined)
  } catch (error) {
    showError(el('approval-error'), error.message)
  }
}

el('approval-allow').addEventListener('click', () => {
  void resolveApproval('allow')
})
el('approval-always').addEventListener('click', () => {
  void resolveApproval('allow', 'tool')
})
el('approval-allow-once').addEventListener('click', () => {
  void resolveApproval('allow', 'once')
})
el('approval-deny').addEventListener('click', () => {
  void resolveApproval('deny')
})

function renderQuestions(views) {
  const container = el('pending')
  const wasHidden = container.classList.contains('hidden')
  container.replaceChildren()
  if (views.length === 0) {
    container.classList.add('hidden')
    return
  }
  container.classList.remove('hidden')
  if (wasHidden) appear(container, 0, 8)

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
  document
    .querySelector('.status-dot')
    ?.classList.toggle('connected', /^(已连接|已订阅|已同步|思考中)/.test(text))
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
  const socket = new WebSocket(
    `${scheme}://${location.host}/api/stream?ticket=${encodeURIComponent(ticket)}&project=${encodeURIComponent(state.projectId)}`,
  )
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
      resetTrace()
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
  if (!state.traceEvents.has(event.eventId)) {
    state.traceEvents.set(event.eventId, event)
    if (state.viewMode === 'advanced') {
      const activity = el('trace-activity')
      if (state.traceEvents.size + state.traceObservations.size === 1) activity.replaceChildren()
      activity.append(traceActivityCard(event, 'event'))
      renderTraceStats()
    }
  }
  const data = event.data ?? {}

  switch (event.type) {
    case 'turn_start':
      state.turnId = event.turnId
      state.running.add(event.sessionId)
      setBusy(true)
      startLiveText(event.turnId)
      void refreshTraceMessages().catch(() => undefined)
      if (
        state.sessions.some(
          (session) => session.id === event.sessionId && session.title === 'Web 会话',
        )
      )
        void refreshSessions().catch(() => undefined)
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
      void refreshTraceMessages().catch(() => undefined)
      scheduleTraceRefresh()
      return
    case 'permission_required':
      void refreshPending().catch(() =>
        showApproval({
          requestId: data.request_id,
          toolName: data.tool_name,
          riskLevel: data.risk_level,
          reason: data.reason,
          argsPreview: data.args_preview,
        }),
      )
      return
    case 'permission_resolved':
      if (data.request_id === state.approvalRequestId) hideApproval()
      void refreshPending().catch(() => undefined)
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
      scheduleTraceRefresh()
      return
    case 'error':
      // ⚠️ `error` 同样是**终止信号**。只认 `turn_end` 的客户端会在这里挂住。
      appendNote(`错误：${data.message ?? ''}`, true)
      endTurn(event.sessionId)
      scheduleTraceRefresh()
      return
    default:
      return
  }
}

function startLiveText(turnId) {
  const container = el('messages')
  hideChatEmptyState()
  const node = document.createElement('div')
  node.className = 'message-assistant markdown-body'
  node.dataset.turnId = turnId ?? ''
  container.append(node)
  appear(node, 0, 7)
  container.scrollTop = container.scrollHeight
  state.liveText = { node, text: '', renderScheduled: false }
}

function appendLiveText(chunk) {
  if (state.liveText === null) startLiveText(state.turnId)
  if (state.liveText === null) return
  const live = state.liveText
  live.text += chunk
  if (live.renderScheduled) return
  live.renderScheduled = true
  window.requestAnimationFrame(() => {
    live.renderScheduled = false
    if (state.liveText !== live) return
    renderMarkdown(live.node, live.text)
    const container = el('messages')
    container.scrollTop = container.scrollHeight
  })
}

function finishTurn(result, sessionId) {
  const running = sessionId ?? state.sessionId
  // `final_text` 是权威产出。流式增量可能是空的（例如全部内容都在工具调用里
  // 走完），所以两边取更完整的那个，而不是无条件相信流式累积。
  if (state.liveText !== null) {
    const finalText = typeof result?.finalText === 'string' ? result.finalText : ''
    const display = finalText.length > state.liveText.text.length ? finalText : state.liveText.text
    if (display === '') state.liveText.node.remove()
    else renderMarkdown(state.liveText.node, display)
    state.liveText = null
  } else if (typeof result?.finalText === 'string' && result.finalText !== '') {
    startLiveText(result.turnId)
    renderMarkdown(state.liveText.node, result.finalText)
    state.liveText = null
  }

  if (result?.cancelled === true) appendNote('已取消')
  else if (result?.status && result.status !== 'completed')
    appendNote(`turn 结束：${result.status}${result.error ? ` — ${result.error}` : ''}`, true)

  endTurn(running)
  void refreshSessions().catch(() => undefined)
  if (state.viewMode === 'advanced') void loadHistory().catch(() => undefined)
}

function endTurn(sessionId) {
  if (sessionId) state.running.delete(sessionId)
  state.turnId = null
  sessionStorage.removeItem(pendingKey(sessionId ?? state.sessionId))
  setBusy(false)
}

// ── 启动 ──────────────────────────────────────────────────────────

// 本机默认模式可以直接进入；需要 token 时，首次 API 请求会显示登录页。
void enterApp()
