# Publishing

Releases use [semantic-release](https://semantic-release.app/) on GitHub Actions with npm [Trusted Publishing](https://docs.npmjs.com/trusted-publishers/) (OIDC). No long-lived `NPM_TOKEN` is required.

Workflow: [`.github/workflows/publish.yml`](../.github/workflows/publish.yml)  
Config: [`release.config.cjs`](../release.config.cjs)

Commit messages must follow [Conventional Commits](https://www.conventionalcommits.org/) (enforced by commitlint + lefthook). Those messages are what semantic-release uses to decide the next version.

## One-time npm setup

1. Package must already exist on npm (one-time local publish if needed).
2. On [npmjs.com](https://www.npmjs.com) → package **effectable** → **Settings** → **Trusted Publisher**:
   - Organization or user: `iamnikas`
   - Repository: `effectable`
   - Workflow filename: `publish.yml` (filename only)
   - Environment: leave empty
   - Allowed actions: `npm publish`

## Channels

| Branch / trigger | npm dist-tag | Version shape | Who bumps |
| --- | --- | --- | --- |
| Push to `develop` | `canary` | `X.Y.Z-canary.N` | semantic-release |
| Push to `main` | `latest` | `X.Y.Z` | semantic-release |
| Actions → Run workflow | same as branch | same | semantic-release |

No manual edits to `"version"` in `package.json` for routine releases. The release commit (`chore(release): … [skip ci]`) updates `package.json`, `package-lock.json`, and `CHANGELOG.md`.

## Bump rules (commitlint ↔ semantic-release)

| Commit type | Release |
| --- | --- |
| `feat:` | minor |
| `fix:` / `perf:` | patch |
| `BREAKING CHANGE:` footer or `feat!:` / `fix!:` | major |
| `docs:`, `chore:`, `ci:`, `test:`, `refactor:` (no bang) | no release |

Squash-merge PR titles **must** stay Conventional Commits — squash message is what lands on the branch.

## Recommended flow

### Canary

1. Merge work into `develop` with Conventional Commits.
2. Publish workflow runs `semantic-release` → npm `@canary` when there are releasable commits since the last canary/stable tag.

### Stable

1. Merge `develop` → `main` (or land releasable commits on `main`).
2. Publish workflow runs `semantic-release` → npm `@latest` + GitHub Release + tag `vX.Y.Z`.

### First-time baseline (already published `0.1.0`)

If `0.1.0` is on npm but git has no matching tag, create it once on the release commit so the next bump starts from there:

```bash
git tag v0.1.0 <commit-sha>
git push origin v0.1.0
```

Otherwise semantic-release may try to publish a version that already exists.

## Local dry-run

```bash
npx semantic-release --dry-run
```

Needs a full git history and network for npm/GitHub metadata; does not publish.

## Provenance

Publishes set `NPM_CONFIG_PROVENANCE=true`. Provenance requires a **public** GitHub repository. Do not set `registry-url` in `actions/setup-node` for this workflow — it breaks OIDC trusted publishing.
