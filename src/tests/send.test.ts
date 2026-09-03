/**
 * The outbound path: which provider a workspace ends up on, which recipients get dropped because they
 * are suppressed, and — end to end — a message queued through `mail.send` arriving at the dev SMTP
 * server, asserted through Mailpit's API.
 */
import {
  addSuppression,
  deliveries,
  filterSuppressed,
  loadSuppressed,
  maskConfig,
  providerFor,
  resolveProvider,
  SECRET_PLACEHOLDER,
  suppressions,
  unmaskConfig,
} from '@kernhq/module-mail/server'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  expectRejection,
  MAILPIT_URL,
  type MailApi,
  mailpit,
  PLATFORM_FROM,
  recipient,
  startMail,
  type TestMail,
  waitFor,
} from '../testing/harness.js'

let mail: TestMail
let api: MailApi
let ws: string
let mailpitUp = false
/** every message this suite put into the shared dev inbox, cleaned up at the end */
const delivered: string[] = []

/**
 * Reads bind `'*'`, the instance-wide binding `mod_mail`'s row-level policies admit — the same one
 * the send job uses. Against a module version from before the policies the binding is inert.
 */
const ALL_WORKSPACES = '*'
const deliveryRow = (id: string) =>
  mail.kernel.database
    .withWorkspace(ALL_WORKSPACES, (tx) => tx.select().from(deliveries).where(eq(deliveries.id, id)).limit(1))
    .then((r) => r[0])

const send = (input: Record<string, unknown>) =>
  mail.kernel.call<{ deliveryId: string; status: string }>('mail.send', input)

beforeAll(async () => {
  mail = await startMail()
  ws = mail.workspaceId
  api = mail.api(mail.admin)
  mailpitUp = await mailpit.available()
  // Skipping the only tests that prove a message really leaves the process is fine on a laptop with
  // no infrastructure running, but it must never be how CI reports success. There it is a failure.
  if (!mailpitUp) {
    const message = `Mailpit is not answering on ${MAILPIT_URL}. Start it with \`pnpm infra\` from the umbrella repository.`
    if (process.env.CI) throw new Error(message)
    process.stderr.write(`\n  ⚠ ${message}\n    The end-to-end delivery tests will be skipped.\n\n`)
  }
})
afterAll(async () => {
  await mailpit.delete(delivered).catch(() => {})
  await mail?.stop()
})

