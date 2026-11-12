import { describe, it } from "node:test";
import assert from "node:assert/strict";
import worker from "./index.js";

describe("AI Studio Worker", () => {
  it("returns health status without exposing secrets", async () => {
    const response = await worker.fetch(new Request("https://studio.test/api/health"), {});
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ok: true,
      service: "ai-studio-api",
      modelConfigured: false
    });
  });

  it("rejects malformed JSON", async () => {
    const request = new Request("https://studio.test/api/plan", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{"
    });
    const response = await worker.fetch(request, {});
    assert.equal(response.status, 400);
  });

  it("rejects an empty task", async () => {
    const request = new Request("https://studio.test/api/plan", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ task: "   " })
    });
    const response = await worker.fetch(request, {});
    assert.equal(response.status, 400);
  });

  it("does not call Gemini when the API key is missing", async () => {
    const request = new Request("https://studio.test/api/plan", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ task: "Создай сайт" })
    });
    const response = await worker.fetch(request, {});
    assert.equal(response.status, 503);
    assert.match((await response.json()).error, /Gemini пока не подключён/);
  });
});
