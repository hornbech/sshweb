import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'

// ── State ──────────────────────────────────────────────────────────────────
const tabs = new Map()   // tabId -> { kind: 'ssh'|'web', ... }
let activeTab = null
let connections = []
let credentials = []
let bookmarks = []
let editingId = null

// ── DOM refs ───────────────────────────────────────────────────────────────
const connList = document.getElementById('connection-list')
const tabBar = document.getElementById('tabs')
const termContainer = document.getElementById('terminal-container')
const noConn = document.getElementById('no-connection')
const modal = document.getElementById('modal')
const connForm = document.getElementById('conn-form')
const modalTitle = document.getElementById('modal-title')
const uptimeEl = document.getElementById('uptime')
const sessionsEl = document.getElementById('active-sessions-list')
const statusDot = document.getElementById('status-dot')
const credsModal = document.getElementById('creds-modal')
const credsList = document.getElementById('creds-list')
const credsForm = document.getElementById('creds-form')
const credsFormTitle = document.getElementById('creds-form-title')
const credsError = document.getElementById('creds-error')
const credSelect = document.getElementById('cred-select')
const inlineCredFields = document.getElementById('inline-cred-fields')
const bookmarkList = document.getElementById('bookmark-list')
const bookmarkModal = document.getElementById('bookmark-modal')
const bookmarkForm = document.getElementById('bookmark-form')
const bookmarkModalTitle = document.getElementById('bookmark-modal-title')
const bookmarkError = document.getElementById('bookmark-error')

