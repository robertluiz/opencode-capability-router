import assert from "node:assert/strict";
import { test } from "node:test";
import router from "../src/candidate.ts";

async function fixture(entries = [], existingIndexer, {
  extraAgents = [], skills = [], commands = [], descriptions = {}, getSession, compact,
} = {}) {
  const hooks = {};
  const toolHooks = {};
  let evaluatePermission;
  let discovery;
  const agents = new Map(extraAgents.map(agent => [agent.id, agent]));
  if (existingIndexer) agents.set("indexer", existingIndexer);
  const state = { entries, agents, catalogs: 0 };
  const sessionID = "ses_child";
  await router.setup({
    location: { directory: "" },
    session: {
      hook: async (name, callback) => { hooks[name] = callback; },
      context: async () => state.entries,
      get: async ({ sessionID: id }) => getSession
        ? getSession(id)
        : { id, parentID: id === "ses_parent" ? undefined : "ses_parent" },
      compact,
    },
    permission: { hook: async (_name, callback) => { evaluatePermission = callback; } },
    tool: {
      hook: async (name, callback) => { toolHooks[name] = callback; },
      transform: async (callback) => callback({ add: (tool) => { discovery = tool; } }),
    },
    agent: {
      list: async () => [...agents.values()],
      transform: async (callback) => callback({
        get: (id) => agents.get(id),
        update: (id, edit) => {
          const agent = agents.get(id) ?? { id, mode: "primary", permissions: [{ action: "*", resource: "*", effect: "allow" }] };
          edit(agent);
          agents.set(id, agent);
        },
      }),
    },
    command: { list: async () => { state.catalogs++; return commands; } },
    skill: { list: async () => skills },
    config: { get: async () => ({ data: [{ info: { compaction: { auto: false } } }] }) },
  });
  const call = { sessionID, agent: "fixer", model: { providerID: "fixture", id: "offline" } };
  return Object.assign(state, {
    context: (event) => hooks.context(event),
    evaluatePermission: (event) => evaluatePermission(event),
    async surface(names = ["find_capabilities", "read", "shell", "patch"], id = sessionID, system = [], agent = call.agent) {
      const event = { ...call, sessionID: id, system, agent, tools: Object.fromEntries(names.map((name) => [
        name, { description: descriptions[name] ?? (name === "read" ? "Read file contents" : name === "shell" ? "Run shell commands" : "") },
      ])) };
      await hooks.context(event);
      return Object.keys(event.tools);
    },
    discoverySchema: () => discovery.input,
    async discover(input, id = sessionID) {
      const { content } = await discovery.execute(input, { ...call, sessionID: id });
      return JSON.parse(content);
    },
    beforeTool: (tool, id, input = {}) => toolHooks["execute.before"]({ tool, sessionID: id, input }),
    async select(id) {
      const { content } = await discovery.execute({ query: id, kind: "tool" }, call);
      assert.deepEqual(JSON.parse(content), [{ kind: "tool", id }]);
    },
    async search(query, intent) {
      const { content } = await discovery.execute({ query, kind: "tool", intent }, call);
      return JSON.parse(content).suggestions;
    },
    prompt: () => hooks.prompt({ sessionID, prompt: { text: "A new request" } }),
  });
}

const user = (id) => ({ type: "user", id, time: { created: 1 } });
const compacted = [{ type: "compaction" }, { type: "assistant" }];
const discoveryOnly = ["find_capabilities"];

test("normal roots build a catalog without routing, and the indexer does not reenter", async () => {
  const router = await fixture();
  assert.deepEqual(router.agents.get("indexer"), {
    id: "indexer", mode: "subagent", hidden: true,
    permissions: [{ action: "*", resource: "*", effect: "deny" }],
  });
  const system = [];
  assert.deepEqual(await router.surface(["read"], "ses_parent", system, "build"), ["read"]);
  assert.deepEqual(await router.surface(undefined, "ses_child", system, "indexer"), [...discoveryOnly, "read", "shell", "patch"]);
  assert.equal(router.catalogs, 0);
  assert.deepEqual(await router.surface(undefined, "ses_parent", system, "build"), ["read", "shell", "patch"]);
  assert.equal(router.catalogs, 1);
  assert.deepEqual(system, []);

  const existing = Object.freeze({ id: "indexer", mode: "primary", permissions: [] });
  const configured = await fixture([], existing);
  assert.equal(configured.agents.get("indexer"), existing);
});

