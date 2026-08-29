import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildPlan, fingerprint } from '../scripts/plan.mjs'

const plugin = {
  name: 'example/dsh-plugin',
  slug: 'example-dsh-plugin',
  install: 'dsh plugin --profile web add example-plugin@1.0.0',
}
const environment = {
  id: 'web-linux-x64-dsh-0.1.1-rc.2',
  label: 'DSH Web 0.1.1-rc.2 on Linux x64',
  surface: 'web',
  os: 'linux',
  arch: 'x64',
  nodeVersion: '22',
  pnpmVersion: '10.34.5',
  dshVersion: '0.1.1-rc.2',
}

test('planner emits one job for an installable plugin and ignores unresolved entries', () => {
  const plan = buildPlan({
    catalog: { plugins: [plugin, { name: 'x/y', slug: 'x-y', install: '' }] },
    index: { receipts: [] },
    environments: { environments: [environment] },
    now: new Date('2026-08-29T00:00:00Z'),
  })
  assert.equal(plan.include.length, 1)
  assert.equal(plan.include[0].spec.plugin.profile, 'web')
})

test('planner reuses a fresh matching receipt and force schedules it again', () => {
  const base = {
    schemaVersion: 1,
    plugin: { ...plugin, profile: 'web' },
    environment,
    runnerVersion: '1.0.0',
  }
  const id = fingerprint(base)
  const input = {
    catalog: { plugins: [plugin] },
    index: { receipts: [{ fingerprint: id, testedAt: '2026-08-28T00:00:00Z' }] },
    environments: { environments: [environment] },
    now: new Date('2026-08-29T00:00:00Z'),
  }
  assert.equal(buildPlan(input).include.length, 0)
  assert.equal(buildPlan({ ...input, force: true }).include.length, 1)
})
