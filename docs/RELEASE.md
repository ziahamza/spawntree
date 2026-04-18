# Releasing spawntree

Releases go out via the [`.github/workflows/release.yml`](../.github/workflows/release.yml) GitHub Actions workflow, driven by [Changesets](https://github.com/changesets/changesets).

## Day-to-day flow

1. When you land a user-facing change, add a changeset:

   ```sh
   pnpm changeset
   ```

   Pick which packages bump and at what level. Commit the generated `.changeset/*.md` file alongside the change.

2. On every push to `main`, the Release workflow runs. If there are pending changesets on `main`, it opens (or updates) the `chore: version packages` PR. Merging that PR publishes the new versions to npm.

3. If there are NO pending changesets but some package's `version` in `package.json` isn't on npm yet, the workflow tries to publish it. This is the path that catches brand-new packages.

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