test("selected tools stay exposed across repeated compactions of the same turn", async () => {
  const router = await fixture([user("msg_first")]);
  router.prompt();
  assert.deepEqual(await router.surface(), discoveryOnly);
  await router.select("read");
  await router.select("shell");
  const selected = [...discoveryOnly, "read", "shell"];
  assert.deepEqual(await router.surface(), selected);

  for (let i = 0; i < 20; i++) {
    router.entries = [...compacted, { type: "compaction", id: `summary_${i}` }];
    for (let step = 0; step < 3; step++) {
      assert.deepEqual(await router.surface(), selected, `compaction ${i + 1}, request ${step + 1}`);
    }
  }

  router.prompt();
  assert.deepEqual(await router.surface(), selected);
});

test("discovery remains usable when the router starts with an already compacted context", async () => {
  const router = await fixture(compacted);
  assert.deepEqual(await router.surface(), discoveryOnly);
  await router.select("read");
  assert.deepEqual(await router.surface(), [...discoveryOnly, "read"]);
  assert.deepEqual(await router.surface(), [...discoveryOnly, "read"]);

  // A missing tool in the host's incoming surface must never be added back.
  assert.deepEqual(await router.surface(["find_capabilities", "shell", "patch"]), discoveryOnly);
  assert.deepEqual(await router.surface(), [...discoveryOnly, "read"]);
});

test("new prompts and repeated discoveries only add to the session's selection", async () => {
  const router = await fixture([user("msg_first")]);
  await router.surface();
  await router.select("read");
  router.entries = compacted;
  assert.deepEqual(await router.surface(), [...discoveryOnly, "read"]);
  router.entries = [user("msg_second")];
  assert.deepEqual(await router.surface(), [...discoveryOnly, "read"]);
  assert.deepEqual(await router.search("run shell commands"), [{ kind: "tool", id: "shell" }]);
  assert.deepEqual(await router.surface(), [...discoveryOnly, "read", "shell"]);
  assert.deepEqual(await router.search("zigzag photosynthesis"), []);
  assert.deepEqual(await router.surface(), [...discoveryOnly, "read", "shell"]);
});

test("selected tools survive catalog cache churn without leaking to other sessions", async () => {
  const router = await fixture();
  await router.surface();
  await router.select("read");
  for (let i = 0; i < 70; i++) {
    assert.deepEqual(await router.surface(undefined, `ses_other_${i}`), discoveryOnly);
  }
  assert.deepEqual(await router.surface(), [...discoveryOnly, "read"]);
});

test("discovery guidance asks for structured constraints without requiring them for exact IDs", async () => {
  const router = await fixture();
  const system = [];
  await router.surface(undefined, undefined, system);
  const guidance = system.map(({ text }) => text).join("\n");
  for (const field of ["intent.objectives", "intent.scope", "intent.exclude"]) {
    assert.ok(guidance.includes(field), `Missing model guidance for ${field}`);
  }
  assert.match(guidance, /one short detail .* only if it changes which tool or skill/);
  assert.match(guidance, /Leave out unrelated history, raw logs and secrets/);
  assert.deepEqual(router.discoverySchema().required, ["query"]);
  assert.match(router.discoverySchema().properties.kind.description, /both a tool and a skill are needed and missing, omit kind and search once/);
  await router.select("read");
  assert.deepEqual(await router.surface(), [...discoveryOnly, "read"]);
});

test("a log path is readable without selecting excluded execution or editing tools", async () => {
  const router = await fixture();
  await router.surface();
  assert.deepEqual(await router.search("Read only service-a/startup.log without executing terminal commands or modifying files", {
    objectives: [{ action: "read", object: "service-a/startup.log" }],
    scope: ["service-a/startup.log"],
    exclude: ["execute terminal commands", "modify files"],
  }), [{ kind: "tool", id: "read" }]);
  assert.deepEqual(await router.surface(), [...discoveryOnly, "read"]);
});

