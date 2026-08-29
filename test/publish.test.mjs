import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fingerprint } from '../scripts/plan.mjs'
import { publish, validateReceipt } from '../scripts/publish-results.mjs'

function receipt() {
  const plugin = {
    name: 'example/dsh-plugin',
    slug: 'example-dsh-plugin',
    install: 'dsh plugin --profile web add example-plugin@1.0.0',
    profile: 'web',
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
  const runner = { repository: 'MeCKodo/dsh-compatibility-lab', revision: 'abc123', version: '1.0.0' }
  return {
    schemaVersion: 1,
    fingerprint: fingerprint({ schemaVersion: 1, plugin, environment, runnerVersion: runner.version }),
    plugin,
    environment,
    status: 'passed',
    detail: 'plugin installed, registered, and booted the profile help surface',
    checks: { install: { status: 'passed' }, registration: { status: 'passed' }, boot: { status: 'passed' } },
    observed: { bundles: ['example-plugin'], dependencies: ['example-plugin'], blockedBuildScripts: [] },
    outputDigest: 'a'.repeat(64),
    testedAt: new Date().toISOString(),
    runner,
  }
}

test('receipt validator rejects unexpected fields', () => {
  const value = receipt()
  assert.equal(validateReceipt(value), value)
  assert.throws(() => validateReceipt({ ...value, injected: '<script>' }), /unexpected fields/)
})

test('publisher writes a receipt and index entry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-publish-'))
  const incoming = join(root, 'incoming')
  const registry = join(root, 'registry/v1')
  await mkdir(incoming, { recursive: true })
  await mkdir(registry, { recursive: true })
  await writeFile(join(registry, 'index.json'), `${JSON.stringify({ schemaVersion: 1, generated: '2026-08-29T00:00:00Z', source: { catalog: 'test' }, receipts: [] })}\n`)
  await writeFile(join(incoming, 'receipt.json'), `${JSON.stringify(receipt())}\n`)
  const result = await publish({ incoming, registry })
  assert.equal(result.accepted, 1)
  const index = JSON.parse(await readFile(join(registry, 'index.json'), 'utf8'))
  assert.equal(index.receipts.length, 1)
  assert.equal(index.receipts[0].status, 'passed')
})
