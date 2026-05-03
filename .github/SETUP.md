# Repo setup notes

These are one-time configuration steps that live outside source control —
GitHub UI settings, secret values, branch protection rules. Captured here
so they don't drift silently and so a fresh maintainer (or a fresh fork)
knows what to enable.

## Branch protection on `main`

The repo accepts automated PRs from two sources:

- **Changesets bot** — opens a `chore: version packages` PR every time a
  changeset lands on `main`. Merging it ships to npm.
- **gitenv subtree sync** — opens "Sync from gitenv main" PRs from the
  `gitenv-upstream` branch every time a downstream commit touches
  `vendor/spawntree/**` in [GitStartHQ/gitenv](https://github.com/GitStartHQ/gitenv).
  Force-pushed to that branch as new gitenv merges land; the PR is
  amended in place, not closed and re-opened.

Both are pre-vetted (CI + Devin Review on each side), but they touch
real code. A human should ack each merge.

To enforce that, configure the following on `main`:

1. **Require a pull request before merging** → on
2. **Require approvals** → 1
3. **Require review from Code Owners** → on
4. **Require status checks to pass before merging** → on
   - Required checks: `test (ubuntu-latest, 20)`, `test (ubuntu-latest, 22)`,
     `test (macos-latest, 20)`, `test (macos-latest, 22)`, `Devin Review`
5. **Require conversation resolution before merging** → on (catches
   "I left a question, please don't merge yet" comments).
6. **Do not allow bypassing the above settings** → on

`.github/CODEOWNERS` defines the owner that the rule looks up. Without
the rule, CODEOWNERS is informational only — GitHub auto-assigns a
review request but doesn't gate the merge.

## Workflows that need secrets

- `release.yml` uses `NPM_TOKEN` (granular access, write to spawntree
  packages, no other scopes). Rotate yearly.
- The gitenv-side `vendor/spawntree` sync workflow uses a fine-grained
  PAT scoped to this repo's `contents: write` + `pull-requests: write`.
  Stored as `SPAWNTREE_SYNC_PAT` on the gitenv side, NOT here.

## Adding new automated PR sources

Anything that opens PRs without a human-on-both-ends review (e.g. another
downstream subtree, a Renovate-style updater, a generated-docs flow)
should:

1. Use a service-account or bot identity with a recognizable login
   (`*-bot`, `dependabot[bot]`, etc.).
2. Be added to the required-status-checks list above if it has its own
   verification job.
3. Be exempted from CODEOWNERS only if its scope is genuinely ignorable
   (e.g. lockfile-only updates). Wide-scope flows stay gated.
