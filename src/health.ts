/**
 * Configuration an operator would otherwise only find in a log line, reported where they look.
 *
 * `MAIL_WEBHOOK_TOKEN` is optional on purpose — an instance sending over SMTP has no provider to
 * hear from and must still boot — but with it unset `/api/mail/webhooks/*` answers 401 to
 * everything, so bounces and complaints stop being recorded and suppression stops growing. Nothing
 * fails: the provider's dashboard shows a failing endpoint and Kern shows a healthy service. One
 * warning at boot is not enough, because nobody reads a container log from three weeks ago.
 *
 * The kernel owns `/api/health` and answers it with an object, so the service adds its own findings
 * to that object on the way out. That is deliberately not a second health endpoint: `/api/health` is
 * what the image probes, what the admin update screen reads and what core's module catalogue calls,
 * so it is the one place an operator and a script already agree on.
 */
import type { FastifyInstance } from 'fastify'
import type { MailEnv } from './env.js'

const HEALTH_PATH = '/api/health'

/** Everything configured in a way that quietly disables part of the service. Empty when all is well. */
export function configWarnings(env: MailEnv): string[] {
  const warnings: string[] = []
  if (!env.MAIL_WEBHOOK_TOKEN) {
    warnings.push(
      'MAIL_WEBHOOK_TOKEN is not set, so /api/mail/webhooks/* refuses every request: provider bounces and complaints are not recorded. Set it, then register the webhook URL with ?token=<the same value>.',
    )
  }
  return warnings
}

/** Adds `warnings` to the kernel's health payload. Always present, so an empty array means "checked". */
export function mountHealthWarnings(app: FastifyInstance, env: MailEnv): void {
  const warnings = configWarnings(env)
  app.addHook('preSerialization', async (req, _reply, payload) => {
    if (req.method !== 'GET' || req.url.split('?')[0] !== HEALTH_PATH) return payload
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return payload
    return { ...payload, warnings }
  })
}
