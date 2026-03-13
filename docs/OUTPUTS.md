# Outputs

## Output Root Layout

By default the project writes to `./output`. The top-level layout looks like this:

```text
output/
  auth/
    storage-state/
      <role>.storage-state.json
      <role>.storage-state.json.meta.json
  matrix/
    matrix-<timestamp>.json
  runs/
    <run-id>/
      run.json
      artifacts/
      packets/
      logs/
  state/
    graph-store.json
```

## Auth Artifacts

For each saved auth profile the project writes:

- `<role>.storage-state.json`: raw Playwright browser auth state
- `<role>.storage-state.json.meta.json`: capture metadata such as role, login URL, and final URL

Treat both files as sensitive.

## Run Metadata

Each run directory contains metadata described by [`src/run/initialize-run.ts`](../src/run/initialize-run.ts):

- `run_id`
- `role`
- `label`
- `started_at`

The run ID format is:

```text
<UTC timestamp>-<role-slug>-<label-slug>
```

Example:

```text
20260312T231455Z-viewer-safe-bfs
```

## Artifacts Directory

Each capture gets its own artifact folder under `artifacts/`. The capture currently writes:

- `full.png`
- `viewport.png`
- `snapshot.html`
- `a11y.txt`

These files are referenced by relative path from the packet JSON.

## Packets Directory

The packets directory contains:

- `<node-id>.packet.json` for seed capture
- `<capture-id>-<node-id>.actions.json` for action candidate manifests
- packet files written by the safe explorer as it captures new states

The `UIStatePacket` schema includes:

- capture metadata
- node identity and fingerprints
- artifact descriptors
- visible text sample
- accessibility text
- interactive elements
- optional list and table metadata

See [`src/contracts/state-packet.ts`](../src/contracts/state-packet.ts) for the exact schema.

## Logs Directory

The safe explorer writes two important files under `logs/`:

- `safe-bfs-checkpoint.json`: queue and progress snapshot for resume support
- `safe-bfs-summary.json`: run summary with crawl metrics and blocked-action history

Summary metrics include:

- explored nodes
- discovered nodes
- actions considered
- actions executed
- actions blocked
- no-transition actions
- edges inserted
- packets written
- overlays explored
- list probes attempted
- blocked-state artifacts

## Graph Store

The file-backed store lives at `output/state/graph-store.json`.

It persists:

- deduplicated nodes
- edges between nodes
- route plus accessibility indexes
- route plus pHash indexes
- a route-to-node lookup
- edge dedupe index

Node records include:

- `node_id`
- `state_type`
- `route_template`
- title candidates
- observed URLs
- fingerprint hashes
- roles seen
- run IDs seen
- packet paths
- first and last seen timestamps

Edge records include:

- `from_node_id`
- `to_node_id`
- `action_type`
- `action_label`
- optional `element_id`
- optional `risk`
- `first_seen_at`

## Stub Analysis Output

`analyze-stub` writes a `UIStateAnalysis` JSON file next to the packet unless you provide `--out`.

The stub output contains:

- proposed screen title
- module candidates
- inferred key entities
- feature list
- outgoing actions
- replication checklist
- exploration hints

See [`src/contracts/state-analysis.ts`](../src/contracts/state-analysis.ts) for the exact schema.