describe('provider selection', () => {
  it('falls back to the platform SMTP when a workspace has no provider', async () => {
    const provider = await resolveProvider(mail.kernel, ws)
    expect(provider.name).toBe('smtp')
    expect(provider.from).toBe(PLATFORM_FROM)
    provider.close?.()
  })

  it('uses the workspace provider once one is configured', async () => {
    await api.settings.set({
      workspaceId: ws,
      config: {
        provider: 'resend',
        apiKey: 're_test_key',
        from: 'Workspace <hello@workspace.test>',
      },
    })

    const provider = await resolveProvider(mail.kernel, ws)
    expect(provider.name).toBe('resend')
    expect(provider.from).toBe('Workspace <hello@workspace.test>')

    // another workspace is unaffected
    const other = await resolveProvider(mail.kernel, '01920000-0000-7000-8000-0000000000ff')
    expect(other.name).toBe('smtp')
    other.close?.()

    await api.settings.set({ workspaceId: ws, config: null })
    expect((await resolveProvider(mail.kernel, ws)).name).toBe('smtp')
  })

  it('builds the right provider for every configured kind', () => {
    const env = { SMTP_URL: 'smtp://localhost:1025', MAIL_FROM: 'Fallback <fallback@localhost>' }
    expect(providerFor(null, env).name).toBe('smtp')
    expect(providerFor({ provider: 'platform' }, env).name).toBe('smtp')
    expect(providerFor({ provider: 'resend', apiKey: 'k', from: 'a@b.test' }, env).name).toBe('resend')
    expect(providerFor({ provider: 'postmark', serverToken: 't', from: 'a@b.test' }, env).name).toBe(
      'postmark',
    )
    expect(
      providerFor({ provider: 'mailgun', apiKey: 'k', domain: 'd', region: 'eu', from: 'a@b.test' }, env)
        .name,
    ).toBe('mailgun')
    expect(
      providerFor(
        { provider: 'ses', accessKeyId: 'a', secretAccessKey: 's', region: 'eu-west-1', from: 'a@b.test' },
        env,
      ).name,
    ).toBe('ses')
  })

  it('refuses to send at all when nothing is configured', () => {
    expect(() => providerFor(null, {})).toThrowError(/no platform smtp_url set|no mail provider/i)
  })

  it('masks secrets on read and keeps them on write-back', async () => {
    await api.settings.set({
      workspaceId: ws,
      config: { provider: 'postmark', serverToken: 'super-secret', from: 'a@b.test' },
    })

    const read = await api.settings.get({ workspaceId: ws })
    expect(read.config?.serverToken).toBe(SECRET_PLACEHOLDER)
    expect(read.config?.from).toBe('a@b.test')

    // writing the placeholder back must keep the stored secret
    await api.settings.set({ workspaceId: ws, config: read.config })
    const provider = await resolveProvider(mail.kernel, ws)
    expect(provider.name).toBe('postmark')
    expect(maskConfig({ provider: 'postmark', serverToken: 'x', from: 'a@b.test' }).serverToken).toBe(
      SECRET_PLACEHOLDER,
    )

    // a placeholder with no stored value behind it is refused rather than sent as a literal
    expect(() =>
      unmaskConfig({ provider: 'resend', apiKey: SECRET_PLACEHOLDER, from: 'a@b.test' }, null),
    ).toThrowError(/secret field/i)

    await api.settings.set({ workspaceId: ws, config: null })
  })

  it('validates the submitted config', async () => {
    await expect(
      api.settings.set({ workspaceId: ws, config: { provider: 'resend', from: 'a@b.test' } }),
    ).rejects.toThrow()
  })

  it('only lets workspace admins read or change mail settings', async () => {
    const plain = mail.api(mail.member('member'))
    await expectRejection(() => plain.settings.get({ workspaceId: ws }), 'FORBIDDEN')
    await expectRejection(() => plain.settings.set({ workspaceId: ws, config: null }), 'FORBIDDEN')
    await expectRejection(() => plain.deliveries.list({ workspaceId: ws, limit: 10 }), 'FORBIDDEN')
    await expectRejection(() => mail.anonymous.settings.get({ workspaceId: ws }), 'UNAUTHORIZED')
  })
})

