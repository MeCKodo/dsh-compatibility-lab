# DSH Compatibility Lab

Public, reproducible compatibility evidence for DeepSeek Harness plugins.

This repository watches the public DeepseekPlugin Registry, schedules only new or stale
plugin/environment fingerprints, installs each plugin in a disposable unprivileged
container, verifies what DSH recorded in the profile manifest, boots the profile help
surface, and publishes bounded JSON receipts under `registry/v1/`.

## What is verified

- the exact published install command resolves;
- DSH records the package as a profile bundle;
- the selected DSH host version can boot its help surface with the plugin registered;
- build-script approval, non-layer packages, timeouts, host throttling, and defects remain
  separate outcomes.

This is compatibility evidence for one exact artifact and environment. It is not a
security review and does not claim that every feature works.

## Automation

The scheduled workflow runs every six hours. A planner compares the current public catalog
with fresh receipts, then emits at most 20 plugin/environment jobs. Unchanged fingerprints
are reused for seven days. Every untrusted install runs in a job with no secrets and inside
a disposable Docker container. A separate trusted job accepts only strict JSON receipts,
updates the public Registry, and can trigger the private site's Cloudflare build.

## Local development

```bash
npm ci --ignore-scripts
npm test
node scripts/plan.mjs --catalog ./test/fixtures/catalog.json
```

Running a real probe requires Docker and executes third-party package install scripts. Do
that only in a disposable, credential-free environment.

## Public Registry

- Index: `registry/v1/index.json`
- Per-environment receipts: `registry/v1/plugins/<slug>/<environment>.json`
- Receipt contract: `schema/receipt.schema.json`

## Attribution

The container probe is derived from the MIT-licensed
[`DshMarketPlace/dsh-plugin-validator`](https://github.com/DshMarketPlace/dsh-plugin-validator).
See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## License

MIT
