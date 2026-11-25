import assert from "node:assert/strict";
import { test } from "node:test";
import router from "../index.ts";

async function fixture(entries = [], existingIndexer) {
  const hooks = {};
  let discovery;
  const agents = new Map(existingIndexer ? [["indexer", existingIndexer]] : []);
  const state = { entries, agents, catalogs: 0 };
  const sessionID = "ses_child";
  await router.setup({
    location: { directory: "" },
    session: {
      hook: async (name, callback) => { hooks[name] = callback; },
      context: async () => state.entries,
      get: async ({ sessionID: id }) => ({ id, parentID: id === "ses_parent" ? undefined : "ses_parent" }),
    },
    permission: { hook: async () => {} },
    tool: {
      hook: async () => {},
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
    command: { list: async () => { state.catalogs++; return []; } },
  });
  const call = { sessionID, agent: "fixer", model: { providerID: "fixture", id: "offline" } };
  return Object.assign(state, {
    async surface(names = ["find_capabilities", "read", "shell", "patch"], id = sessionID, system = [], agent = call.agent) {
      const event = { ...call, sessionID: id, system, agent, tools: Object.fromEntries(names.map((name) => [
        name, { description: name === "read" ? "Read file contents" : name === "shell" ? "Run shell commands" : "" },
      ])) };
      await hooks.context(event);
      return Object.keys(event.tools);
    },
    discoverySchema: () => discovery.input,
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
