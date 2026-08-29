import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { validateReceipt } from './publish-results.mjs'

const index = JSON.parse(await readFile(resolve('registry/v1/index.json'), 'utf8'))
if (index.schemaVersion !== 1 || !Array.isArray(index.receipts)) throw new Error('invalid registry index')

const fingerprints = new Set()
for (const entry of index.receipts) {
  if (fingerprints.has(entry.fingerprint)) throw new Error(`duplicate fingerprint: ${entry.fingerprint}`)
  fingerprints.add(entry.fingerprint)
  const receipt = JSON.parse(await readFile(resolve(entry.path), 'utf8'))
  validateReceipt(receipt)
  if (receipt.fingerprint !== entry.fingerprint) throw new Error(`index mismatch: ${entry.path}`)
  if (receipt.status !== entry.status) throw new Error(`status mismatch: ${entry.path}`)
}

process.stdout.write(`${JSON.stringify({ ok: true, receipts: index.receipts.length })}\n`)
