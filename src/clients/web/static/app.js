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
 *    所有动态外观靠 class 切换。
 * 2. **token 不进 URL**。启用认证时 HTTP 走 `Authorization: Bearer`，
 *    WebSocket 走 `POST /api/ws-ticket` 拿一次性 ticket。token 存在
 *    sessionStorage，关掉标签页即失效。
 * 3. **`replay_complete` 才是"已追平"**。`subscribed` 帧可能排在补发事件之后
 *    （补发是微任务投递的），用它判断会在刷新时过早渲染出半截对话。
 */

const TOKEN_KEY = 'deepcode.token'
const PENDING_KEY_PREFIX = 'deepcode.pending.'
const PROJECT_KEY = 'deepcode.project.path'
const THEME_KEY = 'deepcode.theme'

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
  routeGeneration: 0,
}

const el = (id) => document.getElementById(id)

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

function toggleDialog(id, open) {
  el(id).classList.toggle('hidden', !open)
  el(id).classList.toggle('flex', open)
}

el('open-project').addEventListener('click', () => {
  toggleDialog('project-modal', true)
  void browseDirectory(state.projectPath).then(() => el('directory-path').focus())
})
el('projects-open').addEventListener('click', () => el('open-project').click())
el('close-project').addEventListener('click', () => toggleDialog('project-modal', false))

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
  const projectId = state.projectId
  const session = state.sessions.find((item) => item.id === sessionId)
  el('session-title').textContent = session?.title ?? sessionId
  el('session-meta').textContent = `turn ${session?.currentTurn ?? 0} · ${session?.status ?? ''}`
  renderSessions()

  await loadHistory()
  if (state.sessionId !== sessionId || state.projectId !== projectId) return
  await refreshPending()
  if (state.sessionId !== sessionId || state.projectId !== projectId) return
  connect()
}

/** 从消息历史重建视图。这是 `resync_required` 之后必须走的路。 */
async function loadHistory() {
  if (state.sessionId === null) return
  const sessionId = state.sessionId
  const projectId = state.projectId
  const payload = await api(`/api/sessions/${sessionId}/messages`)
  if (state.sessionId !== sessionId || state.projectId !== projectId) return
  const container = el('messages')
  container.replaceChildren()
  state.liveText = null
  for (const message of payload.messages ?? []) renderMessage(message)
  if (container.childElementCount === 0) renderChatEmptyState()
  container.scrollTop = container.scrollHeight
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
  menu.replaceChildren()
  menu.classList.toggle('hidden', state.commandMatches.length === 0)
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
      await loadHistory()
      await showCommandResult(result)
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

async function showCommandResult(result) {
  if (result.data?.kind === 'switch_session' && result.data.sessionId) {
    await refreshSessions()
    navigate(chatPath(result.data.sessionId))
    return
  }
  if (result.data?.kind === 'session_select' && Array.isArray(result.data.sessions)) {
    const container = el('messages')
    const panel = document.createElement('div')
    panel.className = 'message-note'
    for (const session of result.data.sessions) {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'command-option'
      button.textContent = `${session.title}（${session.current_turn} 轮）`
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
  const hasCommand =
    typeof view.commandPreview === 'string' &&
    view.commandPreview.trim() !== '' &&
    view.commandPreview.trim() !== '[redacted]'
  el('approval-tool').textContent = view.toolName
  el('approval-risk').textContent =
    { low: '低', medium: '中', high: '高', critical: '极高' }[view.riskLevel] ?? view.riskLevel
  el('approval-reason').textContent =
    isBash && view.reason === 'command requires approval'
      ? '此命令需要批准才能执行。'
      : (view.reason ?? '')
  el('approval-command-label').classList.toggle('hidden', !isBash)
  el('approval-args').textContent =
    isBash && hasCommand ? view.commandPreview : (view.argsPreview ?? '')
  el('approval-allow').disabled = isBash && !hasCommand
  el('approval-allow-once').disabled = isBash && !hasCommand
  el('approval-error').textContent =
    isBash && !hasCommand ? '无法读取待执行命令，请刷新页面后重试。' : ''
  el('approval-error').classList.toggle('hidden', !isBash || hasCommand)
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
    void refreshPending().catch(() => undefined)
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
  hideChatEmptyState()
  const node = document.createElement('div')
  node.className = 'message-assistant markdown-body'
  node.dataset.turnId = turnId ?? ''
  container.append(node)
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
