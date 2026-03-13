# Cartographer Roadmap

## Implementation Backlog Checklist

### Phase 0 - Foundation (in progress)
- [x] Convert the architecture into an implementation backlog checklist.
- [x] Bootstrap a TypeScript + Playwright project with a runnable CLI.
- [x] Add deterministic run initialization (`run_id`, run folders, metadata).
- [x] Define and validate a first-pass `UIStatePacket` schema.
- [x] Implement root-state capture (screenshots, HTML, a11y, visible text, interactive elements).
- [x] Implement a persistent state store with route+a11y / route+pHash dedupe indexes.
- [x] Add `UIStateAnalysis` schema and analyzer pipeline skeleton.

### Phase 1 - Explorer Core (safe mode)
- [x] Implement login flow + per-role `storageState` capture.
- [x] Build action candidate discovery from accessibility roles + common UI affordances.
- [x] Add action risk classifier (`safe`, `mutating`, `dangerous`) with allowlist/denylist controls.
- [x] Build queue-based exploration loop (BFS) for safe actions.
- [x] Add state transition detection (URL changes, modal/menu/toast appearance).
- [x] Add child-state recursion for modals, dialogs, menus, and drawers.
- [x] Add list/table handling policy (sample first N rows, pagination once, empty-state attempt).

### Phase 2 - Data Reliability + Coverage Controls
- [x] Implement composite state dedupe policy (`route_template` + a11y hash or pHash similarity).
- [x] Add run resume and crash recovery.
- [x] Add depth, breadth, and time budget controls so runs terminate predictably.
- [x] Add blocked-state capture with screenshot + URL + context for human hints.
- [x] Add role/config matrix execution support.

### Phase 3 - LLM Analysis Pipeline
- [ ] Add strict `UIStateAnalysis` JSON schema.
- [ ] Implement per-state analyzer call with evidence-grounded prompt template.
- [ ] Enforce evidence requirements (`artifact_id`, `element_id`, exact text) for every feature/checklist item.
- [ ] Add retries + schema validation + quarantine for invalid model outputs.
- [ ] Add optional second-pass normalization for taxonomy and feature dedupe.

### Phase 4 - Documentation Writer
- [ ] Implement deterministic file naming and canonical aliases for generated documentation assets.
- [ ] Implement generated block replacement (`BEGIN/END GENERATED:<block>`).
- [ ] Generate screen/overlay summaries with evidence, actions, forms, and checklists.
- [ ] Generate workflow summaries from edge sequences.
- [ ] Generate index artifacts (`Screens`, `Overlays`, `Workflows`, `Coverage Report`).

### Phase 5 - Graph Outputs
- [ ] Generate per-screen local neighbor maps.
- [ ] Generate per-module Mermaid maps with pruning.
- [ ] Generate per-role maps.
- [ ] Generate global primary and global full navigation maps with hard node/edge caps.
- [ ] Add graph legend and canonical link lists under each graph.

### Phase 6 - Workflow Mode + Deeper Coverage
- [ ] Add workflow mode for gated create/edit forms.
- [ ] Capture blank-submit validation error states.
- [ ] Add minimal-valid form fill heuristics and success-state capture.
- [ ] Add mutating-action safeguards and synthetic-data controls.

### Phase 7 - Reporting + Hardening
- [ ] Generate run-level coverage metrics (`nodes`, `overlays`, `actions discovered/executed`, dead ends, blocked states).
- [ ] Add sensitive-data redaction checks and artifact hygiene policies.
- [ ] Add regression smoke tests for capture, dedupe, and documentation generation.
- [ ] Add CI command set (`check`, `build`, smoke run).

## MVP Exit Criteria
- [ ] One role can run end-to-end in safe mode and produce at least 20 unique state templates.
- [ ] Every captured node has a valid packet, at least one screenshot, and one generated documentation artifact.
- [ ] Dedupe prevents obvious loops and collapses repeated templates.
- [ ] Coverage report and at least one module graph are generated.
