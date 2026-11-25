import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const work = mkdtempSync(join(tmpdir(), "router-indexer-model-"));
const installed = process.argv[2] === "installed";
const trigger = { providerID: "openai", id: "fixture-main" };
const chosen = { providerID: "openai", id: "fixture-indexer" };
const expected = installed ? trigger : chosen;
const fixtureKey = "tool:read";
const calls = [];
const stub = createServer(async (req, res) => {
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const data = JSON.parse(Buffer.concat(chunks));
    const texts = data.messages.filter((m) => m.role === "user").flatMap((m) =>
      typeof m.content === "string" ? [m.content] : m.content.map((p) => p.text ?? ""));
    const catalog = texts.find((text) => text.includes("Catalog: "));
    const batch = catalog ? JSON.parse(catalog.split("Catalog: ")[1]) : [];
    calls.push({ provider: req.url.split("/")[1], model: data.model, catalog: !!catalog, tools: data.tools?.length ?? 0 });
    const content = catalog
      ? JSON.stringify({ items: batch.map(({ kind, id }) => ({ kind, id, concepts: { action: ["read"], object: ["fixture"], scope: [], effects: [], aliases: [] } })) })
      : "OK";
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const [delta, finish_reason] of [[{ content }, null], [{}, "stop"]]) {
      res.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: data.model,
        choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    }
    res.end("data: [DONE]\n\n");
  } catch (error) {
    console.error(error);
    res.writeHead(500).end();
  }
});
await new Promise((resolve) => stub.listen(0, "127.0.0.1", resolve));

let host;
try {
  const config = join(work, "opencode.json");
  const provider = ({ providerID, id }) => ({
    npm: "@ai-sdk/openai-compatible",
    name: providerID,
    options: { baseURL: `http://127.0.0.1:${stub.address().port}/${providerID}/v1`, apiKey: "not-a-secret" },
    models: { [id]: { name: id, tool_call: true } },
  });
  writeFileSync(config, JSON.stringify({
    plugins: installed ? [] : ["/router"],
    enabled_providers: ["openai"],
    provider: { openai: { ...provider(trigger), models: { ...provider(trigger).models, ...provider(chosen).models } } },
    agents: {
      ...(installed ? {} : {
        router: { mode: "primary", model: `${trigger.providerID}/${trigger.id}` },
        indexer: { mode: "subagent", model: `${chosen.providerID}/${chosen.id}`,
          permissions: [{ action: "*", resource: "*", effect: "deny" }] },
      }),
    },
    model: `${trigger.providerID}/${trigger.id}`,
  }));
  if (installed) {
    execFileSync(process.execPath, ["/router/manage.mjs", "install", "/router", "--config", config,
      "--destination", join(work, "installed-router")], { stdio: "inherit" });
  }
  const password = "fixture-loopback";
  const env = { ...process.env, XDG_DATA_HOME: join(work, "data"), OPENCODE_CONFIG: config,
    OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_SERVER_PASSWORD: password, OPENCODE_SEMANTIC_INDEX_ENABLED: "1" };
  delete env.OPENCODE_SEMANTIC_INDEX_MODEL;
  host = spawn("opencode", ["serve", "--hostname", "127.0.0.1", "--port", "19193"], {
    cwd: work, env, stdio: ["ignore", "ignore", "inherit"],
  });
  async function api(route, body) {
    const headers = { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`, "content-type": "application/json" };
    const response = await fetch(`http://127.0.0.1:19193/api/${route}`, {
      headers, signal: AbortSignal.timeout(5000),
      ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }),
    });
    assert.ok(response.ok, `${route}: HTTP ${response.status}`);
    return response.json();
  }
  for (let i = 0; ; i++) {
    try { await api("session"); break; }
    catch (error) { if (i === 99 || host.exitCode !== null) throw error; await sleep(100); }
  }
  const { data: main } = await api("session", installed ? {} : { agent: "router", model: trigger });
  if (installed) {
    assert.notEqual(main.agent, "router");
    assert.notEqual(main.agent, "orchestrator");
  }
  await api(`session/${main.id}/prompt`, { text: "Reply OK; no tools are needed." });

  const dir = join(env.XDG_DATA_HOME, "opencode", "capability-router", "semantic-indexes");
  let indexed;
  for (let i = 0; i < 150 && !indexed; i++) {
    await sleep(100);
    for (const file of readdirSync(dir, { throwIfNoEntry: false }) ?? []) {
      if (file.endsWith(".json")) {
        indexed = JSON.parse(readFileSync(join(dir, file), "utf8")).seen[fixtureKey]?.concepts;
        if (indexed) break;
      }
    }
  }
  assert.deepEqual(indexed?.object, ["fixture"], `${fixtureKey} concepts not persisted; recorded calls: ${JSON.stringify(calls)}`);
  assert.ok(calls.some((call) => call.provider === trigger.providerID && call.model === trigger.id && !call.catalog));
  if (installed) assert.ok(calls.some((call) => !call.catalog && call.tools > 1), "The default agent retains its tools");
  assert.deepEqual(calls.filter((call) => call.catalog), [{ provider: expected.providerID, model: expected.id, catalog: true, tools: 0 }]);
  const { data: sessions } = await api("session?search=Semantic%20indexer");
  assert.equal(sessions.length, 1);
  const [indexer] = sessions;
  assert.equal(indexer.parentID, undefined);
  assert.equal(indexer.agent, "indexer");
  assert.notEqual(indexer.id, main.id);
  assert.deepEqual({ providerID: indexer.model.providerID, id: indexer.model.id }, expected);
  console.log(`${installed ? "Installed" : "Explicit"}: ${trigger.providerID}/${trigger.id} -> ${expected.providerID}/${expected.id}; separate root, zero tools, concepts persisted (local stub).`);
} finally {
  if (host?.pid && host.exitCode === null && host.signalCode === null) {
    const exit = new Promise((resolve) => host.once("exit", resolve));
    host.kill();
    await exit;
  }
  stub.close();
  rmSync(work, { recursive: true, force: true });
}
