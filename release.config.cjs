/**
 * semantic-release + Conventional Commits (same rules as commitlint).
 *
 * Branches:
 *   - main    → npm dist-tag "latest"
 *   - develop → npm dist-tag "canary" (prerelease: 0.1.1-canary.1, …)
 *
 * Bump rules (conventionalcommits preset):
 *   - feat             → minor
 *   - fix / perf       → patch
 *   - BREAKING CHANGE  → major
 *   - docs/chore/ci/…  → no release (unless noted in footer)
 */
/** @type {import('semantic-release').GlobalConfig} */
module.exports = {
  branches: [
    'main',
    {
      name: 'develop',
      channel: 'canary',
      prerelease: 'canary'
    }
  ],
  tagFormat: 'v${version}',
  plugins: [
    [
      '@semantic-release/commit-analyzer',
      {
        preset: 'conventionalcommits'
      }
    ],
    [
      '@semantic-release/release-notes-generator',
      {
        preset: 'conventionalcommits'
      }
    ],
    [
      '@semantic-release/changelog',
      {
        changelogFile: 'CHANGELOG.md'
      }
    ],
    [
      '@semantic-release/npm',
      {
        npmPublish: true
      }
    ],
    [
      '@semantic-release/git',
      {
        assets: ['package.json', 'package-lock.json', 'CHANGELOG.md'],
        message: 'chore(release): ${nextRelease.version} [skip ci]\n\n${nextRelease.notes}'
      }
    ],
    '@semantic-release/github'
  ]
};
