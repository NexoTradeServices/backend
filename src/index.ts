import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import pg from 'pg'

const app = express()

const port = Number(process.env.PORT ?? 8080)

// No domain lives in this file. WEB_ORIGIN is the site allowed to call this API -
// idelta.com.au in dev, the prod domain on Fly - and it is required, because a
// silent fallback would quietly allow the wrong origin in production.
const webOrigin = process.env.WEB_ORIGIN
if (!webOrigin) {
  throw new Error('WEB_ORIGIN is not set - it must name the site allowed to call this API')
}

// No host, user or password in this file either. Local Postgres in dev, Neon in
// prod - the difference is entirely inside DATABASE_URL. Neon's own URL carries
// sslmode=require, so TLS needs no code here.
const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
  throw new Error('DATABASE_URL is not set')
}

const pool = new pg.Pool({ connectionString: databaseUrl })

// Credentials on: the session cookie (feature 1003) rides this same path.
app.use(cors({ origin: webOrigin, credentials: true }))

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'tradeservice-backend' })
})

// The last dark link: proves this process can actually reach its database.
// A 503 on failure, not a 200 with bad news inside - Fly's health checks and
// any uptime monitor read the status code, not the body.
app.get('/health/db', (_req, res) => {
  pool
    .query('select 1')
    .then(() => {
      res.json({ status: 'ok', database: 'reachable' })
    })
    .catch((error: unknown) => {
      console.error('database health check failed', error)
      res.status(503).json({ status: 'error', database: 'unreachable' })
    })
})

// 0.0.0.0, not localhost: Caddy on 192.168.1.41 has to reach this from another machine.
app.listen(port, '0.0.0.0', () => {
  console.log(`backend listening on 0.0.0.0:${port}`)
})
