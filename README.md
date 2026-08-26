<p align="center">
<img src="https://raw.githubusercontent.com/KernAIO/app/main/assets/kern-mark.svg" width="56" alt="">
</p>

# mail

**Email leaving Kern, and replies coming back.**

[![CI](https://img.shields.io/github/actions/workflow/status/KernAIO/mail/ci.yml?branch=main&label=CI&style=flat-square)](https://github.com/KernAIO/mail/actions/workflows/ci.yml)
[![Licence](https://img.shields.io/badge/licence-AGPL--3.0-blue?style=flat-square)](LICENSE)
[![Status](https://img.shields.io/badge/status-pre--1.0-orange?style=flat-square)](https://github.com/KernAIO/app#what-works-today)
[![Last commit](https://img.shields.io/github/last-commit/KernAIO/mail?style=flat-square)](https://github.com/KernAIO/mail/commits/main)
[![Website](https://img.shields.io/badge/kernaio.com-1f2328?style=flat-square)](https://kernaio.com)

Every message [Kern](https://github.com/KernAIO/app) sends goes through this service — the sign-in
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
[umbrella repository](https://github.com/KernAIO/app) instead. There, `pnpm setup && pnpm infra &&
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

Read [CONTRIBUTING.md](CONTRIBUTING.md) and [CLAUDE.md](CLAUDE.md).

## Licence

[AGPL-3.0-only](LICENSE). This repository is part of the Kern product.
The Kern framework you build modules against is Apache-2.0 — see
[LICENSING.md](https://github.com/KernAIO/app/blob/main/LICENSING.md).

---

**Kern** — one place for your team's work: issues, conversations, documents and people.
Open source, self-hosted. [kernaio.com](https://kernaio.com) · [github.com/KernAIO](https://github.com/KernAIO)
