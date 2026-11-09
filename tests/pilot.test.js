const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { once } = require("node:events");
const ImpostorClient = require("../classes/impostor_client");
const { listBots, resolveBotConfig } = require("../classes/bot_config");
const Logger = require("../classes/logger");
const WebServer = require("../web/server");

const silent = { debug() {}, info() {}, warn() {}, error() {} };

test("pilot drops excluded traffic and answers only an explicit channel mention without tools", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "impostor-pilot-"));
  const shared = {
    irc: {
      host: "irc.invalid", port: 6697, tls: true,
      mentions_only: true, drop_disallowed_dms: true,
      multiline: false, reactions: false, typing_notifications: { enabled: false },
      dm_delay_min_seconds: 0, dm_delay_max_seconds: 0,
    },
    generator: { deepseek: { model: "fixture", max_tokens: 80 } },
    autonomous: { enabled: false },
    journal: { enabled: false },
    presence: { enabled: false },
    spontaneous: { enabled: false },
    url_summarize: { enabled: false },
    tools: { enabled: false },
  };
  const botEntry = {
    id: "impostorlab", nick: "ImpostorLab", persona: "p", channels: ["#pilot"],
    pm_allowed_users: [], irc: { channel_keys: { "#pilot": "fixture-key" } },
  };
  assert.throws(() => listBots({ bots: [{ ...botEntry, channels: ["#other"] }] }), /irc.channel_keys/);
  assert.throws(() => listBots({ bots: [{ ...botEntry, irc: { channel_keys: { "#pilot": "bad key" } } }] }), /irc.channel_keys/);
  const calls = [];
  const openai = { chat: { completions: { create: async (options) => {
    calls.push(options);
    return { choices: [{ finish_reason: "stop", message: { content: JSON.stringify({
      needs_tool: true, tool_request: { tool_name: "python", code: "do not run" },
      message: "respuesta sintética",
    }) } }] };
  } } } };
  let toolRuns = 0;
  const recordTool = async () => { toolRuns++; return { success: false }; };
  const tools = {
    pythonTool: { executePython: recordTool },
    webSearchTool: { searchWeb: recordTool },
    webFetchTool: { fetchPage: recordTool },
  };
  const bot = new ImpostorClient(silent, resolveBotConfig(shared, listBots({ ...shared, bots: [botEntry] })[0]), {
    openai, tools, dataDir, persona: { name: "ImpostorLab", character: "Bot de ensayo." },
  });
  t.after(() => {
    bot.shutdown();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  let connectOptions;
  const joins = [];
  const modes = [];
  const parted = [];
  bot.ircClient.connect = (options) => { connectOptions = options; };
  bot.ircClient.startPeriodicPing = () => {};
  bot.ircClient.join = (...args) => joins.push(args);
  bot.ircClient.raw = (...args) => modes.push(args);
  bot.ircClient.who = () => {};
  bot.ircClient.part = (channel) => parted.push(channel);
  bot.connect();
  bot.ircClient.emit("registered");
  bot.ircClient.emit("registered");
  assert.equal(connectOptions.rejectUnauthorized, true);
  assert.deepEqual(joins, [["#pilot", "fixture-key"], ["#pilot", "fixture-key"]]);

  const say = (target, message, tags = {}) => bot.handleIrcMessage({ nick: "Tester", target, message, tags });
  bot.ircClient.emit("join", { channel: "#pilot", nick: "ImpostorLab" });
  assert.deepEqual(modes, [["MODE", "#pilot"]]);
  await say("#pilot", "ImpostorLab: espera comprobaciones", { msgid: "before-mode" });
  bot.ircClient.emit("userlist", { channel: "#pilot", users: [{ nick: "ImpostorLab", modes: [] }] });
  await say("#pilot", "ImpostorLab: todavía no es un canal verificado", { msgid: "before-names" });
  bot.ircClient.emit("channel info", { channel: "#pilot", modes: [..."Psnk"].map((mode) => ({ mode: `+${mode}` })) });
  await say("ImpostorLab", "DM excluido", { msgid: "excluded-dm" });
  await say("#outside", "ImpostorLab: canal excluido", { msgid: "excluded-channel" });
  await say("#pilot", "ImpostorLabs no es una mención", { msgid: "ambient" });
  bot.handleTagmsg({ nick: "Tester", target: "ImpostorLab", tags: { "+draft/reply": "ignored", "+draft/react": "x" } });
  assert.equal(bot.db.db.prepare("SELECT count(*) AS n FROM messages").get().n, 0);
  assert.equal(bot.db.db.prepare("SELECT count(*) AS n FROM message_msgids").get().n, 0);
  assert.equal(bot.db.db.prepare("SELECT count(*) AS n FROM reactions").get().n, 0);
  assert.equal(calls.length, 0);

  bot.ircClient.say = (...args) => bot.ircClient.emit("pilot-say", ...args);
  const reply = once(bot.ircClient, "pilot-say", { signal: AbortSignal.timeout(4000) });
  await say("#pilot", "impostorlab: responde con texto sintético", { msgid: "accepted" });
  assert.deepEqual((await reply).slice(0, 2), ["#pilot", "respuesta sintética"]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 1);
  assert.match(calls[0].messages[0].content, /Tools are disabled/);
  assert.doesNotMatch(calls[0].messages[0].content, /web_search/);
  assert.equal((await bot.executeTool({ tool_name: "web_fetch", url: "https://example.invalid" })).success, false);
  assert.equal(toolRuns, 0);
  assert.equal(bot.db.db.prepare("SELECT count(*) AS n FROM messages").get().n, 2);
  assert.equal(bot.db.db.prepare("SELECT count(*) AS n FROM prompts").get().n, 1);
  assert.equal(bot.evaluationTimers.size, 0);
  bot.ircClient.emit("mode", { target: "#pilot", modes: [{ mode: "-s" }] });
  await say("#pilot", "ImpostorLab: canal abierto", { msgid: "reopened" });
  assert.deepEqual(parted, ["#pilot"]);
  assert.equal(bot.db.db.prepare("SELECT count(*) AS n FROM messages").get().n, 2);
  assert.equal(calls.length, 1);
});

test("configured credentials are redacted from plain and structured logs", () => {
  const logger = new Logger(true, null, ['fixture"key']).child("pilot");
  const formatted = logger.formatMessage("error", 'error about fixture"key', { error: 'fixture"key' });
  assert.doesNotMatch(formatted, /fixture/);
  assert.match(formatted, /\[redacted\]/);
});

test("private read-only dashboard requires credentials for the UI and API", async (t) => {
  assert.throws(() => new WebServer(silent, { web: { require_auth: true } }, new Map()), /requires web.auth/);
  const dashboard = new WebServer(silent, {
    web: { require_auth: true, read_only: true, auth: { username: "fixture", password: "synthetic" } },
  }, new Map());
  const server = dashboard.app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const root = `http://127.0.0.1:${server.address().port}`;
  const headers = { Authorization: `Basic ${Buffer.from("fixture:synthetic").toString("base64")}` };
  assert.equal((await fetch(`${root}/`)).status, 401);
  assert.equal((await fetch(`${root}/api/bots`)).status, 401);
  assert.equal((await fetch(`${root}/`, { headers })).status, 200);
  assert.deepEqual(await (await fetch(`${root}/api/bots`, { headers })).json(), []);
  assert.equal((await fetch(`${root}/api/journals/%23pilot/run`, { method: "POST", headers })).status, 405);
  assert.equal((await fetch(`${root}/health`)).status, 200);
});
