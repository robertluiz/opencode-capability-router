import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import router from "../src/candidate.ts";

test("semantic discovery respects scope and excluded effects and drops stale concepts", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "router-semantic-discovery-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const prior = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = directory;
  t.after(() => {
    if (prior === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = prior;
  });

  const tools = {
    lens: { description: "Retrieve ledger entries" },
    mirror: { description: "Retrieve ledger entries" },
    relay: { description: "Retrieve ledger entries" },
  };
  const hooks = {};
  let discovery;
  await router.setup({
    location: { directory },
    session: {
      hook: async (name, hook) => { hooks[name] = hook; },
      get: async ({ sessionID }) => ({ id: sessionID }),
    },
    permission: { hook: async () => {} },
    tool: {
      hook: async () => {},
      list: async () => Object.entries(tools).map(([name, tool]) => ({ name, ...tool })),
      transform: async (transform) => transform({ add: (tool) => { discovery = tool; } }),
    },
    skill: { list: async () => [] },
    agent: { transform: async () => {}, list: async () => [] },
    command: { list: async () => [] },
  });

  const call = { sessionID: "ses_semantic", agent: "router", model: { providerID: "fixture", id: "offline" } };
  const surface = async () => {
    const event = { ...call, system: [], tools: { find_capabilities: {}, ...tools } };
    await hooks.context(event);
    return Object.keys(event.tools);
  };
  const search = async () => JSON.parse((await discovery.execute({
    query: "Read invoices for project amber without deleting records.",
    intent: { objectives: [{ action: "read", object: "invoices" }], scope: ["project amber"], exclude: ["delete"] },
  }, call)).content).suggestions;
  assert.deepEqual(await surface(), ["find_capabilities"]);
  assert.deepEqual(await search(), [], "these descriptions do not match the requested object without the index");

  const hash = (text) => createHash("sha256").update(text).digest("hex");
  const entry = (name, scope, effects = []) => ({
    description: hash(tools[name].description),
    concepts: { action: ["read"], object: ["invoices"], scope: [scope], effects, aliases: [] },
  });
  const index = join(directory, "opencode", "capability-router", "semantic-indexes");
  const file = hash(JSON.stringify([process.env.OPENCODE_TAG_PROFILE || "default", directory])) + ".json";
  await mkdir(index, { recursive: true });
  await writeFile(join(index, file), JSON.stringify({ version: 1, seen: {
    "tool:lens": entry("lens", "project amber"),
    "tool:mirror": entry("mirror", "project sapphire"),
    "tool:relay": entry("relay", "project amber", ["delete"]),
  } }));
  assert.deepEqual(await search(), [{ kind: "tool", id: "lens" }]);
  assert.deepEqual(await surface(), ["find_capabilities", "lens"]);
  tools.lens = { description: "Retrieve ledger lines" };
  await surface();
  assert.deepEqual(await search(), [], "old concepts are not applied to a changed description");
});
