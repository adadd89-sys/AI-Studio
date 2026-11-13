import { describe, it } from "node:test";
import assert from "node:assert/strict";
import worker, { assertWorkflowExecutionSucceeded, getSessionIdentity, hasAuthProvider } from "./core.js";

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

describe("AI Studio Worker", () => {
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
    assert.deepEqual(await response.json(), { authenticated: true, authConfigured: true, telegramAuthConfigured: true });
  });

  it("disables password login even when APP_PASSWORD is configured", async () => {
    const response = await worker.fetch(new Request("https://studio.test/api/login", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://studio.test" },
      body: JSON.stringify({ password: env.APP_PASSWORD })
    }), env);
    assert.equal(response.status, 403);
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
    assert.ok(requestedBudget >= 1024 && requestedBudget <= 4096);
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

  it("coordinates Gemini, Qwen and Gemma and writes approved files to a separate branch", async () => {
    const originalFetch = globalThis.fetch;
    const cookie = await getSessionCookie();
    const writes = [];
    globalThis.fetch = async (url, options = {}) => {
      const target = String(url);
      if (target.includes("generativelanguage.googleapis.com")) {
        return new Response(JSON.stringify({
          candidates: [{ content: { parts: [{ text: JSON.stringify({
            summary: "Добавить экран настроек",
            steps: ["Создать компонент настроек", "Проверить изменения"],
            acceptanceCriteria: ["Экран доступен из навигации"],
            risks: [],
            questions: []
          }) }] } }]
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (target.includes("/git/trees/") && target.includes("?recursive=1")) {
        return new Response(JSON.stringify({ tree: [{ path: "src/App.jsx", type: "blob" }] }), { status: 200 });
      }
      if (target.includes("/contents/src/App.jsx?ref=main")) {
        return new Response(JSON.stringify({ content: btoa("export default function App() { return null; }"), sha: "a".repeat(40) }), { status: 200 });
      }
      if (target.includes("/git/ref/heads/main")) {
        return new Response(JSON.stringify({ object: { sha: "b".repeat(40) } }), { status: 200 });
      }
      if (target.endsWith("/git/refs") && options.method === "POST") {
        return new Response(JSON.stringify({ ref: "refs/heads/ai-studio/task-test" }), { status: 201 });
      }
      if (target.endsWith("/contents/src/new-screen.jsx") && options.method === "PUT") {
        writes.push(JSON.parse(options.body));
        return new Response(JSON.stringify({ commit: { sha: "c".repeat(40) } }), { status: 201 });
      }
      throw new Error("Unexpected mocked request: " + target);
    };
    const ai = {
      run: async model => {
        if (model === "@cf/qwen/qwen3.8-27b") {
          return { response: JSON.stringify({
            summary: "Подготовлен экран настроек",
            changes: [{ path: "src/new-screen.jsx", content: "export default function Settings() { return <main>Settings</main>; }", reason: "Добавить экран настроек" }]
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
        body: JSON.stringify({ task: "Добавь экран настроек" })
      }), { ...env, AI: ai, GITHUB_TOKEN: "test-token", GEMINI_MODEL: "gemini-4-hydrogen" });
      assert.equal(response.status, 200);
      const result = await response.json();
      assert.equal(result.ok, true);
      assert.match(result.branch, /^ai-studio\/task-/);
      assert.deepEqual(result.filesChanged.map(file => file.path), ["src/new-screen.jsx"]);
      assert.equal(result.gemmaReview, "Gemma: Изменения корректны.");
      assert.equal(writes.length, 1);
      assert.equal(writes[0].branch, result.branch);
      assert.equal(writes[0].content, btoa("export default function Settings() { return <main>Settings</main>; }"));
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
});
