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