// ── API helpers ────────────────────────────────────────────────────────────
function checkAuth(res) {
  if (res.status === 401) { location.href = '/unlock'; throw new Error('Unauthorized') }
  return res
}
const api = {
  get: (path) => fetch(path).then(checkAuth).then(r => r.json()),
  post: (path, body) => fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(checkAuth).then(r => r.json()),
  put: (path, body) => fetch(path, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(checkAuth).then(r => r.json()),
  del: (path) => fetch(path, { method: 'DELETE' }).then(checkAuth).then(r => r.json()),
}

// ── Connections ────────────────────────────────────────────────────────────
async function loadConnections() {
  connections = await api.get('/api/connections')
  renderConnectionList()
}

function renderConnectionList() {
  connList.innerHTML = ''
  for (const conn of connections) {
    const li = document.createElement('li')
    li.dataset.id = conn.id

    const info = document.createElement('div')
    info.className = 'conn-info'
    const labelSpan = document.createElement('span')
    labelSpan.textContent = conn.label
    const hostSpan = document.createElement('span')
    hostSpan.className = 'conn-host'
    hostSpan.textContent = conn.host
    info.appendChild(labelSpan)
    info.appendChild(hostSpan)

    const editBtn = document.createElement('button')
    editBtn.className = 'conn-edit'
    editBtn.title = 'Edit connection'
    editBtn.textContent = '✎'
    editBtn.addEventListener('click', async (e) => {
      e.stopPropagation()
      const full = await api.get(`/api/connections/${conn.id}`)
      openModal(full)
    })

    const deleteBtn = document.createElement('button')
    deleteBtn.className = 'conn-delete'
    deleteBtn.title = 'Delete connection'
    deleteBtn.textContent = '✕'
    deleteBtn.addEventListener('click', async (e) => {
      e.stopPropagation()
      if (!confirm(`Delete "${conn.label}"?`)) return
      await api.del(`/api/connections/${conn.id}`)
      await loadConnections()
    })

    li.appendChild(info)
    li.appendChild(editBtn)
    li.appendChild(deleteBtn)
    li.addEventListener('click', () => openTerminal(conn))
    connList.appendChild(li)
  }
}

// ── Credentials ───────────────────────────────────────────────────────────────
async function loadCredentials() {
  credentials = await api.get('/api/credentials')
  renderCredentialList()
  renderCredentialDropdown()
}

function renderCredentialList() {
  credsList.innerHTML = ''
  for (const cred of credentials) {
    const li = document.createElement('li')
    li.className = 'cred-item'

    const info = document.createElement('div')
    info.className = 'cred-info'
    const nameSpan = document.createElement('span')
    nameSpan.className = 'cred-name'
    nameSpan.textContent = cred.name
    const userSpan = document.createElement('span')
    userSpan.className = 'cred-username'
    userSpan.textContent = cred.username
    info.appendChild(nameSpan)
    info.appendChild(userSpan)

    const editBtn = document.createElement('button')
    editBtn.className = 'cred-edit'
    editBtn.title = 'Edit'
    editBtn.textContent = '✎'
    editBtn.addEventListener('click', async () => {
      const full = await api.get(`/api/credentials/${cred.id}`)
      openCredForm(full)
    })

    const deleteBtn = document.createElement('button')
    deleteBtn.className = 'cred-delete'
    deleteBtn.title = 'Delete'
    deleteBtn.textContent = '✕'
    deleteBtn.addEventListener('click', async () => {
      credsError.classList.add('hidden')
      const res = await fetch(`/api/credentials/${cred.id}`, { method: 'DELETE' })
      if (res.status === 409) {
        const data = await res.json()
        credsError.textContent = data.error
        credsError.classList.remove('hidden')
        return
      }
      await loadCredentials()
    })

    li.appendChild(info)
    li.appendChild(editBtn)
    li.appendChild(deleteBtn)
    credsList.appendChild(li)
  }
}

function renderCredentialDropdown() {
  const current = credSelect.value
  while (credSelect.options.length > 1) credSelect.remove(1)
  for (const cred of credentials) {
    const opt = document.createElement('option')
    opt.value = cred.id
    opt.textContent = `${cred.name} (${cred.username})`
    credSelect.appendChild(opt)
  }
  credSelect.value = current
  toggleInlineCredFields()
}

function toggleInlineCredFields() {
  inlineCredFields.style.display = credSelect.value ? 'none' : ''
}

credSelect.addEventListener('change', toggleInlineCredFields)

document.getElementById('creds-btn').addEventListener('click', async () => {
  await loadCredentials()
  openCredForm(null)
  credsModal.classList.remove('hidden')
})

document.getElementById('creds-cancel').addEventListener('click', () => closeCredModal())
credsModal.addEventListener('click', (e) => { if (e.target === credsModal) closeCredModal() })

function closeCredModal() {
  credsModal.classList.add('hidden')
  openCredForm(null)
}

function openCredForm(cred) {
  credsForm.reset()
  credsError.classList.add('hidden')
  if (cred) {
    credsFormTitle.textContent = 'Edit Credential'
    credsForm.elements.id.value = cred.id
    credsForm.elements.name.value = cred.name
    credsForm.elements.username.value = cred.username
    credsForm.elements.authType.value = cred.authType
    credsForm.elements.secret.value = cred.secret
    document.getElementById('creds-submit').textContent = 'Save'
  } else {
    credsFormTitle.textContent = 'Add Credential'
    credsForm.elements.id.value = ''
    document.getElementById('creds-submit').textContent = 'Add'
  }
}

credsForm.addEventListener('submit', async (e) => {
  e.preventDefault()
  credsError.classList.add('hidden')
  const data = Object.fromEntries(new FormData(credsForm))
  const editingCredId = data.id
  delete data.id
  if (editingCredId) {
    await api.put(`/api/credentials/${editingCredId}`, data)
  } else {
    await api.post('/api/credentials', data)
  }
  await loadCredentials()
  openCredForm(null)
})

// ── Terminal tabs ──────────────────────────────────────────────────────────
function openTerminal(conn) {
  const tabId = `tab-${conn.id}-${Date.now()}`
  const pane = document.createElement('div')
  pane.className = 'terminal-pane'
  pane.id = tabId
  termContainer.appendChild(pane)

  const term = new Terminal({ theme: { background: '#1a1a2e', foreground: '#e0e0e0', cursor: '#e94560' }, fontFamily: 'monospace', fontSize: 14, cursorBlink: true })
  const fitAddon = new FitAddon()
  const webLinksAddon = new WebLinksAddon()
  term.loadAddon(fitAddon)
  term.loadAddon(webLinksAddon)
  term.open(pane)
  fitAddon.fit()

  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`)

  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'connect', connectionId: conn.id, cols: term.cols, rows: term.rows }))
  }

  ws.onmessage = ({ data }) => {
    const msg = JSON.parse(data)
    if (msg.type === 'data') term.write(Uint8Array.from(atob(msg.data), c => c.charCodeAt(0)))
    else if (msg.type === 'error') { term.write(`\r\nError: ${msg.message}\r\n`); ws.close() }
    else if (msg.type === 'close') { term.write('\r\n[Connection closed]\r\n') }
  }

  ws.onclose = () => term.write('\r\n[Disconnected]\r\n')

  // Prevent xterm from treating Ctrl+V as the \x16 control character.
  // The paste event handler below sends the actual clipboard text.
  term.attachCustomKeyEventHandler((e) => {
    if (e.type === 'keydown' && e.ctrlKey && e.key === 'v') return false
    return true
  })

  // Handle paste (Ctrl+V, right-click paste) — prevent xterm's own paste
  // handler so text isn't sent twice via onData.
  term.textarea?.addEventListener('paste', (e) => {
    e.preventDefault()
    const text = e.clipboardData?.getData('text') ?? ''
    if (text) ws.send(JSON.stringify({ type: 'data', data: btoa(text) }))
  })

  term.onData((data) => {
    ws.send(JSON.stringify({ type: 'data', data: btoa(data) }))
  })

  term.onResize(({ cols, rows }) => {
    ws.send(JSON.stringify({ type: 'resize', cols, rows }))
  })

  tabs.set(tabId, { kind: 'ssh', term, fitAddon, ws, sessionId: null, label: conn.label })
  addTab(tabId, conn.label)
  switchTab(tabId)
  noConn.style.display = 'none'
}

function addTab(tabId, label) {
  const tab = document.createElement('div')
  tab.className = 'tab'
  tab.dataset.id = tabId
  const span = document.createElement('span')
  span.textContent = label
  const closeBtn = document.createElement('button')
  closeBtn.title = 'Close'
  closeBtn.textContent = '✕'
  tab.appendChild(span)
  tab.appendChild(closeBtn)
  span.addEventListener('click', () => switchTab(tabId))
  closeBtn.addEventListener('click', (e) => { e.stopPropagation(); closeTab(tabId) })
  tabBar.appendChild(tab)
}

function switchTab(tabId) {
  if (activeTab) {
    const prev = tabs.get(activeTab)
    if (prev?.kind === 'ssh') {
      document.querySelector(`#${activeTab}`)?.classList.remove('active')
    } else if (prev?.kind === 'web') {
      prev.container.style.display = 'none'
    }
    document.querySelector(`.tab[data-id="${activeTab}"]`)?.classList.remove('active')
  }
  activeTab = tabId
  const t = tabs.get(tabId)
  if (t?.kind === 'ssh') {
    document.querySelector(`#${tabId}`)?.classList.add('active')
    t.fitAddon.fit()
  } else if (t?.kind === 'web') {
    t.container.style.display = ''
  }
  document.querySelector(`.tab[data-id="${tabId}"]`)?.classList.add('active')
}

