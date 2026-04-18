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

## First-publish of a brand-new package

Automation tokens **cannot** create new packages on npm accounts that have "Require 2FA for package creation" enabled. Updates to existing packages go through fine — only the initial `npm publish` of a never-seen name hits 403.

Three ways to handle this, in order of preference:

### A. One-time manual publish (fastest, 30 seconds)

From a workstation where you're logged into npm with 2FA:

```sh
git pull
cd packages/<name>
npm publish --access public --provenance
```

Future bumps of the same package go through the workflow automatically.

### B. Rotate `NPM_TOKEN` to a Granular Access Token

Automation tokens are the legacy path. Granular tokens with `Read and write` + `All packages` scope bypass the "2FA for package creation" restriction and work end-to-end in CI.

1. Go to https://www.npmjs.com/settings/~/tokens/granular-access-tokens/new
2. Name: `spawntree GitHub Actions`
3. Expiration: 1 year (set a calendar reminder to rotate; update the comment in `release.yml`)
4. Permissions: `Read and write`
5. Packages and scopes: `All packages`
6. Allowed IPs: leave blank
7. Copy the token, update the `NPM_TOKEN` secret in https://github.com/ziahamza/spawntree/settings/secrets/actions

### C. OIDC trusted publishing (post first-publish)

The workflow already has `id-token: write` + `NPM_CONFIG_PROVENANCE=true` wired up. After a package's first publish, configure trusted publishing on npm:

1. Go to `https://www.npmjs.com/package/<name>/settings`
2. Scroll to "Trusted publishers" → "Add trusted publisher"
3. Publisher: GitHub Actions
4. Organization/repo: `ziahamza/spawntree`
5. Workflow filename: `release.yml`
6. (Optional) Environment: leave blank unless you later add a `release` environment gate

Once trusted publishing is set up, the workflow can publish that package without `NPM_TOKEN` at all — the ephemeral OIDC token takes over, and consumers get signed build provenance for free.

## What ran during the incident that added this doc

`spawntree-host-server@0.2.0` was a brand-new package (introduced in [PR #14](https://github.com/ziahamza/spawntree/pull/14)). The release workflow for [PR #22](https://github.com/ziahamza/spawntree/pull/22) successfully published `spawntree@0.4.0`, `spawntree-core@0.4.0`, and `spawntree-daemon@0.3.0` (all pre-existing), but `spawntree-host-server` hit 403 Forbidden because the NPM_TOKEN is an automation token that can't create new packages.

Resolution: do Option A above for `spawntree-host-server@0.2.0` once; future releases will be automatic.

## Diagnostic: has a package been published?

```sh
npm view spawntree-host-server version
# → 404 means the name is unclaimed; first publish needs elevated credentials
# → a version string means the package exists and automation tokens can update it
```

The workflow's `Check for unpublished packages` step does this for every public package in `packages/*` before attempting to publish, and surfaces the list as a build summary so you know what needs attention if the run fails.
