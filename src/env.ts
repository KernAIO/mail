/** Loads `.env` (repo-local, then the umbrella workspace) outside production and validates mail settings. */
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { config as loadDotenv } from 'dotenv'
import { z } from 'zod'

if (process.env.NODE_ENV !== 'production') {
  const here = dirname(fileURLToPath(import.meta.url))
  loadDotenv({ path: resolve(here, '../.env'), quiet: true })
  loadDotenv({ path: resolve(here, '../../../.env'), quiet: true })
}

export const MailEnv = z.object({
  /** fallback provider when a workspace has not configured its own */
  SMTP_URL: z.string().optional(),
  MAIL_FROM: z.string().default('Kern <no-reply@localhost>'),
  KERN_INSTANCE_NAME: z.string().default('Kern'),
  /**
   * Shared secret provider webhooks must present (query `?token=` or `x-kern-webhook-token`).
   *
   * Optional on purpose, and it is not the same as unauthenticated: with no secret configured
   * `/api/mail/webhooks/*` refuses every request. An instance that sends through SMTP has no
   * provider to receive webhooks from and must still boot, and an existing install never re-reads
   * the distribution's `.env.example`, so requiring it here would take mail down on upgrade for
   * everyone who has no use for it.
   *
   * An unset variable and an empty one mean the same thing — Compose substitutes an unset variable
   * as `""` — so both arrive here as `undefined` rather than as a secret equal to the empty string.
   */
  MAIL_WEBHOOK_TOKEN: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.string().optional(),
  ),
})
export type MailEnv = z.infer<typeof MailEnv>

export function loadMailEnv(extra: Record<string, string | undefined> = {}): MailEnv {
  const parsed = MailEnv.safeParse({ ...process.env, ...extra })
  if (!parsed.success) {
    throw new Error(
      `Invalid mail environment:\n${parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n')}`,
    )
  }
  return parsed.data
}
