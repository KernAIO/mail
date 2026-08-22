/**
 * Integration harness for the mail service.
 *
 * The service boots against a scratch database with its own pg-boss workers, so `mail.send` really
 * travels through the queue and out over SMTP. Core is not started: the settings procedures the mail
 * module reads workspace provider config from are registered on the kernel broker instead, backed by
 * an in-memory store the tests can write to.
 */
import { randomBytes } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { MembershipSummary, Principal } from '@kernhq/contracts'
import { ANONYMOUS } from '@kernhq/contracts'
import type { Kernel, RequestContext } from '@kernhq/kernel'
import { uuidv7 } from '@kernhq/kernel'
import { type MailContract, mailContract } from '@kernhq/module-mail/contract'
import { createScratchDatabase } from '@kernhq/testing'
import type { ContractRouterClient } from '@orpc/contract'
import { createRouterClient } from '@orpc/server'
import { config as loadDotenv } from 'dotenv'
import { createMailService, type MailService } from '../service.js'

const here = dirname(fileURLToPath(import.meta.url))
loadDotenv({ path: resolve(here, '../../.env'), quiet: true })
loadDotenv({ path: resolve(here, '../../../../.env'), quiet: true })

export const BASE_DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://kern:kern@localhost:5432/kern'
export const SMTP_URL = process.env.SMTP_URL ?? 'smtp://localhost:1025'
export const MAILPIT_URL = process.env.MAILPIT_URL ?? 'http://localhost:8025'
const TEST_SECRET = process.env.KERN_SECRET ?? 'kern-test-secret-value-at-least-32-chars'

export type MailApi = ContractRouterClient<MailContract>

export interface MailpitMessage {
  ID: string
  Subject: string
  From: { Address: string; Name: string }
  To: Array<{ Address: string }>
  Cc: Array<{ Address: string }> | null
  Bcc: Array<{ Address: string }> | null
  Snippet: string
}

export interface TestMail {
  service: MailService
  kernel: Kernel
  workspaceId: string
  /** workspace integration config, as core would store it (already decrypted) */
  integrations: Map<string, Record<string, unknown> | null>
  api(principal: Principal): MailApi
  member(role?: MembershipSummary['role']): Principal
  admin: Principal
  anonymous: MailApi
  /** start listening so webhook requests can be made; returns http://127.0.0.1:<port> */
  listen(): Promise<string>
  stop(): Promise<void>
}

const unique = () => `${Date.now().toString(36)}_${randomBytes(4).toString('hex')}`

export interface StartMailOptions {
  env?: Record<string, string | undefined>
}

export const PLATFORM_FROM = 'Kern Test <kern-test@localhost>'
export const INSTANCE_NAME = 'Kern Test'