function closeTab(tabId) {
  const t = tabs.get(tabId)
  if (t) {
    if (t.kind === 'ssh') { t.ws.close(); t.term.dispose() }
    if (t.kind === 'web') { t.container.remove() }
  }
  tabs.delete(tabId)
  document.querySelector(`#${tabId}`)?.remove()
  document.querySelector(`.tab[data-id="${tabId}"]`)?.remove()
  if (activeTab === tabId) {
    activeTab = null
    const remaining = [...tabs.keys()]
    if (remaining.length) switchTab(remaining[remaining.length - 1])
    else noConn.style.display = ''
  }
  persistOpenTabs()
}

// ── New/Edit connection modal ───────────────────────────────────────────────
document.getElementById('new-conn-btn').addEventListener('click', () => openModal(null))
document.getElementById('cancel-btn').addEventListener('click', closeModal)
modal.addEventListener('click', (e) => { if (e.target === modal) closeModal() })

function openModal(conn, prefill = null) {
  editingId = conn?.id ?? null
  modalTitle.textContent = conn ? 'Edit Connection' : 'New Connection'
  connForm.reset()
  credSelect.value = ''
  toggleInlineCredFields()
  const fill = conn ?? prefill
  if (fill) {
    Object.entries(fill).forEach(([k, v]) => {
      if (k === 'credentialId') {
        credSelect.value = v ?? ''
        toggleInlineCredFields()
        return
      }
      const el = connForm.elements[k]
      if (el) el.value = v
    })
  }
  modal.classList.remove('hidden')
  connForm.elements.label.focus()
}

function closeModal() { modal.classList.add('hidden'); editingId = null }

connForm.addEventListener('submit', async (e) => {
  e.preventDefault()
  const data = Object.fromEntries(new FormData(connForm))
  data.port = parseInt(data.port, 10)
  if (data.credentialId) {
    data.username = ''
    data.secret = ''
  } else {
    data.credentialId = null
  }
  if (editingId) {
    await api.put(`/api/connections/${editingId}`, data)
  } else {
    await api.post('/api/connections', data)
  }
  closeModal()
  await loadConnections()
})

