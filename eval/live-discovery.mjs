import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

// Opt-in: uses OpenCode's existing OpenAI authentication, never reads credentials.
const ref = process.env.ROUTER_EVAL_MODEL;
const cli = process.env.ROUTER_EVAL_CLI;
assert.match(ref ?? "", /^openai\/[^/#\s]+(?:#[^/#\s]+)?$/, "Set ROUTER_EVAL_MODEL to an OpenAI model ref.");
assert.ok(cli, "Set ROUTER_EVAL_CLI to the OpenCode executable path.");
const [, id, variant] = ref.match(/^openai\/([^#]+)(?:#(.+))?$/);
const model = { providerID: "openai", id, ...(variant ? { variant } : {}) };
const root = await mkdtemp(join(tmpdir(), "router-live-discovery-"));
const project = join(root, "project");
const plugin = join(root, "plugin");
const trace = join(root, "tools.jsonl");
const password = "router-eval-loopback";
let host;
const skills = [
  ["fixture-log-retention", "Consult the checklist for retention and archival of fixture startup logs.", "TOPAZIO-9174"],
  ["fixture-log-checklist", "Consult the checklist for diagnosing startup failures from fixture logs.", "COBALTO-5028"],
  ["fixture-log-redaction", "Consult the checklist for redacting sensitive fields in fixture startup logs.", "JADE-2841"],
];
const skillIDs = skills.map(([id]) => id);
const [, [triageSkill, , triageCode]] = skills;
const logPath = join(project, "service-a", "startup.log");
try {
  await Promise.all([mkdir(project), mkdir(join(plugin, "src"), { recursive: true })]);
  await Promise.all(["src/candidate.ts", "src/semantic-indexer.ts", "src/tag-store.mjs", "package.json"].map((file) =>
    copyFile(new URL(`../${file}`, import.meta.url), join(plugin, file))));
  await writeFile(join(plugin, "index.ts"), `
    import { appendFileSync } from "node:fs";
    import { resolve } from "node:path";
    import router from "./src/candidate.ts";
    export default { id: "router-live-discovery-eval", async setup(ctx) {
      appendFileSync(${JSON.stringify(trace)}, JSON.stringify({ setup: true }) + "\\n");
      const files = new Set(${JSON.stringify([join(project, "first.txt"), join(project, "second.txt"), logPath])});
      const skillIDs = new Set(${JSON.stringify(skillIDs)});
      await ctx.tool.hook("execute.before", (event) => {
        if (event.tool === "find_capabilities") return;
        if (event.tool === "skill" && skillIDs.has(event.input?.id)) return;
        if (event.tool !== "read" || typeof event.input?.path !== "string" ||
            !files.has(resolve(${JSON.stringify(project)}, event.input.path))) {
          throw new Error("Only discovery, fixture skills, and fixture reads are allowed in this eval.");
        }
      });
      const session = Object.create(ctx.session);
      Object.defineProperty(session, "hook", { value: (name, run, ...args) => ctx.session.hook(name, name === "context" ? async (event) => {
        await run(event);
        appendFileSync(${JSON.stringify(trace)}, JSON.stringify({ sessionID: event.sessionID, tools: Object.keys(event.tools).sort() }) + "\\n");
      } : run, ...args) });
      const skills = Object.create(ctx.skill);
      Object.defineProperty(skills, "list", { value: async () => {
        const result = await ctx.skill.list();
        const entries = (Array.isArray(result) ? result : result.data).filter((entry) => skillIDs.has(entry.id));
        const found = new Set(entries.map((entry) => entry.id));
        if ([...skillIDs].some((id) => !found.has(id))) throw new Error("Incomplete fixture skill catalog.");
        return Array.isArray(result) ? entries : { ...result, data: entries };
      } });
      await router.setup(Object.create(ctx, { session: { value: session }, skill: { value: skills } }));
    }};
  `);
  const config = join(project, "opencode.json");
  await writeFile(config, JSON.stringify({
    plugins: [plugin.replaceAll("\\", "/")],
    enabled_providers: ["openai"],
    agents: { router: { mode: "primary", model: ref, permissions: [
      { action: "*", resource: "*", effect: "deny" },
      ...["find_capabilities", "read"].map((action) => ({ action, resource: "*", effect: "allow" })),
      ...skillIDs.map((resource) => ({ action: "skill", resource, effect: "allow" })),
    ] } },
    compaction: { auto: false },
  }));
  await mkdir(dirname(logPath), { recursive: true });
  await Promise.all([
    writeFile(join(project, "first.txt"), "ARANDUVA-7239"),
    writeFile(join(project, "second.txt"), "TAMURAI-6184"),
    writeFile(logPath, "BIRIBA-3901"),
    ...skills.map(async ([id, description, code]) => {
      const dir = join(project, ".opencode", "skills", id);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "SKILL.md"), `---\nname: ${id}\ndescription: ${description}\n---\n# Fixture log checklist\nThe checklist code is ${code}. Do not execute commands or change files.\n`);
    }),
  ]);
  const env = {
    ...process.env,
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_STATE_HOME: join(root, "state"),
    OPENCODE_CONFIG: config,
    OPENCODE_CONFIG_DIR: join(root, "config"),
    OPENCODE_SERVER_PASSWORD: password,
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_SEMANTIC_INDEX_ENABLED: "0",
  };
  delete env.OPENCODE_CONFIG_CONTENT;
  host = spawn(cli, ["--print-logs", "serve", "--hostname", "127.0.0.1", "--port", "0"], { cwd: project, env, stdio: ["ignore", "pipe", "pipe"] });
  let logs = "";
  host.stderr.on("data", (bytes) => { logs = (logs + bytes).slice(-32000); });
  const address = await new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error("OpenCode did not print its loopback address.")), 15000);
    const fail = (error) => { clearTimeout(timer); reject(error); };
    host.once("error", fail);
    host.once("exit", (code) => fail(new Error(`OpenCode exited before startup: ${code}`)));
    host.stdout.on("data", (bytes) => {
      output = (output + bytes).slice(-4000);
      const address = output.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
      if (address) { clearTimeout(timer); resolve(address); }
    });
  });
  async function api(route, body) {
    const headers = { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`, "content-type": "application/json" };
    const response = await fetch(`${address}/api/${route}`, { headers, signal: AbortSignal.timeout(5000), ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }) });
    assert.ok(response.ok, `${route}: HTTP ${response.status}`);
    return response.json();
  }
  const { data: session } = await api("session", { title: "Router on-demand eval", agent: "router", model,
    permissions: [{ action: "skill", resource: "*", effect: "deny" }] });
  assert.equal(session.agent, "router");
  assert.equal(session.model?.providerID, "openai");
  let sessionID = session.id;
  let finished = 0;
  let callsSeen = 0;
  const scenarios = [
    ["Reply with exactly OK. No external information is needed.", "OK", 0, 0],
    ["What is the exact content of the local file first.txt? Reply with just the content.", "ARANDUVA-7239", 1, 1],
    ["And what is the exact content of second.txt in the same directory? Reply with just the content.", "TAMURAI-6184", 0, 1],
    ["Use uma ferramenta de leitura para ler somente service-a/startup.log, sem executar comandos de terminal nem modificar arquivos. Responda apenas com o conteúdo exato.", "BIRIBA-3901", 1, 1, "tool"],
    ["Qual é o código do checklist de triagem de logs de inicialização desta fixture? Consulte as instruções do checklist sem executar comandos nem modificar arquivos. Responda apenas com o código.", triageCode, 1, 0, "skill"],
    ["Leia somente service-a/startup.log e consulte o checklist de triagem de logs de inicialização desta fixture. Sem executar comandos nem modificar arquivos, responda com o conteúdo do log e o código do checklist separados por um espaço.", `BIRIBA-3901 ${triageCode}`, 1, 1, "mixed"],
  ];
  const results = [];
  const surfaces = async () => {
    const data = await readFile(trace, "utf8").catch(() => "");
    assert.match(data, /"setup":true/, `Evaluation plugin did not load: ${logs.split("\n").filter((line) => /plugin|level=ERROR/i.test(line) && !/authorization|secret|api.?key|bearer/i.test(line)).slice(-15).join("\n")}`);
    return data.trim().split("\n").map(JSON.parse).filter((line) => line.sessionID === sessionID);
  };
  for (const [text, expected, expectedSearches, expectedReads, discoveryKind] of scenarios) {
    if (discoveryKind === "tool") {
      const projected = await surfaces();
      const firstExposure = projected.findIndex((entry) => entry.tools.includes("read"));
      assert.ok(firstExposure > 0, "The tool must be exposed only after discovery.");
      assert.ok(projected.slice(firstExposure).every((entry) => entry.tools.includes("read")));
    }
    if (discoveryKind) {
      const { data } = await api("session", { title: `Router intent eval (${discoveryKind})`, agent: "router", model,
        ...(discoveryKind === "tool" ? { permissions: [{ action: "skill", resource: "*", effect: "deny" }] } : {}) });
      sessionID = data.id;
      finished = callsSeen = 0;
    }
    const route = `session/${sessionID}`;
    await api(`${route}/prompt`, { text });
    const deadline = Date.now() + 60_000;
    for (;;) {
      const { data } = await api(`${route}/message?order=asc&limit=100`);
      const idles = data.filter((entry) => entry.type === "idle");
      if (idles.length > finished) {
        assert.equal(idles.at(-1).error, undefined, JSON.stringify(idles.at(-1).error));
        finished = idles.length;
        const assistant = data.filter((entry) => entry.type === "assistant");
        assert.ok(assistant.length > 0);
        assert.ok(assistant.every((entry) => entry.model?.providerID === "openai" && entry.model?.id === id));
        const calls = assistant.flatMap((entry) => entry.content ?? []).filter((part) => part.type === "tool");
        const recent = calls.slice(callsSeen);
        callsSeen = calls.length;
        const discovery = recent.filter((call) => call.name === "find_capabilities");
        const searches = discovery.length;
        const reads = recent.filter((call) => call.name === "read" && call.state.status === "completed").length;
        const answer = assistant.at(-1).content.filter((part) => part.type === "text").map((part) => part.text).join("");
        assert.equal(discoveryKind === "skill" || discoveryKind === "mixed" ? answer : answer.trim(), expected, `Discoveries: ${JSON.stringify(discovery.map((call) => ({
          input: call.state.input, result: call.state.content,
        })))}`);
        const projected = await surfaces();
        assert.equal(searches, expectedSearches, `unexpected discovery count for ${discoveryKind ?? `on-demand turn ${finished}`}; tool surfaces: ${JSON.stringify(projected.map((entry) => entry.tools))}`);
        assert.equal(reads, expectedReads);
        if (discoveryKind) {
          const [call] = discovery;
          assert.match(call.state.input.query, /\b(log|logs|checklist|triage)\b/i);
          assert.match(call.state.input.query, /\b(without|do not|no|exclude|avoid)\b/i);
          const { intent } = call.state.input;
          assert.ok(intent?.objectives?.some(({ action, object }) => /\b(read|consult|load|inspect|get|retrieve)\b/i.test(action) && /\b(log|logs|checklist|triage)\b/i.test(object)),
            `Structured action/object missing: ${JSON.stringify(intent)}`);
          assert.match(intent.exclude?.join(" ") ?? "", /\b(command|commands|shell|terminal|execute|execution)\b/i);
          assert.match(intent.exclude?.join(" ") ?? "", /\b(write|modify|modification|editing|edit|change|changes)\b/i);
          if (discoveryKind !== "skill") {
            assert.ok(call.state.input.query.includes("service-a/startup.log"));
            assert.ok(intent.scope?.some((scope) => scope.includes("service-a/startup.log")));
          }
          const loaded = recent.filter((part) => part.name === "skill").map((part) => part.state.input.id);
          assert.deepEqual(loaded, discoveryKind === "tool" ? [] : [triageSkill]);
          if (discoveryKind === "tool") {
            assert.ok(projected.every((entry) => !entry.tools.includes("skill")), "Skill tool exposed in a tool-only session.");
          }
          if (discoveryKind === "mixed") {
            assert.equal(call.state.input.kind, undefined, "A mixed lookup must not restrict kind.");
            assert.ok(intent.objectives.some(({ object }) => /checklist/i.test(object)));
          }
        }
        assert.ok(recent.every((call) => call.state.status === "completed"));
        results.push({ searches, reads, ...(discoveryKind ? { kind: discoveryKind, structuredIntent: true } : {}) });
        break;
      }
      assert.ok(Date.now() < deadline, `OpenAI turn ${finished + 1} timed out.`);
      await sleep(400);
    }
  }
  console.log(JSON.stringify({ model: ref, scenarios: results, searchesWithReadAlreadyExposed: results[2].searches }));
} finally {
  if (host?.pid && host.exitCode === null && host.signalCode === null) {
    const exit = new Promise((resolve) => host.once("exit", resolve));
    host.kill();
    await exit;
  }
  await rm(root, { recursive: true, force: true, maxRetries: 4 });
}