export async function startMail(opts: StartMailOptions = {}): Promise<TestMail> {
  // `providerFor` and `instanceName()` read the platform defaults straight from `process.env` (in a
  // deployment dotenv has already put them there), so set them the same way rather than only passing
  // them through the service options.
  process.env.SMTP_URL = SMTP_URL
  process.env.MAIL_FROM = PLATFORM_FROM
  process.env.KERN_INSTANCE_NAME = INSTANCE_NAME

  const scratch = await createScratchDatabase(BASE_DATABASE_URL, `kern_test_mail_${unique()}`)
  const workspaceId = uuidv7()
  const service = await createMailService({
    // `both` so the module's own pg-boss worker runs the `mail.send` job the API enqueues
    role: 'both',
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: scratch.url,
      DATABASE_POOL_MAX: '4',
      KERN_SECRET: TEST_SECRET,
      PORT: '0',
      SMTP_URL,
      MAIL_FROM: PLATFORM_FROM,
      KERN_INSTANCE_NAME: INSTANCE_NAME,
      NATS_URL: undefined,
      VALKEY_URL: undefined,
      ...opts.env,
    },
  })
  const kernel = service.kernel
  const integrations = new Map<string, Record<string, unknown> | null>()

  kernel.broker.register('core', {
    'settings.getIntegration': {
      handler: async (input: { workspaceId: string; kind: string }) =>
        integrations.get(`${input.workspaceId}:${input.kind}`) ?? null,
    },
    'settings.setIntegration': {
      handler: async (input: {
        workspaceId: string
        kind: string
        config: Record<string, unknown> | null
      }) => {
        integrations.set(`${input.workspaceId}:${input.kind}`, input.config)
        return { ok: true }
      },
    },
    'modules.isEnabled': { handler: async () => true },
    'authz.customRolePermissions': { handler: async () => [] },
    'authz.bindings': { handler: async () => [] },
    'files.get': { handler: async (input: { id: string }) => ({ id: input.id, key: `test/${input.id}` }) },
  })

  const mod = kernel.registry.get('mail')
  if (!mod?.router) throw new Error('mail module did not expose a router')
  const router = mod.router(kernel)

  const clientFor = (principal: Principal): MailApi =>
    createRouterClient(router, {
      context: (): RequestContext => ({
        kernel,
        principal,
        requestId: `test-${randomBytes(4).toString('hex')}`,
        ip: '127.0.0.1',
        headers: {},
      }),
    }) as unknown as MailApi

  const member = (role: MembershipSummary['role'] = 'member'): Principal => ({
    kind: 'user',
    userId: uuidv7() as Principal['userId'],
    email: 'member@example.test',
    name: 'Member',
    locale: 'en',
    instanceAdmin: false,
    service: null,
    memberships: [
      {
        workspaceId: workspaceId as MembershipSummary['workspaceId'],
        role,
        roleIds: [],
        groupIds: [],
        status: 'active',
      },
    ],
    permissionVersion: 0,
  })

  let baseUrl: string | null = null

  return {
    service,
    kernel,
    workspaceId,
    integrations,
    api: clientFor,
    member,
    admin: member('admin'),
    anonymous: clientFor(ANONYMOUS),
    async listen() {
      if (baseUrl) return baseUrl
      const app = service.app
      if (!app) throw new Error('mail service started without an HTTP server')
      await app.listen({ port: 0, host: '127.0.0.1' })
      baseUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`
      return baseUrl
    },
    async stop() {
      await service.stop()
      await scratch.drop()
    },
  }
}

/** Poll `check` until it returns a truthy value, or fail with `label`. */
export async function waitFor<T>(
  check: () => Promise<T | null | undefined | false>,
  label: string,
  { timeoutMs = 20_000, intervalMs = 150 } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let last: unknown
  while (Date.now() < deadline) {
    last = await check()
    if (last) return last as T
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`)
}

/** Read the Mailpit inbox the dev SMTP server writes into. */
export const mailpit = {
  async search(query: string): Promise<MailpitMessage[]> {
    const res = await fetch(`${MAILPIT_URL}/api/v1/search?query=${encodeURIComponent(query)}`)
    if (!res.ok) throw new Error(`mailpit search failed: ${res.status}`)
    return ((await res.json()) as { messages?: MailpitMessage[] }).messages ?? []
  },
  async message(id: string): Promise<{ Subject: string; Text: string; HTML: string }> {
    const res = await fetch(`${MAILPIT_URL}/api/v1/message/${id}`)
    if (!res.ok) throw new Error(`mailpit message failed: ${res.status}`)
    return (await res.json()) as { Subject: string; Text: string; HTML: string }
  },
  async delete(ids: string[]): Promise<void> {
    if (!ids.length) return
    await fetch(`${MAILPIT_URL}/api/v1/messages`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ IDs: ids }),
    })
  },
  /** true when Mailpit is reachable; suites skip the end-to-end send otherwise */
  async available(): Promise<boolean> {
    try {
      const res = await fetch(`${MAILPIT_URL}/api/v1/info`, { signal: AbortSignal.timeout(2_000) })
      return res.ok
    } catch {
      return false
    }
  },
}

/** A recipient nobody else is using, so suites can run concurrently against one Mailpit. */
export const recipient = (prefix: string) => `${prefix}-${unique()}@kern-test.invalid`

export { mailContract }

export function errorCode(err: unknown): string {
  const e = err as { code?: unknown; name?: unknown; message?: unknown }
  if (typeof e?.code === 'string') return e.code
  return String(e?.name ?? e?.message ?? err)
}

export async function expectRejection(fn: () => Promise<unknown>, code: string): Promise<unknown> {
  try {
    await fn()
  } catch (err) {
    if (errorCode(err) !== code)
      throw new Error(`expected error code ${code}, got ${errorCode(err)}: ${String(err)}`)
    return err
  }
  throw new Error(`expected the call to reject with ${code}, but it resolved`)
}
