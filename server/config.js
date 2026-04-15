import 'dotenv/config'

const VALID_LOG_LEVELS = new Set(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])

function parseIntRequired(value, name) {
  const n = parseInt(value, 10)
  if (!Number.isFinite(n)) throw new Error(`Invalid config: ${name}=${value} is not a valid integer`)
  return n
}

export const config = {
  port: parseIntRequired(process.env.PORT ?? '3000', 'PORT'),
  dataDir: process.env.DATA_DIR ?? './data',
  nodeEnv: process.env.NODE_ENV ?? 'development',
  sessionTimeoutMinutes: parseIntRequired(process.env.SESSION_TIMEOUT_MINUTES ?? '60', 'SESSION_TIMEOUT_MINUTES'),
  maxSessions: parseIntRequired(process.env.MAX_SESSIONS ?? '10', 'MAX_SESSIONS'),
  sshKeepaliveInterval: parseIntRequired(process.env.SSH_KEEPALIVE_INTERVAL ?? '15', 'SSH_KEEPALIVE_INTERVAL'),
  logLevel: (() => {
    const level = process.env.LOG_LEVEL ?? 'info'
    if (!VALID_LOG_LEVELS.has(level)) throw new Error(`Invalid config: LOG_LEVEL=${level} must be one of ${[...VALID_LOG_LEVELS].join(', ')}`)
    return level
  })(),
}
