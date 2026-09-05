/**
 * Provider webhooks. Each provider reports deliveries and bounces in its own shape; the service
 * normalises them into a delivery status plus, for hard failures, a suppression entry.
 */
import { execFileSync } from 'node:child_process'
import { createPrivateKey, createSign, type KeyObject } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Tx } from '@kernhq/kernel'
import { deliveries, loadSuppressed, suppressions } from '@kernhq/module-mail/server'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { recipient, startMail, type TestMail } from '../testing/harness.js'
import { snsStringToSign } from '../webhooks.js'

let mail: TestMail
let baseUrl: string
const TOKEN = 'test-webhook-token'

const post = (provider: string, body: unknown, query = `?token=${TOKEN}`) =>
  fetch(`${baseUrl}/api/mail/webhooks/${provider}${query}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

/** The same request Amazon SNS makes: JSON, labelled `text/plain`. */
const postAsSns = (provider: string, body: unknown, query = `?token=${TOKEN}`) =>
  fetch(`${baseUrl}/api/mail/webhooks/${provider}${query}`, {
    method: 'POST',
    headers: { 'content-type': 'text/plain; charset=UTF-8' },
    body: JSON.stringify(body),
  })

/**
 * Every read and write here binds `'*'`, the instance-wide binding `mod_mail`'s row-level policies
 * admit — the same one the webhook handler uses, because a provider reports on every workspace's
 * mail at once. Against a module version from before the policies the binding is inert.
 */
const ALL_WORKSPACES = '*'
const allWorkspaces = <T>(fn: (tx: Tx) => Promise<T>) =>
  mail.kernel.database.withWorkspace(ALL_WORKSPACES, fn)

/** A delivery row already marked sent, as it would be after the provider accepted it. */
async function sentDelivery(to: string, providerMessageId: string) {
  const [row] = await allWorkspaces((tx) =>
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
  allWorkspaces((tx) => tx.select().from(deliveries).where(eq(deliveries.id, id)).limit(1)).then((r) => r[0]!)

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

  /**
   * Refusing every webhook is right and silent: the provider's dashboard shows a failing endpoint and
   * Kern shows a healthy service. An operator finds it in the log line at boot or not at all, so the
   * service says so where they already look.
   */
  it('says so in the health output, not only in a log line at boot', async () => {
    const res = await fetch(`${url}/api/health`)
    expect(res.status).toBe(200)
    const health = (await res.json()) as { ok: boolean; warnings: string[] }
    expect(health.ok).toBe(true)
    expect(health.warnings).toHaveLength(1)
    expect(health.warnings[0]).toContain('MAIL_WEBHOOK_TOKEN')
    expect(health.warnings[0]).toContain('/api/mail/webhooks/*')
  })
})

describe('health', () => {
  it('reports no warnings when the service is configured', async () => {
    const res = await fetch(`${baseUrl}/api/health`)
    expect(res.status).toBe(200)
    expect((await res.json()) as Record<string, unknown>).toMatchObject({
      ok: true,
      service: 'mail',
      warnings: [],
    })
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
      // the China partition is allowed, so its suffix is worth a hostile case of its own
      'https://sns.cn-north-1.amazonaws.com.cn.attacker.example/?Action=ConfirmSubscription',
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

  /**
   * SNS in Beijing and Ningxia answers on `amazonaws.com.cn`, which a pattern anchored on `.com`
   * refuses — so an instance in that partition could never confirm a subscription. The URL is
   * accepted now; the request still stops at the signature, which is what the message proves.
   */
  it('accepts the China partition’s host and still demands a signature', async () => {
    const res = await post(
      'ses',
      confirmation('https://sns.cn-north-1.amazonaws.com.cn/?Action=ConfirmSubscription', {
        SigningCertURL: 'https://sns.cn-north-1.amazonaws.com.cn/SimpleNotificationService-abc.pem',
      }),
    )
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ code: 'BAD_REQUEST', message: 'SNS signature did not verify' })
  })
})

/**
 * Amazon SNS posts JSON labelled `Content-Type: text/plain`, and Fastify's built-in text/plain parser
 * hands the handler the raw string — so `body.Type` was undefined, every branch missed, and an SES
 * bounce was answered `200 {"ok":true,"ignored":true}` with nothing written. Signature verification
 * sat behind the same `body.Type` and had therefore never run against a real SNS request.
 *
 * Only Amazon can serve the genuine signing certificate, so these tests generate one and answer the
 * single fetch the route makes for it. Everything else — the parse, the envelope, the signature, the
 * delivery row — is the real path.
 */
describe('an SNS notification posted as text/plain', () => {
  const CERT_URL = 'https://sns.eu-west-1.amazonaws.com/SimpleNotificationService-textplain.pem'
  let certificate: string
  let privateKey: KeyObject
  let restoreFetch: () => void

  /** A throwaway self-signed certificate: `X509Certificate` parses only a real one. */
  function selfSigned(): { certificate: string; privateKey: KeyObject } {
    const dir = mkdtempSync(join(tmpdir(), 'kern-sns-'))
    try {
      execFileSync(
        'openssl',
        // biome-ignore format: one switch per line is unreadable
        ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
          '-subj', '/CN=sns.eu-west-1.amazonaws.com',
          '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem')],
        { stdio: 'ignore' },
      )
      return {
        certificate: readFileSync(join(dir, 'cert.pem'), 'utf8'),
        privateKey: createPrivateKey(readFileSync(join(dir, 'key.pem'))),
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  /** Signs an envelope the way SNS does, over the canonical string the verifier rebuilds. */
  const sign = (body: Record<string, unknown>) => {
    const stringToSign = snsStringToSign(body)
    if (!stringToSign) throw new Error('fixture is not a signable SNS envelope')
    return {
      ...body,
      Signature: createSign('RSA-SHA256').update(stringToSign, 'utf8').sign(privateKey, 'base64'),
    }
  }

  const notification = (message: unknown) =>
    sign({
      Type: 'Notification',
      MessageId: `m-${Date.now()}`,
      TopicArn: 'arn:aws:sns:eu-west-1:123456789012:kern-mail',
      Message: typeof message === 'string' ? message : JSON.stringify(message),
      Timestamp: '2026-09-05T09:00:00.000Z',
      SignatureVersion: '2',
      SigningCertURL: CERT_URL,
    })

  beforeAll(() => {
    ;({ certificate, privateKey } = selfSigned())
    const real = globalThis.fetch
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const url = input instanceof Request ? input.url : String(input)
      if (url === CERT_URL) return Promise.resolve(new Response(certificate, { status: 200 }))
      return real(input, init)
    })
    restoreFetch = () => spy.mockRestore()
  })
  afterAll(() => restoreFetch?.())

  it('parses the body, verifies the signature and records the bounce', async () => {
    const to = recipient('ses-text-plain')
    const row = await sentDelivery(to, `ses-tp-${Date.now()}`)

    const res = await postAsSns(
      'ses',
      notification({
        notificationType: 'Bounce',
        bounce: {
          bounceType: 'Permanent',
          bouncedRecipients: [{ emailAddress: to, diagnosticCode: '550 no such mailbox' }],
        },
        mail: { messageId: row.providerMessageId, destination: [to] },
      }),
    )
    expect(res.status).toBe(200)
    // before the parser existed this was `{ ok: true, ignored: true }` and the row stayed sent
    expect(await res.json()).toEqual({ ok: true })
    const updated = await reload(row.id)
    expect(updated.status).toBe('bounced')
    expect(updated.error).toBe('550 no such mailbox')
    expect([...(await loadSuppressed(mail.kernel, mail.workspaceId, [to]))]).toEqual([to.toLowerCase()])
  })

  it('refuses a text/plain notification whose signature does not cover the body', async () => {
    const to = recipient('ses-text-plain-forged')
    const row = await sentDelivery(to, `ses-tpf-${Date.now()}`)
    const signed = notification({ notificationType: 'Delivery', mail: { messageId: 'something else' } })

    // the envelope is signed, then the payload is swapped — exactly what the signature exists to catch
    const forged = {
      ...signed,
      Message: JSON.stringify({
        notificationType: 'Bounce',
        bounce: { bounceType: 'Permanent', bouncedRecipients: [{ emailAddress: to }] },
        mail: { messageId: row.providerMessageId, destination: [to] },
      }),
    }
    const res = await postAsSns('ses', forged)
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ code: 'BAD_REQUEST', message: 'SNS signature did not verify' })
    expect((await reload(row.id)).status).toBe('sent')
    expect([...(await loadSuppressed(mail.kernel, mail.workspaceId, [to]))]).toEqual([])
  })

  /**
   * The webhook scope replaces its own content type parsers, so this checks the module's oRPC routes
   * still read theirs.
   *
   * It authenticates first, on purpose. An anonymous call is refused before the body is looked at,
   * so it answers 401 whether the body arrived or not — the version of this test that did that
   * passed even with the parsers deliberately mounted on the root instance, and therefore guarded
   * nothing. Asking as a service principal makes the answer depend on the body's contents.
   */
  it('leaves the module’s own routes reading their own bodies', async () => {
    const serviceToken = await mail.kernel.auth.signService('webhook-parser-test')
    const ask = (body: unknown) =>
      fetch(`${baseUrl}/api/mail/rpc/settings/get`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-kern-service': serviceToken },
        body: JSON.stringify(body),
      })

    const withId = await ask({ json: { workspaceId: mail.workspaceId } })
    expect(withId.status).toBe(200)

    // The same call minus one field the body carries: a different answer is what proves the route
    // read the body rather than being handed nothing.
    const withoutId = await ask({ json: {} })
    expect(withoutId.status).toBe(400)
    expect((await withoutId.json()) as { json: { code: string } }).toMatchObject({
      json: { code: 'BAD_REQUEST' },
    })
  })

  it('acknowledges an unsubscribe confirmation instead of reading it as an SES event', async () => {
    const res = await postAsSns('ses', {
      Type: 'UnsubscribeConfirmation',
      MessageId: 'm-unsub',
      Token: 'a-token',
      TopicArn: 'arn:aws:sns:eu-west-1:123456789012:kern-mail',
      Message: 'You have chosen to deactivate the subscription.',
      SubscribeURL: 'https://sns.eu-west-1.amazonaws.com/?Action=ConfirmSubscription',
      Timestamp: '2026-09-05T09:00:00.000Z',
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, ignored: true })
  })
})

/** A body the service cannot read is the caller's mistake, and used to be reported as ours. */
describe('a body that is not a readable SES event', () => {
  it('answers 400 rather than 500 when Message is not JSON', async () => {
    for (const message of ['not json at all', '"a string"', 'null', '[1,2,3]']) {
      const res = await post('ses', { Message: message })
      expect([message, res.status]).toEqual([message, 400])
      expect(await res.json()).toEqual({
        code: 'BAD_REQUEST',
        message: 'The SES event could not be read from Message',
      })
    }
  })

  it('answers 400 when the body itself is not a JSON object', async () => {
    for (const raw of ['', 'not json at all', '"a string"', '[1,2,3]', 'null']) {
      const res = await fetch(`${baseUrl}/api/mail/webhooks/postmark?token=${TOKEN}`, {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: raw,
      })
      expect([raw, res.status]).toEqual([raw, 400])
      expect(await res.json()).toEqual({ code: 'BAD_REQUEST', message: 'Body is not a JSON object' })
    }
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
    const [suppression] = await allWorkspaces((tx) =>
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
