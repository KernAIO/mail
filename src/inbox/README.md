# Personal mail inbox (IMAP/SMTP)

Planned for the mail milestone: each user connects their own mailbox (IMAP + SMTP, or Gmail/Microsoft
via OAuth) and reads it inside Kern, with messages linkable to issues, candidates and deals.

The sync engine is built around `imapflow`:

- one long-lived IDLE connection per active account, with a polling fallback for servers without IDLE
  and for accounts nobody is looking at;
- envelopes, flags, UID and MODSEQ are stored in Postgres so the list view is instant and searchable,
  while bodies and attachments are fetched on demand and cached in object storage;
- credentials are encrypted with `kernel.secrets` (AES-256-GCM, key derived from `KERN_SECRET`);
- inbound intake addresses (`intake+<token>@…`) reuse the same pipeline to turn email into issues and
  comments.

`types.ts` holds the interfaces the rest of the service already codes against.
