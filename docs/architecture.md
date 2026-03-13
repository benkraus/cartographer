# Architecture

## Overview

Cartographer is organized as a small set of file-first pipeline stages:

1. authenticate and save Playwright `storageState`
2. capture a `UIStatePacket`
3. discover action candidates from the rendered UI
4. explore new states with a safe breadth-first crawler
5. deduplicate nodes and persist edges in the graph store
6. optionally generate a stub `UIStateAnalysis`

The implementation is intentionally conservative. It is designed to create durable crawl artifacts first and leave richer analysis and documentation export as follow-on phases.

## Core Modules

### CLI

[`src/cli.ts`](../src/cli.ts) is the orchestration layer. It:

- parses command-line options
- loads shared config
- resolves auth state paths
- enforces resume behavior
- dispatches into capture, crawl, matrix, and analysis flows

### Auth Capture

[`src/auth/save-storage-state.ts`](../src/auth/save-storage-state.ts) launches Chromium, opens the login page, and saves `storageState`. It supports:

- manual login for SSO or MFA-heavy apps
- scripted login with configurable selectors
- post-login confirmation by URL pattern or visible selector

### State Capture

[`src/explorer/capture-state.ts`](../src/explorer/capture-state.ts) creates a packet for the current page state. Each capture includes:

- full-page screenshot
- viewport screenshot
- raw HTML snapshot
- accessibility text snapshot
- visible text sample
- interactive element inventory
- detected tables and lists
- route template and page fingerprint hashes

The packet is validated against [`src/contracts/state-packet.ts`](../src/contracts/state-packet.ts).

## State Identity and Dedupe

Route normalization happens in [`src/explorer/fingerprint.ts`](../src/explorer/fingerprint.ts). It replaces:

- numeric path segments with `{id}`
- UUID-like or long-hex segments with `{id}`
- `YYYY-MM-DD` segments with `{date}`
- query values with `{value}` while preserving sorted query keys

Example:

- `/users/42/profile` -> `/users/{id}/profile`
- `/reports/2026-03-12?team=west&view=weekly` -> `/reports/{date}?team={value}&view={value}`

The file-backed store in [`src/store/file-state-store.ts`](../src/store/file-state-store.ts) deduplicates nodes using:

- exact `route_template + a11y_hash`
- exact `route_template + shortened phash`
- nearest pHash match within the same route and state type

This gives the crawler a way to collapse repeated renders without requiring exact DOM equality.

## Interactive Element Discovery

[`src/explorer/discovery.ts`](../src/explorer/discovery.ts) scans the live DOM for likely controls, including:

- anchors
- buttons
- submit inputs
- checkboxes and radios
- selects and textareas
- common ARIA interactive roles

For each discovered control, it records:

- a deterministic `element_id`
- role
- visible name
- locator strategy
- visibility and enabled state
- candidate action types
- a risk guess

Candidate action types include `click`, `select`, `type`, `submit`, and `open_menu`.

## Action Model

[`src/explorer/action-candidates.ts`](../src/explorer/action-candidates.ts) converts interactive elements into executable or blocked action candidates. Each candidate includes:

- an `action_id`
- a human-readable `action_label`
- a risk level
- an expected result type
- an execution decision with an optional skip reason

The current runtime supports the following risk tiers:

- `safe`
- `mutating`
- `dangerous`
- `unknown`

The policy model is simple by design:

- safe actions execute
- mutating actions require explicit enablement
- dangerous actions require explicit enablement
- allow and deny regex patterns can override the defaults

## Explorer Loop

[`src/explorer/safe-bfs-explorer.ts`](../src/explorer/safe-bfs-explorer.ts) implements the main crawl loop.

Behavior:

- launches Chromium with optional `storageState`
- captures the root state
- enqueues screen states for BFS traversal
- writes action manifests per captured state
- explores overlays recursively with a separate overlay-action budget
- probes list and table UIs with row sampling
- prioritizes pagination and empty-state probes when enabled
- checkpoints queue and summary state under `logs/`

The explorer stops when any of these budgets are exhausted:

- `max_states`
- `max_depth`
- `max_queue_size`
- `max_runtime_ms`

## Lists and Tables

[`src/explorer/table-detection.ts`](../src/explorer/table-detection.ts) extracts lightweight metadata for tables and lists:

- title when detectable
- column labels
- presence of row actions
- pagination hints
- filter hints

The safe explorer uses that metadata to prioritize representative coverage rather than trying to enumerate every row in a data-heavy interface.

## Analysis Layer

[`src/contracts/state-analysis.ts`](../src/contracts/state-analysis.ts) defines the analysis schema, and [`src/analyzer/stub-analyzer.ts`](../src/analyzer/stub-analyzer.ts) generates placeholder output from a packet.

The stub exists to:

- validate downstream integrations
- test schema shape
- produce deterministic placeholder data

It is not meant to be a final product analyst. Replacing it with a grounded analyzer is tracked in [`PLAN.md`](../PLAN.md).

## Design Constraints

Current intentional constraints:

- Chromium only
- file-backed persistence only
- no true form automation beyond generic control discovery
- no redaction layer
- no built-in documentation exporter yet

Those constraints keep the existing implementation stable and auditable while the crawler and data model harden.
