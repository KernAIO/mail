/**
 * Provider webhooks. Each provider reports deliveries, bounces and complaints in its own shape; they are
 * normalised here into a delivery status update plus, for hard failures, a suppression entry so later
 * sends skip the address.
 */

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

/**
 * The binding `mod_mail`'s row-level policies admit for instance-wide work. Written here rather
 * than imported so this service builds against a module version from before the policies existed
 * as well as after: with no policy the binding is inert, with one it is what lets a webhook find a
 * delivery it knows only by the provider's id.
 */
const ALL_WORKSPACES = '*'

function normalise(provider: string, body: Record<string, any>): Normalised {
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
      const message = typeof body.Message === 'string' ? JSON.parse(body.Message) : (body.Message ?? body)
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

export function mountWebhooks(app: FastifyInstance, kernel: Kernel, env: MailEnv): void {
  app.post<{ Params: { provider: string }; Querystring: { token?: string } }>(
    '/api/mail/webhooks/:provider',
    async (req, reply) => {
      const provider = req.params.provider
      if (!PROVIDERS.includes(provider as (typeof PROVIDERS)[number])) {
        return reply.status(404).send({ code: 'NOT_FOUND', message: 'Unknown provider' })
      }
      // Providers cannot present a Kern session, so webhook URLs carry a shared secret instead.
      if (env.MAIL_WEBHOOK_TOKEN) {
        const presented = req.query.token ?? req.headers['x-kern-webhook-token']
        if (presented !== env.MAIL_WEBHOOK_TOKEN) {
          return reply.status(401).send({ code: 'UNAUTHORIZED', message: 'Invalid webhook token' })
        }
      }
      const body = (req.body ?? {}) as Record<string, any>
      // SES subscription confirmation
      if (body.Type === 'SubscriptionConfirmation' && typeof body.SubscribeURL === 'string') {
        await fetch(body.SubscribeURL).catch(() => {})
        return { ok: true, confirmed: true }
      }

      const n = normalise(provider, body)
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
}
