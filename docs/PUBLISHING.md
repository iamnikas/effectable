# Publishing

Releases use GitHub Actions + npm [Trusted Publishing](https://docs.npmjs.com/trusted-publishers/) (OIDC). No long-lived `NPM_TOKEN` is required after the first package exists on npm.

Workflow: [`.github/workflows/publish.yml`](../.github/workflows/publish.yml)

## One-time npm setup

1. Create the package once (if it does not exist yet), e.g. local first publish:
   ```bash
   npm login
   npm publish --access public
   ```
2. On [npmjs.com](https://www.npmjs.com) → package **effectable** → **Settings** → **Trusted Publisher**:
   - Organization or user: `iamnikas`
   - Repository: `effectable`
   - Workflow filename: `publish.yml` (filename only)
   - Environment: leave empty (unless you enable `environment: npm` in the workflow)
   - Allowed actions: `npm publish`
3. Optionally restrict token publishing under **Publishing access** after OIDC works.

## Channels

| Trigger | npm dist-tag | Version shape | Install |
| --- | --- | --- | --- |
| Push to `develop` | `canary` | `<package.json>-canary.<sha7>` e.g. `0.1.0-canary.a1b2c3d` | `npm i effectable@canary` |
| Push to `main` (new semver in `package.json`) | `latest` | exact `package.json` version | `npm i effectable` |
| Git tag `vX.Y.Z` | `latest` | must equal `package.json` | `npm i effectable@X.Y.Z` |
| Actions → Run workflow | `canary` or `stable` | same rules | — |

Canary versions are written only in the CI workspace; they are **not** committed back to git.

## Recommended release flow

### Canary (continuous)

1. Merge work into `develop`.
2. CI publishes `effectable@canary` automatically.

### Stable (semver)

1. On `develop` (or a release PR into `main`), bump `package.json` `"version"` with semver (`0.1.0` → `0.1.1` / `0.2.0` / `1.0.0`).
2. Merge into `main`.
3. Publish job runs: if that version is not on npm yet → publishes to `latest`.
4. Optionally tag for clarity:
   ```bash
   git tag v0.1.1
   git push origin v0.1.1
   ```
   Tag publish is idempotent if the version already exists (main job will skip).

Do not put `-canary` / other prerelease suffixes into `package.json` on `main`.

## Provenance

Publishes set `NPM_CONFIG_PROVENANCE=true`. Provenance requires a **public** GitHub repository.
