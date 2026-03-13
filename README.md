# Cartographer

Cartographer is a Playwright-based CLI for mapping authenticated web applications. It captures UI states, screenshots, DOM and accessibility snapshots, discovers interactive controls, explores safe paths with a breadth-first crawler, and persists a deduplicated state graph on disk.

This branch is intentionally product-neutral. Nothing in the runtime assumes a specific vendor, domain, or app category. The target can be any web app you can access with Playwright.

## Current Scope

Implemented today:

- Per-role Playwright `storageState` capture for authenticated sessions
- Single-state seed capture with screenshots, DOM, accessibility text, route normalization, and action candidate generation
- Safe breadth-first exploration with queueing, overlays, list and table heuristics, checkpoints, and resumability
- File-backed state store with route plus accessibility and pHash deduplication
- Matrix execution across roles or configurations
- Schema-validated stub analysis generation for captured state packets

Not implemented yet:

- Production LLM analysis pipeline
- Workflow mode for controlled mutating paths
- Markdown or knowledge-base export layer
- Automated sensitive-data or PII redaction

## Requirements

- Node.js 20+ recommended
- `npm`
- Playwright Chromium installed with `npx playwright install chromium`

## Install

```bash
npm install
npx playwright install chromium
npm run build
```

## Quick Start

1. Capture auth state for a role. Use manual mode if the app requires MFA, SSO, captcha, or a non-standard login flow.

```bash
npm run auth:save-state -- \
  --role viewer \
  --login-url https://app.example.com/login \
  --manual \
  --headed \
  --post-login-selector "[data-app-shell]"
```

2. Run a safe crawl from a known landing page.

```bash
npm run crawl:safe -- \
  --role viewer \
  --start-url https://app.example.com/app \
  --max-states 40 \
  --max-depth 6 \
  --row-sample-size 3 \
  --deny-action "delete|refund|archive"
```

3. Inspect the store summary.

```bash
npm run store:status
```

4. Generate a stub analysis for a captured packet if you want schema-valid downstream test data.

```bash
npm run analyze:stub -- \
  --packet output/runs/<run-id>/packets/<node-id>.packet.json
```

## Credential Conventions

Scripted login resolves credentials in this order:

1. Explicit `--username-env` and `--password-env`
2. `CARTOGRAPHER_<ROLE>_USERNAME` and `CARTOGRAPHER_<ROLE>_PASSWORD`
3. `CARTOGRAPHER_USERNAME` and `CARTOGRAPHER_PASSWORD`

Examples:

```bash
export CARTOGRAPHER_VIEWER_USERNAME="user@example.com"
export CARTOGRAPHER_VIEWER_PASSWORD="secret"
```

```bash
export CARTOGRAPHER_USERNAME="shared@example.com"
export CARTOGRAPHER_PASSWORD="secret"
```

## Output Root

Set `CARTOGRAPHER_OUTPUT_ROOT` to move all generated artifacts, auth state, runs, matrix reports, and the graph store.

```bash
export CARTOGRAPHER_OUTPUT_ROOT="$PWD/output"
```

If unset, output defaults to `./output`.

## Safe Crawling Model

The crawler classifies discovered actions into three buckets:

- `safe`: navigation, tab switches, menus, non-destructive reads
- `mutating`: create, save, update, send, import, upload, invite
- `dangerous`: delete, revoke, reset, refund, purchase, deploy, publish, merge

By default:

- safe actions are executable
- mutating actions are blocked
- dangerous actions are blocked

You can selectively loosen that behavior with `--allow-mutating`, `--allow-dangerous`, `--allow-action`, and `--deny-action`. The safest operating pattern is still to crawl against staging or seeded test accounts.

## Typical Workflow

1. Save auth state for one or more roles.
2. Run `crawl-seed` if you want a single packet before a wider crawl.
3. Run `crawl-safe` for one role or `crawl-matrix` for multiple roles or configurations.
4. Inspect `output/state/graph-store.json` and per-run summaries.
5. Feed packets into `analyze-stub` or your own downstream analysis pipeline.

## Example Matrix

See [matrix.plan.example.json](./matrix.plan.example.json) for a minimal multi-role crawl plan.

Run it with:

```bash
npm run crawl:matrix -- --file matrix.plan.example.json
```

## Documentation Map

- [docs/cli.md](./docs/cli.md): command reference and examples
- [docs/CONFIGURATION.md](./docs/CONFIGURATION.md): env vars, role naming, matrix configuration, and crawl tuning
- [docs/architecture.md](./docs/architecture.md): internal pipeline, packet model, dedupe strategy, and explorer behavior
- [docs/OUTPUTS.md](./docs/OUTPUTS.md): output directory layout and file formats
- [docs/SAFETY.md](./docs/SAFETY.md): operational guidance for safe crawling
- [PLAN.md](./PLAN.md): implementation roadmap

## Repository Scripts

- `npm run build`: compile TypeScript
- `npm run check`: run TypeScript typechecking without emitting files
- `npm run auth:save-state`: save Playwright auth state
- `npm run run:init`: create an empty run directory
- `npm run crawl:seed`: capture one seed state and action list
- `npm run crawl:safe`: run the safe BFS explorer
- `npm run crawl:matrix`: execute a crawl matrix plan
- `npm run analyze:stub`: generate schema-valid stub analysis
- `npm run store:status`: print graph store counts

## Notes

- The current implementation writes raw HTML and screenshots to disk. It does not redact sensitive content.
- Route normalization collapses numeric, UUID-like, long-hex, and date path segments into templates such as `/users/{id}` or `/reports/{date}`.
- The analysis step is intentionally minimal. It is present to validate schemas and unblock downstream integration work, not to serve as a final documentation writer.
