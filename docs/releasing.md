# Releasing OC Router

Use pull requests to integrate work into `beta`. Promote a batch with a PR from `beta` to `main`. For an urgent fix, open a PR to `main` from `fix` or `fix/<name>` in this repository. A fork branch with the same name is not a release source.

## Prepare and publish

1. Bring the source branch up to date with `main` using a merge, then raise `version` in `package.json` (for example, `2.0.3` → `2.0.4` for a patch). Use a stable `major.minor.patch` version.
2. Open or update the PR to `main`. After its **Tests** workflow succeeds, **Release** produces a preview in the run summary and an artifact. For `beta`, it lists merged PRs whose merge commits are in the proposed history but not already in `main`. For a `fix` branch, it lists the fix PR itself.
3. Commit the generated preview as `RELEASE_NOTES.md` on the source branch. The `release/pr-source-and-notes` check compares it with the generated notes and reports the result on the PR's test merge commit. If the PR changes, use the new preview before merging.
4. Verify the PR's source branch, then review the notes and test results. Do not reuse a release PR's head commit as the head of another open PR to `main`. Merge with **Create a merge commit**, not squash or rebase. This preserves the history used to keep already released beta PRs out of the next release.
5. The resulting update to `main` triggers publication. Actions verifies the associated merged PR and publishes a GitHub Release and tag `v<version>` for that exact commit, using the approved notes. Nothing is published to npm. After a hotfix, merge `main` back into `beta` before the next promotion.

## One-time repository setup

If the workflow is not yet on `main`, create `beta` from the current `main` and use a reviewed bootstrap PR to install it. The pre-merge workflow uses the version already on `main`, so it cannot enforce its own bootstrap PR. The preview reads PR inputs as data; it does not execute PR code or read artifacts produced by the Tests workflow.

After the workflow is present, verify that GitHub recognizes the status on both a `beta` PR and a rejected source PR, including when two PRs share the same head. Then configure an active GitHub ruleset targeting `main`:

- Require a pull request before merging and permit only merge commits for that branch.
- Require status checks to pass and require the source branch to be up to date. Select `release/pr-source-and-notes` from the GitHub Actions integration. Keep the existing test and security checks as required checks where applicable.
- When multiple maintainers are available, require an independent approving review and dismiss stale approvals.
- Block force pushes and deletion. Do not add an actor who can bypass these rules if direct updates must be prevented.

The workflow alone cannot stop a direct push to `main`. GitHub enforces that restriction only once the ruleset is active.
