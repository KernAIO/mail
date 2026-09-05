/**
 * Provider webhooks. Each provider reports deliveries and bounces in its own shape; the service
 * normalises them into a delivery status plus, for hard failures, a suppression entry.
 */
import type { Tx } from '@kernhq/kernel'
import { deliveries, loadSuppressed, suppressions } from '@kernhq/module-mail/server'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { recipient, startMail, type TestMail } from '../testing/harness.js'

let mail: TestMail
let baseUrl: string
const TOKEN = 'test-webhook-token'

const post = (provider: string, body: unknown, query = `?token=${TOKEN}`) =>
  fetch(`${baseUrl}/api/mail/webhooks/${provider}${query}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

/**
 * Every read and write here binds `'*'`, the instance-wide binding `mod_mail`'s row-level policies
 * admit — the same one the webhook handler uses, because a provider reports on every workspace's
 * mail at once. Against a module version from before the policies the binding is inert.
 */
const ALL_WORKSPACES = '*'
const unbound = <T>(fn: (tx: Tx) => Promise<T>) => mail.kernel.database.withWorkspace(ALL_WORKSPACES, fn)

/** A delivery row already marked sent, as it would be after the provider accepted it. */
async function sentDelivery(to: string, providerMessageId: string) {
  const [row] = await unbound((tx) =>
    tx
      .insert(deliveries)
      .values({
        workspaceId: mail.workspaceId,
        to: [to],
        subject: 'Webhook subject',
        provider: 'postmark',
        status: 'sent',
        providerMessageId,
      })
      .returning(),
  )
  return row!
}

const reload = (id: string) =>
  unbound((tx) => tx.select().from(deliveries).where(eq(deliveries.id, id)).limit(1)).then((r) => r[0]!)

beforeAll(async () => {
  mail = await startMail({ env: { MAIL_WEBHOOK_TOKEN: TOKEN } })
  baseUrl = await mail.listen()
})
afterAll(async () => {
  await mail?.stop()
})

describe('authentication and routing', () => {
  it('refuses an unknown provider', async () => {
    expect((await post('carrier-pigeon', {})).status).toBe(404)
  })

  it('refuses a request without the shared secret', async () => {
    expect((await post('postmark', { RecordType: 'Delivery' }, '')).status).toBe(401)
    expect((await post('postmark', { RecordType: 'Delivery' }, '?token=wrong')).status).toBe(401)
    // a prefix of the real secret is as wrong as anything else
    expect((await post('postmark', { RecordType: 'Delivery' }, `?token=${TOKEN.slice(0, -1)}`)).status).toBe(
      401,
    )
    const noHeader = await fetch(`${baseUrl}/api/mail/webhooks/postmark`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ RecordType: 'Delivery' }),
    })
    expect(noHeader.status).toBe(401)
  })

  it('accepts the secret in a header as well as the query string', async () => {
    const res = await fetch(`${baseUrl}/api/mail/webhooks/postmark`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-kern-webhook-token': TOKEN },
      body: JSON.stringify({ RecordType: 'Open' }),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, ignored: true })
  })

  it('accepts the correct secret in the query string', async () => {
    const res = await post('postmark', { RecordType: 'Open' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, ignored: true })
  })
})

/**
 * The shipped distribution used to leave `MAIL_WEBHOOK_TOKEN` unset, and the route then skipped the
 * check altogether — so anyone on the internet could write an instance-wide suppression and stop a
 * person's password resets. With nothing to prove against, the endpoint refuses everything.
 */
describe('an instance with no webhook token configured', () => {
  let unconfigured: TestMail
  let url: string

  beforeAll(async () => {
    unconfigured = await startMail({ env: { MAIL_WEBHOOK_TOKEN: undefined } })
    url = await unconfigured.listen()
  })
  afterAll(async () => {
    await unconfigured?.stop()
  })

  it('refuses every request rather than accepting it unauthenticated', async () => {
    const bounce = {
      RecordType: 'Bounce',
      Type: 'HardBounce',
      Email: recipient('unauthenticated'),
      Description: 'mailbox does not exist',
    }
    for (const query of ['', '?token=', '?token=anything']) {
      const res = await fetch(`${url}/api/mail/webhooks/postmark${query}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(bounce),
      })
      expect(res.status).toBe(401)
    }
    // nothing was written, so the address can still be sent to
    const written = await unconfigured.kernel.database.withWorkspace(ALL_WORKSPACES, (tx) =>
      tx.select().from(suppressions),
    )
    expect(written).toEqual([])
  })
})

