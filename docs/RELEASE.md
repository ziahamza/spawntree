# Releasing spawntree

Releases are **fully automatic**, via the [`.github/workflows/release.yml`](../.github/workflows/release.yml) GitHub Actions workflow, driven by [Changesets](https://github.com/changesets/changesets). There is no manual `pnpm changeset` step and no "Version Packages" PR.

## Day-to-day flow

On every push to `main` (typically the merge of the `gitenv-upstream` sync PR), the Release workflow:

1. Runs [`.github/scripts/auto-changeset.mjs`](../.github/scripts/auto-changeset.mjs), which reads the pushed commit range and maps commits → packages (by changed file path) → semver bump (by [Conventional Commits](https://www.conventionalcommits.org/) type), then writes one `.changeset/auto-<sha>.md`:
   - `feat` → **minor**; `fix` / `perf` / `refactor` / `revert` → **patch**; a `!` after the type/scope or a `BREAKING CHANGE:` / `BREAKING-CHANGE:` footer → **major**.
   - A public package touched without any conventional bump gets a **patch** (so real changes always ship).
   - `private` packages and those in the changesets `ignore` list are skipped.
   - The bump per package is the highest seen across the range. Squash-merge bodies are scanned too, so the original commit subjects still drive the bump.
2. Runs `pnpm changeset version` + `pnpm changeset publish` inline, then pushes the `chore: version packages [skip-release]` commit and the new tags back to `main`. The `[skip-release]` tag is how the workflow's own version commit avoids re-triggering itself (a job-level `if:` guard).

You can still add a hand-written `.changeset/*.md` for cases the heuristic shouldn't decide on its own — it's consumed alongside the auto-generated one.

### Dry run

Trigger the **Release** workflow manually (`workflow_dispatch`) to print the generated changeset and `changeset status` **without** publishing. Manual runs are always dry-run — the publish step only runs on a real push to `main`.

### Pushing the version commit (branch protection)

The workflow pushes the version commit + tags straight to `main`. If `main` has branch protection, the default `GITHUB_TOKEN` cannot push past it — the run would fail **after** publishing to npm (a painful partial state). In that case, set a `RELEASE_PUSH_TOKEN` repo secret (a PAT with `contents: write` that can bypass the protection); the checkout step prefers it and falls back to `GITHUB_TOKEN` when it's absent.

## Brand-new packages (first publish)

A package whose name does not yet exist on npm is handled so it never breaks a release: it's left out of the auto-generated changeset, AND the publish step marks it private for that run only (`.github/scripts/skip-unpublished.mjs`) so `changeset publish` doesn't attempt its first-publish — npm automation tokens cannot create new packages (see the next section). The workflow lists it under `NEW_PACKAGES`. Publish it once manually, then every future bump is automatic.

## When `NPM_TOKEN` can't publish a package

Two situations will stop a CI publish:

1. **Brand-new package name, automation token.** Legacy automation tokens can't create new packages on npm accounts that have "Require 2FA for package creation" enabled. Updates to existing packages work — only the initial `npm publish` of a never-seen name hits 403.
2. **Granular token's package allowlist is narrower than `All packages`.** Granular tokens bound to specific package names can update those packages but reject any others — including ones added after the token was issued.

Either way, pick one of the three remediations below. Long term, (B) is the setup that keeps CI publishes painless; (C) removes the long-lived token entirely.

### A. One-time manual publish (fastest, ~30 seconds)

From a workstation where you're logged into npm with 2FA:

```sh
git pull
cd packages/<name>
npm publish --access public
```

Future bumps of the same package go through the workflow automatically (assuming the CI token's scope covers the name — see B).

Note: `--provenance` only works from CI (it needs the runner's OIDC identity). Omit it for local publishes.

### B. Use a Granular Access Token with `All packages` (recommended default)

Granular tokens with `Read and write` + `All packages` skip the "2FA for package creation" restriction AND automatically cover any new packages added later. That's the configuration `NPM_TOKEN` should be in.

1. Go to https://www.npmjs.com/settings/~/tokens/granular-access-tokens/new
2. Name: `spawntree GitHub Actions`
3. Expiration: 1 year (set a calendar reminder to rotate; update the comment in `release.yml`)
4. Permissions: `Read and write`
5. Packages and scopes: `All packages`
6. Allowed IPs: leave blank
7. Copy the token, update the `NPM_TOKEN` secret at https://github.com/ziahamza/spawntree/settings/secrets/actions

### C. OIDC trusted publishing (post first-publish, removes the long-lived token)

The workflow already has `id-token: write` + `NPM_CONFIG_PROVENANCE=true` wired up. After a package's first publish, configure trusted publishing on npm per-package:

1. Go to `https://www.npmjs.com/package/<name>/settings`
2. Scroll to "Trusted publishers" → "Add trusted publisher"
3. Publisher: GitHub Actions
4. Organization/repo: `ziahamza/spawntree`
5. Workflow filename: `release.yml`
6. (Optional) Environment: leave blank unless you later add a `release` environment gate

Once trusted publishing is set up, the workflow publishes that package without `NPM_TOKEN` at all — the ephemeral OIDC token takes over, and consumers get signed build provenance for free (verify with `npm audit signatures`).

## Diagnostic: has a package been published?

```sh
npm view <package-name> version
# → 404 means the name is unclaimed; first publish needs elevated credentials (A or B)
# → a version string means the package exists; check the CI token's allowlist (B)
```

The workflow's `Check for unpublished packages` step does this for every public package in `packages/*` before attempting to publish, and surfaces the list as a build summary so you know what needs attention if the run fails.

## Release history on record

For future maintainers: both times the release workflow has 403'd on `spawntree-host`, the fix was a manual publish from a workstation with the granular publish token (`npm publish --access public`). `0.2.0` landed via the rename in [#27](https://github.com/ziahamza/spawntree/pull/27); `0.2.1` followed when [#28](https://github.com/ziahamza/spawntree/pull/28) merged. The CI token in use at the time was scoped to the older packages and didn't cover the new name — remediation (B) above makes this class of failure go away.
