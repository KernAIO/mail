/**
 * The Amazon SNS envelope, checked without a network or a database.
 *
 * A signing certificate can only be fetched from Amazon, so the verifier takes a public key and
 * these tests hand it a locally generated one. What the webhook route adds on top — that the
 * certificate URL and the subscribe URL are both SNS endpoints over TLS — is in `webhooks.test.ts`.
 */
import { createSign, generateKeyPairSync } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { snsStringToSign, verifySnsSignature } from '../webhooks.js'

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })

const confirmation = {
  Type: 'SubscriptionConfirmation',
  MessageId: '165545c9-2a5c-472c-8df2-7ff2be2b3b1b',
  Token: 'a-very-long-token',
  TopicArn: 'arn:aws:sns:eu-west-1:123456789012:kern-mail',
  Message: 'You have chosen to subscribe to the topic arn:aws:sns:eu-west-1:123456789012:kern-mail.',
  SubscribeURL: 'https://sns.eu-west-1.amazonaws.com/?Action=ConfirmSubscription&Token=a-very-long-token',
  Timestamp: '2026-09-05T09:00:00.000Z',
  SignatureVersion: '2',
  SigningCertURL: 'https://sns.eu-west-1.amazonaws.com/SimpleNotificationService-abc123.pem',
} as Record<string, unknown>

/** Signs a body the way SNS does, so the fixtures cannot drift from what the verifier reads. */
function sign(body: Record<string, unknown>, algorithm = 'RSA-SHA256'): Record<string, unknown> {
  const stringToSign = snsStringToSign(body)
  if (!stringToSign) throw new Error('fixture is not a signable SNS envelope')
  return { ...body, Signature: createSign(algorithm).update(stringToSign, 'utf8').sign(privateKey, 'base64') }
}

describe('the canonical string SNS signs', () => {
  it('takes the documented fields in the documented order', () => {
    expect(snsStringToSign(confirmation)).toBe(
      [
        `Message\n${confirmation.Message}`,
        `MessageId\n${confirmation.MessageId}`,
        `SubscribeURL\n${confirmation.SubscribeURL}`,
        `Timestamp\n${confirmation.Timestamp}`,
        `Token\n${confirmation.Token}`,
        `TopicArn\n${confirmation.TopicArn}`,
        'Type\nSubscriptionConfirmation',
        '',
      ].join('\n'),
    )
  })

  it('omits Subject when the notification has none, and includes it when it has one', () => {
    const notification = {
      Type: 'Notification',
      MessageId: 'm-1',
      TopicArn: 'arn:aws:sns:eu-west-1:123456789012:kern-mail',
      Message: '{"notificationType":"Bounce"}',
      Timestamp: '2026-09-05T09:00:00.000Z',
    }
    expect(snsStringToSign(notification)).not.toContain('Subject')
    expect(snsStringToSign({ ...notification, Subject: 'a subject' })).toContain('Subject\na subject\n')
  })

  it('refuses an envelope that is missing a signed field or is not an SNS type', () => {
    const { Timestamp: _, ...withoutTimestamp } = confirmation
    expect(snsStringToSign(withoutTimestamp)).toBeNull()
    expect(snsStringToSign({ ...confirmation, Type: 'Something else' })).toBeNull()
    expect(snsStringToSign({ RecordType: 'Delivery' })).toBeNull()
  })
})

describe('verifying an SNS signature', () => {
  it('accepts a message signed with the certificate’s key', () => {
    expect(verifySnsSignature(sign(confirmation), publicKey)).toBe(true)
  })

  it('accepts SignatureVersion 1, which SNS signs with SHA-1', () => {
    const v1 = { ...confirmation, SignatureVersion: '1' }
    expect(verifySnsSignature(sign(v1, 'RSA-SHA1'), publicKey)).toBe(true)
    // the same bytes read as SHA-256 are not a valid signature
    expect(verifySnsSignature({ ...sign(v1, 'RSA-SHA1'), SignatureVersion: '2' }, publicKey)).toBe(false)
  })

  it('refuses a message whose SubscribeURL was swapped after signing', () => {
    const signed = sign(confirmation)
    expect(
      verifySnsSignature({ ...signed, SubscribeURL: 'https://169.254.169.254/latest/meta-data/' }, publicKey),
    ).toBe(false)
  })

  it('refuses a missing, malformed or unknown-version signature', () => {
    expect(verifySnsSignature(confirmation, publicKey)).toBe(false)
    expect(verifySnsSignature({ ...confirmation, Signature: 'not base64 at all' }, publicKey)).toBe(false)
    expect(verifySnsSignature({ ...sign(confirmation), SignatureVersion: '9' }, publicKey)).toBe(false)
  })

  it('refuses a signature made with another key', () => {
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const stringToSign = snsStringToSign(confirmation) as string
    const forged = {
      ...confirmation,
      Signature: createSign('RSA-SHA256').update(stringToSign, 'utf8').sign(other.privateKey, 'base64'),
    }
    expect(verifySnsSignature(forged, publicKey)).toBe(false)
  })
})
