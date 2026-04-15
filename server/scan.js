import { createConnection } from 'node:net'
import { reverse } from 'node:dns/promises'
import { networkInterfaces } from 'node:os'

// Return suggested subnets from the server's own non-loopback interfaces.
export function getLocalSubnets() {
  const subnets = new Set()
  for (const addrs of Object.values(networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.family !== 'IPv4' || addr.internal || !addr.cidr) continue
      const prefixLen = parseInt(addr.cidr.split('/')[1], 10)
      if (prefixLen < 22 || prefixLen > 30) continue
      const hostBits = 32 - prefixLen
      const size = 2 ** hostBits
      const [a, b, c, d] = addr.address.split('.').map(Number)
      const ipInt = a * 16777216 + b * 65536 + c * 256 + d
      const netInt = ipInt - (ipInt % size)
      const netAddr = [
        Math.floor(netInt / 16777216) % 256,
        Math.floor(netInt / 65536) % 256,
        Math.floor(netInt / 256) % 256,
        netInt % 256,
      ].join('.')
      subnets.add(`${netAddr}/${prefixLen}`)
    }
  }
  return [...subnets]
}

// Parse a CIDR string into a list of host IPs (excludes network + broadcast).
// Accepts /22 to /30 (2–1022 hosts).
export function parseCIDR(cidr) {
  const m = cidr.trim().match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/)
  if (!m) throw new Error('Invalid CIDR — expected x.x.x.x/n')
  const [a, b, c, d, p] = m.slice(1).map(Number)
  if ([a, b, c, d].some(x => x > 255)) throw new Error('Invalid IP address')
  if (p < 22 || p > 30) throw new Error('Prefix must be /22–/30 (max 1022 hosts)')
  const hostBits = 32 - p
  const size = 2 ** hostBits
  const ipInt = a * 16777216 + b * 65536 + c * 256 + d
  const netInt = ipInt - (ipInt % size)
  const hosts = []
  for (let i = netInt + 1; i < netInt + size - 1; i++) {
    hosts.push([
      Math.floor(i / 16777216) % 256,
      Math.floor(i / 65536) % 256,
      Math.floor(i / 256) % 256,
      i % 256,
    ].join('.'))
  }
  return hosts
}

function probePort22(ip, timeoutMs = 800) {
  return new Promise(resolve => {
    const sock = createConnection({ host: ip, port: 22 })
    sock.setTimeout(timeoutMs)
    const done = (result) => { sock.destroy(); resolve(result) }
    sock.on('connect', () => done(true))
    sock.on('error', () => done(false))
    sock.on('timeout', () => done(false))
  })
}

async function resolveHostname(ip) {
  try {
    const names = await reverse(ip)
    return names[0] ?? null
  } catch {
    return null
  }
}

// Scan a subnet for open port 22. Calls onHost({ip, hostname}) for each hit,
// onProgress({scanned, total}) periodically. Returns when done or isAborted().
export async function scanSubnet(cidr, { onHost, onProgress, isAborted }) {
  const hosts = parseCIDR(cidr)
  const total = hosts.length
  const CONCURRENCY = 50
  let scanned = 0

  for (let i = 0; i < hosts.length; i += CONCURRENCY) {
    if (isAborted()) break
    const batch = hosts.slice(i, i + CONCURRENCY)
    await Promise.all(batch.map(async ip => {
      if (isAborted()) return
      const open = await probePort22(ip)
      scanned++
      if (open && !isAborted()) {
        const hostname = await resolveHostname(ip)
        onHost({ ip, hostname })
      }
    }))
    if (!isAborted()) onProgress({ scanned, total })
  }

  return { total, scanned }
}
