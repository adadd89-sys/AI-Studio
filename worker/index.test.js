import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import worker, { WORKFLOW_STEP_TIMEOUT, assertWorkflowExecutionSucceeded, finalizeWorkflowAgentStatuses, extractCohereResponseText, extractQwenResponseText, parseQwenChangesResponse, getSessionIdentity, hasAuthProvider, hasTaskSnapshotChanged, isDeveloperWritablePath, normalizeAgentAssignments, normalizeGeminiPlan, normalizeWorkflowTeamSettings, parseCohereChangesResponse, normalizeCreatedPullRequest, buildAgentContextText, applyCohereTextEdits, isWorkersAITimeoutError, shouldFallbackQwenToNorth, runWorkersAIWithRetry } from "./core.js";

const env = {
  APP_PASSWORD: "correct-horse",
  SESSION_SECRET: "test-session-secret",
  GEMINI_API_KEY: "test-key",
  TELEGRAM_BOT_TOKEN: "123456:telegram-test-token",
  TELEGRAM_OWNER_ID: "987654321"
};

async function createTelegramInitData(userId, botToken = env.TELEGRAM_BOT_TOKEN, authDate = Math.floor(Date.now() / 1000)) {
  const entries = [
    ["auth_date", String(authDate)],
    ["query_id", "AAE-test-query"],
    ["user", JSON.stringify({ id: userId, first_name: "Test" })]
  ];
  const checkString = [...entries].sort(([left], [right]) => left.localeCompare(right)).map(([key, value]) => key + "=" + value).join("\n");
  const webAppKey = await crypto.subtle.importKey("raw", new TextEncoder().encode("WebAppData"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const secret = await crypto.subtle.sign("HMAC", webAppKey, new TextEncoder().encode(botToken));
  const validationKey = await crypto.subtle.importKey("raw", secret, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", validationKey, new TextEncoder().encode(checkString)));
  const hash = [...digest].map(byte => byte.toString(16).padStart(2, "0")).join("");
  return new URLSearchParams([...entries, ["hash", hash]]).toString();
}

async function getSessionCookie() {
  const initData = await createTelegramInitData(Number(env.TELEGRAM_OWNER_ID));
  const response = await worker.fetch(new Request("https://studio.test/api/telegram-login", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://studio.test" },
    body: JSON.stringify({ initData })
  }), env);
  assert.equal(response.status, 200);
  return response.headers.get("set-cookie").split(";")[0];
}

function planRequest(cookie, body = { task: "Создай сайт" }) {
  return new Request("https://studio.test/api/plan", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie
    },
    body: typeof body === "string" ? body : JSON.stringify(body)
  });
}


describe("Agent read-only repository context", () => {
  it("keeps relevant source files readable even when they are outside the agent write allowlist", () => {
    const context = buildAgentContextText([
      { path: "worker/core.js", content: "export function parseCohereChangesResponse() {}" },
      { path: "worker/index.test.js", content: "test coverage" }
    ]);
    assert.match(context, /worker\/core\.js/);
    assert.match(context, /parseCohereChangesResponse/);
    assert.match(context, /worker\/index\.test\.js/);
  });
  it("returns an empty context for invalid input and ignores malformed entries", () => {
    assert.equal(buildAgentContextText(null), "");
    assert.equal(buildAgentContextText([{ path: "worker/core.js" }, null]), "");
  });
});

describe("GitHub Pull Request response validation", () => {
  it("accepts only a complete PR response for this repository", () => {
    assert.deepEqual(normalizeCreatedPullRequest({ number: 73, html_url: "https://github.com/adadd89-sys/AI-Studio/pull/73", state: "open" }), {
      number: 73, url: "https://github.com/adadd89-sys/AI-Studio/pull/73", state: "open"
    });
  });
  it("rejects a PR response without a number", () => {
    assert.throws(() => normalizeCreatedPullRequest({ html_url: "https://github.com/adadd89-sys/AI-Studio/pull/73" }), /неполный или некорректный ответ/);
  });
  it("rejects a PR response without html_url", () => {
    assert.throws(() => normalizeCreatedPullRequest({ number: 73 }), /неполный или некорректный ответ/);
  });
  it("rejects a PR URL for another repository", () => {
    assert.throws(() => normalizeCreatedPullRequest({ number: 73, html_url: "https://github.com/Al-Studio/pull/73" }), /неполный или некорректный ответ/);
  });
});

describe("Workers AI timeout recovery", () => {
  it("recognizes Cloudflare internal error 3046 in common error shapes", () => {
    assert.equal(isWorkersAITimeoutError({ code: 3046, message: "AiError: Request timeout" }), true);
    assert.equal(isWorkersAITimeoutError({ internalCode: 3046, httpCode: 408 }), true);
    assert.equal(isWorkersAITimeoutError(new Error("AiError: Request timeout")), true);
    assert.equal(isWorkersAITimeoutError(new Error("Invalid model")), false);
  });
  it("uses North as a fallback only for Qwen timeouts when North is enabled and configured", () => {
    const timeout = Object.assign(new Error("Request timeout"), { code: 3046 });
    const ordinary = new Error("Invalid request");
    assert.equal(shouldFallbackQwenToNorth(timeout, { northEnabled: true, apiKeyAvailable: true }), true);
    assert.equal(shouldFallbackQwenToNorth(timeout, { northEnabled: false, apiKeyAvailable: true }), false);
    assert.equal(shouldFallbackQwenToNorth(timeout, { northEnabled: true, apiKeyAvailable: false }), false);
    assert.equal(shouldFallbackQwenToNorth(ordinary, { northEnabled: true, apiKeyAvailable: true }), false);
  });

  it("retries a Workers AI 3046 and returns the successful response", async () => {
    let calls = 0;
    const ai = { run: async () => {
      calls++;
      if (calls < 3) throw Object.assign(new Error("Request timeout"), { internalCode: 3046 });
      return { response: "ok" };
    } };
    const result = await runWorkersAIWithRetry(ai, "@cf/qwen/qwen3.8-27b", {}, { wait: async () => {} });
    assert.equal(result.response, "ok");
    assert.equal(calls, 3);
  });
  it("returns a clear 3046 error after the retry is exhausted", async () => {
    let calls = 0;
    const ai = { run: async () => {
      calls++;
      throw Object.assign(new Error("Request timeout"), { code: 3046 });
    } };
    await assert.rejects(
      runWorkersAIWithRetry(ai, "@cf/qwen/qwen3.8-27b", {}, { wait: async () => {} }),
      error => error.code === 3046 && /после 3 попыток/.test(error.message)
    );
    assert.equal(calls, 3);
  });
});

describe("Qwen response normalization", () => {
  it("prefers OpenAI-compatible assistant content over a top-level response field", () => {
    const generated = JSON.stringify({ summary: "Updated cards", changes: [{ path: "src/App.jsx", content: "export default function App() { return null; }" }] });
    const payload = {
      id: "chatcmpl-test", object: "chat.completion",
      response: JSON.stringify({ error: "gateway metadata, not model output" }),
      choices: [{ message: { role: "assistant", content: generated } }],
      usage: { total_tokens: 123 }
    };
    assert.equal(extractQwenResponseText(payload), generated);
    assert.deepEqual(JSON.parse(extractQwenResponseText(payload)).changes.map(change => change.path), ["src/App.jsx"]);
  });
  it("supports multipart Qwen assistant content", () => {
    const payload = { choices: [{ message: { content: [{ type: "text", text: '{"summary":"ok","changes":[]}' }] } }] };
    assert.equal(extractQwenResponseText(payload), '{"summary":"ok","changes":[]}');
  });
  it("parses fenced and nested Qwen changes responses", () => {
    const fenced = "Here is the result:\n" + String.fromCharCode(96,96,96) + "json\n" + JSON.stringify({ summary: "ok", changes: [{ path: "src/App.jsx", content: "x" }] }) + "\n" + String.fromCharCode(96,96,96);
    assert.equal(parseQwenChangesResponse(fenced).changes[0].path, "src/App.jsx");
    const nested = JSON.stringify({ result: { files: [{ path: "src/styles.css", content: ".team-card{}" }] } });
    assert.equal(parseQwenChangesResponse(nested).changes[0].path, "src/styles.css");
  });
  it("rejects ordinary Qwen text without file changes", () => {
    assert.equal(parseQwenChangesResponse("I can help with that, but here is a plan."), null);
  });
});

describe("Cohere North patch application", () => {
  it("applies exact unique edits to a large source file", () => {
    const source = ".agent-card{padding:12px;background:#111}";
    const result = applyCohereTextEdits(source, [{ find: "padding:12px", replace: "padding:16px" }]);
    assert.equal(result, ".agent-card{padding:16px;background:#111}");
  });
  it("rejects missing or ambiguous patch anchors", () => {
    assert.throws(() => applyCohereTextEdits(".a{x:1}", [{ find: ".missing", replace: ".b" }]), /отсутствует или встречается несколько раз/);
    assert.throws(() => applyCohereTextEdits(".a{x:1}.a{x:2}", [{ find: ".a", replace: ".b" }]), /отсутствует или встречается несколько раз/);
  });
  it("rejects empty edit lists", () => {
    assert.throws(() => applyCohereTextEdits("source", []), /некорректный массив/);
  });
});

