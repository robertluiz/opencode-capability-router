import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const version = execFileSync("opencode", ["--version"], { encoding: "utf8" }).trim();
assert.match(version, /\bv?2\.\d+\.\d+$/);
const work = mkdtempSync(join(tmpdir(), "router-compaction-"));
const marker = "router-compaction-fixture-marker";
const path = join(work, "marker.txt");
const model = { providerID: "stub", id: "test" };
const password = "local-fixture-only";
const readsPerCompaction = 4;
const expectedCompactions = 9;
const readLimit = readsPerCompaction * expectedCompactions;
const stats = { attempts: 0, discovery: 0, missing: 0, followup: 0 };
let followup = false;
let sequence = 0;
let childID;

const stub = createServer(async (req, res) => {
  try {
    const parts = [];
    for await (const part of req) parts.push(part);
    const { tools = [], messages = [] } = JSON.parse(Buffer.concat(parts));
    const offered = new Set(tools.map((tool) => tool.function?.name));
    const userTexts = messages.filter((message) => message.role === "user").map((message) => JSON.stringify(message.content));
    const summarize = userTexts.some((text) => /You MUST summarize the conversation above|Update the existing checkpoint in the conversation above/.test(text));
    // The parent also calls the stub when OpenCode delivers the child's completion.
    const latestUser = messages.findLast((message) => message.role === "user")?.content;
    const parentNotification = childID && typeof latestUser === "string" &&
      (latestUser.startsWith(`<subagent sessionID="${childID}"`) ||
       latestUser.startsWith(`<background-result kind="subagent" sessionID="${childID}"`));
    let name, args, text, inputTokens = 50;
    if (summarize) {
      text = `## Objective\nRead the fixture.\n\n## Requirements\nContinue this turn.\n\n## Decisions\nNone.\n\n## Work State\n### Completed\nSelected read.\n### Active\nRead the fixture.\n### Blocked\nNone.\n\n## Next Move\nRead ${path}.\n\n## Relevant Files\n${path}.\n\n## Important Context\nRead is already selected.`;
    } else if (offered.has("find_capabilities") && !parentNotification) {
      if (!offered.has("read")) {
        if (stats.discovery || followup) {
          stats.missing++;
          text = "Selected read tool is missing.";
        } else {
          stats.discovery++;
          name = "find_capabilities";
          args = { query: "read", kind: "tool" };
        }
      } else if (followup ? stats.followup === 0 : stats.attempts < readLimit) {
        name = "read";
        args = { path };
        if (followup) stats.followup++;
        // Report a large request periodically so the real host compacts automatically.
        else if (++stats.attempts % readsPerCompaction === 0) inputTokens = 32000;
      } else text = "Read chain complete.";
    } else text = "Fixture response.";

    const delta = name
      ? { tool_calls: [{ index: 0, id: `call_${++sequence}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] }
      : { content: text };
    const chunk = { id: "fixture", object: "chat.completion.chunk", created: 1, model: model.id };
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const payload of [
      { choices: [{ index: 0, delta, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: name ? "tool_calls" : "stop" }] },
      { choices: [], usage: { prompt_tokens: inputTokens, completion_tokens: 10, total_tokens: inputTokens + 10 } },
    ]) res.write(`data: ${JSON.stringify({ ...chunk, ...payload })}\n\n`);
    res.end("data: [DONE]\n\n");
  } catch (error) {
    console.error(error);
    res.writeHead(500).end();
  }
});

await new Promise((resolve, reject) => stub.once("error", reject).listen(0, "127.0.0.1", resolve));
let host;
try {
  writeFileSync(path, marker);
  const config = join(work, "opencode.json");
  writeFileSync(config, JSON.stringify({
    plugins: ["/router"],
    model: "stub/test",
    provider: { stub: {
      npm: "@ai-sdk/openai-compatible",
      name: "local deterministic stub",
      options: { baseURL: `http://127.0.0.1:${stub.address().port}/v1`, apiKey: "not-a-secret" },
      models: { test: { name: "test", tool_call: true, limit: { context: 32768, output: 1024 } } },
    } },
    agents: { orchestrator: { mode: "primary", model: "stub/test" }, worker: { mode: "subagent", model: "stub/test" } },
    permissions: [{ action: "read", resource: "*", effect: "allow" }],
    compaction: { auto: true, buffer: 1024, keep: { tokens: 128 }, background: false },
  }));
  host = spawn("opencode", ["serve", "--hostname", "127.0.0.1", "--port", "19193"], {
    cwd: work,
    env: { ...process.env, OPENCODE_SERVER_PASSWORD: password, OPENCODE_CONFIG: config, OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_SEMANTIC_INDEX_ENABLED: "0" },
    stdio: ["ignore", "ignore", "inherit"],
  });
  async function api(route, body) {
    const headers = { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`, "content-type": "application/json" };
    const request = body === undefined ? { headers } : { method: "POST", headers, body: JSON.stringify(body) };
    const response = await fetch(`http://127.0.0.1:19193/api/${route}`, { ...request, signal: AbortSignal.timeout(5000) });
    const text = await response.text();
    assert.ok(response.ok, `${route}: HTTP ${response.status} ${text.slice(0, 300)}`);
    return JSON.parse(text);
  }
  for (let i = 0; ; i++) {
    try { await api("session"); break; }
    catch (error) {
      if (i === 99 || host.exitCode !== null) throw error;
      await sleep(100);
    }
  }
  const { data: parent } = await api("session", { agent: "orchestrator", model });
  const { data: child } = await api("session", { parentID: parent.id, agent: "worker", model });
  childID = child.id;
  const session = `session/${child.id}`;
  const messages = async () => (await api(`${session}/message?limit=200`)).data;
  async function prompt(text) {
    const done = (await messages()).filter((message) => message.type === "idle").length;
    await api(`${session}/prompt`, { text });
    for (let i = 0; i < 300; i++) {
      const idle = (await messages()).filter((message) => message.type === "idle");
      if (idle.length > done) {
        assert.equal(idle[0].error, undefined, JSON.stringify(idle[0].error));
        return;
      }
      await sleep(100);
    }
    assert.fail("Timed out waiting for the child session to finish the prompt.");
  }
  const tools = (entries) => entries.flatMap((message) => message.content ?? []).filter((part) => part.type === "tool");
  const completedReads = (calls) => calls.filter((call) => call.name === "read" && call.state.status === "completed" && JSON.stringify(call.state.content).includes(marker)).length;

  await prompt("Read the fixture repeatedly in this turn.");
  const first = await messages();
  const compactions = first.filter((message) => message.type === "compaction" && message.reason === "auto" && message.status === "completed").length;
  assert.equal(stats.missing, 0, `Selected read was no longer offered after ${compactions} automatic compaction(s).`);
  assert.ok(compactions >= expectedCompactions, `Expected ${expectedCompactions} completed compactions, got ${compactions}.`);
  assert.equal((await api(`${session}/context`)).data.some((message) => message.type === "user"), false);
  assert.equal(completedReads(tools(first)), readLimit);

  followup = true;
  await prompt("Continue with one more read, without rediscovery.");
  const calls = tools(await messages());
  assert.equal(stats.missing, 0, "Selected read was no longer offered after a new prompt.");
  assert.equal(completedReads(calls), readLimit + 1);
  assert.equal(calls.filter((call) => call.name === "find_capabilities").length, 1);
  assert.equal(calls.filter((call) => call.state.status === "error").length, 0);
  console.log(`${version}: ${compactions} automatic compactions; ${readLimit + 1} completed reads including follow-up; 1 discovery; 0 tool errors.`);
} finally {
  if (host && host.exitCode === null) {
    const exited = new Promise((resolve) => host.once("exit", resolve));
    host.kill();
    await exited;
  }
  stub.close();
  rmSync(work, { recursive: true, force: true });
}
