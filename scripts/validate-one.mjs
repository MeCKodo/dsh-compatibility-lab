import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const ALLOWED_STATUSES = new Set([
  'passed',
  'boot-failed',
  'needs-approval',
  'not-a-layer',
  'failed',
  'timeout',
  'inconclusive',
])

function run(file, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(file, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (value) => { stdout += value })
    child.stderr.on('data', (value) => { stderr += value })
    child.on('error', reject)
    child.on('close', (code) => resolvePromise({ code, stdout, stderr }))
  })
}

function validateSpec(spec) {
  if (spec?.schemaVersion !== 1) throw new Error('spec.schemaVersion must be 1')
  if (!/^[a-f0-9]{64}$/.test(spec.fingerprint || '')) throw new Error('invalid fingerprint')
  if (!/^[a-z0-9][a-z0-9-]*$/.test(spec.plugin?.slug || '')) throw new Error('invalid plugin slug')
  if (!/^dsh plugin --profile [A-Za-z0-9_.-]+ add \S+$/.test(spec.plugin?.install || '')) {
    throw new Error('invalid install command')
  }
  if (!/^[A-Za-z0-9_.-]+$/.test(spec.plugin?.profile || '')) throw new Error('invalid profile')
  if (!/^[a-z0-9][a-z0-9.-]*$/.test(spec.environment?.id || '')) throw new Error('invalid environment id')
  if (!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(spec.environment?.dshVersion || '')) {
    throw new Error('invalid DSH version')
  }
}

function parseVerdict(stdout) {
  const lines = stdout.trim().split('\n').filter(Boolean)
  const verdict = JSON.parse(lines.at(-1) || '{}')
  if (!ALLOWED_STATUSES.has(verdict.status)) throw new Error('probe returned an invalid status')
  if (typeof verdict.detail !== 'string' || verdict.detail.length > 300) throw new Error('invalid detail')
  if (!verdict.checks || typeof verdict.checks !== 'object') throw new Error('invalid checks')
  return verdict
}

export async function main() {
  const spec = JSON.parse(process.env.SPEC_JSON || '{}')
  validateSpec(spec)
  const image = `dsh-compat-${spec.fingerprint.slice(0, 12)}`
  const build = await run('docker', [
    'build',
    '--build-arg', `DSH_VERSION=${spec.environment.dshVersion}`,
    '--build-arg', `PNPM_VERSION=${spec.environment.pnpmVersion}`,
    '-t', image,
    '.',
  ])
  if (build.code !== 0) throw new Error(`runner image build failed: ${build.stderr.slice(-2000)}`)

  const probe = await run('docker', [
    'run', '--rm', '--network', 'bridge',
    '--memory', '1500m', '--memory-swap', '1500m',
    '--cpus', '1.0', '--pids-limit', '512',
    '--security-opt', 'no-new-privileges',
    '--cap-drop', 'ALL', '--stop-timeout', '10',
    image, spec.plugin.install,
  ])
  const verdict = parseVerdict(probe.stdout)
  const receipt = {
    schemaVersion: 1,
    fingerprint: spec.fingerprint,
    plugin: spec.plugin,
    environment: spec.environment,
    status: verdict.status,
    detail: verdict.detail,
    checks: verdict.checks,
    observed: verdict.observed || { bundles: [], dependencies: [], blockedBuildScripts: [] },
    outputDigest: verdict.outputDigest || null,
    testedAt: new Date().toISOString(),
    runner: {
      repository: process.env.GITHUB_REPOSITORY || 'local',
      revision: process.env.GITHUB_SHA || 'local',
      version: spec.runnerVersion,
    },
  }
  const outputDir = resolve(process.env.RECEIPT_DIR || 'work/receipts')
  await mkdir(outputDir, { recursive: true })
  const output = resolve(outputDir, `${spec.plugin.slug}--${spec.environment.id}.json`)
  await writeFile(output, `${JSON.stringify(receipt, null, 2)}\n`)
  process.stdout.write(`${JSON.stringify({ status: receipt.status, output })}\n`)
}

main().catch((error) => {
  console.error(error.stack || error.message)
  process.exit(1)
})
