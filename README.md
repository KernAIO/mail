# mail

**Email leaving Kern, and replies coming back.**

Every message [Kern](https://github.com/KernAIO/kern) sends goes through this service — the sign-in
link, the invitation, the digest, the notification a module raised. One queue, one delivery log, one
suppression list, so a bounce is visible wherever it happened.

Each workspace can send through its own provider. A workspace that has not configured one uses the
instance's, so a fresh install works with no setup at all.

## Run it

Goal: start mail on your own machine and send a message you can read back.

You need:

- Node 24 and pnpm 10.
- A Postgres 18 database.
- An SMTP server. [Mailpit](https://mailpit.axllent.org/) is ideal for development.

Most people should run the whole platform from the
[umbrella repository](https://github.com/KernAIO/kern) instead. There, `pnpm setup && pnpm infra &&
pnpm dev` starts mail with Mailpit beside it.

### 1. Install and configure

```bash
pnpm install
cp .env.example .env
```

Set `DATABASE_URL` and `SMTP_URL` in `.env`.

### 2. Start mail

```bash
pnpm dev
```

The service creates its own database tables the first time it starts.

**Expected result:** `migrations applied`, then the service listens on port 4200.

### 3. Watch a message arrive

If you are running Mailpit, open http://localhost:8025 to read everything the service sends.

**Expected result:** messages appear in Mailpit as Kern sends them.

## Providers

| Provider | Configured with |
|---|---|
| SMTP | A host, a port and credentials |
| Mailgun | An API key and a domain |
| Amazon SES | An access key pair and a region |
| Postmark | A server token |
| Resend | An API key |

A workspace sets its provider in workspace settings. Secrets are encrypted before they are stored. A read
returns a placeholder instead of the real value. Writing that placeholder back keeps the stored
secret unchanged.

## Things worth knowing

- **A delivery is a row, not a hope.** Every message is queued, retried on failure and recorded with
  what the provider said. A bounce adds the address to the suppression list, and nothing is sent to a
  suppressed address again.
- **Provider webhooks authenticate with `MAIL_WEBHOOK_TOKEN`**, not a Kern session, because a
  provider has none.
- **Deliveries are not row-level secured.** Instance mail belongs to no workspace, so the column is
  nullable and access is filtered in the API instead. The reason is written into the module's own
  `migrations/0001_notes.sql`, in the [modules repository](https://github.com/KernAIO/modules).
- The personal mail inbox — reading your own IMAP account inside Kern — is **not built yet**. The
  interfaces are sketched in `src/inbox/`.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) and [CLAUDE.md](CLAUDE.md). Licence: [AGPL-3.0](LICENSE).

Website: [kernaio.com](https://kernaio.com).
