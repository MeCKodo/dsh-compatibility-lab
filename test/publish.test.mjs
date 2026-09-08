import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
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

test('historical receipts survive publication and full registry validation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-history-'))
  const incoming = join(root, 'incoming')
  const registry = join(root, 'registry/v1')
  await mkdir(incoming, { recursive: true })
  await mkdir(registry, { recursive: true })
  await writeFile(join(registry, 'index.json'), JSON.stringify({ schemaVersion: 1, receipts: [] }))
  const old = receipt()
  await writeFile(join(incoming, 'receipt.json'), JSON.stringify(old))
  await publish({ incoming, registry })
  old.testedAt = new Date(Date.now() - 8 * 86_400_000).toISOString()
  const index = JSON.parse(await readFile(join(registry, 'index.json'), 'utf8'))
  index.receipts[0].testedAt = old.testedAt
  const oldPath = join(root, index.receipts[0].path)
  await writeFile(oldPath, JSON.stringify(old))
  await writeFile(join(registry, 'index.json'), JSON.stringify(index))

  // The same old receipt must still be rejected at the untrusted intake boundary.
  await writeFile(join(incoming, 'receipt.json'), JSON.stringify(old))
  await assert.rejects(publish({ incoming, registry }), /testedAt/)
  const fresh = receipt()
  fresh.plugin = { ...fresh.plugin, slug: 'another-plugin' }
  fresh.fingerprint = fingerprint({ schemaVersion: 1, plugin: fresh.plugin, environment: fresh.environment, runnerVersion: fresh.runner.version })
  await writeFile(join(incoming, 'receipt.json'), JSON.stringify(fresh))
  assert.equal((await publish({ incoming, registry })).total, 2)
  const validate = () => spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/validate-registry.mjs', import.meta.url))], { cwd: root, encoding: 'utf8' })
  const result = validate()
  assert.equal(result.status, 0, result.stderr)
  assert.equal(JSON.parse(await readFile(oldPath, 'utf8')).testedAt, old.testedAt)
  await writeFile(oldPath, JSON.stringify({ ...old, fingerprint: 'b'.repeat(64) }))
  assert.match(validate().stderr, /fingerprint/)
  for (const testedAt of ['invalid', new Date(Date.now() + 8 * 86_400_000).toISOString()]) {
    await writeFile(oldPath, JSON.stringify({ ...old, testedAt }))
    assert.match(validate().stderr, /testedAt/)
  }
})
