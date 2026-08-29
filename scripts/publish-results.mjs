import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { fingerprint } from './plan.mjs'

const STATUSES = new Set(['passed', 'boot-failed', 'needs-approval', 'not-a-layer', 'failed', 'timeout', 'inconclusive'])
const CHECK_STATUSES = new Set(['passed', 'failed', 'blocked', 'timeout', 'not-run', 'not-applicable', 'unknown', 'inconclusive', 'rejected'])
const DETAILS = new Set([
  'install command did not match the allowed DSH command shape',
  'install target was not an allowed npm or GitHub spec',
  'plugin install exceeded the time limit',
  'a package host throttled or failed the test run',
  'DSH did not write a readable profile manifest',
  'source install needs a build script approval before registration',
  'a blocked build script stopped plugin registration',
  'package installed but does not declare a DSH bundle layer',
  'package did not register as a profile bundle',
  'registered plugin timed out while booting the profile help surface',
  'registered plugin caused the profile help surface to fail during boot',
  'plugin installed, registered, and booted the profile help surface',
])
const PACKAGE_NAME = /^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/i

function exactKeys(value, expected, label) {
  const actual = Object.keys(value || {}).sort()
  const wanted = [...expected].sort()
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new Error(`${label} has unexpected fields: ${actual.join(', ')}`)
  }
}

function boundedString(value, max, label) {
  if (typeof value !== 'string' || !value || value.length > max) throw new Error(`invalid ${label}`)
}

function safeObserved(observed) {
  exactKeys(observed, ['bundles', 'dependencies', 'blockedBuildScripts'], 'observed')
  for (const key of ['bundles', 'dependencies', 'blockedBuildScripts']) {
    if (!Array.isArray(observed[key]) || observed[key].length > 100) throw new Error(`invalid observed.${key}`)
    for (const value of observed[key]) {
      if (typeof value !== 'string' || !PACKAGE_NAME.test(value)) throw new Error(`invalid observed.${key} value`)
    }
  }
}

export function validateReceipt(receipt) {
  exactKeys(receipt, [
    'schemaVersion', 'fingerprint', 'plugin', 'environment', 'status', 'detail',
    'checks', 'observed', 'outputDigest', 'testedAt', 'runner',
  ], 'receipt')
  if (receipt.schemaVersion !== 1) throw new Error('schemaVersion must be 1')
  if (!/^[a-f0-9]{64}$/.test(receipt.fingerprint || '')) throw new Error('invalid fingerprint')
  if (!STATUSES.has(receipt.status)) throw new Error('invalid status')
  if (!DETAILS.has(receipt.detail)) throw new Error('unrecognised detail')
  exactKeys(receipt.plugin, ['name', 'slug', 'install', 'profile'], 'plugin')
  boundedString(receipt.plugin.name, 200, 'plugin.name')
  if (!/^[a-z0-9][a-z0-9-]*$/.test(receipt.plugin.slug || '')) throw new Error('invalid plugin.slug')
  if (!/^dsh plugin --profile [A-Za-z0-9_.-]+ add \S+$/.test(receipt.plugin.install || '')) throw new Error('invalid plugin.install')
  if (!/^[A-Za-z0-9_.-]+$/.test(receipt.plugin.profile || '')) throw new Error('invalid plugin.profile')
  boundedString(receipt.environment?.id, 100, 'environment.id')
  if (!/^[a-z0-9][a-z0-9.-]*$/.test(receipt.environment.id)) throw new Error('invalid environment.id')
  boundedString(receipt.environment?.dshVersion, 80, 'environment.dshVersion')
  if (!receipt.checks || typeof receipt.checks !== 'object') throw new Error('invalid checks')
  exactKeys(receipt.checks, ['install', 'registration', 'boot'], 'checks')
  for (const [name, check] of Object.entries(receipt.checks)) {
    exactKeys(check, ['status'], `checks.${name}`)
    if (!CHECK_STATUSES.has(check.status)) throw new Error(`invalid checks.${name}.status`)
  }
  safeObserved(receipt.observed)
  if (receipt.outputDigest !== null && !/^[a-f0-9]{64}$/.test(receipt.outputDigest || '')) throw new Error('invalid outputDigest')
  const testedAt = Date.parse(receipt.testedAt)
  if (!Number.isFinite(testedAt) || Math.abs(Date.now() - testedAt) > 7 * 86_400_000) throw new Error('testedAt is outside the accepted window')
  exactKeys(receipt.runner, ['repository', 'revision', 'version'], 'runner')
  boundedString(receipt.runner.repository, 200, 'runner.repository')
  boundedString(receipt.runner.revision, 100, 'runner.revision')
  boundedString(receipt.runner.version, 30, 'runner.version')
  const expectedFingerprint = fingerprint({
    schemaVersion: 1,
    plugin: receipt.plugin,
    environment: receipt.environment,
    runnerVersion: receipt.runner.version,
  })
  if (expectedFingerprint !== receipt.fingerprint) throw new Error('fingerprint does not match receipt content')
  return receipt
}

async function jsonFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...await jsonFiles(path))
    else if (entry.isFile() && entry.name.endsWith('.json')) files.push(path)
  }
  return files
}

export async function publish({ incoming = 'incoming', registry = 'registry/v1' } = {}) {
  const incomingDir = resolve(incoming)
  const registryDir = resolve(registry)
  const indexPath = join(registryDir, 'index.json')
  const index = JSON.parse(await readFile(indexPath, 'utf8'))
  const files = await jsonFiles(incomingDir)
  const byKey = new Map(index.receipts.map((entry) => [`${entry.plugin.slug}\0${entry.environment.id}`, entry]))
  let accepted = 0
  let skipped = 0

  for (const file of files.sort()) {
    if ((await readFile(file)).byteLength > 64 * 1024) throw new Error(`receipt is too large: ${basename(file)}`)
    const receipt = validateReceipt(JSON.parse(await readFile(file, 'utf8')))
    if (receipt.status === 'inconclusive') {
      skipped += 1
      continue
    }
    const relative = `plugins/${receipt.plugin.slug}/${receipt.environment.id}.json`
    const output = join(registryDir, relative)
    await mkdir(resolve(output, '..'), { recursive: true })
    await writeFile(output, `${JSON.stringify(receipt, null, 2)}\n`)
    byKey.set(`${receipt.plugin.slug}\0${receipt.environment.id}`, {
      fingerprint: receipt.fingerprint,
      plugin: { name: receipt.plugin.name, slug: receipt.plugin.slug },
      environment: receipt.environment,
      status: receipt.status,
      checks: receipt.checks,
      detail: receipt.detail,
      testedAt: receipt.testedAt,
      runner: receipt.runner,
      path: `registry/v1/${relative}`,
    })
    accepted += 1
  }

  index.generated = new Date().toISOString()
  index.receipts = [...byKey.values()].sort((left, right) => (
    left.plugin.slug.localeCompare(right.plugin.slug) || left.environment.id.localeCompare(right.environment.id)
  ))
  await writeFile(indexPath, `${JSON.stringify(index, null, 2)}\n`)
  return { accepted, skipped, total: index.receipts.length }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  publish({ incoming: process.env.INCOMING_DIR || 'incoming' })
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error) => {
      console.error(error.stack || error.message)
      process.exit(1)
    })
}