// ── Network scan ──────────────────────────────────────────────────────────
const scanModal = document.getElementById('scan-modal')
const scanSubnetInput = document.getElementById('scan-subnet')
const scanStartBtn = document.getElementById('scan-start-btn')
const scanStatus = document.getElementById('scan-status')
const scanResultsList = document.getElementById('scan-results')
let scanSource = null

document.getElementById('scan-btn').addEventListener('click', async () => {
  scanResultsList.innerHTML = ''
  scanStatus.textContent = ''
  scanModal.classList.remove('hidden')
  scanSubnetInput.focus()
  if (!scanSubnetInput.value) {
    try {
      const data = await api.get('/api/scan/subnets')
      if (data.subnets?.length) scanSubnetInput.value = data.subnets[0]
    } catch {}
  }
})

document.getElementById('scan-close-btn').addEventListener('click', closeScanModal)
scanModal.addEventListener('click', (e) => { if (e.target === scanModal) closeScanModal() })

function closeScanModal() {
  abortScan()
  scanModal.classList.add('hidden')
}

function abortScan() {
  if (scanSource) { scanSource.close(); scanSource = null }
  scanStartBtn.textContent = 'Scan'
  scanStartBtn.disabled = false
}

scanStartBtn.addEventListener('click', () => {
  if (scanSource) { abortScan(); return }
  const subnet = scanSubnetInput.value.trim()
  if (!subnet) { scanStatus.textContent = 'Enter a subnet to scan.'; return }
  scanResultsList.innerHTML = ''
  scanStatus.textContent = 'Starting…'
  scanStartBtn.textContent = 'Stop'

  scanSource = new EventSource(`/api/scan?subnet=${encodeURIComponent(subnet)}`)

  scanSource.onmessage = (e) => {
    const msg = JSON.parse(e.data)
    if (msg.done) {
      const n = scanResultsList.children.length
      scanStatus.textContent = `Done — ${n} host${n !== 1 ? 's' : ''} with SSH open.`
      abortScan()
    } else if (msg.error) {
      scanStatus.textContent = `Error: ${msg.error}`
      abortScan()
    } else if (msg.progress) {
      scanStatus.textContent = `Scanning ${msg.progress.scanned} / ${msg.progress.total}…`
    } else if (msg.ip) {
      appendScanResult(msg)
    }
  }

  scanSource.onerror = () => {
    if (scanSource?.readyState === EventSource.CLOSED) return
    scanStatus.textContent = 'Stream error — check server logs.'
    abortScan()
  }
})

function appendScanResult({ ip, hostname }) {
  const li = document.createElement('li')
  li.className = 'scan-result'

  const ipEl = document.createElement('span')
  ipEl.className = 'scan-result-ip'
  ipEl.textContent = ip

  const hostEl = document.createElement('span')
  hostEl.className = 'scan-result-host'
  hostEl.textContent = hostname ?? '—'

  const addBtn = document.createElement('button')
  addBtn.textContent = 'Add'
  addBtn.addEventListener('click', () => {
    openModal(null, { host: ip, label: hostname ?? ip, port: 22 })
  })

  li.appendChild(ipEl)
  li.appendChild(hostEl)
  li.appendChild(addBtn)
  scanResultsList.appendChild(li)
}

// ── Admin panel ────────────────────────────────────────────────────────────
document.getElementById('lock-btn').addEventListener('click', async () => {
  await api.post('/api/lock', {})
  window.location.href = '/unlock'
})

const changePwModal = document.getElementById('change-pw-modal')
const changePwForm = document.getElementById('change-pw-form')
const changePwError = document.getElementById('change-pw-error')

document.getElementById('change-pw-btn').addEventListener('click', () => {
  changePwForm.reset()
  changePwError.classList.add('hidden')
  changePwModal.classList.remove('hidden')
  changePwForm.elements.currentPassword.focus()
})

document.getElementById('change-pw-cancel').addEventListener('click', () => changePwModal.classList.add('hidden'))
changePwModal.addEventListener('click', (e) => { if (e.target === changePwModal) changePwModal.classList.add('hidden') })

