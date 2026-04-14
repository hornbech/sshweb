import 'dotenv/config'

export const config = {
  port: parseInt(process.env.PORT ?? '3000', 10),
  dataDir: process.env.DATA_DIR ?? './data',
  sessionTimeoutMinutes: parseInt(process.env.SESSION_TIMEOUT_MINUTES ?? '60', 10),
  maxSessions: parseInt(process.env.MAX_SESSIONS ?? '10', 10),
  logLevel: process.env.LOG_LEVEL ?? 'info',
}
