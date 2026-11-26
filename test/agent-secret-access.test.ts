// A worker's own authority over agent secret access: one capability per chat and process launch, in memory only.
import { describe, expect, test } from 'bun:test'
import { SecretAccess } from '../server/live/secret-access.ts'

const chain = ['p:box:gtm', 'm:box', 'all']

describe('secret capabilities', () => {
  test('a capability proves one chat and the level chain it was issued for', () => {
    const access = new SecretAccess()
    const token = access.issue('GTM-1/Agent', '4812:1700000000000', chain)
    expect(token).toMatch(/^[a-f0-9]{64}$/)
    expect(access.authenticate(token)).toEqual({ chat: 'GTM-1/Agent', chain })
    // anything that is not one of its own 256-bit tokens proves nothing
    for (const bad of [undefined, '', 'short', '0'.repeat(63), '0'.repeat(64), token.toUpperCase()]) expect(access.authenticate(bad)).toBeUndefined()
  })

  test('the same launch and scope keep their capability; another launch or scope replaces it', () => {
    const access = new SecretAccess()
    const first = access.issue('GTM-1/Agent', '4812:1700000000000', chain)
    expect(access.issue('GTM-1/Agent', '4812:1700000000000', chain)).toBe(first)
    // the agent started again: the old one is no longer current
    const relaunched = access.issue('GTM-1/Agent', '4813:1700000001000', chain)
    expect(relaunched).not.toBe(first)
    expect(access.authenticate(first)).toBeUndefined()
    // its space or machine changed under it: so does the capability
    const narrowed = access.issue('GTM-1/Agent', '4813:1700000001000', ['p:box:gtm', 'all'])
    expect(narrowed).not.toBe(relaunched)
    expect(access.authenticate(relaunched)).toBeUndefined()
    expect(access.authenticate(narrowed)).toEqual({ chat: 'GTM-1/Agent', chain: ['p:box:gtm', 'all'] })
  })

  test('a revoked capability is nothing, and every worker has its own authority', () => {
    const access = new SecretAccess()
    const token = access.issue('GTM-1/Agent', '4812:1700000000000', chain)
    access.revoke('GTM-1/Agent')
    expect(access.authenticate(token)).toBeUndefined()
    // revoking a chat that has none changes nothing
    access.revoke('GTM-2/Agent')
    const other = new SecretAccess()
    const theirs = other.issue('GTM-1/Agent', '4812:1700000000000', chain)
    expect(new SecretAccess().authenticate(theirs)).toBeUndefined()
    expect(access.authenticate(other.issue('GTM-1/Agent', '4812:1700000000000', chain))).toBeUndefined()
  })

  test('a chat and its reviewer are two, and one chat never proves another', () => {
    const access = new SecretAccess()
    const agent = access.issue('GTM-1/Agent', '4812:1', chain)
    const reviewer = access.issue('GTM-1/Reviewer', '4813:1', chain)
    expect(access.authenticate(agent)!.chat).toBe('GTM-1/Agent')
    expect(access.authenticate(reviewer)!.chat).toBe('GTM-1/Reviewer')
    access.revoke('GTM-1/Reviewer')
    expect(access.authenticate(reviewer)).toBeUndefined()
    expect(access.authenticate(agent)).toEqual({ chat: 'GTM-1/Agent', chain })
  })
})