test("a terse request to read a .txt file finds the file reader", async () => {
  const router = await fixture();
  await router.surface();
  assert.deepEqual(await router.search("Read only first.txt verbatim", {
    objectives: [{ action: "read", object: "first.txt" }],
    scope: ["only first.txt"],
  }), [{ kind: "tool", id: "read" }]);
});

test("one lexical search selects a tool and skill, but excludes matching editors and executors", async () => {
  const router = await fixture([user("msg_first")], undefined, {
    skills: [{ id: "log-triage", description: "Read startup logs for incident triage" }],
    descriptions: {
      read: "Read startup logs for incident triage",
      patch: "Modify startup logs for incident triage",
      shell: "Execute terminal commands to read startup logs for incident triage",
    },
  });
  const incoming = [...discoveryOnly, "read", "skill", "patch", "shell"];
  assert.deepEqual(await router.surface(incoming), discoveryOnly);
  const { suggestions } = await router.discover({
    query: "Read startup logs without executing terminal commands or modifying files",
    intent: {
      objectives: [{ action: "read", object: "startup logs" }],
      exclude: ["execute terminal commands", "modify files"],
    },
  });
  assert.deepEqual(suggestions.map(({ kind, id }) => `${kind}:${id}`).sort(), [
    "skill:log-triage", "tool:read",
  ]);
  assert.deepEqual(await router.surface(incoming), [...discoveryOnly, "read", "skill"]);
  router.entries = compacted;
  assert.deepEqual(await router.surface(incoming), [...discoveryOnly, "read", "skill"]);
});

test("MCP selection exposes the selected tool and guidance, not sibling capabilities", async () => {
  const router = await fixture([], undefined, {
    descriptions: { archive_lookup: "Read archived invoices", archive_purge: "Delete archived invoices" },
  });
  const incoming = [...discoveryOnly, "archive_lookup", "archive_purge"];
  const mcp = '<server name="archive">PRIVATE_SERVER_NOTE archive_lookup archive_purge</server>';
  const system = () => [{
    type: "text", text: `Keep this instruction.\n${mcp}`,
    metadata: { experimental: { instructions: [{ key: "core/mcp-guidance", text: mcp }] } },
  }];
  const before = system();
  assert.deepEqual(await router.surface(incoming, undefined, before), discoveryOnly);
  assert.equal(before[0].text.trim(), "Keep this instruction.");
  assert.deepEqual(await router.discover({ query: "archive_lookup", kind: "mcp" }), [
    { kind: "mcp", id: "archive_lookup" },
  ]);
  const after = system();
  assert.deepEqual(await router.surface(incoming, undefined, after), [...discoveryOnly, "archive_lookup"]);
  assert.match(after[0].text, /archive_lookup: Read archived invoices/);
  assert.doesNotMatch(after[0].text, /archive_purge|PRIVATE_SERVER_NOTE/);
});

test("commands are suggestions only; a visible agent activates subagent but a hidden one does not", async () => {
  const router = await fixture([], undefined, {
    commands: [{ name: "report", execute: () => assert.fail("command executed by discovery") }],
    extraAgents: [
      { id: "reviewer", mode: "subagent", permissions: [{ action: "*", resource: "*", effect: "allow" }] },
      { id: "private-reviewer", mode: "subagent", hidden: true },
    ],
  });
  const incoming = [...discoveryOnly, "subagent", "report"];
  assert.deepEqual(await router.surface(incoming), discoveryOnly);
  assert.deepEqual(await router.discover({ query: "report", kind: "command" }), [
    { kind: "command", id: "report", use: "/report" },
  ]);
  assert.deepEqual(await router.surface(incoming), discoveryOnly);
  const hidden = await router.discover({ query: "private-reviewer", kind: "agent" });
  assert.deepEqual(hidden.suggestions, []);
  assert.deepEqual(await router.surface(incoming), discoveryOnly);
  assert.deepEqual(await router.discover({ query: "reviewer", kind: "agent" }), [
    { kind: "agent", id: "reviewer" },
  ]);
  assert.deepEqual(await router.surface(incoming), [...discoveryOnly, "subagent"]);
});

test("a post-permission surface without discovery is not rewritten", async () => {
  const router = await fixture();
  await router.surface();
  await router.select("read");
  const tools = { read: { description: "Read file contents" }, patch: { description: "Edit files" } };
  const system = [{ type: "text", text: "Host-provided guidance" }];
  const event = { sessionID: "ses_child", agent: "fixer", tools, system };
  const original = structuredClone(event);
  await router.context(event);
  assert.deepEqual(event, original);
  assert.equal(router.catalogs, 1);
});