/**
 * A subscription confirmation makes this service fetch a URL out of the request body. Unchecked that
 * is a blind SSRF from inside the private network, so only an SNS endpoint over TLS is ever called —
 * and the refusal happens before anything leaves the process.
 */
describe('SNS subscription confirmation', () => {
  const confirmation = (subscribeUrl: string, extra: Record<string, unknown> = {}) => ({
    Type: 'SubscriptionConfirmation',
    MessageId: 'm-1',
    Token: 'a-token',
    TopicArn: 'arn:aws:sns:eu-west-1:123456789012:kern-mail',
    Message: 'You have chosen to subscribe.',
    Timestamp: '2026-09-05T09:00:00.000Z',
    SignatureVersion: '2',
    Signature: 'not-a-real-signature',
    SigningCertURL: 'https://sns.eu-west-1.amazonaws.com/SimpleNotificationService-abc123.pem',
    SubscribeURL: subscribeUrl,
    ...extra,
  })

  /** Runs `fn` with every outbound URL recorded, and returns the ones that did not go to this service. */
  async function outboundDuring(fn: () => Promise<void>): Promise<string[]> {
    const seen: string[] = []
    const real = globalThis.fetch
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      seen.push(input instanceof Request ? input.url : String(input))
      return real(input, init)
    })
    try {
      await fn()
    } finally {
      spy.mockRestore()
    }
    return seen.filter((u) => !u.startsWith(baseUrl))
  }

  it('refuses a SubscribeURL that is not an SNS endpoint, without fetching it', async () => {
    const hostile = [
      'http://169.254.169.254/latest/meta-data/iam/security-credentials/',
      'https://169.254.169.254/latest/meta-data/',
      'http://sns.eu-west-1.amazonaws.com/?Action=ConfirmSubscription',
      'https://sns.eu-west-1.amazonaws.com.attacker.example/?Action=ConfirmSubscription',
      'https://attacker.example/?Action=ConfirmSubscription',
      'https://sns.eu-west-1.amazonaws.com:8443/?Action=ConfirmSubscription',
      'file:///etc/passwd',
      'not a url at all',
    ]
    const outbound = await outboundDuring(async () => {
      for (const subscribeUrl of hostile) {
        const res = await post('ses', confirmation(subscribeUrl))
        expect([subscribeUrl, res.status]).toEqual([subscribeUrl, 400])
        expect(await res.json()).toEqual({
          code: 'BAD_REQUEST',
          message: 'SubscribeURL is not an Amazon SNS endpoint',
        })
      }
    })
    expect(outbound).toEqual([])
  })

  it('refuses a confirmation whose signing certificate is not an SNS endpoint', async () => {
    const outbound = await outboundDuring(async () => {
      const res = await post(
        'ses',
        confirmation('https://sns.eu-west-1.amazonaws.com/?Action=ConfirmSubscription', {
          SigningCertURL: 'https://attacker.example/SimpleNotificationService.pem',
        }),
      )
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ code: 'BAD_REQUEST', message: 'SNS signature did not verify' })
    })
    expect(outbound).toEqual([])
  })
})

