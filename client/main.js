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
    li.appendChild(deleteBtn)
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

  term.attachCustomKeyEventHandler((e) => {
    if (e.type === 'keydown' && e.ctrlKey && e.key === 'v') {
      navigator.clipboard.readText().then((text) => {
        ws.send(JSON.stringify({ type: 'data', data: btoa(text) }))
      }).catch(() => {})
      return false // prevent xterm from handling it
    }
    return true
  })

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

function openModal(conn, prefill = null) {
  editingId = conn?.id ?? null
  modalTitle.textContent = conn ? 'Edit Connection' : 'New Connection'
  connForm.reset()
  const fill = conn ?? prefill
  if (fill) {
    Object.entries(fill).forEach(([k, v]) => {
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

// ── Resize ────────────────────────────────────────────────────────────────
const ro = new ResizeObserver(() => {
  if (activeTab) tabs.get(activeTab)?.fitAddon.fit()
})
ro.observe(termContainer)

// ── Init ──────────────────────────────────────────────────────────────────
loadConnections()
refreshAdmin()
setInterval(refreshAdmin, 15_000)
