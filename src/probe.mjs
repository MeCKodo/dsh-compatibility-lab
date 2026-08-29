import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const COMMAND = /^dsh plugin --profile ([A-Za-z0-9_.-]+) add (\S+)$/
const NPM = /^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*(?:@[\w.^~><=|\-+*]+)?$/i
const GITHUB = /^github:[\w.-]+\/[\w.-]+(?:#[\w./-]+)?$/
const PACKAGE_NAME = /^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/i
const INSTALL_TIMEOUT_MS = Number(process.env.PROBE_TIMEOUT_MS || 180_000)
const BOOT_TIMEOUT_MS = Number(process.env.BOOT_TIMEOUT_MS || 60_000)

function run(file, args, options = {}) {
  return new Promise((resolve) => {
    execFile(file, args, {
      timeout: options.timeout || INSTALL_TIMEOUT_MS,
      maxBuffer: 8 << 20,
      ...options,
    }, (error, stdout, stderr) => {
      resolve({
        code: typeof error?.code === 'number' ? error.code : error ? 1 : 0,
        killed: Boolean(error?.killed),
        output: `${stdout || ''}${stderr || ''}`,
      })
    })
  })
}

function digest(value) {
  return createHash('sha256').update(String(value || '')).digest('hex')
}

function safeNames(values) {
  return [...new Set(values)]
    .filter((value) => typeof value === 'string' && PACKAGE_NAME.test(value))
    .slice(0, 100)
}

function report(status, detail, checks, extra = {}) {
  process.stdout.write(`${JSON.stringify({
    status,
    detail,
    checks,
    ...extra,
  })}\n`)
  process.exit(0)
}

const command = String(process.argv[2] || '').trim()
const match = COMMAND.exec(command)

if (!match) {
  report('failed', 'install command did not match the allowed DSH command shape', {
    install: { status: 'rejected' },
    registration: { status: 'not-run' },
    boot: { status: 'not-run' },
  })
}

const [, profile, target] = match
if (target.includes('..') || (!NPM.test(target) && !GITHUB.test(target))) {
  report('failed', 'install target was not an allowed npm or GitHub spec', {
    install: { status: 'rejected' },
    registration: { status: 'not-run' },
    boot: { status: 'not-run' },
  })
}

const home = await mkdtemp(join(tmpdir(), 'dsh-compat-'))
const profileDir = join(home, 'profiles', profile)
const env = {
  ...process.env,
  DSH_HOME: home,
  DSH_TELEMETRY_DISABLED: '1',
}

const install = await run('dsh', ['plugin', '--profile', profile, 'add', target], {
  env,
  timeout: INSTALL_TIMEOUT_MS,
})

if (install.killed) {
  report('timeout', 'plugin install exceeded the time limit', {
    install: { status: 'timeout' },
    registration: { status: 'not-run' },
    boot: { status: 'not-run' },
  }, { outputDigest: digest(install.output) })
}

if (/ERR_PNPM_FETCH_(?:429|5\d\d)\b|(?:npm|codeload\.github\.com).*\b429\b/i.test(install.output)) {
  report('inconclusive', 'a package host throttled or failed the test run', {
    install: { status: 'inconclusive' },
    registration: { status: 'not-run' },
    boot: { status: 'not-run' },
  }, { outputDigest: digest(install.output) })
}

let manifest
try {
  manifest = JSON.parse(await readFile(join(profileDir, 'package.json'), 'utf8'))
} catch {
  report('failed', 'DSH did not write a readable profile manifest', {
    install: { status: install.code === 0 ? 'unknown' : 'failed' },
    registration: { status: 'failed' },
    boot: { status: 'not-run' },
  }, { outputDigest: digest(install.output) })
}

const bundles = safeNames(manifest?.dsh?.profile?.bundles || [])
const dependencies = safeNames(Object.keys(manifest?.dependencies || {}))
const blockedBuildScripts = safeNames(
  [...install.output.matchAll(/Ignored build scripts:\s*([^\n]+)/g)]
    .flatMap((entry) => entry[1].split(','))
    .map((value) => value.replace(/[\s│|]+$/, '').trim().replace(/\.$/, '')),
)

const packageName = target.startsWith('github:')
  ? null
  : target.replace(/^(@[^/]+\/[^@]+|[^@][^@]*)@.+$/, '$1')
const landed = packageName ? dependencies.includes(packageName) : dependencies.length > 0
const registered = packageName
  ? bundles.includes(packageName)
  : bundles.length > 2 || dependencies.length > 0

const observed = { bundles, dependencies, blockedBuildScripts }

if (/ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED/.test(install.output)) {
  report('needs-approval', 'source install needs a build script approval before registration', {
    install: { status: landed ? 'passed' : 'failed' },
    registration: { status: 'blocked' },
    boot: { status: 'not-run' },
  }, { observed, outputDigest: digest(install.output) })
}

if (landed && blockedBuildScripts.length && !registered) {
  report('needs-approval', 'a blocked build script stopped plugin registration', {
    install: { status: 'passed' },
    registration: { status: 'blocked' },
    boot: { status: 'not-run' },
  }, { observed, outputDigest: digest(install.output) })
}

if (landed && !registered && /declares no dsh\.bundle/i.test(install.output)) {
  report('not-a-layer', 'package installed but does not declare a DSH bundle layer', {
    install: { status: 'passed' },
    registration: { status: 'not-applicable' },
    boot: { status: 'not-run' },
  }, { observed, outputDigest: digest(install.output) })
}

if (!registered) {
  report('failed', 'package did not register as a profile bundle', {
    install: { status: landed ? 'passed' : 'failed' },
    registration: { status: 'failed' },
    boot: { status: 'not-run' },
  }, { observed, outputDigest: digest(install.output) })
}

const boot = await run('dsh', ['--profile', profile, '--help'], {
  env,
  timeout: BOOT_TIMEOUT_MS,
})

if (boot.killed) {
  report('boot-failed', 'registered plugin timed out while booting the profile help surface', {
    install: { status: 'passed' },
    registration: { status: 'passed' },
    boot: { status: 'timeout' },
  }, { observed, outputDigest: digest(`${install.output}\n${boot.output}`) })
}

if (boot.code !== 0) {
  report('boot-failed', 'registered plugin caused the profile help surface to fail during boot', {
    install: { status: 'passed' },
    registration: { status: 'passed' },
    boot: { status: 'failed' },
  }, { observed, outputDigest: digest(`${install.output}\n${boot.output}`) })
}

report('passed', 'plugin installed, registered, and booted the profile help surface', {
  install: { status: 'passed' },
  registration: { status: 'passed' },
  boot: { status: 'passed' },
}, { observed, outputDigest: digest(`${install.output}\n${boot.output}`) })