test("isolated evaluations do not expose project memory or its server guidance", async () => {
  const router = await fixture();
  const action = "ai-memory_memory_query";
  const system = [{ type: "text", text: 'Keep this instruction.\n<server name="ai-memory">Fixture guidance.</server>' }];
  const tools = [...discoveryOnly, action];
  assert.deepEqual(await router.surface(tools, "ses_child", system, "probe"), discoveryOnly);
  assert.equal(system[0].text.trim(), "Keep this instruction.");
  const probe = { agent: "probe", action, effect: "allow" };
  const normal = { agent: "build", action, effect: "allow" };
  await router.evaluatePermission(probe);
  await router.evaluatePermission(normal);
  assert.equal(probe.effect, "deny");
  assert.equal(normal.effect, "allow");
  assert.deepEqual(await router.surface(tools, "ses_parent", [], "build"), [action]);
});

test("runtime gate reports available compaction without invoking it and distinguishes delegation status", async () => {
  let compactions = 0;
  const router = await fixture([], undefined, {
    compact: () => { compactions++; },
    extraAgents: [{ id: "reviewer", mode: "subagent" }],
  });
  await router.surface([...discoveryOnly, "read", "patch"]);
  const gate = await router.discover({ query: "runtime-gate" });
  assert.equal(gate.compaction.status, "available");
  assert.equal(gate.compaction.autoConfigured, false);
  assert.equal(gate.compaction.source, "plugin config API");
  assert.equal(gate.compaction.executed, false);
  assert.deepEqual(gate.read, { status: "available", tool: "read" });
  assert.deepEqual(gate.edit, { status: "available", tool: "patch" });
  assert.deepEqual(gate.skill, { status: "unavailable", tool: null });
  assert.equal(gate.delegation.status, "unavailable");
  assert.equal(gate.delegation.newChildAllowed, false);

  const incoming = [...discoveryOnly, "subagent"];
  assert.deepEqual(await router.surface(incoming), discoveryOnly);
  assert.equal((await router.discover({ query: "runtime-gate" })).delegation.status, "available");
  assert.deepEqual(await router.surface(incoming), incoming);
  assert.equal(compactions, 0);

  const withoutCompact = await fixture();
  await withoutCompact.surface();
  const { compaction } = await withoutCompact.discover({ query: "compaction" });
  assert.equal(compaction.status, "not_verifiable");
  assert.equal(compaction.autoConfigured, false);
});

test("delegation status and invocation enforce the depth limit and require proven ancestry for new children", async () => {
  const router = await fixture([], undefined, {
    extraAgents: [{ id: "reviewer", mode: "subagent" }, { id: "hidden", mode: "subagent", hidden: true }],
    getSession: (id) => {
      if (id === "ses_unknown") return { id: "ses_wrong" };
      const depth = Number(id.at(-1));
      return { id, parentID: depth > 0 ? `ses_depth_${depth - 1}` : undefined };
    },
  });
  for (const [id, depth, allowed] of [
    ["ses_depth_4", 4, true],
    ["ses_depth_5", 5, false],
    ["ses_unknown", null, false],
  ]) {
    await router.surface([...discoveryOnly, "subagent"], id);
    const { delegation } = await router.discover({ query: "delegation" }, id);
    assert.deepEqual(
      { status: delegation.status, tool: delegation.tool, examples: delegation.examples,
        depth: delegation.depth, maxDepth: delegation.maxDepth, newChildAllowed: delegation.newChildAllowed },
      { status: "available", tool: "subagent", examples: ["reviewer"], depth, maxDepth: 5, newChildAllowed: allowed },
    );
  }
  await assert.doesNotReject(router.beforeTool("subagent", "ses_depth_4"));
  await assert.rejects(router.beforeTool("subagent", "ses_depth_5"), /depth limit/i);
  await assert.rejects(router.beforeTool("subagent", "ses_unknown"), /ancestry/i);
  await assert.doesNotReject(router.beforeTool("subagent", "ses_depth_5", { sessionID: "ses_existing" }));
});
