# Configuration

## Environment Variables

Recognized environment variables:

- `CARTOGRAPHER_OUTPUT_ROOT`: base directory for all generated output
- `CARTOGRAPHER_<ROLE>_USERNAME`: role-specific username for scripted login
- `CARTOGRAPHER_<ROLE>_PASSWORD`: role-specific password for scripted login
- `CARTOGRAPHER_USERNAME`: shared fallback username for scripted login
- `CARTOGRAPHER_PASSWORD`: shared fallback password for scripted login

Examples:

```bash
export CARTOGRAPHER_OUTPUT_ROOT="$PWD/output"
export CARTOGRAPHER_ADMIN_USERNAME="admin@example.com"
export CARTOGRAPHER_ADMIN_PASSWORD="secret"
```

## Role Naming

Roles are free-form strings, but they are normalized in two different ways:

- file and run identifiers use a lowercase dash slug such as `ops-user` or `read-only`
- credential lookup uses an uppercase underscore token such as `FRONT_DESK` or `READ_ONLY`

Examples:

- `viewer` -> file slug `viewer`, env token `VIEWER`
- `qa admin` -> file slug `qa-admin`, env token `QA_ADMIN`
- `read_only` -> file slug `read-only`, env token `READ_ONLY`

Choose stable role labels because they become part of output paths, run IDs, and credential variable names.

## Output Paths

If `CARTOGRAPHER_OUTPUT_ROOT` is not set, output defaults to `./output`.

The project writes:

- auth state under `output/auth/storage-state`
- runs under `output/runs`
- matrix reports under `output/matrix`
- state store under `output/state/graph-store.json`

## Storage-State Resolution

When a crawl command needs auth state, resolution happens in this order:

1. `--storage-state <path>` if provided
2. default role path under `output/auth/storage-state/<role-slug>.storage-state.json`
3. no auth state, if neither file exists

That last case is valid for public pages or apps where the start URL is already accessible.

## Matrix Plan Shape

The matrix loader validates [`matrix.plan.example.json`](../matrix.plan.example.json) against the schema in [`src/run/matrix-plan.ts`](../src/run/matrix-plan.ts).

Top-level fields:

- `matrix_version`: optional, current example uses `1.0`
- `default_label`: optional run-label prefix
- `defaults`: optional defaults for all entries
- `entries`: required array of crawl entries

Supported `defaults` fields:

- `limits`
- `policy`
- `probes`
- `headed`
- `resume_from_checkpoint`

Supported per-entry fields:

- `role`
- `start_url`
- `label`
- `config_label`
- `storage_state_path`
- `limits`
- `policy`
- `probes`

`storage_state_path` inside the matrix file is resolved relative to the directory containing the matrix file unless it is already absolute.

## Limit Tuning

Practical starting values for a medium-size app:

- `max_states`: `30` to `60`
- `max_actions_per_state`: `10` to `20`
- `max_overlay_actions`: `4` to `8`
- `overlay_depth`: `1` to `2`
- `max-depth`: `4` to `8`
- `max-queue-size`: `100` to `250`
- `max-runtime-minutes`: `15` to `45`
- `row-sample-size`: `2` to `5`

Increase limits gradually. The crawler is breadth-first, so a small increase in per-state actions can multiply the total frontier quickly.

## Action Policy Tuning

Available policy inputs:

- `allow_mutating`
- `allow_dangerous`
- `allow_label_patterns`
- `deny_label_patterns`

Recommended approach:

1. Start with defaults.
2. Add `deny_label_patterns` for app-specific destructive verbs.
3. Only allow mutating actions when you are using seeded test data.
4. Prefer a narrow `allow_label_patterns` override over globally enabling dangerous actions.

Example matrix policy snippet:

```json
{
  "policy": {
    "allow_mutating": false,
    "allow_dangerous": false,
    "deny_label_patterns": ["delete", "reset", "refund"]
  }
}
```

## Start URL Selection

Good start URLs:

- a stable post-login landing page
- a module dashboard
- an internal area with obvious navigation controls

Avoid:

- deep detail pages with volatile IDs unless they are the exact area you need
- routes that trigger expensive background jobs
- routes that perform immediate writes on load
