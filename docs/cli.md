# CLI Reference

All commands are implemented in [`src/cli.ts`](../src/cli.ts). You can run them either through the npm scripts in [`package.json`](../package.json) or directly with `tsx src/cli.ts`.

For script-based execution, pass command arguments after `--`.

```bash
npm run crawl:safe -- --role viewer --start-url https://app.example.com/app
```

## `auth-save-state`

Purpose:

- open the login page
- complete login manually or with provided credentials
- persist Playwright `storageState` for a role

Required options:

- `--role <role>`
- `--login-url <url>`

Important options:

- `--manual`: do the login in the browser yourself
- `--headed`: run Chromium with a visible window
- `--out <path>`: override the default storage-state file
- `--timeout-ms <ms>`: login timeout, default `120000`
- `--post-login-url <pattern>`: glob or pattern that confirms login
- `--post-login-selector <selector>`: selector that confirms login
- `--username-env <env>` and `--password-env <env>`: explicit credential env vars
- `--username-selector <selector>`
- `--password-selector <selector>`
- `--submit-selector <selector>`
- `--submit-enter`: submit by pressing Enter in the password field

Examples:

Manual login:

```bash
npm run auth:save-state -- \
  --role viewer \
  --login-url https://app.example.com/login \
  --manual \
  --headed \
  --post-login-selector "[data-app-shell]"
```

Scripted login:

```bash
export CARTOGRAPHER_VIEWER_USERNAME="user@example.com"
export CARTOGRAPHER_VIEWER_PASSWORD="secret"

npm run auth:save-state -- \
  --role viewer \
  --login-url https://app.example.com/login \
  --post-login-url "**/app/**"
```

## `init-run`

Purpose:

- create a run directory without starting a crawl

Required options:

- `--role <role>`

Optional:

- `--label <label>`: default `seed`

Example:

```bash
npm run run:init -- --role viewer --label smoke
```

## `crawl-seed`

Purpose:

- visit a start URL
- capture a single `UIStatePacket`
- generate action candidates for that state
- insert the packet into the file-backed store

Required options:

- `--role <role>`
- `--start-url <url>`

Important options:

- `--label <label>`: default `seed`
- `--storage-state <path>`: override role-based storage-state lookup
- `--headed`
- `--allow-mutating`
- `--allow-dangerous`
- `--allow-action <pattern>`: repeatable
- `--deny-action <pattern>`: repeatable

Example:

```bash
npm run crawl:seed -- \
  --role viewer \
  --start-url https://app.example.com/app \
  --deny-action "delete|archive"
```

## `crawl-safe`

Purpose:

- run the safe breadth-first explorer from a start URL
- persist packets, action manifests, summaries, and checkpoints
- update the graph store with nodes and edges

Required options:

- `--role <role>`
- `--start-url <url>`

Important options:

- `--label <label>`: default `safe-bfs`
- `--resume-run <runId>`: reuse an existing run and checkpoint
- `--storage-state <path>`
- `--headed`
- `--max-states <n>`: default `30`
- `--max-actions-per-state <n>`: default `20`
- `--max-overlay-actions <n>`: default `8`
- `--overlay-depth <n>`: default `2`
- `--max-depth <n>`: default `6`
- `--max-queue-size <n>`: default `200`
- `--max-runtime-minutes <n>`: default `30`
- `--row-sample-size <n>`: default `3`
- `--disable-empty-state-probe`
- `--disable-pagination-probe`
- `--allow-mutating`
- `--allow-dangerous`
- `--allow-action <pattern>`
- `--deny-action <pattern>`

Example:

```bash
npm run crawl:safe -- \
  --role admin \
  --start-url https://app.example.com/admin \
  --max-states 60 \
  --max-depth 8 \
  --deny-action "delete|reset|refund"
```

## `crawl-matrix`

Purpose:

- execute `crawl-safe` repeatedly using a JSON plan
- merge defaults with per-entry overrides
- emit a matrix report under `output/matrix`

Required options:

- `--file <path>`

Important options:

- `--headed`: force headed mode for every entry
- `--continue-on-error`: keep processing after failures
- `--limit <n>`: stop after the first `n` entries

Example:

```bash
npm run crawl:matrix -- --file matrix.plan.example.json --continue-on-error
```

## `analyze-stub`

Purpose:

- read a `UIStatePacket`
- generate a schema-valid placeholder `UIStateAnalysis`

Required options:

- `--packet <path>`

Optional:

- `--out <path>`

Example:

```bash
npm run analyze:stub -- \
  --packet output/runs/<run-id>/packets/<node-id>.packet.json
```

## `store-status`

Purpose:

- print node and edge counts from the graph store as JSON

Example:

```bash
npm run store:status
```

## Help Output

Commander provides command help automatically. For the latest options, run:

```bash
npm run crawl:safe -- --help
```

The CLI uses `CARTOGRAPHER_*` environment variables for scripted login and output configuration.