changePwForm.addEventListener('submit', async (e) => {
  e.preventDefault()
  changePwError.classList.add('hidden')
  const currentPassword = changePwForm.elements.currentPassword.value
  const newPassword = changePwForm.elements.newPassword.value
  const confirmPassword = changePwForm.elements.confirmPassword.value
  if (newPassword !== confirmPassword) {
    changePwError.textContent = 'New passwords do not match.'
    changePwError.classList.remove('hidden')
    changePwForm.elements.confirmPassword.value = ''
    changePwForm.elements.confirmPassword.focus()
    return
  }
  const res = await fetch('/api/change-password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ currentPassword, newPassword }),
  })
  const data = await res.json().catch(() => ({}))
  if (res.ok) {
    changePwModal.classList.add('hidden')
  } else {
    changePwError.textContent = data.error || 'Failed to change password.'
    changePwError.classList.remove('hidden')
    changePwForm.elements.currentPassword.value = ''
    changePwForm.elements.currentPassword.focus()
  }
})

async function refreshAdmin() {
  try {
    const health = await api.get('/health')
    const s = health.uptime
    uptimeEl.textContent = `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
    statusDot.className = `dot ${health.status === 'ok' ? 'green' : 'red'}`

    const sessions = await api.get('/api/sessions')
    sessionsEl.innerHTML = ''
    if (sessions.length === 0) {
      const empty = document.createElement('div')
      empty.style.cssText = 'color:var(--text-muted);font-size:.8rem'
      empty.textContent = 'No active sessions'
      sessionsEl.appendChild(empty)
    } else {
      for (const session of sessions) {
        const item = document.createElement('div')
        item.className = 'session-item'
        const label = document.createElement('span')
        label.textContent = session.label
        const killBtn = document.createElement('button')
        killBtn.textContent = 'Kill'
        killBtn.addEventListener('click', () => killSession(session.id))
        item.appendChild(label)
        item.appendChild(killBtn)
        sessionsEl.appendChild(item)
      }
    }
  } catch {}
}

async function killSession(id) {
  await api.del(`/api/sessions/${id}`)
  refreshAdmin()
}

// ── Bookmarks ─────────────────────────────────────────────────────────────
async function loadBookmarks() {
  bookmarks = await api.get('/api/bookmarks')
  renderBookmarkList()
}

function renderBookmarkList() {
  bookmarkList.innerHTML = ''
  for (const bm of bookmarks) {
    const li = document.createElement('li')
    li.dataset.id = bm.id

    const info = document.createElement('div')
    info.className = 'conn-info'
    const label = document.createElement('span')
    label.textContent = bm.label
    const host = document.createElement('span')
    host.className = 'conn-host'
    try { host.textContent = new URL(bm.url).host } catch { host.textContent = bm.url }
    info.appendChild(label)
    info.appendChild(host)

    const editBtn = document.createElement('button')
    editBtn.className = 'conn-edit'
    editBtn.title = 'Edit bookmark'
    editBtn.textContent = '\u270E'
    editBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      openBookmarkModal(bm)
    })

    const deleteBtn = document.createElement('button')
    deleteBtn.className = 'conn-delete'
    deleteBtn.title = 'Delete bookmark'
    deleteBtn.textContent = '\u2715'
    deleteBtn.addEventListener('click', async (e) => {
      e.stopPropagation()
      if (!confirm(`Delete "${bm.label}"?`)) return
      await api.del(`/api/bookmarks/${bm.id}`)
      await loadBookmarks()
    })

    li.appendChild(info)
    li.appendChild(editBtn)
    li.appendChild(deleteBtn)
    li.addEventListener('click', () => openWebTab({ url: bm.url, label: bm.label }))
    bookmarkList.appendChild(li)
  }
}

// Bookmark modal
document.getElementById('add-bookmark').addEventListener('click', () => openBookmarkModal(null))
document.getElementById('bookmark-cancel').addEventListener('click', closeBookmarkModal)
bookmarkModal.addEventListener('click', (e) => { if (e.target === bookmarkModal) closeBookmarkModal() })

function openBookmarkModal(bm) {
  bookmarkForm.reset()
  bookmarkError.classList.add('hidden')
  if (bm) {
    bookmarkModalTitle.textContent = 'Edit Bookmark'
    bookmarkForm.elements.id.value = bm.id
    bookmarkForm.elements.label.value = bm.label
    bookmarkForm.elements.url.value = bm.url
    bookmarkForm.elements.ignoreTls.checked = bm.ignoreTls
    document.getElementById('bookmark-submit').textContent = 'Save'
  } else {
    bookmarkModalTitle.textContent = 'Add Bookmark'
    bookmarkForm.elements.id.value = ''
    document.getElementById('bookmark-submit').textContent = 'Add'
  }
  bookmarkModal.classList.remove('hidden')
  bookmarkForm.elements.label.focus()
}

function closeBookmarkModal() {
  bookmarkModal.classList.add('hidden')
}

bookmarkForm.addEventListener('submit', async (e) => {
  e.preventDefault()
  bookmarkError.classList.add('hidden')
  const data = {
    label: bookmarkForm.elements.label.value,
    url: bookmarkForm.elements.url.value,
    ignoreTls: bookmarkForm.elements.ignoreTls.checked,
  }
  const editId = bookmarkForm.elements.id.value
  try {
    if (editId) {
      await api.put(`/api/bookmarks/${editId}`, data)
    } else {
      await api.post('/api/bookmarks', data)
    }
    closeBookmarkModal()
    await loadBookmarks()
  } catch (err) {
    bookmarkError.textContent = err.message || 'Failed to save bookmark'
    bookmarkError.classList.remove('hidden')
  }
})

// ── Web tabs ──────────────────────────────────────────────────────────────
function openWebTab({ url, label = null }) {
  const tabId = `web-${crypto.randomUUID()}`
  const container = document.createElement('div')
  container.className = 'web-tab'
  container.innerHTML = `
    <div class="web-chrome">
      <button data-act="back" title="Back">\u2190</button>
      <button data-act="forward" title="Forward">\u2192</button>
      <button data-act="reload" title="Reload">\u27F3</button>
      <form class="web-url-form"><input class="web-url" type="text" value="${url}" spellcheck="false"></form>
    </div>
    <iframe class="web-frame" src="/proxy/${url}" sandbox="allow-same-origin allow-scripts allow-forms allow-popups"></iframe>
  `
  termContainer.appendChild(container)
  container.style.display = 'none'

  const iframe = container.querySelector('iframe')
  const urlInput = container.querySelector('.web-url')
  const form = container.querySelector('.web-url-form')

  form.addEventListener('submit', (ev) => {
    ev.preventDefault()
    const v = urlInput.value.trim()
    if (v) iframe.src = '/proxy/' + v
  })
  container.querySelector('[data-act="back"]').onclick = () => { try { iframe.contentWindow.history.back() } catch {} }
  container.querySelector('[data-act="forward"]').onclick = () => { try { iframe.contentWindow.history.forward() } catch {} }
  container.querySelector('[data-act="reload"]').onclick = () => { try { iframe.contentWindow.location.reload() } catch {} }

  iframe.addEventListener('load', () => {
    try {
      const path = iframe.contentWindow.location.pathname + iframe.contentWindow.location.search
      const m = path.match(/^\/proxy\/(.+)$/)
      if (m) urlInput.value = decodeURIComponent(m[1])
    } catch { /* cross-origin */ }
    persistOpenTabs()
  })

  const tabLabel = label || (() => { try { return new URL(url).host } catch { return url } })()
  tabs.set(tabId, { kind: 'web', container, iframe, urlInput, label: tabLabel })
  addTab(tabId, tabLabel)
  switchTab(tabId)
  noConn.style.display = 'none'
  persistOpenTabs()
}

async function persistOpenTabs() {
  const state = [...tabs.entries()]
    .filter(([, t]) => t.kind === 'web')
    .map(([tabId, t]) => ({ tabId, url: t.urlInput.value }))
  try { await api.put('/api/tabs', state) } catch {}
}

async function restoreWebTabs() {
  try {
    const saved = await api.get('/api/tabs')
    for (const t of saved) openWebTab({ url: t.url })
  } catch {}
}

// ── Admin web panel ───────────────────────────────────────────────────────
document.getElementById('admin-web-clear').addEventListener('click', async () => {
  await api.post('/api/admin/web/clear-cookies', {})
  refreshAdminWeb()
})

async function refreshAdminWeb() {
  try {
    const data = await api.get('/api/admin/web')
    document.getElementById('admin-web-cookies').textContent = data.activeCookieSessions
    document.getElementById('admin-web-tabs').textContent = data.openTabs
  } catch {}
}

// ── Resize ────────────────────────────────────────────────────────────────
const ro = new ResizeObserver(() => {
  const t = activeTab && tabs.get(activeTab)
  if (t?.kind === 'ssh') t.fitAddon.fit()
})
ro.observe(termContainer)

// ── Init ──────────────────────────────────────────────────────────────────
loadConnections()
loadCredentials()
loadBookmarks().then(() => restoreWebTabs())
refreshAdmin()
refreshAdminWeb()
setInterval(refreshAdmin, 15_000)
setInterval(refreshAdminWeb, 15_000)
