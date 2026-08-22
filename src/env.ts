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
  /** shared secret provider webhooks must present (query `?token=` or `x-kern-webhook-token`) */
  MAIL_WEBHOOK_TOKEN: z.string().optional(),
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