describe('normalising provider events', () => {
  it('marks a postmark delivery as sent and a hard bounce as bounced + suppressed', async () => {
    const to = recipient('postmark-bounce')
    const ok = await sentDelivery(recipient('postmark-ok'), `pm-ok-${Date.now()}`)
    const bad = await sentDelivery(to, `pm-bad-${Date.now()}`)

    await post('postmark', { RecordType: 'Delivery', MessageID: ok.providerMessageId, Email: ok.to[0] })
    expect((await reload(ok.id)).status).toBe('sent')

    await post('postmark', {
      RecordType: 'Bounce',
      Type: 'HardBounce',
      MessageID: bad.providerMessageId,
      Email: to,
      Description: 'mailbox does not exist',
    })
    const bounced = await reload(bad.id)
    expect(bounced.status).toBe('bounced')
    expect(bounced.error).toBe('mailbox does not exist')
    expect([...(await loadSuppressed(mail.kernel, mail.workspaceId, [to]))]).toEqual([to.toLowerCase()])
  })

  it('treats a soft bounce as a retryable failure and does not suppress', async () => {
    const to = recipient('postmark-soft')
    const row = await sentDelivery(to, `pm-soft-${Date.now()}`)

    await post('postmark', {
      RecordType: 'Bounce',
      Type: 'SoftBounce',
      MessageID: row.providerMessageId,
      Email: to,
      Description: 'mailbox full',
    })
    expect((await reload(row.id)).status).toBe('failed')
    expect([...(await loadSuppressed(mail.kernel, mail.workspaceId, [to]))]).toEqual([])
  })

  it('suppresses a spam complaint', async () => {
    const to = recipient('postmark-complaint')
    const row = await sentDelivery(to, `pm-spam-${Date.now()}`)

    await post('postmark', {
      RecordType: 'SpamComplaint',
      MessageID: row.providerMessageId,
      Email: to,
    })
    expect((await reload(row.id)).status).toBe('failed')
    const [suppression] = await unbound((tx) =>
      tx.select().from(suppressions).where(eq(suppressions.email, to.toLowerCase())),
    )
    expect(suppression?.reason).toBe('complaint')
    expect(suppression?.source).toBe('postmark')
  })

  it('understands mailgun’s envelope', async () => {
    const to = recipient('mailgun')
    const row = await sentDelivery(to, `mg-${Date.now()}`)

    await post('mailgun', {
      'event-data': {
        event: 'failed',
        severity: 'permanent',
        recipient: to,
        message: { headers: { 'message-id': row.providerMessageId } },
        'delivery-status': { message: 'no such user' },
      },
    })
    const updated = await reload(row.id)
    expect(updated.status).toBe('bounced')
    expect(updated.error).toBe('no such user')
    expect([...(await loadSuppressed(mail.kernel, mail.workspaceId, [to]))]).toEqual([to.toLowerCase()])
  })

  it('understands resend’s envelope', async () => {
    const to = recipient('resend')
    const row = await sentDelivery(to, `rs-${Date.now()}`)

    await post('resend', {
      type: 'email.bounced',
      data: { email_id: row.providerMessageId, to: [to], reason: 'blocked' },
    })
    expect((await reload(row.id)).status).toBe('bounced')
  })

  it('understands SES notifications, including the stringified Message envelope', async () => {
    const to = recipient('ses')
    const row = await sentDelivery(to, `ses-${Date.now()}`)

    await post('ses', {
      Message: JSON.stringify({
        notificationType: 'Bounce',
        bounce: {
          bounceType: 'Permanent',
          bouncedRecipients: [{ emailAddress: to, diagnosticCode: '550 unknown' }],
        },
        mail: { messageId: row.providerMessageId, destination: [to] },
      }),
    })
    const updated = await reload(row.id)
    expect(updated.status).toBe('bounced')
    expect(updated.error).toBe('550 unknown')
  })

  it('ignores an event it does not recognise and leaves the delivery alone', async () => {
    const row = await sentDelivery(recipient('ignored'), `ig-${Date.now()}`)
    const res = await post('postmark', { RecordType: 'Click', MessageID: row.providerMessageId })
    expect(await res.json()).toEqual({ ok: true, ignored: true })
    expect((await reload(row.id)).status).toBe('sent')
  })

  it('still records a suppression when the delivery is unknown', async () => {
    const to = recipient('orphan-bounce')
    const res = await post('postmark', { RecordType: 'Bounce', Type: 'HardBounce', Email: to })
    expect(res.status).toBe(200)
    // no delivery row to attribute it to, so it lands instance-wide
    expect([...(await loadSuppressed(mail.kernel, null, [to]))]).toEqual([to.toLowerCase()])
  })
})
