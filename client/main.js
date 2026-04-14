import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'

// ── State ──────────────────────────────────────────────────────────────────
const tabs = new Map()   // tabId -> { term, fitAddon, ws, sessionId, label }
let activeTab = null
let connections = []
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

// ── API helpers ────────────────────────────────────────────────────────────
const api = {
  get: (path) => fetch(path).then(r => r.json()),
  post: (path, body) => fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json()),
  put: (path, body) => fetch(path, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json()),
  del: (path) => fetch(path, { method: 'DELETE' }).then(r => r.json()),
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
    const labelSpan = document.createElement('span')
    labelSpan.textContent = conn.label
    const hostSpan = document.createElement('span')
    hostSpan.className = 'conn-host'
    hostSpan.textContent = conn.host
    li.appendChild(labelSpan)
    li.appendChild(hostSpan)
    li.addEventListener('click', () => openTerminal(conn))
    connList.appendChild(li)
  }
}

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
    if (msg.type === 'data') term.write(atob(msg.data))
    else if (msg.type === 'error') { term.write(`\r\nError: ${msg.message}\r\n`); ws.close() }
    else if (msg.type === 'close') { term.write('\r\n[Connection closed]\r\n') }
  }

  ws.onclose = () => term.write('\r\n[Disconnected]\r\n')

  term.onData((data) => {
    ws.send(JSON.stringify({ type: 'data', data: btoa(data) }))
  })

  term.onResize(({ cols, rows }) => {
    ws.send(JSON.stringify({ type: 'resize', cols, rows }))
  })

  tabs.set(tabId, { term, fitAddon, ws, sessionId: null, label: conn.label })
  addTab(tabId, conn.label)
  switchTab(tabId)
  noConn.style.display = 'none'
}

function addTab(tabId, label) {
  const tab = document.createElement('div')
  tab.className = 'tab'
  tab.dataset.id = tabId
  tab.innerHTML = `<span>${label}</span><button title="Close">✕</button>`
  tab.querySelector('span').addEventListener('click', () => switchTab(tabId))
  tab.querySelector('button').addEventListener('click', (e) => { e.stopPropagation(); closeTab(tabId) })
  tabBar.appendChild(tab)
}

function switchTab(tabId) {
  if (activeTab) {
    document.querySelector(`#${activeTab}`)?.classList.remove('active')
    document.querySelector(`.tab[data-id="${activeTab}"]`)?.classList.remove('active')
  }
  activeTab = tabId
  document.querySelector(`#${tabId}`)?.classList.add('active')
  document.querySelector(`.tab[data-id="${tabId}"]`)?.classList.add('active')
  tabs.get(tabId)?.fitAddon.fit()
}

function closeTab(tabId) {
  const t = tabs.get(tabId)
  if (t) { t.ws.close(); t.term.dispose() }
  tabs.delete(tabId)
  document.querySelector(`#${tabId}`)?.remove()
  document.querySelector(`.tab[data-id="${tabId}"]`)?.remove()
  if (activeTab === tabId) {
    activeTab = null
    const remaining = [...tabs.keys()]
    if (remaining.length) switchTab(remaining[remaining.length - 1])
    else noConn.style.display = ''
  }
}

// ── New/Edit connection modal ───────────────────────────────────────────────
document.getElementById('new-conn-btn').addEventListener('click', () => openModal(null))
document.getElementById('cancel-btn').addEventListener('click', closeModal)
modal.addEventListener('click', (e) => { if (e.target === modal) closeModal() })

function openModal(conn) {
  editingId = conn?.id ?? null
  modalTitle.textContent = conn ? 'Edit Connection' : 'New Connection'
  connForm.reset()
  if (conn) {
    Object.entries(conn).forEach(([k, v]) => {
      const el = connForm.elements[k] ?? connForm.elements[k === 'authType' ? 'authType' : null]
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
  if (editingId) {
    await api.put(`/api/connections/${editingId}`, data)
  } else {
    await api.post('/api/connections', data)
  }
  closeModal()
  await loadConnections()
})

// ── Admin panel ────────────────────────────────────────────────────────────
document.getElementById('lock-btn').addEventListener('click', async () => {
  await api.post('/api/lock', {})
  window.location.href = '/unlock'
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

// ── Resize ────────────────────────────────────────────────────────────────
const ro = new ResizeObserver(() => {
  if (activeTab) tabs.get(activeTab)?.fitAddon.fit()
})
ro.observe(termContainer)

// ── Init ──────────────────────────────────────────────────────────────────
loadConnections()
refreshAdmin()
setInterval(refreshAdmin, 15_000)
