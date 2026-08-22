/**
 * Interfaces for the personal IMAP/SMTP inbox. The implementation lands with the mail milestone;
 * these types fix the shape the rest of the service (and the API contract) expects.
 */

export interface MailAccount {
  id: string
  workspaceId: string
  userId: string
  email: string
  displayName: string | null
  /** how Kern authenticates against the mailbox */
  auth:
    | { kind: 'password'; user: string; password: string }
    | { kind: 'oauth2'; provider: 'google' | 'microsoft'; refreshToken: string }
  imap: { host: string; port: number; secure: boolean }
  smtp: { host: string; port: number; secure: boolean }
  /** folders the user chose to sync */
  folders: string[]
  status: 'connected' | 'error' | 'disabled'
  lastError: string | null
}

export interface SyncState {
  accountId: string
  folder: string
  /** IMAP UIDVALIDITY; a change means the folder must be resynchronised from scratch */
  uidValidity: number
  /** highest UID seen so far */
  lastUid: number
  /** CONDSTORE modification sequence, when the server supports it */
  modSeq: string | null
  syncedAt: string
}

export interface InboxEngine {
  /** connect an account and start watching its folders */
  start(account: MailAccount): Promise<void>
  /** stop watching (sign-out, disabled account, shutdown) */
  stop(accountId: string): Promise<void>
  /** fetch one message body on demand, caching it in object storage */
  fetchBody(
    accountId: string,
    folder: string,
    uid: number,
  ): Promise<{ html: string | null; text: string | null }>
  /** currently connected accounts */
  connected(): string[]
}

/** Thrown when a mailbox rejects the stored credentials so the account can be flagged in the UI. */
export class MailboxAuthError extends Error {
  constructor(
    public readonly accountId: string,
    message: string,
  ) {
    super(message)
    this.name = 'MailboxAuthError'
  }
}