describe("Cohere North response normalization", () => {
  it("parses valid OpenRouter JSON content", () => {
    const p={choices:[{message:{content:'{"changes":[{"path":"src/App.jsx","content":"x"}]}'}}]};
    assert.equal(parseCohereChangesResponse(p).changes[0].path,"src/App.jsx");
  });
  it("parses Markdown-fenced JSON", () => {
    const p={choices:[{message:{content:'\x60\x60\x60json\\n{"changes":[{"path":"worker/core.js","content":"x"}]}\\n\x60\x60\x60'}}]};
    assert.equal(parseCohereChangesResponse(p).changes.length,1);
  });
  it("extracts multipart message content", () => {
    const p={choices:[{message:{content:[{type:"text",text:'{"changes":[]}' }]}}]};
    assert.equal(extractCohereResponseText(p),'{"changes":[]}');
    assert.deepEqual(parseCohereChangesResponse(p).changes,[]);
  });
  it("extracts JSON returned through an OpenRouter tool call", () => {
    const p={choices:[{message:{content:null,tool_calls:[{function:{arguments:'{"changes":[]}'}}]}}]};
    assert.equal(extractCohereResponseText(p),'{"changes":[]}');
    assert.deepEqual(parseCohereChangesResponse(p).changes,[]);
  });
  it("rejects ordinary text and empty responses", () => {
    assert.equal(parseCohereChangesResponse({choices:[{message:{content:"I changed files."}}]}),null);
    assert.equal(parseCohereChangesResponse({choices:[{message:{content:""}}]}),null);
  });
  it("unwraps nested response JSON", () => {
    const p={choices:[{message:{content:JSON.stringify({result:{changes:[{path:"src/x.js",content:"x"}]}})}}]};
    assert.equal(parseCohereChangesResponse(p).changes[0].path,"src/x.js");
  });
});

describe("Gemini developer delegation", () => {
  it("only exposes source and runtime files as developer-writable paths", () => {
    assert.equal(isDeveloperWritablePath("src/App.jsx"), true);
    assert.equal(isDeveloperWritablePath("worker/core.js"), true);
    assert.equal(isDeveloperWritablePath("index.html"), true);
    assert.equal(isDeveloperWritablePath("README.md"), false);
    assert.equal(isDeveloperWritablePath("package.json"), false);
    assert.equal(isDeveloperWritablePath("package-lock.json"), false);
    assert.equal(isDeveloperWritablePath("wrangler.toml"), false);
  });

  it("requires a separate assignment for every enabled developer", () => {
    const assignments = [
      { agent: "qwen", task: "Implement the API", allowedPaths: ["worker/core.js"] }
    ];
    assert.throws(
      () => normalizeAgentAssignments(assignments, ["qwen", "north"], "Build the feature"),
      /каждому включённому разработчику/
    );
  });

  it("preserves distinct scoped assignments for Qwen and North", () => {
    const assignments = normalizeAgentAssignments([
      { agent: "qwen", task: "Implement backend", allowedPaths: ["worker/core.js"] },
      { agent: "north", task: "Implement UI", allowedPaths: ["src/App.jsx"] }
    ], ["qwen", "north"], "Build the feature");
    assert.deepEqual(assignments, [
      { agent: "qwen", task: "Implement backend", allowedPaths: ["worker/core.js"] },
      { agent: "north", task: "Implement UI", allowedPaths: ["src/App.jsx"] }
    ]);
  });

  it("rejects an assignment missing task text or allowed paths", () => {
    assert.throws(
      () => normalizeAgentAssignments([
        { agent: "qwen", task: "", allowedPaths: ["worker/core.js"] }
      ], ["qwen"], "Build the feature"),
      /нужны текст задания и разрешённые файлы/
    );
    assert.throws(
      () => normalizeAgentAssignments([
        { agent: "qwen", task: "Implement backend", allowedPaths: [] }
      ], ["qwen"], "Build the feature"),
      /нужны текст задания и разрешённые файлы/
    );
  });
  it("rejects overlapping file ownership between developers", () => {
    assert.throws(() => normalizeAgentAssignments([
      { agent: "qwen", task: "Backend", allowedPaths: ["worker/core.js"] },
      { agent: "north", task: "Also backend", allowedPaths: ["worker/core.js"] }
    ], ["qwen", "north"], "Build the feature"), /один файл нескольким разработчикам/);
  });

  it("rejects an assignment for a disabled developer", () => {
    assert.throws(() => normalizeAgentAssignments([
      { agent: "qwen", task: "Backend", allowedPaths: ["worker/core.js"] },
      { agent: "north", task: "UI", allowedPaths: ["src/App.jsx"] }
    ], ["qwen"], "Build the feature"), /отключён/);
  });

  it("keeps the single-developer fallback when Gemini supplies no assignments", () => {
    assert.deepEqual(
      normalizeAgentAssignments([], ["qwen"], "Build the feature"),
      [{ agent: "qwen", task: "Build the feature", allowedPaths: [] }]
    );
  });
  it("supplies repository-scoped fallback paths for a single developer", () => {
    assert.deepEqual(
      normalizeAgentAssignments([], ["qwen"], "Build the feature", ["worker/core.js"], ["worker/core.js", "src/App.jsx"]),
      [{ agent: "qwen", task: "Build the feature", allowedPaths: ["worker/core.js"] }]
    );
  });
  it("rejects allowed paths that are not present in the repository tree", () => {
    assert.throws(
      () => normalizeAgentAssignments([
        { agent: "qwen", task: "Implement backend", allowedPaths: ["worker/missing.js"] }
      ], ["qwen"], "Build the feature", [], ["worker/core.js"]),
      /недопустимый путь файла/
    );
  });
  it("does not create an unscoped fallback when repository paths are known but no safe path is available", () => {
    assert.throws(
      () => normalizeAgentAssignments([], ["qwen"], "Build the feature", [], ["worker/core.js"]),
      /разрешённые файлы/
    );
  });
});

