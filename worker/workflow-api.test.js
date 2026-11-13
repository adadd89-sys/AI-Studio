import { describe, it } from "node:test";
import assert from "node:assert/strict";
import api from "./index.js";
import core from "./core.js";

const baseEnv = { APP_PASSWORD: "test-password", SESSION_SECRET: "test-session-secret" };

async function passwordCookie() {
  const response = await core.fetch(new Request("https://studio.test/api/login", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://studio.test" },
    body: JSON.stringify({ password: baseEnv.APP_PASSWORD })
  }), baseEnv);
  assert.equal(response.status, 200);
  return response.headers.get("set-cookie").split(";")[0];
}

describe("AI Studio persistent task API", () => {
  it("requires a Telegram identity before exposing shared task history", async () => {
    const cookie = await passwordCookie();
    const response = await api.fetch(new Request("https://studio.test/api/tasks", {
      headers: { cookie }
    }), { ...baseEnv, TASKS: { list: async () => ({ keys: [] }), get: async () => null } });
    assert.equal(response.status, 403);
    assert.match((await response.json()).error, /Telegram Mini App/);
  });

  it("does not start workflow tasks when the persistent KV binding is missing", async () => {
    const cookie = await passwordCookie();
    const response = await api.fetch(new Request("https://studio.test/api/execute", {
      method: "POST",
      headers: { cookie, origin: "https://studio.test", "content-type": "application/json" },
      body: JSON.stringify({
        task: "Проверить сохранение истории",
        teamSettings: { mode: "normal", agents: { gemini: false, qwen: true, gemma: false, north: false } }
      })
    }), {
      ...baseEnv,
      GITHUB_TOKEN: "test-github-token",
      AI: {},
      AI_STUDIO_WORKFLOW: { create: async () => { throw new Error("Workflow must not start"); } }
    });
    assert.equal(response.status, 503);
    assert.match((await response.json()).error, /KV binding TASKS/);
  });
});
