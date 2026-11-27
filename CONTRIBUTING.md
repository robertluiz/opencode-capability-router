# Contributing to OC Router

Open feature, documentation, and routine fix PRs against `beta`. Use a descriptive branch name and explain what changed, why it matters, and how it was tested. Keep unrelated changes out of the PR.

Only maintainers promote `beta` to `main` or open urgent hotfix PRs from `fix` or `fix/<name>` in this repository. Do not push directly to `main`. Release PRs must include the version bump and release notes and use a merge commit. See [the release guide](docs/releasing.md).

## Verify changes

- Run `node --test tests/*.test.mjs` from the repository root on Windows with Node.js 24 or newer. On other platforms, run the test files individually, excluding `tests/installer.test.mjs`, which requires Windows PowerShell.
- Run the relevant Docker regressions for changes to routing, indexing, or installation. See [the eval guide](eval/README.md).
- Add a regression test when changing behavior. Use synthetic fixtures; do not include credentials, real logs, private skills, or internal endpoints.
- Explain new dependencies and review their licenses and transitive dependencies. Keep third-party Actions pinned to full commit SHAs and their permissions narrowly scoped.

Only submit work you have permission to share under the [MIT License](LICENSE). Keep required notices for any reused material. Report vulnerabilities privately using the [security policy](SECURITY.md), not in a public issue or PR.
