# OpenCode Capability Router

Discover tools and skills on demand in OpenCode. Eligible agents start with a smaller tool list, find what they need with `find_capabilities`, and keep selected tools available across follow-up messages and context compaction.

## Quick start

Requires Windows, PowerShell, Node.js, and OpenCode V2. From this checkout or the extracted package directory, run:

```powershell
.\install.ps1 -WhatIf  # Preview; optional
.\install.ps1
```

Restart OpenCode and start a new session. The installer copies and registers the plugin without replacing your agent settings. To try discovery, select an existing `router` or `orchestrator` agent and ask it to find a missing capability:

```text
Find a way to read logs/startup.log without running commands or modifying files.
```

If neither agent exists, add `"router": { "mode": "primary" }` to the `agents` object in your OpenCode configuration, then reload and select `router`. The indexer does not need this step.

## How it works

- Use tools and skill instructions already available. Search only for what is missing.
- Use an exact ID for a known capability. For a natural-language search, include the action, object, and any constraints that change the choice.
- If both a tool and a skill are needed, leave `kind` unset and search for them together. Otherwise, use `kind` to narrow the search.
- Discovery does not execute tools or load skill instructions. OpenCode still enforces access and execution permissions.

For normal primary agents other than `router` and `orchestrator`, the plugin leaves the existing tool list alone.

## Semantic indexing and privacy

On startup, the plugin registers an isolated `indexer` if none exists. An existing `indexer` is preserved and must be a subagent with all permissions denied. When indexing is available, it runs separately without tools and inherits the triggering session's settings unless explicitly overridden. Discovery uses textual matching when indexed concepts are unavailable.

Indexing sends tool and skill names and descriptions and may incur charges. Do not put sensitive data in catalog metadata. To turn semantic indexing off, set `OPENCODE_SEMANTIC_INDEX_ENABLED=0` in the environment that starts OpenCode. Textual discovery still works.

An explicit `OPENCODE_SEMANTIC_INDEX_MODEL` setting takes precedence over `agents.indexer.model`. Invalid or unsupported settings do not fall back to another configuration. Changing this setting alone does not rebuild the index.

## Install elsewhere or uninstall

The default configuration is `opencode/opencode.json` under `$env:XDG_CONFIG_HOME` (or `$HOME/.config`). The package is installed under `$env:XDG_DATA_HOME` (or `$HOME/.local/share`) at `opencode/capability-router/package`.

To use a different profile or package directory, pass `-ConfigPath` and `-Destination` to both scripts. Keep the destination outside the profile's plugin autodiscovery directory. The installer expects strict JSON and refuses to overwrite unmanaged or modified packages.

```powershell
.\uninstall.ps1 -WhatIf
.\uninstall.ps1
```

Restart OpenCode after uninstalling. Uninstall removes the registration, preserves unrelated settings, and does not delete the index.

## Test and package

Run the local checks from the source checkout:

```powershell
node --test eval/router-compaction.test.mjs indexer-model-test.mjs storage-test.mjs
```

`eval/README.md` documents the Docker and optional live tests. To build a local package, create `dist` and run `npm pack --pack-destination dist`. Only the package allowlist is included.

For questions and bug reports, use the repository's Issues tab. Include the OpenCode version and the smallest reproducible example; remove credentials and private logs.
