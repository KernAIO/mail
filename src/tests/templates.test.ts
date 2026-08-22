/**
 * Template rendering. Every transactional email the platform sends goes through here, so the shape of
 * the output (subject line, plain-text alternative, escaped HTML) is worth pinning down.
 */
import { hasTemplate, renderTemplate, templateNames } from '@kernhq/module-mail/server'
import { describe, expect, it } from 'vitest'

describe('the template catalogue', () => {
  it('lists the transactional templates and hides the shared layout', () => {
    const names = templateNames()
    expect(names).toEqual(
      expect.arrayContaining([
        'invitation',
        'magic-link',
        'notification-digest',
        'reset-password',
        'test',
        'verify-email',
      ]),
    )
    expect(names).not.toContain('_layout')
  })

  it('only recognises names it can safely resolve to a file', () => {
    expect(hasTemplate('invitation')).toBe(true)
    expect(hasTemplate('_layout')).toBe(false)
    expect(hasTemplate('../../etc/passwd')).toBe(false)
    expect(hasTemplate('Invitation')).toBe(false)
    expect(hasTemplate('')).toBe(false)
  })

  it('refuses to render an unknown template', async () => {
    await expect(renderTemplate('does-not-exist', {})).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(renderTemplate('../_layout', {})).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe('rendering', () => {
  it('produces a subject, compiled HTML and a plain-text alternative', async () => {
    const rendered = await renderTemplate(
      'invitation',
      {
        inviterName: 'Ada Lovelace',
        workspaceName: 'Analytical Engines',
        acceptUrl: 'https://kern.example/invite/abc123',
      },
      { instanceName: 'Kern Test' },
    )

    expect(rendered.subject).toBeTruthy()
    expect(rendered.subject).not.toContain('\n')
    expect(rendered.html).toMatch(/^<!doctype html>/i)
    expect(rendered.html).toContain('https://kern.example/invite/abc123')
    expect(rendered.html).toContain('Analytical Engines')
    expect(rendered.text).toContain('https://kern.example/invite/abc123')
    // the text alternative must not carry markup
    expect(rendered.text).not.toContain('<td')
  })

  it('interpolates every template with the instance name', async () => {
    // one representative payload that satisfies every template's expectations
    const data = {
      name: 'Ada',
      email: 'ada@example.test',
      url: 'https://kern.example/link',
      acceptUrl: 'https://kern.example/invite/abc',
      inboxUrl: 'https://kern.example/inbox',
      inviterName: 'Grace',
      workspaceName: 'Engines',
      periodLabel: 'daily',
      provider: 'smtp',
      items: [{ title: 'Something happened', body: 'and here is why', url: 'https://kern.example/x' }],
    }
    for (const name of templateNames()) {
      const rendered = await renderTemplate(name, data, { instanceName: 'Acme Intranet' })
      expect(rendered.html, `${name} should mention the instance`).toContain('Acme Intranet')
      expect(rendered.subject, `${name} should have a subject`).toBeTruthy()
      expect(rendered.text.length, `${name} should have a text body`).toBeGreaterThan(0)
      expect(rendered.html, `${name} should compile to email HTML`).toMatch(/^<!doctype html>/i)
    }
  })

  it('escapes interpolated values in HTML but leaves the text body raw', async () => {
    const nasty = '<script>alert(1)</script>'
    const rendered = await renderTemplate('invitation', {
      inviterName: nasty,
      workspaceName: 'Safe',
      acceptUrl: 'https://kern.example/invite/x',
    })

    expect(rendered.html).not.toContain('<script>alert(1)</script>')
    expect(rendered.html).toContain('&lt;script&gt;')
    expect(rendered.text).toContain(nasty)
  })

  it('escapes the instance name in the layout header and footer', async () => {
    const rendered = await renderTemplate('test', {}, { instanceName: '<b>Evil</b> & Co' })
    expect(rendered.html).not.toContain('<b>Evil</b>')
    expect(rendered.html).toContain('&lt;b&gt;Evil&lt;/b&gt; &amp; Co')
  })

  it('accepts a custom footer', async () => {
    const rendered = await renderTemplate('test', {}, { footer: 'Sent from a test run' })
    expect(rendered.html).toContain('Sent from a test run')
  })

  it('renders deterministically for the same input', async () => {
    const data = { inviterName: 'Ada', workspaceName: 'Engines', acceptUrl: 'https://kern.example/x' }
    const [a, b] = await Promise.all([
      renderTemplate('invitation', data, { instanceName: 'Kern' }),
      renderTemplate('invitation', data, { instanceName: 'Kern' }),
    ])
    expect(a).toEqual(b)
  })
})
