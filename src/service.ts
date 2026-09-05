import { createHttpServer, createKernel, type Kernel } from '@kernhq/kernel'
import { mailModule } from '@kernhq/module-mail/server'
import type { FastifyInstance } from 'fastify'
import { loadMailEnv, type MailEnv } from './env.js'
import { mountHealthWarnings } from './health.js'
import { createPrincipals, type Principals } from './principal.js'
import { mountWebhooks } from './webhooks.js'

export interface MailServiceOptions {
  role?: 'api' | 'worker' | 'both'
  env?: Record<string, string | undefined>
}

export interface MailService {
  kernel: Kernel
  env: MailEnv
  app: FastifyInstance | null
  principals: Principals
  stop(): Promise<void>
}

/**
 * Boots the mail service: the mail module (providers, templates, delivery log) plus the provider
 * webhooks. Runs the `mail.send` worker in the same process by default, so a self-hosted install does
 * not need a separate container for outgoing email.
 */
export async function createMailService(opts: MailServiceOptions = {}): Promise<MailService> {
  const role = opts.role ?? 'both'
  const env = loadMailEnv(opts.env ?? {})
  const kernel = await createKernel({
    service: 'mail',
    modules: [mailModule],
    role,
    env: { PORT: process.env.PORT ?? '4200', ...opts.env },
  })
  await kernel.start()

  const principals = createPrincipals(kernel)
  let app: FastifyInstance | null = null
  if (role !== 'worker') {
    const corsOrigins = [
      ...new Set(
        [kernel.env.KERN_BASE_URL, ...(kernel.env.CORS_ORIGINS ?? '').split(',').map((s) => s.trim())].filter(
          Boolean,
        ),
      ),
    ]
    app = await createHttpServer({
      kernel,
      resolvePrincipal: (req) => principals.fromRequest(req),
      corsOrigins,
      openapi: { title: 'Kern', version: kernel.version },
      // The hook goes on before the webhook scope is registered: awaiting a `register` flushes
      // Fastify's pending plugins, and a route's hooks are fixed at that point.
      extend: async (fastify) => {
        mountHealthWarnings(fastify, env)
        await mountWebhooks(fastify, kernel, env)
      },
    })
  }

  return {
    kernel,
    env,
    app,
    principals,
    async stop() {
      await app?.close()
      await kernel.stop()
    },
  }
}
