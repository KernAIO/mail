# CLAUDE.md — Kern project rules

Rules for anyone (human or AI agent) working on Kern repositories. These apply to every repo in the KernAIO org.

## We build in the open
The repositories are **public**, so every commit is visible the moment it is pushed:
- Never commit secrets, tokens, personal data, or machine-specific paths. Use `.env` (gitignored) + `.env.example`.
- Write READMEs, docs, and issue/PR text for external contributors, not for ourselves.
- Keep commit history clean and meaningful — it is part of what people judge the project by.
- Every repo carries LICENSE, CLA.md, CODE_OF_CONDUCT.md, SECURITY.md, CONTRIBUTING.md.
- **Two licences, split at the framework boundary.** The `kernel` repo and `modules`'
  `_template` + `workflow` are **Apache-2.0** so anyone can write a closed module; the product —
  `shell`, `core`, `chat`, `mail`, `collab`, `docs`, this umbrella, the first-party modules — is
  **AGPL-3.0-only**. A new package inherits its repo's licence unless it is something a third-party
  module must import, and then it is Apache-2.0 with its own LICENSE file. Apache-2.0 packages take
  only permissive dependencies. If a module author has to import an AGPL package to get something
  done, move the API — never the licence. See `LICENSING.md` and
  `docs/adr/0005-licensing-and-the-module-boundary.md`.

