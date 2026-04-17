import { promises as dns } from 'node:dns'
import net from 'node:net'

const PRIVATE_V4_RANGES = [
  ['10.0.0.0', 8],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
]

function ipToLong(ip) {
  return ip.split('.').reduce((acc, oct) => (acc * 256) + Number(oct), 0)
}

function inV4Range(ip, base, prefix) {
  const ipN = ipToLong(ip)
  const baseN = ipToLong(base)
  const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0
  return (ipN & mask) === (baseN & mask)
}

export function isPrivateAddress(addr) {
  if (net.isIPv4(addr)) {
    return PRIVATE_V4_RANGES.some(([b, p]) => inV4Range(addr, b, p))
  }
  if (net.isIPv6(addr)) {
    const lower = addr.toLowerCase()
    if (lower === '::1') return true
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true // ULA
    if (lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) return true // link-local
    return false
  }
  return false
}

export async function classifyHost(hostname) {
  if (net.isIP(hostname)) {
    return isPrivateAddress(hostname)
      ? { allowed: true, resolvedIp: hostname }
      : { allowed: false, reason: 'Target is a public IP address' }
  }
  let addrs
  try {
    addrs = await dns.lookup(hostname, { all: true, verbatim: true })
  } catch (err) {
    return { allowed: false, reason: `DNS lookup failed: ${err.code || err.message}` }
  }
  for (const { address } of addrs) {
    if (!isPrivateAddress(address)) {
      return { allowed: false, reason: `Hostname resolves to public IP ${address}` }
    }
  }
  return { allowed: true, resolvedIp: addrs[0].address }
}