describe('suppressions', () => {
  it('splits recipients into deliverable and suppressed', () => {
    const blocked = new Set(['blocked@example.test'])
    expect(filterSuppressed(['ok@example.test', 'BLOCKED@example.test'], blocked)).toEqual({
      deliverable: ['ok@example.test'],
      suppressed: ['BLOCKED@example.test'],
    })
    expect(filterSuppressed([], blocked)).toEqual({ deliverable: [], suppressed: [] })
  })

  it('scopes a workspace suppression to that workspace and an instance one to everybody', async () => {
    const perWorkspace = recipient('bounced-ws')
    const instanceWide = recipient('bounced-all')
    await addSuppression(mail.kernel, { workspaceId: ws, email: perWorkspace, reason: 'bounce' })
    await addSuppression(mail.kernel, { workspaceId: null, email: instanceWide, reason: 'complaint' })

    const inWorkspace = await loadSuppressed(mail.kernel, ws, [perWorkspace, instanceWide])
    expect([...inWorkspace].sort()).toEqual([instanceWide, perWorkspace].sort())

    const elsewhere = await loadSuppressed(mail.kernel, '01920000-0000-7000-8000-0000000000ee', [
      perWorkspace,
      instanceWide,
    ])
    expect([...elsewhere]).toEqual([instanceWide])

    const instanceLevel = await loadSuppressed(mail.kernel, null, [perWorkspace, instanceWide])
    expect([...instanceLevel]).toEqual([instanceWide])
  })

  it('is idempotent and case-insensitive', async () => {
    const address = recipient('dupe')
    await addSuppression(mail.kernel, { workspaceId: ws, email: address.toUpperCase(), reason: 'bounce' })
    await addSuppression(mail.kernel, { workspaceId: ws, email: address, reason: 'manual' })

    const rows = await mail.kernel.database.withWorkspace(ALL_WORKSPACES, (tx) =>
      tx.select().from(suppressions).where(eq(suppressions.email, address.toLowerCase())),
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]!.reason).toBe('bounce')

    expect([...(await loadSuppressed(mail.kernel, ws, [address.toUpperCase()]))]).toEqual([
      address.toLowerCase(),
    ])
  })

  it('fails the delivery instead of sending when every recipient is suppressed', async () => {
    const address = recipient('all-suppressed')
    await addSuppression(mail.kernel, { workspaceId: null, email: address, reason: 'bounce' })

    const { deliveryId } = await send({
      workspaceId: ws,
      to: [address],
      subject: 'Should never leave',
      text: 'nope',
    })
    const row = await waitFor(async () => {
      const r = await deliveryRow(deliveryId)
      return r && r.status !== 'queued' ? r : null
    }, 'the delivery to settle')
    expect(row.status).toBe('failed')
    expect(row.error).toBe('all recipients suppressed')
  })
})

describe('the delivery log', () => {
  it('records a row per message and pages it newest-first', async () => {
    const before = await api.deliveries.list({ workspaceId: ws, limit: 100 })
    const ids: string[] = []
    for (let i = 0; i < 3; i++) {
      const { deliveryId, status } = await send({
        workspaceId: ws,
        to: [recipient(`logged-${i}`)],
        subject: `Logged ${i}`,
        text: 'body',
        tags: ['test'],
      })
      expect(status).toBe('queued')
      ids.push(deliveryId)
    }

    const after = await api.deliveries.list({ workspaceId: ws, limit: 100 })
    expect(after.items.length).toBe(before.items.length + 3)
    const logged = after.items.filter((d) => ids.includes(d.id))
    expect(logged).toHaveLength(3)
    expect(logged[0]!.subject).toBe('Logged 2')
    expect(logged[0]!.provider).toBe('platform')
    expect(logged[0]!.tags).toEqual(['test'])

    // pages walk the log without repeating a row
    const first = await api.deliveries.list({ workspaceId: ws, limit: 2 })
    expect(first.items).toHaveLength(2)
    expect(first.nextCursor).toBeTruthy()
    const second = await api.deliveries.list({ workspaceId: ws, limit: 2, cursor: first.nextCursor! })
    expect(second.items.map((d) => d.id)).not.toEqual(expect.arrayContaining(first.items.map((d) => d.id)))
  })

  it('never shows another workspace’s deliveries', async () => {
    const otherWorkspace = '01920000-0000-7000-8000-0000000000dd'
    await send({ workspaceId: otherWorkspace, to: [recipient('other')], subject: 'Other', text: 'x' })
    const mine = await api.deliveries.list({ workspaceId: ws, limit: 100 })
    expect(mine.items.every((d) => d.workspaceId === ws)).toBe(true)
  })

  it('rejects a message with neither text, html nor a template', async () => {
    await expect(send({ workspaceId: ws, to: [recipient('empty')], subject: 'Nothing' })).rejects.toThrow()
  })
})