## Git
- Author identity: `Navid Mirzaaghazadeh <mirzaaghazadeh@icloud.com>` (already set in each repo's local git config — plain `git commit` is correct; do not override with `-c`).
- **Do not add `Claude-Session:`, `Co-Authored-By: Claude`, "Generated with", or any AI trailer/branding to commit messages, PRs, or code comments.**
- Conventional Commits (`feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`, with optional scope). Imperative mood, ≤ 72-char subject.
- Push to `origin main`. Never force-push. If `git pull --rebase` complains about unstaged files that aren't yours (parallel agents share worktrees), use `git -c rebase.autoStash=true pull --rebase`.
- **Never `git add -A` or `git add .`. Stage the paths you changed, by name.** Several agents share
  these checkouts, and another one is very often part-way through a new package in the same repo.
  `git add -A` sweeps their half-finished files into your commit and pushes them — under your commit
  message, without their lockfile entry, so CI fails at install for everyone. It happened on
  2026-08-24: a contact-address fix carried two unfinished modules into `main`. Run
  `git status --porcelain` first and stage from it; if you cannot name every path you are about to
  commit, you are not ready to commit. When it does happen, do not revert the other agent's files —
  they are still working on them; tell them instead, and repair what you broke.

## Layout & workflow
- Umbrella dev workspace: `app/` with sibling repos cloned under `app/repos/<name>` (gitignored there). pnpm links all `@kernhq/*` packages via the umbrella workspace.
- Install dependencies ONLY via `app/scripts/pnpm-install-locked.sh` (serialises pnpm at the umbrella root).
- Node 24 (`nvm use 24`), pnpm 10, TypeScript ~5.9, ESM/NodeNext, Biome for lint+format (run `pnpm exec biome check --write <paths>` before committing), Vitest.
- Contracts first: changes to `@kernhq/contracts` / module contracts land (and build) before their consumers.
- Modules own their data: Postgres schema `mod_<id>`, `workspace_id` + RLS on every tenant table, cross-module access only via `kernel.call()` and events. See `modules` repo `packages/_template`.
- Ports: shell 5173 · core 4000 · chat 4100 · mail 4200 · collab 4300 · docs 4400.
- Dev DB on this machine: Homebrew Postgres 18 at `localhost:5432` (`kern`/`kern`); the compose Postgres listens on `${KERN_PG_PORT:-5432}` (5433 here).

## CI
Every service repository's CI runs the real suites, so the workflow starts the infrastructure they
need as service containers: Postgres (`pgvector/pgvector:pg18`) everywhere, Valkey for `chat`,
Mailpit for `mail`. Things learned the hard way:
- Address a service container as **127.0.0.1**, never `localhost` — a runner resolves `localhost` to
  `::1` first, where the published port is not listening, and `fetch` does not retry over IPv4.
- Do not set `registry-url` on `actions/setup-node` in an install job. It writes an `.npmrc` with a
  placeholder token, and npm answers a bad token with **404**, so public packages appear to vanish.
- A repository is built **standalone** in CI. `workspace:*` only resolves inside the umbrella
  workspace; depend on the published version instead.
- **Each repository's own `pnpm-lock.yaml` is what CI installs from, and you cannot refresh it from
  inside the umbrella.** Add a dependency to a package and the umbrella install updates the *umbrella*
  lockfile, leaving the repo's committed one stale — CI then fails every job at
  `ERR_PNPM_OUTDATED_LOCKFILE`, install-time, before a single test runs. Plain `pnpm install` in
  `repos/<name>` walks up and attaches to the umbrella; `--ignore-workspace` skips `packages/*` and
  cheerfully reports nothing to do. Clone the repo somewhere outside the workspace and run
  `pnpm install --lockfile-only` there, then copy the lockfile back.
- Skipping a test because its infrastructure is missing is fine on a laptop and dishonest in CI.
  Fail when `process.env.CI` is set.

## Writing
Documentation — READMEs, guides, runbooks, `docs/`, and any procedure someone follows — uses the
`adhd-friendly-ste-technical-writer` skill in `.claude/skills/`: goal first, one action per step,
short sentences, conditions before commands, an observable result after every important action.
It is a house style inspired by ASD-STE100, not certified compliance — do not claim otherwise.
It governs documents for readers. Code comments and commit messages keep the voice they have.

## Quality bar
- `pnpm typecheck && pnpm lint && pnpm test && pnpm build` must pass before pushing.
- UI follows `shell/DESIGN.md` (Ink/paper design system) and must work in RTL (fa/ar) and dark mode.
- All user-facing strings go through i18n (Paraglide) — no hardcoded English in components.

## Keeping this file current
This file is how the next person — or the next agent — avoids repeating what we already worked out.
When you learn something durable, add it here **in the same commit as the change that taught you**:
- a trap that cost you time (a silent failure, a misleading error, a tool that lies about success)
- a convention you had to infer from reading several files
- a decision and the reason behind it, especially where the obvious choice is wrong
Keep it specific and short. Delete anything that stops being true — a stale note is worse than none.

---

# This repository: mail (outbound email)

Providers, templates, the delivery log and suppression lists. Runs on **:4200**. Every message in the
platform — account email from core, digests, module notifications — is queued through
`kernel.call('mail.send', …)` so retries, suppression and the audit trail behave identically.

**Things worth knowing**
- A workspace configures its own provider (SMTP, Mailgun, SES, Postmark, Resend); without one the
  instance's `SMTP_URL` is used, so a fresh self-host works with no configuration.
- Secrets are encrypted at rest and never returned: reads replace them with a placeholder, and writing
  the placeholder back keeps the stored value. Do not "helpfully" return the real value.
- **A secret that is only checked when it is configured is not a secret.** Provider webhooks
  (`/api/mail/webhooks/<provider>`) authenticate with `MAIL_WEBHOOK_TOKEN`, since a provider cannot
  present a Kern session — and the route used to skip the check entirely when the variable was
  unset, which is what every shipped stack did. So anyone on the internet could `POST` a hard bounce
  for any address and write an **instance-wide** suppression (an unmatched delivery gives
  `workspaceId: null`), stopping that person's password resets, magic links and invitations for
  good. It refuses with 401 when nothing is configured, and compares with `timingSafeEqual` over two
  digests. The variable stays *optional* in the env schema on purpose: an SMTP-only instance has no
  provider to hear from and must still boot, and an existing install never re-reads the
  distribution's `.env.example`, so making it required would take mail down on upgrade for everyone
  who has no use for it. Fail closed at the route, not at boot.
- **A URL out of a request body is an outbound request the caller chose.** The SES branch fetched
  `SubscribeURL` as it was given — a blind SSRF from inside the private network, and
  `http://169.254.169.254/…` is the first thing anyone tries. `SubscribeURL` and `SigningCertURL`
  must both be `https`, no port, no credentials, host matching
  `^sns\.[a-z0-9-]+\.amazonaws\.com(\.cn)?$` — the `.cn` is the China partition, which an earlier
  pattern anchored on `.com` refused, and the two air-gapped partitions are deliberately left out
  because widening an allowlist for a network nobody can test against is how it stops meaning
  anything — and the SNS signature has to verify against the certificate at that URL; `fetch` uses
  `redirect: 'error'` so a 302 cannot walk out of the allowlist. `new URL()` does the hard part —
  `https://sns.eu-west-1.amazonaws.com@attacker.example/` has hostname `attacker.example`.
  Signature verification needs no dependency: `new X509Certificate(pem).publicKey` feeds
  `createVerify('RSA-SHA256'|'RSA-SHA1')`. Only Amazon can serve that certificate, so
  `verifySnsSignature` takes a key and `src/tests/sns-signature.test.ts` hands it a generated one.
- **A webhook the tests reach is not a webhook the provider reaches.** Amazon SNS posts JSON with
  `Content-Type: text/plain`, and Fastify's built-in text/plain parser hands the handler the raw
  *string* — so `body.Type` was undefined, every branch missed, and each SES bounce was answered
  `200 {"ok":true,"ignored":true}` with nothing written. The whole SES path was dead, signature
  verification included: it had never once executed, because it sits behind the same `body.Type`.
  Nothing noticed for as long as it existed, because every test posted `application/json`.
  `webhooks.test.ts` posts the way SNS does now, with a generated signing certificate served to the
  one fetch the route makes. When a provider's shape is only ever exercised by a fixture we wrote,
  send the request the provider sends, headers included.
- **A content type parser on the root instance does not reach the oRPC routes, and a missing parser
  is a 415 — never a body arriving as `undefined`.** This file, `webhooks.ts` and the commit that
  added them all claimed the opposite until 2026-09-05, and it was never true. Measured on Fastify
  5.12.1: a scope's parser set is fixed when the scope is *registered*, so a
  `removeAllContentTypeParsers()` on the root reaches only the root's own routes and scopes
  registered after it. Every oRPC scope is immune twice over — `createHttpServer` gives each one its
  own `'*'` pass-through, and registers it before `extend` runs. Mounting the webhook parsers on
  `app` instead of inside `app.register` was tried: the whole suite stayed green and
  `/api/mail/rpc/settings/get` answered byte for byte the same (`200` for a valid `workspaceId`,
  `400 workspaceId required` without one). Keep the `register` anyway — it bounds the blast radius
  to this route for anything registered later, which is the honest reason to have it. When a parser
  really is absent Fastify answers `415 FST_ERR_CTP_INVALID_MEDIA_TYPE`, loudly.
- **An anonymous oRPC call is refused *after* the body is read, and the correction that said
  otherwise is itself corrected here.** `createHttpServer` hands `req.raw` to oRPC, so oRPC
  deserialises before the procedure's authorisation middleware runs: measured on the booted service,
  `POST /api/mail/rpc/settings/get` with no credential answers **401 with a body and 500 without
  one** — the same 500 a service principal gets — so the refusal is not reached when the body is
  lost. On 2026-09-05 `webhooks.test.ts` asserted the reverse ("refused before the body is looked
  at, so it answers 401 whether the body arrived or not") to justify rewriting the parser guard as a
  service-principal call, and the rewrite's premise fell with it: mounting the webhook parsers on
  the root instance leaves the suite **64/64 with either version**, so neither ever guarded that.
  Keep the service-principal version — an assertion the body's *contents* decide is worth more than
  one its mere presence decides — for that reason and not the stated one. Two things the round also
  got wrong about its own record: `abc5194`'s commit *message* does not carry the hook-order claim
  (the claim was in the code comment that commit added; only `576a0a1`'s message carries the parser
  one), and a correction is a claim like any other — run it before you write it down.
- **`JSON.parse` on a request body is a 500 waiting to happen.** `normalise('ses', …)` parsed
  `Message` unguarded, so a `Message` that is not JSON — or is `null`, a number or an array — threw a
  `SyntaxError` out of the handler and the service reported the caller's mistake as its own. It reads
  the body once, answers 400, and `UnsubscribeConfirmation` is acknowledged before it gets there:
  SNS puts plain English in `Message` for that one, and 400 to a message Amazon considers well formed
  is a delivery failure in their dashboard.
- **`MAIL_WEBHOOK_TOKEN` unset is reported in `GET /api/health`, not only in a log line.** A service
  refusing every webhook is a *healthy* service — the provider's dashboard shows the failing endpoint
  and Kern shows nothing — and nobody reads a container log from three weeks ago. The kernel owns
  `/api/health` and answers it with an object, so `src/health.ts` adds `warnings` to that object in a
  `preSerialization` hook rather than standing up a second endpoint. **The order inside `extend` does
  not matter**, though this file said it did until 2026-09-05: measured on Fastify 5.12.1, a hook
  added on the root instance runs for every route whenever it is added — routes registered before it,
  scopes registered before it, and scopes registered after. Awaiting a `register` does flush
  Fastify's pending plugins, but that settles the plugin's own body, not the instance's hooks. The
  one real deadline is `ready()`: `addHook` after it throws `AVV_ERR_ROOT_PLG_BOOTED`, and `extend`
  runs well before that.
- `deliveries`, `suppressions` and `inbound_routes` carry a **forced row-level policy** since
  `@kernhq/module-mail` 0.5.0 (they carried none before, and this note argued for it). The policy
  admits a row for its own workspace or for the `'*'` binding; this service's webhook handler and
  its tests bind `'*'` (written locally as `ALL_WORKSPACES`) because a provider reports on every
  workspace's mail at once. Bind before you read.
- **"A transaction that binds nothing sees nothing" is not something you can check here, and this
  file asserted it until 2026-09-05.** A superuser bypasses row-level security outright — forced or
  not — and both this machine and CI connect as `kern`, which is one (`usesuper` is true; CI's
  `pgvector/pgvector:pg18` makes `POSTGRES_USER` the superuser). Measured: with `relrowsecurity` and
  `relforcerowsecurity` both true on `deliveries`, `suppressions` and `inbound_routes`, an unbound
  `kernel.database.db` select still returned the row. The policies are real and production is
  subject to them, because it connects as `kern_app`; the *check* is what was wrong. Never read
  isolation off a query on a dev or CI database — ask the catalogue whether the policy exists, which
  is what `module-mail`'s `migrations.test.ts` does and the reason it is written that way. There
  *is* a way to see the policy work here, and it takes four statements: `create role … login`, grant
  it `usage` and `select`, then in one transaction `set local role`, select, and select again after
  `set_config('app.workspace_id','*',true)`. Measured on this machine — 0 rows unbound, 1 row bound
  — which is the production shape (`kern_app`) rather than the superuser's.
- Mailpit (http://localhost:8025) receives everything in development; its API is how tests assert.
- `providerFor()` and `instanceName()` read `SMTP_URL` / `MAIL_FROM` / `KERN_INSTANCE_NAME` from
  `process.env`, not from the validated `MailEnv`. dotenv puts them there in a deployment; anything that
  boots the service programmatically has to set them the same way.
- Tests boot the service with its own pg-boss worker, so `mail.send` really travels through the queue
  and out over SMTP; each suite uses a unique recipient so several can share one Mailpit.
- The personal IMAP inbox is not built yet — interfaces are sketched in `src/inbox/`.
