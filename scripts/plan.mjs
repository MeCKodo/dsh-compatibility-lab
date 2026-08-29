import { createHash } from 'node:crypto'
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const DEFAULT_CATALOG = 'https://deepseekplugin.org/registry/v1/catalog.json'
const DEFAULT_INDEX = 'registry/v1/index.json'
const DEFAULT_ENVIRONMENTS = 'config/environments.json'
const INSTALL = /^dsh plugin --profile ([A-Za-z0-9_.-]+) add (\S+)$/

export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

export function fingerprint(spec) {
  return createHash('sha256').update(canonical(spec)).digest('hex')
}

export function buildPlan({ catalog, index, environments, force = false, limit = 20, now = new Date() }) {
  if (!Array.isArray(catalog?.plugins)) throw new Error('catalog.plugins must be an array')
  if (!Array.isArray(index?.receipts)) throw new Error('index.receipts must be an array')
  if (!Array.isArray(environments?.environments) || !environments.environments.length) {
    throw new Error('environments.environments must be a non-empty array')
  }

  const previous = new Map(index.receipts.map((entry) => [entry.fingerprint, entry]))
  const include = []

  for (const plugin of catalog.plugins) {
    if (!plugin?.install || !plugin?.slug || !plugin?.name) continue
    const parsed = INSTALL.exec(plugin.install)
    if (!parsed) continue
    const [, profile] = parsed

    for (const environment of environments.environments) {
      const base = {
        schemaVersion: 1,
        plugin: {
          name: plugin.name,
          slug: plugin.slug,
          install: plugin.install,
          profile,
        },
        environment,
        runnerVersion: '1.0.0',
      }
      const id = fingerprint(base)
      const old = previous.get(id)
      const maxAgeDays = Number(environment.maxAgeDays || 7)
      const staleBefore = now.getTime() - maxAgeDays * 86_400_000
      const stale = !old?.testedAt || Date.parse(old.testedAt) < staleBefore
      if (!force && old && old.status !== 'inconclusive' && !stale) continue

      include.push({ spec: { ...base, fingerprint: id } })
      if (include.length >= limit) return { include }
    }
  }

  return { include }
}

async function loadJson(source) {
  if (/^https?:\/\//.test(source)) {
    const response = await fetch(source, { headers: { 'user-agent': 'dsh-compatibility-lab/1.0' } })
    if (!response.ok) throw new Error(`failed to fetch ${source}: HTTP ${response.status}`)
    return response.json()
  }
  return JSON.parse(await readFile(resolve(source), 'utf8'))
}

function args(argv) {
  const result = {
    catalog: process.env.CATALOG_URL || DEFAULT_CATALOG,
    index: DEFAULT_INDEX,
    environments: DEFAULT_ENVIRONMENTS,
    output: 'work/plan.json',
    force: process.env.FORCE === 'true',
    limit: Number(process.env.MAX_JOBS || 20),
  }
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i]
    if (value === '--force') result.force = true
    else if (value === '--catalog') result.catalog = argv[++i]
    else if (value === '--index') result.index = argv[++i]
    else if (value === '--environments') result.environments = argv[++i]
    else if (value === '--output') result.output = argv[++i]
    else if (value === '--limit') result.limit = Number(argv[++i])
    else throw new Error(`unknown argument: ${value}`)
  }
  if (!Number.isInteger(result.limit) || result.limit < 1 || result.limit > 100) {
    throw new Error('--limit must be an integer from 1 to 100')
  }
  return result
}

export async function main(argv = process.argv.slice(2)) {
  const options = args(argv)
  const [catalog, index, environments] = await Promise.all([
    loadJson(options.catalog),
    loadJson(options.index),
    loadJson(options.environments),
  ])
  const plan = buildPlan({
    catalog,
    index,
    environments,
    force: options.force,
    limit: options.limit,
  })
  const output = resolve(options.output)
  await mkdir(dirname(output), { recursive: true })
  await writeFile(output, `${JSON.stringify(plan, null, 2)}\n`)
  const compact = JSON.stringify(plan)
  if (process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT, `count=${plan.include.length}\nmatrix=${compact}\n`)
  }
  process.stdout.write(`${JSON.stringify({ count: plan.include.length, output: options.output })}\n`)
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.stack || error.message)
    process.exit(1)
  })
}
