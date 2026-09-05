/**
 * Provider webhooks. Each provider reports deliveries, bounces and complaints in its own shape; they are
 * normalised here into a delivery status update plus, for hard failures, a suppression entry so later
 * sends skip the address.
 */

import { createHash, createVerify, type KeyObject, timingSafeEqual, X509Certificate } from 'node:crypto'
import type { Kernel } from '@kernhq/kernel'
import { addSuppression, deliveries, emitDeliveryEvent, mailEvents } from '@kernhq/module-mail/server'
import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import type { MailEnv } from './env.js'

type Normalised = {
  providerMessageId: string | null
  recipient: string | null
  event: 'delivered' | 'bounced' | 'complained' | 'failed' | 'ignored'
  reason: string | null
}

const asString = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)

/** A plain JSON object, or `null` for anything else — an array and `null` included. */
const asObject = (v: unknown): Record<string, any> | null =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, any>) : null

/**
 * The SES event itself. SNS wraps it as a **string** in `Message`, so reading it means parsing JSON
 * out of a request body — and a body that does not parse used to throw a `SyntaxError` out of the
 * handler, which the error handler answers 500 to. It is the caller's mistake, not the service's, so
 * this returns `null` and the route answers 400.
 */
function sesMessage(body: Record<string, any>): Record<string, any> | null {
  if (typeof body.Message !== 'string') return asObject(body.Message) ?? asObject(body)
  try {
    return asObject(JSON.parse(body.Message))
  } catch {
    return null
  }
}

/**
 * The binding `mod_mail`'s row-level policies admit for instance-wide work. Written here rather
 * than imported so this service builds against a module version from before the policies existed
 * as well as after: with no policy the binding is inert, with one it is what lets a webhook find a
 * delivery it knows only by the provider's id.
 */
const ALL_WORKSPACES = '*'

/** The event this body reports, or `null` when the body is not readable and the route must answer 400. */
function normalise(provider: string, body: Record<string, any>): Normalised | null {
  switch (provider) {
    case 'mailgun': {
      const e = body['event-data'] ?? {}
      const kind = asString(e.event)
      return {
        providerMessageId: asString(e.message?.headers?.['message-id']),
        recipient: asString(e.recipient),
        event:
          kind === 'delivered'
            ? 'delivered'
            : kind === 'failed'
              ? e.severity === 'permanent'
                ? 'bounced'
                : 'failed'
              : kind === 'complained'
                ? 'complained'
                : 'ignored',
        reason: asString(e['delivery-status']?.message) ?? asString(e.reason),
      }
    }
    case 'postmark': {
      const type = asString(body.RecordType)
      return {
        providerMessageId: asString(body.MessageID),
        recipient: asString(body.Email) ?? asString(body.Recipient),
        event:
          type === 'Delivery'
            ? 'delivered'
            : type === 'Bounce'
              ? body.Type === 'SoftBounce'
                ? 'failed'
                : 'bounced'
              : type === 'SpamComplaint'
                ? 'complained'
                : 'ignored',
        reason: asString(body.Description) ?? asString(body.Details),
      }
    }
    case 'ses': {
      const message = sesMessage(body)
      if (!message) return null
      const type = asString(message.notificationType ?? message.eventType)
      const recipient =
        asString(message.bounce?.bouncedRecipients?.[0]?.emailAddress) ??
        asString(message.complaint?.complainedRecipients?.[0]?.emailAddress) ??
        asString(message.mail?.destination?.[0])
      return {
        providerMessageId: asString(message.mail?.messageId),
        recipient,
        event:
          type === 'Delivery'
            ? 'delivered'
            : type === 'Bounce'
              ? message.bounce?.bounceType === 'Transient'
                ? 'failed'
                : 'bounced'
              : type === 'Complaint'
                ? 'complained'
                : 'ignored',
        reason: asString(message.bounce?.bouncedRecipients?.[0]?.diagnosticCode),
      }
    }
    case 'resend': {
      const type = asString(body.type)
      return {
        providerMessageId: asString(body.data?.email_id),
        recipient: asString(body.data?.to?.[0]),
        event:
          type === 'email.delivered'
            ? 'delivered'
            : type === 'email.bounced'
              ? 'bounced'
              : type === 'email.complained'
                ? 'complained'
                : 'ignored',
        reason: asString(body.data?.reason),
      }
    }
    default:
      return { providerMessageId: null, recipient: null, event: 'ignored', reason: null }
  }
}

