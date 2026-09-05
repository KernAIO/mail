import { ANONYMOUS, type Principal } from '@kernhq/contracts'
import type { Kernel } from '@kernhq/kernel'
import type { FastifyRequest } from 'fastify'

const READ_METHODS = new Set(['GET', 'HEAD'])

/** Separates the two halves of a cache key. It cannot occur in a token, so the split is unambiguous. */
const KEY_SEP = ' '

/**
 * What an MCP token is being asked to authorise here: the module the request targets and whether it
 * writes. Core holds a `kmt_…` token to the scopes its consent screen named, and it cannot work the
 * need out for itself — it does not have this request. A token that arrives with no need resolves
 * to ANONYMOUS, so any non-module path refuses one outright.
 */
export interface McpNeed {
  module: string
  write: boolean
}

/** The need a request expresses, or null if it is not aimed at a module API this service hosts. */
export function needForRequest(kernel: Kernel, req: FastifyRequest): McpNeed | null {
  const path = (req.url ?? '').split('?')[0] ?? ''
  for (const mod of kernel.registry.all()) {
    const prefix = `/api/${mod.definition.apiPrefix ?? mod.definition.id}`
    if (path === prefix || path.startsWith(`${prefix}/`))
      return { module: mod.definition.id, write: !READ_METHODS.has(req.method) }
  }
  return null
}

/**
 * Resolves principals for a service that does not own the identity tables: the session token is handed
 * to core (`core.users.principal`), and the answer is cached briefly so that a burst of requests or a
 * WebSocket handshake storm does not amplify into core.
 */
export interface Principals {
  fromToken(token: string, need?: McpNeed | null): Promise<Principal>
  fromRequest(req: FastifyRequest): Promise<Principal>
  invalidate(token?: string): void
}

export function createPrincipals(kernel: Kernel, ttlMs = 60_000): Principals {
  const cache = new Map<string, { principal: Principal; expires: number }>()

  /**
   * The need is part of the key, because it is part of the question. Keyed on the token alone, the
   * first GET would answer every later POST from cache and the scope check would be decorative —
   * core would be asked once, about a read, and the write waved through on the cached answer.
   */
  const keyOf = (token: string, need: McpNeed | null) =>
    `${token}${KEY_SEP}${need ? `${need.module}:${need.write ? 'w' : 'r'}` : ''}`

  const fromToken = async (token: string, need: McpNeed | null = null): Promise<Principal> => {
    if (!token) return ANONYMOUS
    const key = keyOf(token, need)
    const hit = cache.get(key)
    if (hit && hit.expires > Date.now()) return hit.principal
    const principal = await kernel
      .call<Principal>('core.users.principal', {
        token,
        ...(need ? { module: need.module, write: need.write } : {}),
      })
      .catch((err): Principal => {
        kernel.log.warn({ err }, 'principal lookup failed')
        return ANONYMOUS
      })
    if (principal.kind !== 'anonymous') cache.set(key, { principal, expires: Date.now() + ttlMs })
    return principal
  }

  return {
    fromToken,
    async fromRequest(req) {
      const service = req.headers['x-kern-service']
      if (typeof service === 'string') {
        const name = await kernel.auth.verifyService(service)
        if (name) return { ...ANONYMOUS, kind: 'service', service: name, instanceAdmin: true }
      }
      const auth = req.headers.authorization
      if (auth?.startsWith('Bearer ')) return fromToken(auth.slice(7), needForRequest(kernel, req))
      const cookie = req.headers.cookie
      if (cookie) {
        const match = /(?:^|;\s*)(?:__Secure-)?kern\.session_token=([^;]+)/.exec(cookie)
        if (match?.[1]) return fromToken(decodeURIComponent(match[1]))
      }
      return ANONYMOUS
    },
    invalidate(token) {
      if (!token) return cache.clear()
      // one token now has an entry per need, so drop the whole family
      for (const k of cache.keys()) if (k.startsWith(`${token}${KEY_SEP}`)) cache.delete(k)
    },
  }
}
