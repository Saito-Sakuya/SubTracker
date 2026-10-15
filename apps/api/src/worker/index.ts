import { PrismaClient } from '@prisma/client'
import { PrismaD1 } from '@prisma/adapter-d1'
import { Hono } from 'hono'
import { appRoutes } from '../routes/app'
import { authRoutes } from '../routes/auth'
import { tagRoutes } from '../routes/tags'
import { subscriptionRoutes } from '../routes/subscriptions'
import { statisticsRoutes } from '../routes/statistics'
import { calendarRoutes } from '../routes/calendar'
import { exchangeRateRoutes } from '../routes/exchange-rates'
import { settingsRoutes } from '../routes/settings'
import { notificationRoutes } from '../routes/notifications'
import { aiRoutes } from '../routes/ai'
import { importRoutes } from '../routes/imports'
import { versionRoutes } from '../routes/version'
import { ensureDatabaseInitialized } from './database-init'
import { LegacyFastifyApp, serveStaticLogo } from './legacy-fastify'
import { runWithRuntimeContext, type WorkerBindings } from '../runtime'
import { runWorkerScheduledTasks } from './scheduled'
import type { D1Database, ExecutionContext, ScheduledController } from './types'
import { requiresWorkerRuntimeContext } from './request-routing'

const app = new Hono<{ Bindings: WorkerBindings }>()

function getPrismaClient(db: D1Database) {
  return new PrismaClient({
    adapter: new PrismaD1(db as any)
  })
}

export async function registerWorkerRoutes(targetApp: Hono) {
  const legacy = new LegacyFastifyApp(targetApp as unknown as Hono, '/api/v1')
  await appRoutes(legacy as never)
  await authRoutes(legacy as never)
  await tagRoutes(legacy as never)
  await subscriptionRoutes(legacy as never)
  await statisticsRoutes(legacy as never)
  await calendarRoutes(legacy as never)
  await exchangeRateRoutes(legacy as never)
  await settingsRoutes(legacy as never)
  await notificationRoutes(legacy as never)
  await aiRoutes(legacy as never)
  await importRoutes(legacy as never)
  await versionRoutes(legacy as never)
}

async function bootstrapRoutes() {
  await registerWorkerRoutes(app as unknown as Hono)
}

const bootstrapPromise = bootstrapRoutes()

app.get('/health', (c) =>
  c.json({
    ok: true,
    timestamp: new Date().toISOString()
  })
)

app.get('/static/logos/:key{.+}', async (c) => {
  return serveStaticLogo(c.req.param('key'))
})

async function runWithContext(bindings: WorkerBindings, request: Request, execute: () => Promise<Response>) {
  await ensureDatabaseInitialized(bindings.DB)
  let prisma: PrismaClient | undefined
  try {
    return await runWithRuntimeContext(
      {
        createPrisma: () => {
          prisma ??= getPrismaClient(bindings.DB)
          return prisma
        },
        bindings,
        request
      },
      execute
    )
  } finally {
    if (prisma !== undefined) {
      await prisma.$disconnect().catch(() => undefined)
    }
  }
}

export default {
  async fetch(request: Request, env: WorkerBindings, _ctx: ExecutionContext) {
    const url = new URL(request.url)

    if (url.pathname === '/health') {
      await bootstrapPromise
      return app.fetch(request, env)
    }

    if (!requiresWorkerRuntimeContext(url.pathname)) {
      if (env.ASSETS) {
        return env.ASSETS.fetch(request)
      }

      return new Response('Asset binding not configured', { status: 404 })
    }

    return runWithContext(env, request, async () => {
      await bootstrapPromise
      if (requiresWorkerRuntimeContext(url.pathname)) {
        return app.fetch(request, env)
      }
      return new Response('Not found', { status: 404 })
    })
  },

  async scheduled(controller: ScheduledController, env: WorkerBindings, ctx: ExecutionContext) {
    // Ignore retired triggers while Cloudflare propagates schedule changes.
    if (controller.cron !== '* * * * *') return

    const request = new Request('https://worker.local/__scheduled__')
    await runWithContext(env, request, async () => {
      await bootstrapPromise
      await runWorkerScheduledTasks(new Date(Math.floor(controller.scheduledTime / 60_000) * 60_000))

      return new Response('ok')
    })

    ctx.waitUntil(Promise.resolve())
  }
}
