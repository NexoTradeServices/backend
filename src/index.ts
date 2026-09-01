import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import pg from 'pg'
import { toNodeHandler } from 'better-auth/node'
import { notificationWebhooks, startNotifications } from './notifications/index.js'
import { buildAuth } from './auth/config.js'
import { attachSession } from './auth/middleware.js'
import { authRoutes } from './auth/routes.js'
import { getPrisma } from './db/client.js'

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
const prisma = getPrisma()

// Credentials on: the session cookie (feature 1003) rides this same path.
app.use(cors({ origin: webOrigin, credentials: true }))

// One auth brain, server-side (feature 1003, decision 1). Mounted before any
// body-parsing middleware -- Better Auth reads the raw request body itself,
// and a parser upstream would consume the stream first (there is none in
// this app yet, but the order matters the moment one is added).
const auth = buildAuth({ client: prisma })
app.all('/api/auth/*splat', toNodeHandler(auth))

// Loads the session (and re-checks a contractor's live status) on every
// request; RBAC-guarded routes read `req.authUser` after this runs.
app.use(attachSession(auth, prisma))
app.use('/api', authRoutes(prisma))

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

// Provider delivery events (feature 1004). The module owns the route bodies;
// this file only says where they live: /webhooks/mailjet, /webhooks/clicksend.
app.use('/webhooks', notificationWebhooks())

// The notification queue drains inside this process (feature 1004). It is
// started BEFORE listen so its own startup warnings land before the "backend
// listening" line -- but a missing provider credential never refuses this
// boot (feature 1009): it only warns, and each affected send fails on its own
// row instead. Only a missing PlatformSettings row (the base seed never run)
// still stops the process here, the same way WEB_ORIGIN and DATABASE_URL do.
startNotifications()
  .then(() => {
    // 0.0.0.0, not localhost: Caddy on 192.168.1.41 has to reach this from another machine.
    app.listen(port, '0.0.0.0', () => {
      console.log(`backend listening on 0.0.0.0:${port}`)
    })
  })
  .catch((error: unknown) => {
    console.error('the API could not start', error)
    process.exit(1)
  })
