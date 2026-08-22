# Kern mail service

Outbound email for the whole platform, and the future home of the personal IMAP inbox.
Part of [Kern](https://github.com/KernAIO/kern).

Every message — account emails from core, notification digests, module notifications — is queued
through `kernel.call('mail.send', …)`, so retries, suppression lists and the delivery log behave the
same regardless of the sender.

## Providers

Each workspace configures its own provider under Settings → Mail; without one, the instance's
`SMTP_URL` is used, so a self-hosted install works out of the box.

| provider | configuration | delivery feedback |
|---|---|---|
| SMTP | host, port, TLS, credentials | none (SMTP is fire-and-forget) |
| Mailgun | API key, domain, region | webhook |
| Amazon SES | access key, secret, region | SNS webhook |
| Postmark | server token | webhook |
| Resend | API key | webhook |

Secrets are encrypted at rest and never returned by the API — reads replace them with a placeholder,
and writing the placeholder back keeps the stored value.

Webhooks are mounted at `/api/mail/webhooks/<provider>`. Set `MAIL_WEBHOOK_TOKEN` and append
`?token=…` to the URL you register with the provider; bounces and complaints update the delivery and
add a suppression so later sends skip the address.

## Templates

MJML templates in the module (`invitation`, `magic-link`, `verify-email`, `reset-password`,
`notification-digest`, `test`) render to HTML with a plain-text fallback. Preview one with
`kernel.call('mail.render', { name, data })`.

## Development

```bash
pnpm dev   # http://localhost:4200, health at /api/health
```

Requires Postgres, NATS and the core service; `pnpm infra` in the umbrella repo starts the
dependencies, and Mailpit (http://localhost:8025) receives everything sent in development.

The personal IMAP/SMTP inbox is planned next — see `src/inbox/README.md`.