describe('end to end through SMTP', () => {
  it('queues, sends and lands in the inbox', async ({ skip }) => {
    if (!mailpitUp) skip('Mailpit is not running')
    const to = recipient('e2e')
    const subject = `Kern e2e ${to}`

    const { deliveryId, status } = await send({
      workspaceId: ws,
      to: [to],
      subject,
      text: 'the body of the end-to-end message',
      html: '<p>the body of the end-to-end message</p>',
      tags: ['e2e'],
    })
    expect(status).toBe('queued')

    const row = await waitFor(async () => {
      const r = await deliveryRow(deliveryId)
      return r && r.status === 'sent' ? r : null
    }, 'the delivery to be marked sent')
    expect(row.providerMessageId).toBeTruthy()
    expect(row.error).toBeNull()

    const [message] = await waitFor(async () => {
      const found = await mailpit.search(`to:${to}`)
      return found.length ? found : null
    }, `the message to reach Mailpit for ${to}`)
    delivered.push(message!.ID)
    expect(message!.Subject).toBe(subject)
    expect(message!.To.map((t) => t.Address)).toEqual([to])
    expect(message!.From.Address).toBe('kern-test@localhost')
    expect(message!.From.Name).toBe('Kern Test')

    const full = await mailpit.message(message!.ID)
    expect(full.Text).toContain('the body of the end-to-end message')
    expect(full.HTML).toContain('<p>the body of the end-to-end message</p>')
  })

  it('renders a template on the way out', async ({ skip }) => {
    if (!mailpitUp) skip('Mailpit is not running')
    const to = recipient('e2e-template')

    const { deliveryId } = await send({
      workspaceId: ws,
      to: [to],
      // a blank subject defers to the template's own subject line
      subject: ' ',
      template: { name: 'test', data: { provider: 'smtp', workspaceName: 'Engines' } },
    })
    await waitFor(async () => {
      const r = await deliveryRow(deliveryId)
      return r && r.status === 'sent' ? r : null
    }, 'the templated delivery to be marked sent')

    const [message] = await waitFor(async () => {
      const found = await mailpit.search(`to:${to}`)
      return found.length ? found : null
    }, `the templated message to reach Mailpit for ${to}`)
    delivered.push(message!.ID)
    // an empty subject is filled in from the template
    expect(message!.Subject).toContain('Kern Test')

    const full = await mailpit.message(message!.ID)
    expect(full.HTML).toContain('Mail is working')
    expect(full.HTML).toContain('Engines')
    expect(full.Text.length).toBeGreaterThan(0)

    const row = await deliveryRow(deliveryId)
    expect(row!.template).toBe('test')
  })

  it('drops the suppressed recipients and still delivers to the rest', async ({ skip }) => {
    if (!mailpitUp) skip('Mailpit is not running')
    const good = recipient('e2e-good')
    const blocked = recipient('e2e-blocked')
    await addSuppression(mail.kernel, { workspaceId: ws, email: blocked, reason: 'bounce' })

    const { deliveryId } = await send({
      workspaceId: ws,
      to: [good, blocked],
      subject: `Partial ${good}`,
      text: 'only one of you should get this',
    })
    await waitFor(async () => {
      const r = await deliveryRow(deliveryId)
      return r && r.status === 'sent' ? r : null
    }, 'the partially suppressed delivery to be marked sent')

    const [message] = await waitFor(async () => {
      const found = await mailpit.search(`to:${good}`)
      return found.length ? found : null
    }, `the message to reach Mailpit for ${good}`)
    delivered.push(message!.ID)
    expect(message!.To.map((t) => t.Address)).toEqual([good])
    expect(await mailpit.search(`to:${blocked}`)).toEqual([])
  })

  it('sends the workspace test message from the settings screen', async ({ skip }) => {
    if (!mailpitUp) skip('Mailpit is not running')
    const to = recipient('e2e-settings-test')

    const result = await api.settings.test({ workspaceId: ws, to })
    expect(result).toEqual({ ok: true, error: null })

    const [message] = await waitFor(async () => {
      const found = await mailpit.search(`to:${to}`)
      return found.length ? found : null
    }, `the test message to reach Mailpit for ${to}`)
    delivered.push(message!.ID)
    expect(message!.Subject).toContain('Kern Test')
  })
})