const PROVIDERS = ['mailgun', 'postmark', 'ses', 'resend'] as const

/**
 * Compares a presented secret with the configured one in time that does not depend on how much of
 * it is right. Both sides are hashed first so the comparison is over two equal-length digests and
 * the length of the secret leaks no more than the digest does.
 */
function secretsMatch(presented: string, expected: string): boolean {
  const a = createHash('sha256').update(presented).digest()
  const b = createHash('sha256').update(expected).digest()
  return timingSafeEqual(a, b)
}

/**
 * Amazon SNS carries SES events, and confirming a subscription means this service fetches a URL the
 * *caller* chose — a request made from inside the private network, where a link-local metadata
 * address answers. So every URL taken out of a webhook body has to be an SNS endpoint over TLS
 * before anything leaves the process, and that is the only reason this regexp exists.
 *
 * The `.cn` suffix is the China partition — `sns.cn-north-1.amazonaws.com.cn` — which is Amazon's
 * own domain there and was refused by an earlier pattern anchored on `.com`. The two air-gapped
 * partitions (`c2s.ic.gov`, `sc2s.sgov.gov`) are deliberately **not** here: an instance that can
 * reach them is not an instance that reached this code from the public internet, and widening an
 * allowlist for a network nobody here can test against is how an allowlist stops meaning anything.
 * An operator in one of those partitions has to change this line, and should.
 */
const SNS_HOST = /^sns\.[a-z0-9-]+\.amazonaws\.com(\.cn)?$/

/** The URL when it is an Amazon SNS endpoint we may call, `null` for anything else. */
function snsUrl(raw: unknown): URL | null {
  if (typeof raw !== 'string' || !raw) return null
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  // `https://sns.eu-west-1.amazonaws.com@attacker.example/` parses with hostname `attacker.example`,
  // so the host test below already refuses it; credentials and a port are refused on their own
  // because a genuine SNS URL carries neither.
  if (url.protocol !== 'https:' || url.port !== '' || url.username || url.password) return null
  return SNS_HOST.test(url.hostname) ? url : null
}

/** The fields SNS signs, in the order it signs them. `Subject` is present only on some notifications. */
const SNS_SIGNED_FIELDS: Record<string, readonly string[]> = {
  Notification: ['Message', 'MessageId', 'Subject', 'Timestamp', 'TopicArn', 'Type'],
  SubscriptionConfirmation: [
    'Message',
    'MessageId',
    'SubscribeURL',
    'Timestamp',
    'Token',
    'TopicArn',
    'Type',
  ],
  UnsubscribeConfirmation: ['Message', 'MessageId', 'SubscribeURL', 'Timestamp', 'Token', 'TopicArn', 'Type'],
}

/** The canonical string SNS signed, or `null` when the body is not a signable SNS envelope. */
export function snsStringToSign(body: Record<string, unknown>): string | null {
  const fields = SNS_SIGNED_FIELDS[typeof body.Type === 'string' ? body.Type : '']
  if (!fields) return null
  let out = ''
  for (const key of fields) {
    const value = body[key]
    if (typeof value !== 'string') {
      // `Subject` is the one field SNS omits when it is absent; anything else missing means this is
      // not the envelope it claims to be.
      if (key === 'Subject') continue
      return null
    }
    out += `${key}\n${value}\n`
  }
  return out
}

/**
 * Verifies the RSA signature SNS puts on every message against the public key of its signing
 * certificate. Exported so it can be tested with a locally generated key: the certificate itself can
 * only be fetched from Amazon.
 */
export function verifySnsSignature(body: Record<string, unknown>, publicKey: KeyObject | string): boolean {
  const stringToSign = snsStringToSign(body)
  if (!stringToSign) return false
  const version = typeof body.SignatureVersion === 'string' ? body.SignatureVersion : '1'
  const algorithm = version === '2' ? 'RSA-SHA256' : version === '1' ? 'RSA-SHA1' : null
  if (!algorithm) return false
  if (typeof body.Signature !== 'string' || !body.Signature) return false
  try {
    return createVerify(algorithm).update(stringToSign, 'utf8').verify(publicKey, body.Signature, 'base64')
  } catch {
    return false
  }
}

