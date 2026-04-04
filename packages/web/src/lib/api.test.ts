import { describe, it, expect } from 'vitest'
import { deriveEnvStatus } from './api'
import type { EnvListItem } from './api'

function makeEnv(statuses: string[]): EnvListItem {
  return {
    envId: 'test',
    repoId: 'repo',
    repoPath: '/path',
    branch: 'main',
    basePort: 10000,
    createdAt: '2026-01-01T00:00:00Z',
    services: statuses.map((s, i) => ({
      name: `svc-${i}`,
      type: 'process' as const,
      status: s as any,
      port: 10000 + i,
    })),
  }
}

describe('deriveEnvStatus', () => {
  it('returns stopped for env with no services', () => {
    const env = makeEnv([])
    expect(deriveEnvStatus(env)).toBe('stopped')
  })

  it('returns running when any service is running', () => {
    expect(deriveEnvStatus(makeEnv(['running', 'stopped']))).toBe('running')
    expect(deriveEnvStatus(makeEnv(['failed', 'running']))).toBe('running')
  })

  it('returns starting when any service is starting and none running', () => {
    expect(deriveEnvStatus(makeEnv(['starting', 'stopped']))).toBe('starting')
  })

  it('returns crashed when any service is failed and none running/starting', () => {
    expect(deriveEnvStatus(makeEnv(['failed', 'stopped']))).toBe('crashed')
    expect(deriveEnvStatus(makeEnv(['failed']))).toBe('crashed')
  })

  it('returns stopped when all services are stopped', () => {
    expect(deriveEnvStatus(makeEnv(['stopped', 'stopped']))).toBe('stopped')
  })

  it('running takes precedence over failed', () => {
    expect(deriveEnvStatus(makeEnv(['running', 'failed', 'starting']))).toBe('running')
  })

  it('starting takes precedence over failed', () => {
    expect(deriveEnvStatus(makeEnv(['starting', 'failed']))).toBe('starting')
  })
})
