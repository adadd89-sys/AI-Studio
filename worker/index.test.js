import { describe, it } from "node:test";
import assert from "node:assert/strict";
import worker from "./core.js";

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
      openrouterConfigured: false,
      githubConfigured: false,
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


  it("keeps lightweight chat separate from the development workflow", async () => {
    const cookie = await getSessionCookie();
    let requestedModel = "";
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

  it("rejects lightweight chat without an enabled agent", async () => {
    const cookie = await getSessionCookie();
    const response = await worker.fetch(new Request("https://studio.test/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json", cookie, origin: "https://studio.test" },
      body: JSON.stringify({ message: "Тест", teamSettings: { agents: { gemini: false, qwen: false, gemma: false, north: false } } })
    }), env);
    assert.equal(response.status, 400);
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
      assert.equal(result.gemmaReview, "Изменения корректны.");
      assert.equal(writes.length, 1);
      assert.equal(writes[0].branch, result.branch);
      assert.equal(writes[0].content, btoa("export default function Settings() { return <main>Settings</main>; }"));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

});
