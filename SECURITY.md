# Security policy

## Supported releases

Security fixes target the current stable release and `main`. The `beta` branch is for integration, not production use. Older releases are not guaranteed to receive backports.

## Report a vulnerability privately

Use **Security → Advisories → Report a vulnerability** when private reporting is available. Otherwise, use the public contact email on the [maintainer's GitHub profile](https://github.com/robertluiz) to arrange a secure channel. Do not disclose the issue in a public issue, pull request, or discussion.

Include the affected OC Router and OpenCode versions, the operating system, the impact, and the smallest example that demonstrates the issue using synthetic data. Remove tokens, credentials, and private logs. If a credential has been exposed, revoke or rotate it first.

## Security boundaries

OC Router discovers capabilities; it does not grant permissions. OpenCode still decides which tools and skills may run. Do not include secrets in capability names or descriptions. Disable semantic indexing with `OPENCODE_SEMANTIC_INDEX_ENABLED=0` if catalog metadata must not be sent to a model.

CI scans code, workflow definitions, checked-out files, and evaluator image dependencies. Dependency review runs on PRs to `main`. These checks do not replace maintainer review, especially for changes to workflows, installers, and release automation.
