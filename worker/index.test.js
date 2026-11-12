import { describe, it } from "node:test";
import assert from "node:assert/strict";
import worker from "./index.js";

const env = { APP_PASSWORD: "correct-horse", SESSION_SECRET: "test-session-secret", GEMINI_API_KEY: "test-key" };

async function getSessionCookie() {
  const response = await worker.fetch(new Request("https://studio.test/api/login", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://studio.test" },
    body: JSON.stringify({ password: env.APP_PASSWORD })
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
  it("returns health status without exposing secrets", async () => {
    const response = await worker.fetch(new Request("https://studio.test/api/health"), {});
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ok: true,
      service: "ai-studio-api",
      modelConfigured: false,
      qwenConfigured: false,
      authConfigured: false
    });
  });

  it("rejects planning requests without a session", async () => {
    const response = await worker.fetch(planRequest("", { task: "Создай сайт" }), env);
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

  it("creates a signed session for the correct password", async () => {
    const cookie = await getSessionCookie();
    const response = await worker.fetch(new Request("https://studio.test/api/session", {
      headers: { cookie }
    }), env);
    assert.deepEqual(await response.json(), { authenticated: true, authConfigured: true });
  });

  it("rejects an incorrect password", async () => {
    const response = await worker.fetch(new Request("https://studio.test/api/login", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://studio.test" },
      body: JSON.stringify({ password: "wrong" })
    }), env);
    assert.equal(response.status, 401);
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
      SESSION_SECRET: env.SESSION_SECRET
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
});