/** Signing certificates, keyed by URL. SNS rotates them rarely and reuses one across many messages. */
const snsKeys = new Map<string, KeyObject>()

/** The public key of an SNS signing certificate, or `null` if the URL or the certificate is not one. */
async function snsPublicKey(rawUrl: unknown): Promise<KeyObject | null> {
  const url = snsUrl(rawUrl)
  if (!url) return null
  const cached = snsKeys.get(url.href)
  if (cached) return cached
  try {
    const res = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(5_000) })
    if (!res.ok) return null
    const key = new X509Certificate(await res.text()).publicKey
    // A caller picks the URL, so the cache is capped rather than left to grow.
    if (snsKeys.size >= 16) snsKeys.clear()
    snsKeys.set(url.href, key)
    return key
  } catch {
    return null
  }
}

/**
 * Reads a request body as JSON whatever the provider labelled it.
 *
 * A body that does not parse is handed back **as the string it was**, rather than raised as a parser
 * error: the route then answers it in the same shape as every other refusal here, instead of leaving
 * Fastify to invent one.
 */
function parseJsonBody(_req: unknown, raw: string, done: (err: Error | null, body?: unknown) => void): void {
  try {
    done(null, JSON.parse(raw))
  } catch {
    done(null, raw)
  }
}

export async function mountWebhooks(app: FastifyInstance, kernel: Kernel, env: MailEnv): Promise<void> {
  const configuredToken = env.MAIL_WEBHOOK_TOKEN
  if (!configuredToken) {
    kernel.log.warn(
      'MAIL_WEBHOOK_TOKEN is not set, so provider webhooks refuse every request. Set it and register the webhook URL with ?token=<the same value>.',
    )
  }
  /*
   * The route lives in its own encapsulated scope so it can parse a `text/plain` body as JSON.
   *
   * Amazon SNS posts `Content-Type: text/plain` — JSON with the wrong label — and Fastify's built-in
   * text/plain parser hands the handler the raw **string**. `body.Type` was therefore undefined, the
   * SNS branches never ran, `normalise` read nothing, and every SES bounce and complaint was
   * answered `200 {"ok":true,"ignored":true}` while nothing was recorded. Signature verification sat
   * behind the same `body.Type` and had never once executed.
   *
   * `app.register` is what keeps this to this route: content type parsers are encapsulated, so
   * replacing them here changes nothing for the oRPC routes beside it — a parser added on `app`
   * itself would replace theirs and every request body in the service would arrive as `undefined`.
   */
  await app.register(async (scope) => {
    scope.removeAllContentTypeParsers()
    for (const contentType of ['application/json', 'text/plain'])
      scope.addContentTypeParser(contentType, { parseAs: 'string' }, parseJsonBody)
    scope.post<{ Params: { provider: string }; Querystring: { token?: string } }>(
      '/api/mail/webhooks/:provider',
      async (req, reply) => {
        // Providers cannot present a Kern session, so webhook URLs carry a shared secret instead. With
        // no secret configured there is nothing anyone could prove, so every request is refused: this
        // endpoint writes suppressions, and a suppression a stranger wrote silently stops that
        // person's password resets, magic links and invitations for good.
        if (!configuredToken) {
          return reply
            .status(401)
            .send({ code: 'UNAUTHORIZED', message: 'Provider webhooks are not configured' })
        }
        const header = req.headers['x-kern-webhook-token']
        const presented = req.query.token ?? (Array.isArray(header) ? header[0] : header)
        if (typeof presented !== 'string' || !secretsMatch(presented, configuredToken)) {
          return reply.status(401).send({ code: 'UNAUTHORIZED', message: 'Invalid webhook token' })
        }

        const provider = req.params.provider
        if (!PROVIDERS.includes(provider as (typeof PROVIDERS)[number])) {
          return reply.status(404).send({ code: 'NOT_FOUND', message: 'Unknown provider' })
        }
        // Everything below reads fields off the body, so it has to be an object. A body that did not
        // parse arrives here as the string it was, and a JSON `null`, number or array as itself.
        const body = asObject(req.body)
        if (!body) {
          return reply.status(400).send({ code: 'BAD_REQUEST', message: 'Body is not a JSON object' })
        }
        const snsType = typeof body.Type === 'string' ? body.Type : null

        // An SNS envelope is signed, and a subscription confirmation makes this service fetch a URL
        // out of the body — so the URL is checked before the signature (nothing leaves the process for
        // a URL we would never call) and the signature before the fetch.
        if (snsType === 'SubscriptionConfirmation') {
          const subscribeUrl = snsUrl(body.SubscribeURL)
          if (!subscribeUrl) {
            kernel.log.warn(
              { provider },
              'refused an SNS confirmation whose SubscribeURL is not an SNS endpoint',
            )
            return reply
              .status(400)
              .send({ code: 'BAD_REQUEST', message: 'SubscribeURL is not an Amazon SNS endpoint' })
          }
          const key = await snsPublicKey(body.SigningCertURL)
          if (!key || !verifySnsSignature(body, key)) {
            return reply.status(400).send({ code: 'BAD_REQUEST', message: 'SNS signature did not verify' })
          }
          await fetch(subscribeUrl, { redirect: 'error', signal: AbortSignal.timeout(10_000) }).catch(
            () => {},
          )
          return { ok: true, confirmed: true }
        }
        // SNS says so in plain English when a subscription is removed, and there is nothing to do about
        // it here. Acknowledge it rather than letting it fall through to the SES reader, which would
        // answer 400 to a message Amazon considers perfectly well formed.
        if (snsType === 'UnsubscribeConfirmation') return { ok: true, ignored: true }
        // A notification that presents a signature has to have a real one. One that presents none is a
        // provider posting its own shape (Postmark, Mailgun, Resend) and is held up by the token alone.
        if (snsType === 'Notification' && body.Signature !== undefined) {
          const key = await snsPublicKey(body.SigningCertURL)
          if (!key || !verifySnsSignature(body, key)) {
            return reply.status(400).send({ code: 'BAD_REQUEST', message: 'SNS signature did not verify' })
          }
        }

        const n = normalise(provider, body)
        if (!n) {
          return reply
            .status(400)
            .send({ code: 'BAD_REQUEST', message: 'The SES event could not be read from Message' })
        }
        if (n.event === 'ignored') return { ok: true, ignored: true }

        // A provider reports on every workspace's mail at once, so this binds every workspace: the
        // module's row-level policies admit `'*'` and refuse a transaction that binds nothing.
        const row = n.providerMessageId
          ? (
              await kernel.database.withWorkspace(ALL_WORKSPACES, (tx) =>
                tx
                  .select()
                  .from(deliveries)
                  .where(eq(deliveries.providerMessageId, n.providerMessageId as string))
                  .limit(1),
              )
            )[0]
          : undefined

        if (row) {
          const status = n.event === 'delivered' ? 'sent' : n.event === 'bounced' ? 'bounced' : 'failed'
          await kernel.database.withWorkspace(ALL_WORKSPACES, (tx) =>
            tx
              .update(deliveries)
              .set({ status, error: n.reason, updatedAt: new Date() })
              .where(eq(deliveries.id, row.id)),
          )
          if (n.event !== 'delivered') {
            await emitDeliveryEvent(
              kernel,
              n.event === 'bounced' ? mailEvents.deliveryBounced : mailEvents.deliveryFailed,
              { id: row.id, workspaceId: row.workspaceId, to: row.to },
              { error: n.reason ?? undefined },
            )
          }
        }
        if (n.recipient && (n.event === 'bounced' || n.event === 'complained')) {
          await addSuppression(kernel, {
            workspaceId: row?.workspaceId ?? null,
            email: n.recipient,
            reason: n.event === 'complained' ? 'complaint' : 'bounce',
            source: provider,
          })
        }
        kernel.log.info({ provider, event: n.event, recipient: n.recipient }, 'mail webhook')
        return { ok: true }
      },
    )
  })
}
