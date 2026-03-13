# Safety Guidance

## Use the Right Environment

Recommended targets:

- staging
- sandbox
- demo tenants
- seeded QA accounts
- disposable development environments

Avoid running broad crawls against production unless you have already proven the app has no hidden write-on-read behavior and you are comfortable storing screenshots and HTML locally.

## Default Risk Model

The crawler labels actions as:

- `safe`
- `mutating`
- `dangerous`

Defaults:

- safe actions run
- mutating actions are blocked
- dangerous actions are blocked

This is intentionally conservative but not perfect. Action labels are inferred from text, role, and common verbs. Any app with misleading button labels can still surprise you.

## Defensive Operating Practices

Use these by default:

1. Start with `crawl-seed` to inspect one packet before a full crawl.
2. Run `crawl-safe` with small budgets first.
3. Add app-specific `--deny-action` patterns early.
4. Prefer manual auth capture for complex login flows.
5. Use dedicated test accounts with the minimum permissions needed.

Good deny-pattern starters:

```text
delete|destroy|archive|reset|refund|purchase|pay|deploy|publish|merge|revoke
```

## Sensitive Data

The current implementation writes raw artifacts:

- screenshots
- HTML
- accessibility text
- visible UI text
- auth state

There is no built-in redaction. If the app contains sensitive data, you need external safeguards:

- use test data
- use isolated output storage
- encrypt or tightly control the output directory
- delete artifacts after review if they are not needed

## Session Handling

`storageState` files can represent an authenticated browser session. Treat them like credentials:

- do not commit them
- do not share them casually
- rotate them if a crawl machine is compromised
- keep per-role auth state separate

## Scope Control

Use crawl limits aggressively:

- `--max-states`
- `--max-depth`
- `--max-actions-per-state`
- `--max-runtime-minutes`

Low initial settings reduce blast radius and help you learn the app's navigation topology before expanding coverage.

## Resume with Care

Checkpoint resume is convenient, but remember:

- the underlying app may have changed since the checkpoint was written
- auth state may have expired
- UI ordering can shift, especially in dynamic dashboards

If a resumed crawl behaves oddly, start a fresh run instead of assuming the checkpoint is still trustworthy.

## Known Safety Gaps

Current gaps to account for operationally:

- risk classification is heuristic, not semantic
- there is no rate limiting layer
- there is no automated redaction
- there is no domain-specific workflow guardrail system yet
- there is no screenshot masking or selector-based suppression

Those gaps are acceptable for controlled environments, but they are not enough for unattended production crawling.