describe("AI Studio Worker", () => {
  it("uses an explicit 30-minute Workflow step timeout", () => {
    assert.equal(WORKFLOW_STEP_TIMEOUT, "30 minutes");
  });

  it("marks workflow execution as failed when the internal worker returns an error", () => {
    assert.throws(
      () => assertWorkflowExecutionSucceeded(502, { error: "Qwen вернул пустой ответ." }),
      /Qwen вернул пустой ответ/
    );
    assert.throws(
      () => assertWorkflowExecutionSucceeded(200, { error: "Частичные изменения не сохранены." }),
      /Частичные изменения не сохранены/
    );
  });

  it("preserves every enabled Gemini reviewer when normalizing workflow settings", () => {
    const settings = normalizeWorkflowTeamSettings({
      intensity: 75, mode: "normal",
      agents: { gemini: true, gemini38: true, gemini36: false, geminiLite: true, gemini31Lite: true, qwen: true, gemma: true, north: true }
    });
    assert.deepEqual(settings.agents, {
      gemini: true, gemini38: true, gemini36: false, geminiLite: true, gemini31Lite: true,
      qwen: true, gemma: true, north: true
    });
    assert.equal(settings.intensity, 75);
  });

  it("preserves successful workflow output for status polling", () => {
    const result = assertWorkflowExecutionSucceeded(200, { ok: true, branch: "ai-studio/task-1" });
    assert.deepEqual(result, { httpStatus: 200, data: { ok: true, branch: "ai-studio/task-1" } });
  });

  it("accepts Telegram as an authentication provider without APP_PASSWORD", () => {
    assert.equal(hasAuthProvider({ SESSION_SECRET: "secret", TELEGRAM_BOT_TOKEN: "bot-token", TELEGRAM_OWNER_ID: "123456789", APP_PASSWORD: "" }), true);
    assert.equal(hasAuthProvider({ SESSION_SECRET: "secret", TELEGRAM_BOT_TOKEN: "bot-token", APP_PASSWORD: "" }), false);
    assert.equal(hasAuthProvider({ SESSION_SECRET: "secret", APP_PASSWORD: "password" }), false);
  });
  it("returns health status without exposing secrets", async () => {
    const response = await worker.fetch(new Request("https://studio.test/api/health"), {});
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ok: true,
      service: "ai-studio-api",
      modelConfigured: false,
      qwenConfigured: false,
      openrouterConfigured: false,
      telegramAuthConfigured: false,
      passwordAuthConfigured: false,
      githubConfigured: false,
      authConfigured: false
    });
  });

  it("rejects planning requests without a session", async () => {
    const response = await worker.fetch(planRequest("", { task: "Создай сайт" }), env);
    assert.equal(response.status, 401);
  });


  it("authenticates a Telegram Mini App user with a valid signed initData payload", async () => {
    const botToken = "123456:telegram-test-token";
    const entries = [
      ["auth_date", String(Math.floor(Date.now() / 1000))],
      ["query_id", "AAE-test-query"],
      ["user", JSON.stringify({ id: 987654321, first_name: "Test" })]
    ];
    const checkString = [...entries].sort(([left],[right]) => left.localeCompare(right)).map(([key,value]) => key + "=" + value).join("\n");
    const webAppKey = await crypto.subtle.importKey("raw", new TextEncoder().encode("WebAppData"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const secret = await crypto.subtle.sign("HMAC", webAppKey, new TextEncoder().encode(botToken));
    const validationKey = await crypto.subtle.importKey("raw", secret, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const digest = new Uint8Array(await crypto.subtle.sign("HMAC", validationKey, new TextEncoder().encode(checkString)));
    const hash = [...digest].map(byte => byte.toString(16).padStart(2, "0")).join("");
    const initData = new URLSearchParams([...entries, ["hash", hash]]).toString();
    const response = await worker.fetch(new Request("https://studio.test/api/telegram-login", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://studio.test" },
      body: JSON.stringify({ initData })
    }), { SESSION_SECRET: env.SESSION_SECRET, TELEGRAM_BOT_TOKEN: botToken, TELEGRAM_OWNER_ID: "987654321" });
    assert.equal(response.status, 200);
    const cookie = response.headers.get("set-cookie").split(";")[0];
    const identity = await getSessionIdentity(new Request("https://studio.test/", { headers: { cookie } }), env.SESSION_SECRET);
    assert.deepEqual(identity, { telegramUserId: 987654321 });
    const session = await worker.fetch(new Request("https://studio.test/api/session", { headers: { cookie } }), {
      SESSION_SECRET: env.SESSION_SECRET, TELEGRAM_BOT_TOKEN: botToken, TELEGRAM_OWNER_ID: "987654321"
    });
    assert.equal((await session.json()).authenticated, true);
  });


  it("rejects validly signed Telegram initData older than ten minutes", async () => {
    const botToken = "123456:telegram-test-token";
    const entries = [
      ["auth_date", String(Math.floor(Date.now() / 1000) - 601)],
      ["query_id", "AAE-stale-query"],
      ["user", JSON.stringify({ id: 987654321, first_name: "Test" })]
    ];
    const checkString = [...entries].sort(([left],[right]) => left.localeCompare(right)).map(([key,value]) => key + "=" + value).join("\n");
    const webAppKey = await crypto.subtle.importKey("raw", new TextEncoder().encode("WebAppData"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const secret = await crypto.subtle.sign("HMAC", webAppKey, new TextEncoder().encode(botToken));
    const validationKey = await crypto.subtle.importKey("raw", secret, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const digest = new Uint8Array(await crypto.subtle.sign("HMAC", validationKey, new TextEncoder().encode(checkString)));
    const hash = [...digest].map(byte => byte.toString(16).padStart(2, "0")).join("");
    const initData = new URLSearchParams([...entries, ["hash", hash]]).toString();
    const response = await worker.fetch(new Request("https://studio.test/api/telegram-login", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://studio.test" },
      body: JSON.stringify({ initData })
    }), { SESSION_SECRET: env.SESSION_SECRET, TELEGRAM_BOT_TOKEN: botToken, TELEGRAM_OWNER_ID: "987654321" });
    assert.equal(response.status, 401);
  });

  it("rejects tampered Telegram Mini App initData", async () => {
    const response = await worker.fetch(new Request("https://studio.test/api/telegram-login", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://studio.test" },
      body: JSON.stringify({ initData: "auth_date=1&user=%7B%22id%22%3A1%7D&hash=" + "0".repeat(64) })
    }), { SESSION_SECRET: env.SESSION_SECRET, TELEGRAM_BOT_TOKEN: "test-token", TELEGRAM_OWNER_ID: "987654321" });
    assert.equal(response.status, 401);
  });

  it("rejects login requests from a different origin", async () => {
    const response = await worker.fetch(new Request("https://studio.test/api/login", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://attacker.test" },
      body: JSON.stringify({ password: env.APP_PASSWORD })
    }), env);
    assert.equal(response.status, 403);
  });

  it("creates a signed session only for the configured Telegram owner", async () => {
    const cookie = await getSessionCookie();
    const response = await worker.fetch(new Request("https://studio.test/api/session", {
      headers: { cookie }
    }), env);
    assert.deepEqual(await response.json(), { authenticated: true, isOwner: true, role: "owner", telegramUserId: 987654321, authConfigured: true, telegramAuthConfigured: true });
  });

  it("disables password login even when APP_PASSWORD is configured", async () => {
    const response = await worker.fetch(new Request("https://studio.test/api/login", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://studio.test" },
      body: JSON.stringify({ password: env.APP_PASSWORD })
    }), env);
    assert.equal(response.status, 403);
  });

  it("allows an owner-approved Telegram user to sign in, but blocks repository work", async () => {
    const ownerCookie = await getSessionCookie();
    const records = new Map();
    const store = {
      get: async key => records.get(key) || null,
      put: async (key, value) => { records.set(key, value); }
    };
    const addResponse = await worker.fetch(new Request("https://studio.test/api/users", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: ownerCookie, origin: "https://studio.test" },
      body: JSON.stringify({ telegramUserId: "123456789" })
    }), { ...env, TASKS: store });
    assert.equal(addResponse.status, 200);
    assert.equal((await addResponse.json()).users[0].role, "user");

    const initData = await createTelegramInitData(123456789);
    const loginResponse = await worker.fetch(new Request("https://studio.test/api/telegram-login", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://studio.test" },
      body: JSON.stringify({ initData })
    }), { ...env, TASKS: store });
    assert.equal(loginResponse.status, 200);
    const cookie = loginResponse.headers.get("set-cookie").split(";")[0];

    const sessionResponse = await worker.fetch(new Request("https://studio.test/api/session", { headers: { cookie } }), { ...env, TASKS: store });
    assert.deepEqual(await sessionResponse.json(), {
      authenticated: true, isOwner: false, role: "user", telegramUserId: 123456789, authConfigured: true, telegramAuthConfigured: true
    });

    const blocked = await worker.fetch(new Request("https://studio.test/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json", cookie, origin: "https://studio.test" },
      body: JSON.stringify({ message: "Исправь код в GitHub" })
    }), { ...env, TASKS: store });
    assert.equal(blocked.status, 403);
  });

  it("revokes an invited user's access immediately after removal", async () => {
    const ownerCookie = await getSessionCookie();
    const records = new Map([["access:telegram-users", JSON.stringify([
      { telegramUserId: "123456789", role: "user", active: true }
    ])]]);
    const store = { get: async key => records.get(key) || null, put: async (key, value) => records.set(key, value) };
    const initData = await createTelegramInitData(123456789);
    const loginResponse = await worker.fetch(new Request("https://studio.test/api/telegram-login", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://studio.test" },
      body: JSON.stringify({ initData })
    }), { ...env, TASKS: store });
    assert.equal(loginResponse.status, 200);
    const cookie = loginResponse.headers.get("set-cookie").split(";")[0];
    const revoke = await worker.fetch(new Request("https://studio.test/api/users", {
      method: "DELETE",
      headers: { "content-type": "application/json", cookie: ownerCookie, origin: "https://studio.test" },
      body: JSON.stringify({ telegramUserId: "123456789" })
    }), { ...env, TASKS: store });
    assert.equal(revoke.status, 200);
    const session = await worker.fetch(new Request("https://studio.test/api/session", { headers: { cookie } }), { ...env, TASKS: store });
    assert.equal((await session.json()).authenticated, false);
  });

  it("rejects a valid Telegram signature from a non-owner account", async () => {
    const initData = await createTelegramInitData(123456789);
    const response = await worker.fetch(new Request("https://studio.test/api/telegram-login", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://studio.test" },
      body: JSON.stringify({ initData })
    }), env);
    assert.equal(response.status, 403);
  });

  it("rejects malformed JSON after authentication", async () => {
    const cookie = await getSessionCookie();
    const response = await worker.fetch(planRequest(cookie, "{"), env);
    assert.equal(response.status, 400);
  });

  it("rejects an empty task after authentication", async () => {
    const cookie = await getSessionCookie();
    const response = await worker.fetch(planRequest(cookie, { task: "   " }), env);
    assert.equal(response.status, 400);
  });

  it("does not call Gemini when the API key is missing", async () => {
    const cookie = await getSessionCookie();
    const response = await worker.fetch(planRequest(cookie), {
      APP_PASSWORD: env.APP_PASSWORD,
      SESSION_SECRET: env.SESSION_SECRET,
      TELEGRAM_BOT_TOKEN: env.TELEGRAM_BOT_TOKEN,
      TELEGRAM_OWNER_ID: env.TELEGRAM_OWNER_ID
    });
    assert.equal(response.status, 503);
    assert.match((await response.json()).error, /Gemini пока не подключён/);
  });

  it("returns a structured plan from Gemini", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: JSON.stringify({
        summary: "План создания сайта",
        steps: ["Уточнить требования", "Собрать интерфейс", "Проверить сборку"],
        risks: [],
        questions: []
      }) }] } }]
    }), { status: 200, headers: { "content-type": "application/json" } });

    try {
      const cookie = await getSessionCookie();
      const response = await worker.fetch(planRequest(cookie), env);
      assert.equal(response.status, 200);
      const result = await response.json();
      assert.equal(result.model, "gemini-3.8-flash");
      assert.equal(result.plan.steps.length, 3);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("checks model availability without generating content", async () => {
    const originalFetch = globalThis.fetch;
    let requestedUrl = "";
    globalThis.fetch = async (url, options) => {
      requestedUrl = String(url);
      assert.equal(options.headers["x-goog-api-key"], env.GEMINI_API_KEY);
      return new Response(JSON.stringify({ models: [{
        name: "models/gemini-4-hydrogen",
        displayName: "Gemini 4 Hydrogen",
        supportedGenerationMethods: ["generateContent"],
        inputTokenLimit: 1048576,
        outputTokenLimit: 8192
      }] }), { status: 200, headers: { "content-type": "application/json" } });
    };
    try {
      const cookie = await getSessionCookie();
      const response = await worker.fetch(new Request("https://studio.test/api/models/check", {
        headers: { cookie }
      }), env);
      assert.equal(response.status, 200);
      const result = await response.json();
      assert.equal(result.found, true);
      assert.equal(result.supportsGenerateContent, true);
      assert.match(requestedUrl, /\/models\?/);
      assert.doesNotMatch(requestedUrl, /generateContent/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("falls back from Hydrogen to Flash when the primary model is rate-limited", async () => {
    const originalFetch = globalThis.fetch;
    const requestedModels = [];
    globalThis.fetch = async (url) => {
      const match = String(url).match(/models\/([^:]+):generateContent/);
      requestedModels.push(decodeURIComponent(match?.[1] || ""));
      if (requestedModels.length === 1) return new Response("{}", { status: 429 });
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: JSON.stringify({
          summary: "План создан резервной моделью",
          steps: ["Проверить результат"],
          risks: [],
          questions: []
        }) }] } }]
      }), { status: 200, headers: { "content-type": "application/json" } });
    };

    try {
      const cookie = await getSessionCookie();
      const response = await worker.fetch(planRequest(cookie), {
        ...env,
        GEMINI_MODEL: "gemini-4-hydrogen",
        GEMINI_FALLBACK_MODEL: "gemini-3.8-flash"
      });
      assert.equal(response.status, 200);
      const result = await response.json();
      assert.equal(result.model, "gemini-3.8-flash");
      assert.equal(result.primaryModel, "gemini-4-hydrogen");
      assert.equal(result.fallbackUsed, true);
      assert.deepEqual(requestedModels, ["gemini-4-hydrogen", "gemini-3.8-flash"]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("rejects Gemma reviews without a session", async () => {
    const response = await worker.fetch(new Request("https://studio.test/api/agents/gemma-review", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ task: "Создай сайт", plan: "Сделать сайт" })
    }), { ...env, AI: { run: async () => ({ response: "ok" }) } });
    assert.equal(response.status, 401);
  });

  it("returns a structured review from Gemma through Workers AI", async () => {
    const cookie = await getSessionCookie();
    let calledModel = "";
    let calledMessages = [];
    const response = await worker.fetch(new Request("https://studio.test/api/agents/gemma-review", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ task: "Создай сайт", plan: "1. Уточнить требования\\n2. Собрать интерфейс" })
    }), {
      ...env,
      GEMMA_MODEL: "@cf/google/gemma-4-26b-a4b-it",
      AI: {
        run: async (model, input) => {
          calledModel = model;
          calledMessages = input.messages;
          return { response: "Риски: не определены критерии приёмки.\\nИсправление: добавить тесты." };
        }
      }
    });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.ok, true);
    assert.equal(result.agent, "Gemma");
    assert.equal(result.model, "@cf/google/gemma-4-26b-a4b-it");
    assert.match(result.review, /критерии приёмки/);
    assert.equal(calledModel, "@cf/google/gemma-4-26b-a4b-it");
    assert.equal(calledMessages.length, 2);
  });

  it("does not call Workers AI when the binding is missing", async () => {
    const cookie = await getSessionCookie();
    const response = await worker.fetch(new Request("https://studio.test/api/agents/gemma-review", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ task: "Создай сайт", plan: "Сделать сайт" })
    }), env);
    assert.equal(response.status, 503);
    assert.match((await response.json()).error, /Workers AI не подключён/);
  });


  it("rejects Qwen reviews without a session", async () => {
    const response = await worker.fetch(new Request("https://studio.test/api/agents/qwen-review", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ task: "Создай сайт", plan: "Сделать сайт" })
    }), { ...env, AI: { run: async () => ({ response: "ok" }) } });
    assert.equal(response.status, 401);
  });

  it("returns a structured Qwen review through Cloudflare Workers AI", async () => {
    const cookie = await getSessionCookie();
    let calledModel = "";
    let calledMessages = [];
    const response = await worker.fetch(new Request("https://studio.test/api/agents/qwen-review", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ task: "Создай сайт", plan: "1. Уточнить требования\\n2. Собрать интерфейс" })
    }), {
      ...env,
      QWEN_MODEL: "@cf/qwen/qwen3.8-27b",
      AI: {
        run: async (model, input) => {
          calledModel = model;
          calledMessages = input.messages;
          return { response: "Недостаточно критериев приёмки. Добавить тесты и проверку сборки." };
        }
      }
    });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.ok, true);
    assert.equal(result.agent, "Qwen");
    assert.equal(result.model, "@cf/qwen/qwen3.8-27b");
    assert.match(result.review, /критериев приёмки/);
    assert.equal(calledModel, "@cf/qwen/qwen3.8-27b");
    assert.equal(calledMessages.length, 2);
  });

  it("does not call Workers AI for Qwen when the AI binding is missing", async () => {
    const cookie = await getSessionCookie();
    const response = await worker.fetch(new Request("https://studio.test/api/agents/qwen-review", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ task: "Создай сайт", plan: "Сделать сайт" })
    }), env);
    assert.equal(response.status, 503);
    assert.match((await response.json()).error, /Qwen не подключён/);
  });


  it("requires a configured GitHub token for repository access", async () => {
    const cookie = await getSessionCookie();
    const response = await worker.fetch(new Request("https://studio.test/api/github/tree"), {
      ...env,
      GITHUB_TOKEN: ""
    });
    assert.equal(response.status, 401);
    const authenticated = await worker.fetch(new Request("https://studio.test/api/github/tree", {
      headers: { cookie }
    }), { ...env, GITHUB_TOKEN: "" });
    assert.equal(authenticated.status, 503);
    assert.match((await authenticated.json()).error, /GITHUB_TOKEN/);
  });

  it("never allows writes to main", async () => {
    const cookie = await getSessionCookie();
    const response = await worker.fetch(new Request("https://studio.test/api/github/file", {
      method: "PUT",
      headers: { "content-type": "application/json", cookie, origin: "https://studio.test" },
      body: JSON.stringify({ path: "README.md", branch: "main", content: "unsafe", sha: "a".repeat(40) })
    }), { ...env, GITHUB_TOKEN: "test-token" });
    assert.equal(response.status, 403);
  });

  it("rejects path traversal before calling GitHub", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error("GitHub should not be called"); };
    try {
      const cookie = await getSessionCookie();
      const response = await worker.fetch(new Request("https://studio.test/api/github/file?path=..%2Fsecret.txt&ref=main", {
        headers: { cookie }
      }), { ...env, GITHUB_TOKEN: "test-token" });
      assert.equal(response.status, 400);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("commits file updates only to an AI Studio branch", async () => {
    const originalFetch = globalThis.fetch;
    let requestedUrl = "";
    let requestBody = null;
    globalThis.fetch = async (url, options) => {
      requestedUrl = String(url);
      requestBody = JSON.parse(options.body);
      return new Response(JSON.stringify({
        content: { sha: "b".repeat(40) },
        commit: { sha: "c".repeat(40) }
      }), { status: 200, headers: { "content-type": "application/json" } });
    };
    try {
      const cookie = await getSessionCookie();
      const response = await worker.fetch(new Request("https://studio.test/api/github/file", {
        method: "PUT",
        headers: { "content-type": "application/json", cookie, origin: "https://studio.test" },
        body: JSON.stringify({
          path: "src/example.js",
          branch: "ai-studio/task-1",
          content: "export const ready = true;",
          sha: "a".repeat(40),
          message: "Update example"
        })
      }), { ...env, GITHUB_TOKEN: "test-token" });
      assert.equal(response.status, 200);
      const result = await response.json();
      assert.equal(result.ok, true);
      assert.equal(result.commit, "c".repeat(40));
      assert.equal(requestBody.branch, "ai-studio/task-1");
      assert.equal(requestBody.sha, "a".repeat(40));
      assert.match(requestedUrl, /contents\/src\/example\.js$/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("rejects file deletion from main", async () => {
    const cookie = await getSessionCookie();
    const response = await worker.fetch(new Request("https://studio.test/api/github/file", {
      method: "DELETE",
      headers: { "content-type": "application/json", cookie, origin: "https://studio.test" },
      body: JSON.stringify({ path: "README.md", branch: "main", sha: "a".repeat(40) })
    }), { ...env, GITHUB_TOKEN: "test-token" });
    assert.equal(response.status, 403);
  });

  it("deletes a file only from an AI Studio branch using its current SHA", async () => {
    const originalFetch = globalThis.fetch;
    let requestedUrl = "";
    let requestBody = null;
    globalThis.fetch = async (url, options) => {
      requestedUrl = String(url);
      requestBody = JSON.parse(options.body);
      return new Response(JSON.stringify({ commit: { sha: "d".repeat(40) } }), {
        status: 200, headers: { "content-type": "application/json" }
      });
    };
    try {
      const cookie = await getSessionCookie();
      const response = await worker.fetch(new Request("https://studio.test/api/github/file", {
        method: "DELETE",
        headers: { "content-type": "application/json", cookie, origin: "https://studio.test" },
        body: JSON.stringify({ path: "src/old.js", branch: "ai-studio/task-1", sha: "a".repeat(40) })
      }), { ...env, GITHUB_TOKEN: "test-token" });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).commit, "d".repeat(40));
      assert.equal(requestBody.branch, "ai-studio/task-1");
      assert.equal(requestBody.sha, "a".repeat(40));
      assert.match(requestedUrl, /contents\/src\/old\.js$/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("requires the current file SHA before deletion", async () => {
    const cookie = await getSessionCookie();
    const response = await worker.fetch(new Request("https://studio.test/api/github/file", {
      method: "DELETE",
      headers: { "content-type": "application/json", cookie, origin: "https://studio.test" },
      body: JSON.stringify({ path: "src/old.js", branch: "ai-studio/task-1", sha: null })
    }), { ...env, GITHUB_TOKEN: "test-token" });
    assert.equal(response.status, 400);
  });

  it("returns a rate-limit message when Gemini responds with 429", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response("{}", { status: 429 });
    try {
      const cookie = await getSessionCookie();
      const response = await worker.fetch(planRequest(cookie), env);
      assert.equal(response.status, 429);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });



  it("allows Telegram-authenticated sessions to use the chat API without APP_PASSWORD", async () => {
    const cookie = await getSessionCookie();
    const response = await worker.fetch(new Request("https://studio.test/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json", cookie, origin: "https://studio.test" },
      body: JSON.stringify({
        message: "Привет",
        teamSettings: { mode: "chat", intensity: 10, agents: { gemini: false, qwen: true, gemma: false, north: false } }
      })
    }), {
      ...env,
      APP_PASSWORD: "",
      TELEGRAM_BOT_TOKEN: "configured-telegram-bot-token",
      AI: { run: async () => ({ response: "Привет! Я Qwen." }) }
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).agent, "qwen");
  });

  it("keeps lightweight chat separate from the development workflow", async () => {
    const cookie = await getSessionCookie();
    let requestedModel = "";
    let requestedBudget = 0;
    const response = await worker.fetch(new Request("https://studio.test/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json", cookie, origin: "https://studio.test" },
      body: JSON.stringify({
        message: "Привет! Давай просто поговорим.",
        history: [{ role: "user", content: "Предыдущая реплика" }],
        teamSettings: { mode: "chat", intensity: 10, agents: { gemini: false, qwen: true, gemma: false, north: false } }
      })
    }), {
      ...env,
      AI: { run: async (model, input) => {
        requestedModel = model;
        requestedBudget = input.max_completion_tokens;
        assert.equal(input.messages.at(-1).content, "Привет! Давай просто поговорим.");
        return { response: "Привет! Конечно, давай." };
      } }
    });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.agent, "qwen");
    assert.equal(result.reply, "Привет! Конечно, давай.");
    assert.equal(result.usage.requests, 1);
    assert.equal(requestedModel, "@cf/qwen/qwen3.8-27b");
    assert.ok(requestedBudget >= 2048 && requestedBudget <= 8192);
  });

  it("does not contact a disabled agent in lightweight chat", async () => {
    const cookie = await getSessionCookie();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error("Disabled Gemini must not be called"); };
    try {
      const response = await worker.fetch(new Request("https://studio.test/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json", cookie, origin: "https://studio.test" },
        body: JSON.stringify({ message: "Тест", teamSettings: { mode: "chat", agents: { gemini: false, qwen: true, gemma: false, north: false } } })
      }), { ...env, AI: { run: async () => ({ response: "Ответ от Qwen." }) } });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).agent, "qwen");
    } finally { globalThis.fetch = originalFetch; }
  });


  it("routes lightweight chat to Cohere North Mini Code when it is the enabled agent", async () => {
    const cookie = await getSessionCookie();
    const originalFetch = globalThis.fetch;
    let sentModel = "";
    globalThis.fetch = async (url, options) => {
      assert.match(String(url), /openrouter\.ai\/api\/v1\/chat\/completions/);
      sentModel = JSON.parse(options.body).model;
      return new Response(JSON.stringify({ choices: [{ message: { content: "Привет! Я North." } }] }), {
        status: 200, headers: { "content-type": "application/json" }
      });
    };
    try {
      const response = await worker.fetch(new Request("https://studio.test/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json", cookie, origin: "https://studio.test" },
        body: JSON.stringify({ message: "Привет", teamSettings: { mode: "chat", agents: { gemini: false, qwen: false, gemma: false, north: true } } })
      }), { ...env, OPENROUTER_API_KEY: "test-openrouter-key" });
      assert.equal(response.status, 200);
      const result = await response.json();
      assert.equal(result.agent, "north");
      assert.equal(result.reply, "Привет! Я North.");
      assert.equal(sentModel, "cohere/north-mini-code:free");
    } finally { globalThis.fetch = originalFetch; }
  });

  it("rejects lightweight chat without an enabled agent", async () => {
    const cookie = await getSessionCookie();
    const response = await worker.fetch(new Request("https://studio.test/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json", cookie, origin: "https://studio.test" },
      body: JSON.stringify({ message: "Тест", teamSettings: { agents: { gemini: false, qwen: false, gemma: false, north: false } } })
    }), env);
    assert.equal(response.status, 400);
  });

  it("allows execution with Gemini disabled when Qwen remains enabled", async () => {
    const cookie = await getSessionCookie();
    const response = await worker.fetch(new Request("https://studio.test/api/execute", {
      method: "POST",
      headers: { "content-type": "application/json", cookie, origin: "https://studio.test" },
      body: JSON.stringify({ task: "", teamSettings: {
        intensity: 20, mode: "normal",
        agents: { gemini: false, qwen: true, gemma: false, north: false }
      } })
    }), { ...env, GEMINI_API_KEY: undefined, GITHUB_TOKEN: "test-github-token", AI: { run: async () => ({ response: "{}" }) } });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /Опишите задачу/);
  });

  it("allows North-only execution without the Cloudflare AI binding", async () => {
    const cookie = await getSessionCookie();
    const response = await worker.fetch(new Request("https://studio.test/api/execute", {
      method: "POST",
      headers: { "content-type": "application/json", cookie, origin: "https://studio.test" },
      body: JSON.stringify({ task: "", teamSettings: {
        intensity: 20, mode: "normal",
        agents: { gemini: false, qwen: false, gemma: false, north: true }
      } })
    }), { ...env, GEMINI_API_KEY: undefined, GITHUB_TOKEN: "test-github-token", AI: undefined, OPENROUTER_API_KEY: "test-openrouter-key" });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /Опишите задачу/);
  });

  it("rejects autonomous execution without a session", async () => {
    const response = await worker.fetch(new Request("https://studio.test/api/execute", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://studio.test" },
      body: JSON.stringify({ task: "Добавь экран настроек" })
    }), { ...env, AI: { run: async () => ({ response: "{}" }) }, GITHUB_TOKEN: "test-token" });
    assert.equal(response.status, 401);
  });

  it("rejects autonomous execution from a different origin", async () => {
    const cookie = await getSessionCookie();
    const response = await worker.fetch(new Request("https://studio.test/api/execute", {
      method: "POST",
      headers: { "content-type": "application/json", cookie, origin: "https://attacker.test" },
      body: JSON.stringify({ task: "Добавь экран настроек" })
    }), { ...env, AI: { run: async () => ({ response: "{}" }) }, GITHUB_TOKEN: "test-token" });
    assert.equal(response.status, 403);
  });

  it("requires Workers AI for autonomous execution", async () => {
    const cookie = await getSessionCookie();
    const response = await worker.fetch(new Request("https://studio.test/api/execute", {
      method: "POST",
      headers: { "content-type": "application/json", cookie, origin: "https://studio.test" },
      body: JSON.stringify({ task: "Добавь экран настроек" })
    }), { ...env, AI: null, GITHUB_TOKEN: "test-token" });
    assert.equal(response.status, 503);
    assert.match((await response.json()).error, /Workers AI/);
  });

  it("coordinates Gemini and Qwen implementation with independent North and Gemma review", async () => {
    const originalFetch = globalThis.fetch;
    const cookie = await getSessionCookie();
    const writes = [];
    const requestedGeminiModels = [];
    const assignmentRepairPrompts = [];
    globalThis.fetch = async (url, options = {}) => {
      const target = String(url);
      if (target.includes("generativelanguage.googleapis.com")) {
        const model = decodeURIComponent(target.match(/models\/([^:]+):generateContent/)?.[1] || "");
        requestedGeminiModels.push(model);
        if (model === "gemini-4-hydrogen" || model === "gemini-3.8-flash") {
          return new Response(JSON.stringify({ error: { message: "Model overloaded" } }), { status: 503 });
        }
        const prompt = JSON.parse(options.body).contents?.[0]?.parts?.[0]?.text || "";
        if (prompt.includes("Ты исправляешь только распределение задач")) assignmentRepairPrompts.push(prompt);
        const responseData = prompt.includes("Ты исправляешь только распределение задач")
          ? { assignments: [
              { agent: "qwen", task: "Обнови компонент приложения для экрана настроек", allowedPaths: ["src/App.jsx"] }
            ] }
          : {
              summary: "Добавить экран настроек",
              steps: ["Создать компонент настроек", "Проверить изменения"],
              acceptanceCriteria: ["Экран доступен из навигации"],
              risks: [],
              questions: [],
              assignments: [
                { agent: "qwen", task: "Создай компонент настроек", allowedPaths: ["src/App.jsx"] },
                { agent: "north", task: "Обнови документацию", allowedPaths: ["README.md"] }
              ]
            };
        return new Response(JSON.stringify({
          candidates: [{ content: { parts: [{ text: JSON.stringify(responseData) }] } }]
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (target.includes("/git/trees/") && target.includes("?recursive=1")) {
        return new Response(JSON.stringify({ tree: [
          { path: "README.md", type: "blob" },
          { path: "src/App.jsx", type: "blob" },
          { path: "src/theme.css", type: "blob" }
        ] }), { status: 200 });
      }
      if (target.includes("/contents/src/theme.css?ref=main")) {
        return new Response(JSON.stringify({ content: btoa(".settings { display: block; }"), sha: "e".repeat(40) }), { status: 200 });
      }
      if (target.includes("/contents/src/App.jsx?ref=main")) {
        return new Response(JSON.stringify({ content: btoa("export default function App() { return null; }"), sha: "a".repeat(40) }), { status: 200 });
      }
      if (target.includes("/contents/") && target.includes("?ref=ai-studio%2Ftask-")) {
        return new Response(JSON.stringify({ sha: "d".repeat(40) }), { status: 200 });
      }
      if (target.includes("/git/ref/heads/main")) {
        return new Response(JSON.stringify({ object: { sha: "b".repeat(40) } }), { status: 200 });
      }
      if (target.endsWith("/git/refs") && options.method === "POST") {
        return new Response(JSON.stringify({ ref: "refs/heads/ai-studio/task-test" }), { status: 201 });
      }
      if (target.includes("openrouter.ai/api/v1/chat/completions")) {
        const payload = JSON.parse(options.body);
        const system = payload.messages?.[0]?.content || "";
        const result = system.includes("основной разработчик")
          ? (assert.deepEqual(payload.response_format, { type: "json_object" }), { summary: "North подготовил стили", changes: [{ path: "src/theme.css", edits: [{ find: ".settings { display: block; }", replace: ".settings { display: grid; }" }], reason: "Стили настроек" }] })
          : { approved: true, summary: "North проверил изменения.", issues: [] };
        return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(result) } }] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (target.includes("/contents/") && options.method === "PUT") {
        writes.push(JSON.parse(options.body));
        return new Response(JSON.stringify({ commit: { sha: "c".repeat(40) } }), { status: 201 });
      }
      if (target.endsWith("/pulls") && options.method === "POST") {
        return new Response(JSON.stringify({ number: 41, html_url: "https://github.com/adadd89-sys/AI-Studio/pull/41", state: "open" }), { status: 201 });
      }
      throw new Error("Unexpected mocked request: " + target);
    };
    const ai = {
      run: async model => {
        if (model === "@cf/qwen/qwen3.8-27b") {
          return { response: JSON.stringify({
            summary: "Подготовлен экран настроек",
            changes: [{ path: "src/App.jsx", content: "export default function Settings() { return <main>Settings</main>; }", reason: "Добавить экран настроек" }]
          }) };
        }
        if (model === "@cf/google/gemma-4-26b-a4b-it") {
          return { response: JSON.stringify({ approved: true, summary: "Изменения корректны.", issues: [] }) };
        }
        throw new Error("Unexpected model: " + model);
      }
    };
    try {
      const response = await worker.fetch(new Request("https://studio.test/api/execute", {
        method: "POST",
        headers: { "content-type": "application/json", cookie, origin: "https://studio.test" },
        body: JSON.stringify({ task: "Добавь экран настроек", teamSettings: { agents: { north: true } } })
      }), { ...env, AI: ai, GITHUB_TOKEN: "test-token", GEMINI_MODEL: "gemini-4-hydrogen", OPENROUTER_API_KEY: "test-openrouter" });
      assert.equal(response.status, 200);
      const result = await response.json();
      assert.equal(result.ok, true);
      assert.equal(result.model, "gemini-3.6-flash");
      assert.equal(result.primaryModel, "gemini-4-hydrogen");
      assert.equal(result.fallbackUsed, true);
      const expectedFallbackSequence = [
        "gemini-4-hydrogen", "gemini-4-hydrogen", "gemini-4-hydrogen",
        "gemini-3.8-flash", "gemini-3.8-flash", "gemini-3.8-flash",
        "gemini-3.6-flash"
      ];
      assert.deepEqual(requestedGeminiModels, [...expectedFallbackSequence, ...expectedFallbackSequence]);
      assert.ok(assignmentRepairPrompts.length > 0);
      for (const prompt of assignmentRepairPrompts) {
        assert.match(prompt, /Предыдущая ошибка проверки: Gemini назначил задачу агенту, который отключён или не является разработчиком/);
        const offeredPaths = prompt.split("Доступные для изменения файлы")[1].split(". Назначь")[0].split("\n").slice(1).join("\n");
        assert.equal(offeredPaths.includes("README.md"), false);
        assert.equal(offeredPaths.includes("src/App.jsx"), true);
      }
      assert.match(result.branch, /^ai-studio\/task-/);
      assert.deepEqual(result.filesChanged.map(file => file.path).sort(), ["src/App.jsx"]);
      assert.match(result.gemmaReview, /Gemma: Изменения корректны\./);
      assert.deepEqual(result.delegation.map(item => item.agent).sort(), ["qwen"]);
      assert.equal(result.pullRequest.number, 41);
      assert.equal(result.pullRequest.url, "https://github.com/adadd89-sys/AI-Studio/pull/41");
      assert.equal(writes.length, 1);
      assert.ok(writes.every(write => write.branch === result.branch));
      assert.ok(writes.some(write => write.content === btoa("export default function Settings() { return <main>Settings</main>; }")));
      assert.ok(writes.every(write => write.content !== btoa(".settings { display: grid; }")));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });


  it("does not report a model-invented PR when GitHub did not create one", async () => {
    const cookie = await getSessionCookie();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      const target = String(url);
      if (target.includes("generativelanguage.googleapis.com")) {
        return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "Готово. Создал PR #1: https://github.com/Al-Studio/pull/1" }] } }] }), {
          status: 200, headers: { "content-type": "application/json" }
        });
      }
      if (target.endsWith("/git/ref/heads/main")) {
        return new Response(JSON.stringify({ object: { sha: "a".repeat(40) } }), { status: 200 });
      }
      if (target.includes("/git/trees/") && target.includes("?recursive=1")) {
        return new Response(JSON.stringify({ tree: [] }), { status: 200 });
      }
      throw new Error("Unexpected mocked request: " + target);
    };
    try {
      const response = await worker.fetch(new Request("https://studio.test/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json", cookie, origin: "https://studio.test" },
        body: JSON.stringify({ message: "Исправь код в репозитории", history: [], teamSettings: {
          intensity: 50, agents: { gemini: true, qwen: false, gemma: false, north: false }
        } })
      }), { ...env, GITHUB_TOKEN: "test-token", GEMINI_API_KEY: "test-gemini-key" });
      const payload = await response.json();
      assert.equal(response.status, 200);
      assert.equal(payload.github, null);
      assert.doesNotMatch(payload.reply, /PR #1/);
      assert.doesNotMatch(payload.reply, /Al-Studio/);
      assert.match(payload.reply, /GitHub не подтвердил|сервер не сохранил изменения и не создал PR/i);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("lets Gemini read, edit a separate GitHub branch and open a PR from chat tools", async () => {
    const cookie = await getSessionCookie();
    const originalFetch = globalThis.fetch;
    const geminiCalls = [
      { functionCall: { name: "list_repository_files", args: { ref: "main" } } },
      { functionCall: { name: "read_repository_file", args: { path: "README.md", ref: "main" } } },
      { functionCall: { name: "create_work_branch", args: { name: "chat-tool-test" } } },
      { functionCall: { name: "write_repository_file", args: { path: "README.md", branch: "ai-studio/chat-tool-test", content: "# Updated\\n", message: "Update README" } } },
      { functionCall: { name: "create_pull_request", args: { branch: "ai-studio/chat-tool-test", title: "Update README", body: "Updated through Gemini chat." } } }
    ];
    const githubCalls = [];
    let finalReply = false;
    globalThis.fetch = async (url, options = {}) => {
      const target = String(url);
      if (target.includes("generativelanguage.googleapis.com")) {
        if (geminiCalls.length) {
          return new Response(JSON.stringify({ candidates: [{ content: { parts: [geminiCalls.shift()] } }] }), { status: 200, headers: { "content-type": "application/json" } });
        }
        finalReply = true;
        return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "Готово. Создан Pull Request #42." }] } }] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      githubCalls.push({ target, method: options.method || "GET" });
      if (target.endsWith("/git/ref/heads/main")) return new Response(JSON.stringify({ object: { sha: "a".repeat(40) } }), { status: 200 });
      if (target.includes("/git/trees/") && target.includes("?recursive=1")) return new Response(JSON.stringify({ tree: [{ path: "README.md", type: "blob" }] }), { status: 200 });
      if (target.includes("/contents/README.md?ref=main")) return new Response(JSON.stringify({ type: "file", content: btoa("# Original\\n"), sha: "b".repeat(40) }), { status: 200 });
      if (target.endsWith("/git/refs") && options.method === "POST") return new Response(JSON.stringify({ ref: "refs/heads/ai-studio/chat-tool-test" }), { status: 201 });
      if (target.includes("/contents/README.md?ref=ai-studio%2Fchat-tool-test")) return new Response(JSON.stringify({ type: "file", sha: "c".repeat(40) }), { status: 200 });
      if (target.endsWith("/contents/README.md") && options.method === "PUT") return new Response(JSON.stringify({ commit: { sha: "d".repeat(40) } }), { status: 200 });
      if (target.endsWith("/pulls") && options.method === "POST") {
        const pr = JSON.parse(options.body);
        assert.equal(pr.base, "main");
        assert.equal(pr.head, "ai-studio/chat-tool-test");
        return new Response(JSON.stringify({ number: 42, html_url: "https://github.com/adadd89-sys/AI-Studio/pull/42", state: "open" }), { status: 201 });
      }
      throw new Error("Unexpected mocked request: " + target);
    };
    try {
      const response = await worker.fetch(new Request("https://studio.test/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json", cookie, origin: "https://studio.test" },
        body: JSON.stringify({ message: "Изучи README, измени его, создай PR", history: [], teamSettings: {
          intensity: 80, agents: { gemini: true, qwen: false, gemma: false, north: false }
        } })
      }), { ...env, GITHUB_TOKEN: "test-token" });
      const payload = await response.json();
      assert.equal(response.status, 200);
      assert.match(payload.reply, /Pull Request #42/);
      assert.equal(payload.github.number, 42);
      assert.equal(payload.github.url, "https://github.com/adadd89-sys/AI-Studio/pull/42");
      assert.deepEqual(payload.filesChanged, ["README.md"]);
      assert.equal(githubCalls.some(call => call.method === "PUT"), true);
      assert.equal(githubCalls.some(call => call.target.endsWith("/pulls")), true);
      assert.equal(finalReply, true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("retries a temporary Gemini 503 in chat before returning an error", async () => {
    const cookie = await getSessionCookie();
    const originalFetch = globalThis.fetch;
    let attempts = 0;
    globalThis.fetch = async () => {
      attempts++;
      if (attempts === 1) return new Response(JSON.stringify({ error: { message: "Model overloaded" } }), { status: 503 });
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "Ответ после повтора." }] } }] }), { status: 200, headers: { "content-type": "application/json" } });
    };
    try {
      const response = await worker.fetch(new Request("https://studio.test/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json", cookie, origin: "https://studio.test" },
        body: JSON.stringify({ message: "Привет", teamSettings: { agents: { gemini: true, qwen: false, gemma: false, north: false } } })
      }), env);
      assert.equal(response.status, 200);
      assert.equal((await response.json()).reply, "Ответ после повтора.");
      assert.equal(attempts, 2);
    } finally { globalThis.fetch = originalFetch; }
  });

  it("hands off to enabled Qwen when all Gemini models return HTTP 524", async () => {
    const cookie = await getSessionCookie();
    const originalFetch = globalThis.fetch;
    const requestedModels = [];
    globalThis.fetch = async url => {
      const target = String(url);
      const model = target.match(/models\/([^:]+):generateContent/)?.[1];
      requestedModels.push(model);
      return new Response("upstream timeout", { status: 524 });
    };
    const testEnv = { ...env, AI: { run: async (model, options) => {
      assert.equal(model, "@cf/qwen/qwen3.8-27b");
      assert.match(options.messages.at(-1).content, /Привет/);
      return { response: "Ответил Qwen после недоступности Gemini." };
    } } };
    try {
      const response = await worker.fetch(new Request("https://studio.test/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json", cookie, origin: "https://studio.test" },
        body: JSON.stringify({ message: "Привет", teamSettings: { agents: { gemini: true, qwen: true, gemma: false, north: false } } })
      }), testEnv);
      const payload = await response.json();
      assert.equal(response.status, 200);
      assert.equal(payload.reply, "Ответил Qwen после недоступности Gemini.");
      assert.equal(payload.agentLabel, "Qwen (резерв)");
      assert.deepEqual(payload.agentsUsed, ["gemini", "qwen"]);
      assert.deepEqual(requestedModels, ["gemini-4-hydrogen", "gemini-3.8-flash", "gemini-3.6-flash", "gemini-3.5-flash-lite"]);
    } finally { globalThis.fetch = originalFetch; }
  });

  it("consults enabled Qwen and Gemma in parallel after the lead chat response", async () => {
    const cookie = await getSessionCookie();
    const originalFetch = globalThis.fetch;
    const consulted = [];
    globalThis.fetch = async url => new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: "Основной ответ Hydrogen." }] } }]
    }), { status: 200, headers: { "content-type": "application/json" } });
    const testEnv = {
      ...env,
      AI: { run: async model => {
        consulted.push(model);
        return { response: model.includes("qwen") ? "Qwen подтверждает ответ." : "Gemma замечаний не нашла." };
      } }
    };
    try {
      const response = await worker.fetch(new Request("https://studio.test/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json", cookie, origin: "https://studio.test" },
        body: JSON.stringify({ message: "Проанализируй архитектуру backend, найди риски производительности и безопасности, предложи план рефакторинга и набор интеграционных тестов.", teamSettings: {
          agents: { gemini: true, qwen: true, gemma: true, north: false }
        } })
      }), testEnv);
      const payload = await response.json();
      assert.equal(response.status, 200);
      assert.match(payload.reply, /Основной ответ Hydrogen/);
      assert.ok(payload.reply.includes("**Qwen:** Qwen подтверждает ответ."));
      assert.ok(payload.reply.includes("**Gemma:** Gemma замечаний не нашла."));
      assert.deepEqual(new Set(consulted), new Set(["@cf/qwen/qwen3.8-27b", "@cf/google/gemma-4-26b-a4b-it"]));
      assert.equal(consulted.length, 2);
      assert.deepEqual(new Set(payload.agentsUsed), new Set(["gemini", "qwen", "gemma"]));
      assert.equal(payload.usage.requests, 3);
      assert.equal(payload.consultationFailures, 0);
    } finally { globalThis.fetch = originalFetch; }
  });

  it("does not start consultations for a simple chat question", async () => {
    const cookie = await getSessionCookie();
    const originalFetch = globalThis.fetch;
    const consulted = [];
    globalThis.fetch = async () => new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: "Короткий ответ без привлечения команды." }] } }]
    }), { status: 200, headers: { "content-type": "application/json" } });
    const testEnv = {
      ...env,
      AI: { run: async model => {
        consulted.push(model);
        return { response: "Этого вызова быть не должно." };
      } }
    };
    try {
      const response = await worker.fetch(new Request("https://studio.test/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json", cookie, origin: "https://studio.test" },
        body: JSON.stringify({ message: "Сколько будет 2 + 2?", teamSettings: {
          agents: { gemini: true, qwen: true, gemma: true, north: true }
        } })
      }), testEnv);
      const payload = await response.json();
      assert.equal(response.status, 200);
      assert.equal(payload.reply, "Короткий ответ без привлечения команды.");
      assert.equal(payload.teamMode, "lead_only");
      assert.deepEqual(payload.agentsUsed, ["gemini"]);
      assert.equal(payload.usage.requests, 1);
      assert.equal(payload.consultationFailures, 0);
      assert.deepEqual(consulted, []);
    } finally { globalThis.fetch = originalFetch; }
  });

  it("switches to Gemini fallback after repeated 524 timeout responses in chat", async () => {
    const cookie = await getSessionCookie();
    const originalFetch = globalThis.fetch;
    const requestedModels = [];
    globalThis.fetch = async url => {
      const target = String(url);
      const model = target.match(/models\/([^:]+):generateContent/)?.[1];
      requestedModels.push(model);
      if (model === "gemini-4-hydrogen") {
        return new Response("upstream timeout", { status: 524 });
      }
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "Ответ резервной модели после тайм-аута." }] } }] }), {
        status: 200, headers: { "content-type": "application/json" }
      });
    };
    try {
      const response = await worker.fetch(new Request("https://studio.test/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json", cookie, origin: "https://studio.test" },
        body: JSON.stringify({ message: "Привет", teamSettings: { agents: { gemini: true, qwen: false, gemma: false, north: false } } })
      }), env);
      assert.equal(response.status, 200);
      assert.equal((await response.json()).reply, "Ответ резервной модели после тайм-аута.");
      assert.deepEqual(requestedModels, ["gemini-4-hydrogen", "gemini-3.8-flash"]);
    } finally { globalThis.fetch = originalFetch; }
  });

  it("switches to Gemini fallback after repeated 503 responses in chat", async () => {
    const cookie = await getSessionCookie();
    const originalFetch = globalThis.fetch;
    const requestedModels = [];
    globalThis.fetch = async url => {
      const target = String(url);
      requestedModels.push(target.match(/models\/([^:]+):generateContent/)?.[1]);
      if (requestedModels.length <= 3) return new Response(JSON.stringify({ error: { message: "Model overloaded" } }), { status: 503 });
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "Ответ резервной модели." }] } }] }), { status: 200, headers: { "content-type": "application/json" } });
    };
    try {
      const response = await worker.fetch(new Request("https://studio.test/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json", cookie, origin: "https://studio.test" },
        body: JSON.stringify({ message: "Привет", teamSettings: { agents: { gemini: true, qwen: false, gemma: false, north: false } } })
      }), env);
      assert.equal(response.status, 200);
      const result = await response.json();
      assert.equal(result.reply, "Ответ резервной модели.");
      assert.deepEqual(requestedModels, ["gemini-4-hydrogen", "gemini-4-hydrogen", "gemini-4-hydrogen", "gemini-3.8-flash"]);
    } finally { globalThis.fetch = originalFetch; }
  });

  it("falls through to Gemini 3.6 Flash when both Hydrogen and Gemini 3.8 are overloaded", async () => {
    const cookie = await getSessionCookie();
    const originalFetch = globalThis.fetch;
    const requestedModels = [];
    globalThis.fetch = async url => {
      const target = String(url);
      const model = target.match(/models\/([^:]+):generateContent/)?.[1];
      requestedModels.push(model);
      if (model !== "gemini-3.6-flash") {
        return new Response(JSON.stringify({ error: { message: "This model is currently experiencing high demand." } }), { status: 503 });
      }
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "Ответ от третьей модели." }] } }] }), {
        status: 200, headers: { "content-type": "application/json" }
      });
    };
    try {
      const response = await worker.fetch(new Request("https://studio.test/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json", cookie, origin: "https://studio.test" },
        body: JSON.stringify({ message: "Привет", teamSettings: { agents: { gemini: true, qwen: false, gemma: false, north: false } } })
      }), env);
      const payload = await response.json();
      assert.equal(response.status, 200);
      assert.equal(payload.reply, "Ответ от третьей модели.");
      assert.deepEqual(requestedModels, [
        "gemini-4-hydrogen", "gemini-4-hydrogen", "gemini-4-hydrogen",
        "gemini-3.8-flash", "gemini-3.8-flash", "gemini-3.8-flash",
        "gemini-3.6-flash"
      ]);
      assert.equal(payload.agentLabel, "Gemini 3.6 Flash");
      assert.equal(payload.model, "gemini-3.6-flash");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("recovers an empty Gemini candidate through a text-only fallback request", async () => {
    const cookie = await getSessionCookie();
    const originalFetch = globalThis.fetch;
    const requested = [];
    globalThis.fetch = async (url, options = {}) => {
      const target = String(url);
      requested.push({
        model: target.match(/models\/([^:]+):generateContent/)?.[1],
        body: JSON.parse(options.body)
      });
      if (requested.length === 1) {
        return new Response(JSON.stringify({ candidates: [{ content: { parts: [] }, finishReason: "MAX_TOKENS" }] }), {
          status: 200, headers: { "content-type": "application/json" }
        });
      }
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "Вот мой ответ." }] } }] }), {
        status: 200, headers: { "content-type": "application/json" }
      });
    };
    try {
      const response = await worker.fetch(new Request("https://studio.test/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json", cookie, origin: "https://studio.test" },
        body: JSON.stringify({ message: "Привет", teamSettings: { agents: { gemini: true, qwen: false, gemma: false, north: false } } })
      }), env);
      const payload = await response.json();
      assert.equal(response.status, 200);
      assert.equal(payload.reply, "Вот мой ответ.");
      assert.deepEqual(requested.map(item => item.model), ["gemini-4-hydrogen", "gemini-3.8-flash"]);
      assert.equal(requested[1].body.tools, undefined);
      assert.match(requested[1].body.contents.at(-1).parts.at(-1).text, /Не вызывай инструменты/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("routes selected Gemini 3.6 Flash agent to its fixed free-tier model", async () => {
    const cookie = await getSessionCookie();
    const originalFetch = globalThis.fetch;
    let requestedUrl = "";
    globalThis.fetch = async url => {
      requestedUrl = String(url);
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "Gemini 3.6 отвечает." }] } }] }), {
        status: 200, headers: { "content-type": "application/json" }
      });
    };
    try {
      const response = await worker.fetch(new Request("https://studio.test/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json", cookie, origin: "https://studio.test" },
        body: JSON.stringify({ message: "Проверь", history: [], teamSettings: {
          intensity: 50, agents: { gemini: false, gemini36: true, qwen: false, gemma: false, north: false }
        } })
      }), env);
      const payload = await response.json();
      assert.equal(response.status, 200);
      assert.equal(payload.agent, "gemini36");
      assert.equal(payload.agentLabel, "Gemini 3.6 Flash");
      assert.match(requestedUrl, /models\/gemini-3\.6-flash:generateContent/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("normalizes wrapped and alternate Gemini plan formats", () => {
    const wrapped = normalizeGeminiPlan({
      result: {
        title: "Улучшение карточек команды",
        tasks: [
          { agent: "qwen", description: "Обнови компонент карточек", allowedPaths: ["src/App.jsx"] },
          { agent: "north", task: "Обнови стили карточек", allowedPaths: ["src/theme.css"] }
        ]
      }
    });
    assert.equal(wrapped.summary, "Улучшение карточек команды");
    assert.equal(wrapped.steps.length, 2);
    assert.equal(wrapped.assignments.length, 2);
    assert.equal(wrapped.assignments[0].agent, "qwen");
    assert.equal(wrapped.assignments[0].task, "Обнови компонент карточек");
    assert.deepEqual(wrapped.assignments[0].allowedPaths, ["src/App.jsx"]);
    const stringSteps = normalizeGeminiPlan({
      summary: "План",
      steps: "Изучи файлы; внеси изменения; проверь сборку"
    });
    assert.deepEqual(stringSteps.steps, ["Изучи файлы; внеси изменения; проверь сборку"]);
    assert.equal(normalizeGeminiPlan({ message: "Не план" }), null);
    assert.equal(normalizeGeminiPlan(null), null);
    assert.equal(normalizeGeminiPlan(undefined), null);
  });

  it("marks only agents listed in successful workflow output as completed", () => {
    const agents = {
      gemini: "Передал задания",
      qwen: "Завершил",
      north: "Завершил",
      gemma: "Ожидает",
      gemini38: "Ожидает",
      gemini36: "Отключён"
    };
    assert.deepEqual(finalizeWorkflowAgentStatuses(agents, "complete", ["gemini", "qwen", "north"]), {
      gemini: "Завершил",
      qwen: "Завершил",
      north: "Завершил",
      gemma: "Пропущен",
      gemini38: "Пропущен",
      gemini36: "Отключён"
    });
  });

  it("marks only participating or active agents as failed after a workflow error", () => {
    const agents = {
      gemini: "Работает",
      qwen: "Ожидает",
      north: "Работает",
      gemma: "Ожидает",
      gemini38: "Отключён"
    };
    assert.deepEqual(finalizeWorkflowAgentStatuses(agents, "failed", ["gemini"]), {
      gemini: "Ошибка или прервано",
      qwen: "Пропущен",
      north: "Ошибка или прервано",
      gemma: "Пропущен",
      gemini38: "Отключён"
    });
  });

  it("preserves agents that completed their work before a later workflow failure", () => {
    const agents = {
      gemini: "Работает",
      qwen: "Завершил",
      north: "Результат принят",
      gemma: "Завершил проверку",
      gemini38: "Ожидает",
      gemini36: "Отключён"
    };
    assert.deepEqual(finalizeWorkflowAgentStatuses(agents, "failed", []), {
      gemini: "Ошибка или прервано",
      qwen: "Завершил",
      north: "Результат принят",
      gemma: "Завершил проверку",
      gemini38: "Пропущен",
      gemini36: "Отключён"
    });
  });

  it("detects task snapshot changes before writing to KV", () => {
    const queued = { jobId: "job-1", state: "queued", status: "В очереди" };
    const unchanged = { jobId: "job-1", state: "queued", status: "В очереди" };
    const running = { jobId: "job-1", state: "running", status: "Выполняется" };
    assert.equal(hasTaskSnapshotChanged(queued, unchanged), false);
    assert.equal(hasTaskSnapshotChanged(queued, running), true);
    assert.equal(hasTaskSnapshotChanged(running, { ...running, result: { branch: "task-1" } }), true);
  });

  it("keeps contextFiles in the enclosing scope for the workflow error handler", () => {


    const source = readFileSync(new URL("./core.js", import.meta.url), "utf8");
    assert.ok(source.includes("let contextFiles = [];"));
    assert.ok(source.includes("contextFiles = [];"));
    assert.ok(!source.includes("const contextFiles = [];"));
  });


  it("shows successful agent diagnostics after a completed workflow", () => {
    const source = readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
    const successStart = source.indexOf("if (!completed)");
    const successEnd = source.indexOf("const actualAgents = Array.isArray(data.agentsUsed)", successStart);
    assert.ok(successStart >= 0 && successEnd > successStart);
    const successHandler = source.slice(successStart, successEnd);
    assert.match(successHandler, /setAgentExecutionDetails\(data\.usage\.agentResults\)/);
  });
  it("records provider transport and real HTTP status for successful agent calls", () => {
    const core = readFileSync(new URL("./core.js", import.meta.url), "utf8");
    const app = readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
    assert.ok(core.includes('transport: "Cloudflare Workers AI binding", providerStatus: "success", upstreamStatus: null'));
    assert.ok(core.includes('transport: "OpenRouter HTTP API", providerStatus: "success", upstreamStatus: response.status'));
    assert.ok(app.includes("HTTP-код провайдера: {entry.upstreamStatus}"));
    assert.ok(app.includes("HTTP-код: не предоставляется Workers AI binding API"));
  });

  it("keeps North as an optional reviewer when Qwen is enabled and includes workflow source in backend context", () => {
    const core = readFileSync(new URL("./core.js", import.meta.url), "utf8");
    const app = readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
    assert.match(core, /worker\/workflow\.js/);
    assert.match(core, /const availableDevelopers = \[teamSettings\.agents\.qwen \? "qwen" : "north"\]/);
    assert.match(core, /Promise\.all\(reviewTasks\)/);
    assert.match(app, /Независимый ревьюер Qwen/);
    assert.match(app, /Qwen — основной разработчик/);
  });

  it("records the number of files received in successful and failed agent diagnostics", () => {
    const core = readFileSync(new URL("./core.js", import.meta.url), "utf8");
    assert.match(core, /filesReceivedCount: contextFiles\.length/);
    assert.match(core, /filesReceivedCount: Array\.isArray\(filesReceived\)/);
  });

});
