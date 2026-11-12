const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };
const SESSION_COOKIE = "ai_studio_session";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...JSON_HEADERS, ...headers }
  });
}

function toBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromBase64Url(value) {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - base64.length % 4) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}

async function sign(value, secret) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)));
}

async function createSession(secret) {
  const payload = toBase64Url(new TextEncoder().encode(JSON.stringify({
    exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS
  })));
  const signature = toBase64Url(await sign(payload, secret));
  return payload + "." + signature;
}

async function isValidSession(request, secret) {
  if (!secret) return false;
  const cookie = request.headers.get("cookie") || "";
  const token = cookie.split(";").map(part => part.trim())
    .find(part => part.startsWith(SESSION_COOKIE + "="))?.slice(SESSION_COOKIE.length + 1);
  if (!token) return false;
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra) return false;
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"]
    );
    const valid = await crypto.subtle.verify(
      "HMAC",
      key,
      fromBase64Url(signature),
      new TextEncoder().encode(payload)
    );
    if (!valid) return false;
    const data = JSON.parse(new TextDecoder().decode(fromBase64Url(payload)));
    return Number.isInteger(data.exp) && data.exp > Math.floor(Date.now() / 1000);
  } catch {
    return false;
  }
}

function hasSameOrigin(request) {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  try {
    return new URL(origin).host === new URL(request.url).host;
  } catch {
    return false;
  }
}


const GITHUB_REPO = "adadd89-sys/AI-Studio";
const GITHUB_API = "https://api.github.com";

function validRepoPath(path) {
  return typeof path === "string" && path.length > 0 && path.length <= 500 &&
    !path.startsWith("/") && !path.includes("\\") &&
    path.split("/").every(part => part && part !== "." && part !== "..");
}

function validAiBranch(branch) {
  return typeof branch === "string" && branch.startsWith("ai-studio/") &&
    branch.length <= 120 && /^[a-zA-Z0-9._/-]+$/.test(branch) &&
    !branch.includes("..") && !branch.endsWith("/") && !branch.includes("//");
}

async function githubRequest(env, path, options = {}) {
  const headers = {
    "accept": "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    ...(options.body ? { "content-type": "application/json" } : {}),
    "authorization": "Bearer " + env.GITHUB_TOKEN
  };
  const response = await fetch(GITHUB_API + path, { ...options, headers: { ...headers, ...(options.headers || {}) } });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.message || "GitHub API request failed");
    error.status = response.status;
    throw error;
  }
  return payload;
}

function githubError(error) {
  const status = error?.status === 404 ? 404 : error?.status === 409 ? 409 : 502;
  return json({ error: error?.message || "Не удалось выполнить запрос к GitHub." }, status);
}

async function requireGithubSession(request, env) {
  if (!env.APP_PASSWORD || !env.SESSION_SECRET) return json({ error: "Авторизация AI Studio не настроена." }, 503);
  if (!await isValidSession(request, env.SESSION_SECRET)) return json({ error: "Требуется вход в AI Studio." }, 401);
  if (!env.GITHUB_TOKEN) return json({ error: "GitHub ещё не подключён. Добавьте секрет GITHUB_TOKEN в Cloudflare Worker." }, 503);
  return null;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/health" && request.method === "GET") {
      return json({
        ok: true,
        service: "ai-studio-api",
        modelConfigured: Boolean(env.GEMINI_API_KEY),
        qwenConfigured: Boolean(env.AI),
        githubConfigured: Boolean(env.GITHUB_TOKEN),
        authConfigured: Boolean(env.APP_PASSWORD && env.SESSION_SECRET)
      });
    }

    if (url.pathname === "/api/session" && request.method === "GET") {
      return json({
        authenticated: await isValidSession(request, env.SESSION_SECRET),
        authConfigured: Boolean(env.APP_PASSWORD && env.SESSION_SECRET)
      });
    }

    if (url.pathname === "/api/login" && request.method === "POST") {
      if (!hasSameOrigin(request)) return json({ error: "Недопустимый источник запроса." }, 403);
      if (!env.APP_PASSWORD || !env.SESSION_SECRET) {
        return json({ error: "Авторизация ещё не настроена. Добавьте APP_PASSWORD и SESSION_SECRET в секреты Worker." }, 503);
      }
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: "Ожидается корректный JSON." }, 400);
      }
      if (typeof body?.password !== "string" || body.password !== env.APP_PASSWORD) {
        return json({ error: "Неверный пароль." }, 401);
      }
      const token = await createSession(env.SESSION_SECRET);
      return json({ ok: true }, 200, {
        "set-cookie": SESSION_COOKIE + "=" + token + "; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=" + SESSION_TTL_SECONDS
      });
    }

    if (url.pathname === "/api/logout" && request.method === "POST") {
      if (!hasSameOrigin(request)) return json({ error: "Недопустимый источник запроса." }, 403);
      return json({ ok: true }, 200, {
        "set-cookie": SESSION_COOKIE + "=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0"
      });
    }

    if (url.pathname === "/api/models/check" && request.method === "GET") {
      if (!env.APP_PASSWORD || !env.SESSION_SECRET) {
        return json({ error: "Авторизация ещё не настроена." }, 503);
      }
      if (!await isValidSession(request, env.SESSION_SECRET)) {
        return json({ error: "Требуется вход в AI Studio." }, 401);
      }
      if (!env.GEMINI_API_KEY) {
        return json({ error: "Gemini API-ключ не настроен." }, 503);
      }

      const targetModel = "gemini-4-hydrogen";
      let upstream;
      try {
        upstream = await fetch("https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000", {
          headers: { "x-goog-api-key": env.GEMINI_API_KEY }
        });
      } catch {
        return json({ error: "Не удалось получить список моделей Gemini." }, 502);
      }
      if (!upstream.ok) {
        return json({ error: "Gemini API отклонил запрос списка моделей.", upstreamStatus: upstream.status }, 502);
      }

      try {
        const payload = await upstream.json();
        const model = (payload.models || []).find(item =>
          item.name === "models/" + targetModel || item.name === targetModel
        );
        return json({
          ok: true,
          model: targetModel,
          found: Boolean(model),
          supportsGenerateContent: Boolean(model?.supportedGenerationMethods?.includes("generateContent")),
          displayName: model?.displayName || null,
          inputTokenLimit: model?.inputTokenLimit || null,
          outputTokenLimit: model?.outputTokenLimit || null,
          billingNote: "Проверка списка моделей не выполняет генерацию и не подтверждает бесплатный тариф."
        });
      } catch {
        return json({ error: "Gemini вернул некорректный список моделей." }, 502);
      }
    }


    if (url.pathname === "/api/agents/qwen-review" && request.method === "POST") {
      if (!env.APP_PASSWORD || !env.SESSION_SECRET) {
        return json({ error: "Авторизация ещё не настроена." }, 503);
      }
      if (!await isValidSession(request, env.SESSION_SECRET)) {
        return json({ error: "Требуется вход в AI Studio." }, 401);
      }
      if (!env.AI) {
        return json({ error: "Qwen не подключён. Проверьте AI binding в Cloudflare Worker." }, 503);
      }

      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: "Ожидается корректный JSON." }, 400);
      }

      const task = typeof body?.task === "string" ? body.task.trim() : "";
      const plan = typeof body?.plan === "string" ? body.plan.trim() : "";
      if (!task || !plan) return json({ error: "Нужны исходная задача и план для проверки." }, 400);
      if (task.length > 6000 || plan.length > 12000) {
        return json({ error: "Объём задачи или плана превышает допустимый лимит." }, 413);
      }

      const model = env.QWEN_MODEL || "@cf/qwen/qwen3.8-27b";
      try {
        const result = await env.AI.run(model, {
          messages: [
            {
              role: "system",
              content: "Ты — независимый ИИ-архитектор и ревьюер команды AI Studio. Критически проверь план: найди пропуски, технические риски, зависимости и слабые места. Не соглашайся автоматически. Предложи конкретные улучшения и оцени готовность плана к исполнению. Отвечай по-русски, структурированно и кратко. Не утверждай, что работа уже выполнена."
            },
            {
              role: "user",
              content: "Исходная задача пользователя:\\n" + task + "\\n\\nПлан Gemini:\\n" + plan
            }
          ],
          max_completion_tokens: 1200,
          temperature: 0.2
        });
        const review = typeof result?.response === "string"
          ? result.response.trim()
          : typeof result?.choices?.[0]?.message?.content === "string"
            ? result.choices[0].message.content.trim()
            : "";
        if (!review) throw new Error("Empty model response");
        return json({ ok: true, agent: "Qwen", model, review });
      } catch (error) {
        return json({
          error: "Qwen через Cloudflare Workers AI не смог выполнить проверку. Проверьте доступность модели и бесплатный лимит Workers AI.",
          detail: error?.message || null
        }, 502);
      }
    }

    if (url.pathname === "/api/agents/gemma-review" && request.method === "POST") {
      if (!env.APP_PASSWORD || !env.SESSION_SECRET) {
        return json({ error: "Авторизация ещё не настроена." }, 503);
      }
      if (!await isValidSession(request, env.SESSION_SECRET)) {
        return json({ error: "Требуется вход в AI Studio." }, 401);
      }
      if (!env.AI) {
        return json({ error: "Workers AI не подключён. Проверьте AI binding в Cloudflare." }, 503);
      }

      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: "Ожидается корректный JSON." }, 400);
      }

      const task = typeof body?.task === "string" ? body.task.trim() : "";
      const plan = typeof body?.plan === "string" ? body.plan.trim() : "";
      if (!task || !plan) return json({ error: "Нужны исходная задача и план для проверки." }, 400);
      if (task.length > 6000 || plan.length > 12000) {
        return json({ error: "Объём задачи или плана превышает допустимый лимит." }, 413);
      }

      const model = env.GEMMA_MODEL || "@cf/google/gemma-4-26b-a4b-it";
      try {
        const result = await env.AI.run(model, {
          messages: [
            {
              role: "system",
              content: "Ты — независимый технический аналитик и тестировщик AI Studio. Проверь план критически: найди пропуски, технические риски, скрытые зависимости и критерии готовности. Не соглашайся автоматически с исходным планом. Предложи конкретные исправления. Ответь по-русски, структурированно и кратко."
            },
            {
              role: "user",
              content: "Исходная задача пользователя:\\n" + task + "\\n\\nПлан, который нужно проверить:\\n" + plan
            }
          ],
          max_completion_tokens: 1200,
          temperature: 0.2
        });
        const review = typeof result?.response === "string"
          ? result.response.trim()
          : typeof result?.choices?.[0]?.message?.content === "string"
            ? result.choices[0].message.content.trim()
            : "";
        if (!review) throw new Error("Empty model response");
        return json({ ok: true, agent: "Gemma", model, review });
      } catch {
        return json({ error: "Gemma не смогла выполнить проверку. Возможно, временно исчерпан бесплатный лимит Workers AI или модель недоступна." }, 502);
      }
    }


    if (url.pathname.startsWith("/api/github/")) {
      const denied = await requireGithubSession(request, env);
      if (denied) return denied;

      try {
        if (url.pathname === "/api/github/tree" && request.method === "GET") {
          const ref = url.searchParams.get("ref") || "main";
          if (ref !== "main" && !validAiBranch(ref)) return json({ error: "Недопустимая ветка." }, 400);
          const repo = await githubRequest(env, "/repos/" + GITHUB_REPO);
          const branch = await githubRequest(env, "/repos/" + GITHUB_REPO + "/git/ref/heads/" + encodeURIComponent(ref).replace(/%2F/gi, "/"));
          const tree = await githubRequest(env, "/repos/" + GITHUB_REPO + "/git/trees/" + branch.object.sha + "?recursive=1");
          return json({ ok: true, repository: GITHUB_REPO, branch: ref, files: (tree.tree || []).filter(item => item.type === "blob").map(item => ({ path: item.path, size: item.size || 0 })).slice(0, 500), truncated: Boolean(tree.truncated), defaultBranch: repo.default_branch });
        }

        if (url.pathname === "/api/github/file" && request.method === "GET") {
          const path = url.searchParams.get("path") || "";
          const ref = url.searchParams.get("ref") || "main";
          if (!validRepoPath(path)) return json({ error: "Недопустимый путь к файлу." }, 400);
          if (ref !== "main" && !validAiBranch(ref)) return json({ error: "Недопустимая ветка." }, 400);
          const file = await githubRequest(env, "/repos/" + GITHUB_REPO + "/contents/" + path.split("/").map(encodeURIComponent).join("/") + "?ref=" + encodeURIComponent(ref));
          if (file.type !== "file" || typeof file.content !== "string") return json({ error: "Поддерживаются только текстовые файлы." }, 415);
          const content = atob(file.content.replace(/\s/g, ""));
          const bytes = Uint8Array.from(content, char => char.charCodeAt(0));
          return json({ ok: true, path, ref, sha: file.sha, content: new TextDecoder("utf-8", { fatal: false }).decode(bytes), size: file.size });
        }

        if (url.pathname === "/api/github/branches" && request.method === "GET") {
          const branches = await githubRequest(env, "/repos/" + GITHUB_REPO + "/branches?per_page=100");
          return json({ ok: true, branches: branches.map(item => item.name).filter(name => name === "main" || validAiBranch(name)) });
        }

        if (url.pathname === "/api/github/branch" && request.method === "POST") {
          if (!hasSameOrigin(request)) return json({ error: "Недопустимый источник запроса." }, 403);
          const body = await request.json().catch(() => null);
          const branch = body?.branch;
          if (!validAiBranch(branch)) return json({ error: "Имя ветки должно начинаться с ai-studio/ и содержать только латинские буквы, цифры, точки, дефисы и слеши." }, 400);
          const base = await githubRequest(env, "/repos/" + GITHUB_REPO + "/git/ref/heads/main");
          await githubRequest(env, "/repos/" + GITHUB_REPO + "/git/refs", {
            method: "POST",
            body: JSON.stringify({ ref: "refs/heads/" + branch, sha: base.object.sha })
          });
          return json({ ok: true, branch }, 201);
        }

        if (url.pathname === "/api/github/file" && request.method === "PUT") {
          if (!hasSameOrigin(request)) return json({ error: "Недопустимый источник запроса." }, 403);
          const body = await request.json().catch(() => null);
          const path = body?.path;
          const branch = body?.branch;
          const content = body?.content;
          const sha = body?.sha;
          if (!validRepoPath(path)) return json({ error: "Недопустимый путь к файлу." }, 400);
          if (!validAiBranch(branch)) return json({ error: "Запись разрешена только в отдельные ветки ai-studio/; main защищена." }, 403);
          if (typeof content !== "string" || content.length > 500000) return json({ error: "Файл пустой или превышает лимит 500 КБ." }, 413);
          if (sha !== null && sha !== undefined && (typeof sha !== "string" || !/^[a-f0-9]{40}$/i.test(sha))) return json({ error: "Некорректный SHA файла." }, 400);
          const bytes = new TextEncoder().encode(content);
          let binary = "";
          for (const byte of bytes) binary += String.fromCharCode(byte);
          const payload = { message: typeof body.message === "string" && body.message.trim() ? body.message.trim().slice(0, 120) : "Update " + path, content: btoa(binary), branch };
          if (sha) payload.sha = sha;
          const result = await githubRequest(env, "/repos/" + GITHUB_REPO + "/contents/" + path.split("/").map(encodeURIComponent).join("/"), {
            method: "PUT",
            body: JSON.stringify(payload)
          });
          return json({ ok: true, path, branch, commit: result.commit?.sha || null, sha: result.content?.sha || null });
        }

        if (url.pathname === "/api/github/file" && request.method === "DELETE") {
          if (!hasSameOrigin(request)) return json({ error: "Недопустимый источник запроса." }, 403);
          const body = await request.json().catch(() => null);
          const path = body?.path;
          const branch = body?.branch;
          const sha = body?.sha;
          if (!validRepoPath(path)) return json({ error: "Недопустимый путь к файлу." }, 400);
          if (!validAiBranch(branch)) return json({ error: "Удаление разрешено только в отдельные ветки ai-studio/; main защищена." }, 403);
          if (typeof sha !== "string" || !/^[a-f0-9]{40}$/i.test(sha)) return json({ error: "Для удаления требуется актуальный SHA файла." }, 400);
          const result = await githubRequest(env, "/repos/" + GITHUB_REPO + "/contents/" + path.split("/").map(encodeURIComponent).join("/"), {
            method: "DELETE",
            body: JSON.stringify({ message: "Delete " + path, sha, branch })
          });
          return json({ ok: true, path, branch, commit: result.commit?.sha || null });
        }

        return json({ error: "GitHub API-маршрут не найден." }, 404);
      } catch (error) {
        return githubError(error);
      }
    }


    if (url.pathname === "/api/execute" && request.method === "POST") {
      if (!env.APP_PASSWORD || !env.SESSION_SECRET) return json({ error: "Авторизация ещё не настроена." }, 503);
      if (!await isValidSession(request, env.SESSION_SECRET)) return json({ error: "Требуется вход в AI Studio." }, 401);
      if (!hasSameOrigin(request)) return json({ error: "Недопустимый источник запроса." }, 403);
      if (!env.GEMINI_API_KEY) return json({ error: "Gemini API не подключён." }, 503);
      if (!env.AI) return json({ error: "Workers AI не подключён. Нужны Qwen и Gemma." }, 503);
      if (!env.GITHUB_TOKEN) return json({ error: "GitHub не подключён. Проверьте GITHUB_TOKEN." }, 503);

      let body;
      try { body = await request.json(); } catch { return json({ error: "Ожидается корректный JSON." }, 400); }
      const task = typeof body?.task === "string" ? body.task.trim() : "";
      if (!task) return json({ error: "Опишите задачу." }, 400);
      if (task.length > 6000) return json({ error: "Задача слишком длинная. Максимум — 6000 символов." }, 413);

      const primaryModel = env.GEMINI_MODEL || "gemini-4-hydrogen";
      const fallbackModel = env.GEMINI_FALLBACK_MODEL || "gemini-3.8-flash";
      const qwenModel = env.QWEN_MODEL || "@cf/qwen/qwen3.8-27b";
      const gemmaModel = env.GEMMA_MODEL || "@cf/google/gemma-4-26b-a4b-it";

      function parseJsonObject(value) {
        if (typeof value !== "string") return null;
        let cleaned = value.trim();
        if (cleaned.startsWith(String.fromCharCode(96,96,96))) {
          cleaned = cleaned.replace(/^\x60{3}(?:json)?\s*/i, "").replace(/\s*\x60{3}$/, "");
        }
        try {
          const parsed = JSON.parse(cleaned);
          return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
        } catch {
          const start = cleaned.indexOf("{");
          const end = cleaned.lastIndexOf("}");
          if (start < 0 || end <= start) return null;
          try {
            const parsed = JSON.parse(cleaned.slice(start, end + 1));
            return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
          } catch { return null; }
        }
      }
      function modelText(result) {
        if (typeof result?.response === "string") return result.response.trim();
        if (typeof result?.choices?.[0]?.message?.content === "string") return result.choices[0].message.content.trim();
        return "";
      }
      async function callGemini(prompt) {
        const requestBody = JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: { responseMimeType: "application/json", temperature: 0.2 }
        });
        async function call(model) {
          return fetch("https://generativelanguage.googleapis.com/v1beta/models/" + encodeURIComponent(model) +
            ":generateContent?key=" + encodeURIComponent(env.GEMINI_API_KEY), {
              method: "POST", headers: { "content-type": "application/json" }, body: requestBody
            });
        }
        let model = primaryModel;
        let response = await call(primaryModel);
        let fallbackUsed = false;
        if (!response.ok && [429,500,502,503,504].includes(response.status) && fallbackModel !== primaryModel) {
          model = fallbackModel; fallbackUsed = true; response = await call(fallbackModel);
        }
        if (!response.ok) { const error = new Error("Gemini API вернул ошибку " + response.status); error.status = response.status; throw error; }
        const payload = await response.json();
        const raw = payload?.candidates?.[0]?.content?.parts?.map(part => part.text || "").join("").trim();
        const parsed = parseJsonObject(raw);
        if (!parsed) throw new Error("Gemini вернул ответ не в формате JSON.");
        return { data: parsed, model, fallbackUsed };
      }

      try {
        const planResult = await callGemini(
          "Ты — руководитель команды разработки AI Studio. Проанализируй задачу и составь конкретный исполнимый план для изменения текущего репозитория AI Studio. " +
          "Верни только JSON: {\"summary\":\"...\",\"steps\":[\"...\"],\"acceptanceCriteria\":[\"...\"],\"risks\":[\"...\"],\"questions\":[]}. " +
          "Если данных достаточно, questions должен быть пустым массивом. Не утверждай, что работа уже выполнена. Задача пользователя: " + task
        );
        const plan = planResult.data;
        if (typeof plan.summary !== "string" || !Array.isArray(plan.steps) || !plan.steps.length) {
          return json({ error: "Gemini составил план в неожиданном формате." }, 502);
        }

        const mainRef = await githubRequest(env, "/repos/" + GITHUB_REPO + "/git/ref/heads/main");
        const tree = await githubRequest(env, "/repos/" + GITHUB_REPO + "/git/trees/" + mainRef.object.sha + "?recursive=1");
        const repoFiles = (tree.tree || []).filter(item => item.type === "blob").map(item => item.path).slice(0, 250);
        const contextPaths = ["src/App.jsx", "src/styles.css", "worker/index.js", "worker/index.test.js"];
        const contextFiles = [];
        for (const path of contextPaths) {
          const item = (tree.tree || []).find(entry => entry.type === "blob" && entry.path === path);
          if (!item) continue;
          const file = await githubRequest(env, "/repos/" + GITHUB_REPO + "/contents/" + path.split("/").map(encodeURIComponent).join("/") + "?ref=main");
          if (typeof file.content !== "string") continue;
          const binary = atob(file.content.replace(/\s/g, ""));
          const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
          const content = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
          contextFiles.push({ path, content: content.slice(0, path === "worker/index.js" ? 9000 : 12000) });
        }

        const developerSystem =
          "Ты — Qwen, основной разработчик команды AI Studio. Подготовь реальные изменения файлов существующего репозитория. " +
          "Верни ТОЛЬКО JSON без Markdown: {\"summary\":\"...\",\"changes\":[{\"path\":\"src/...\",\"content\":\"ПОЛНОЕ СОДЕРЖИМОЕ ФАЙЛА\",\"reason\":\"...\"}]}. " +
          "Каждый content — полное содержимое файла, не diff. Не выдумывай секреты и API-ключи. " +
          "Не меняй workflows, package.json, package-lock, wrangler config, настройки доступа или секреты. " +
          "Изменяй только необходимые файлы внутри src/, public/, worker/ либо index.html. Максимум 6 файлов. " +
          "Сохраняй архитектуру. Если задача не требует кода, верни changes: [].";
        const contextText = "Контекст файлов (содержимое может быть обрезано):\n" +
          contextFiles.map(file => "===== " + file.path + " =====\n" + file.content).join("\n\n") +
          "\n\nДерево файлов:\n" + repoFiles.join("\n");
        const planText = JSON.stringify(plan);
        async function askQwen(feedback) {
          const result = await env.AI.run(qwenModel, {
            messages: [
              { role: "system", content: developerSystem },
              { role: "user", content: "Задача пользователя:\n" + task + "\n\nПлан Gemini:\n" + planText +
                "\n\n" + contextText + (feedback ? "\n\nЗамечания Gemma:\n" + feedback : "") +
                "\n\nПодготовь законченные изменения файлов. Ответ только JSON." }
            ],
            max_completion_tokens: 8192, temperature: 0.15
          });
          const parsed = parseJsonObject(modelText(result));
          if (!parsed || !Array.isArray(parsed.changes)) throw new Error("Qwen вернул ответ не в ожидаемом формате.");
          if (parsed.changes.length > 6) throw new Error("Qwen предложил изменить больше 6 файлов.");
          for (const change of parsed.changes) {
            if (!change || typeof change.path !== "string" || typeof change.content !== "string") throw new Error("Qwen вернул некорректное описание файла.");
            const allowed = change.path === "index.html" || change.path.startsWith("src/") ||
              change.path.startsWith("public/") || change.path.startsWith("worker/");
            if (!allowed || !validRepoPath(change.path) || change.path.split("/").some(part => part.startsWith(".")) ||
                change.path.includes("node_modules") || change.path.includes("dist/")) {
              throw new Error("Запрошен недопустимый путь файла: " + change.path);
            }
            if (change.content.length > 250000) throw new Error("Файл " + change.path + " превышает лимит 250 КБ.");
          }
          return parsed;
        }

        let implementation = await askQwen("");
        if (!implementation.changes.length) {
          return json({ ok: true, task, plan, summary: implementation.summary || plan.summary,
            model: planResult.model, primaryModel, fallbackUsed: planResult.fallbackUsed,
            qwenModel, gemmaModel, branch: null, filesChanged: [],
            qwenReview: "Qwen не предложил изменений файлов.",
            gemmaReview: "Проверка кода не запускалась, так как изменений нет." });
        }

        async function reviewChanges(changes) {
          const reviewInput = JSON.stringify({ task, plan,
            changes: changes.map(change => ({ path: change.path, reason: change.reason || "", content: change.content })) });
          const result = await env.AI.run(gemmaModel, {
            messages: [
              { role: "system", content: "Ты — Gemma, независимый ревьюер и тестировщик. Критически проверь изменения на соответствие задаче, ошибки, безопасность и поломку архитектуры. " +
                "Верни только JSON: {\"approved\":true,\"summary\":\"...\",\"issues\":[\"...\"]}. " +
                "approved=true только если изменения пригодны к сохранению. Не утверждай, что запускал тесты: ты анализируешь код." },
              { role: "user", content: reviewInput }
            ],
            max_completion_tokens: 2200, temperature: 0.1
          });
          const parsed = parseJsonObject(modelText(result));
          if (!parsed || typeof parsed.approved !== "boolean" || !Array.isArray(parsed.issues)) throw new Error("Gemma вернула ответ не в ожидаемом формате.");
          return parsed;
        }

        let review = await reviewChanges(implementation.changes);
        let repairAttempted = false;
        if (!review.approved) {
          repairAttempted = true;
          implementation = await askQwen(JSON.stringify(review));
          if (!implementation.changes.length) return json({ error: "Gemma отклонила изменения, а Qwen не предложил исправления.", review }, 422);
          review = await reviewChanges(implementation.changes);
        }
        if (!review.approved) return json({
          error: "Gemma не одобрила изменения после исправления. В GitHub ничего не записано.",
          plan, review, repairAttempted
        }, 422);

        const branch = "ai-studio/task-" + Date.now().toString(36);
        await githubRequest(env, "/repos/" + GITHUB_REPO + "/git/refs", {
          method: "POST", body: JSON.stringify({ ref: "refs/heads/" + branch, sha: mainRef.object.sha })
        });

        const changed = [];
        try {
          for (const change of implementation.changes) {
            const existing = (tree.tree || []).find(item => item.type === "blob" && item.path === change.path);
            const bytes = new TextEncoder().encode(change.content);
            let binary = "";
            for (const byte of bytes) binary += String.fromCharCode(byte);
            const payload = { message: "AI Studio: " + (change.reason || "update " + change.path).slice(0, 100),
              content: btoa(binary), branch };
            if (existing) {
              const current = await githubRequest(env, "/repos/" + GITHUB_REPO + "/contents/" +
                change.path.split("/").map(encodeURIComponent).join("/") + "?ref=" + encodeURIComponent(branch));
              payload.sha = current.sha;
            }
            const saved = await githubRequest(env, "/repos/" + GITHUB_REPO + "/contents/" +
              change.path.split("/").map(encodeURIComponent).join("/"), { method: "PUT", body: JSON.stringify(payload) });
            changed.push({ path: change.path, commit: saved.commit?.sha || null });
          }
        } catch (writeError) {
          return json({ error: "Не все файлы удалось сохранить. Частичные изменения оставлены в отдельной ветке; main не затронута.",
            branch, filesChanged: changed, detail: writeError.message }, 502);
        }

        return json({ ok: true, task, plan, summary: implementation.summary || plan.summary,
          model: planResult.model, primaryModel, fallbackUsed: planResult.fallbackUsed,
          qwenModel, gemmaModel, branch, filesChanged: changed,
          qwenReview: "Изменения подготовлены Qwen.",
          gemmaReview: review.summary || (review.issues.length ? review.issues.join("\n") : "Изменения одобрены."),
          reviewIssues: review.issues, repairAttempted });
      } catch (error) {
        return json({ error: error?.message || "Не удалось выполнить задачу командой ИИ.", upstreamStatus: error?.status || null }, 502);
      }
    }

    if (url.pathname === "/api/plan" && request.method === "POST") {
      if (!env.APP_PASSWORD || !env.SESSION_SECRET) {
        return json({ error: "Авторизация ещё не настроена. Добавьте APP_PASSWORD и SESSION_SECRET в секреты Worker." }, 503);
      }
      if (!await isValidSession(request, env.SESSION_SECRET)) {
        return json({ error: "Требуется вход в AI Studio." }, 401);
      }
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: "Ожидается корректный JSON." }, 400);
      }

      const task = typeof body?.task === "string" ? body.task.trim() : "";
      if (!task) return json({ error: "Опишите задачу." }, 400);
      if (task.length > 6000) return json({ error: "Задача слишком длинная. Максимум — 6000 символов." }, 413);
      if (!env.GEMINI_API_KEY) {
        return json({ error: "Gemini пока не подключён. Добавьте GEMINI_API_KEY в секреты Worker." }, 503);
      }

      const primaryModel = env.GEMINI_MODEL || "gemini-3.8-flash";
      const fallbackModel = env.GEMINI_FALLBACK_MODEL || "gemini-3.8-flash";
      const requestBody = JSON.stringify({
        contents: [{ role: "user", parts: [{ text:
          "Ты — технический координатор AI Studio. Разбей запрос пользователя на понятный план разработки. Верни только JSON с полями summary (строка), steps (массив из 3–7 коротких строк), risks (массив строк), questions (массив строк). Не утверждай, что работа уже выполнена. Запрос: " + task
        }] }],
        generationConfig: { responseMimeType: "application/json", temperature: 0.2 }
      });

      async function callModel(model) {
        return fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(env.GEMINI_API_KEY)}`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: requestBody
          }
        );
      }

      let model = primaryModel;
      let fallbackUsed = false;
      let upstream;
      try {
        upstream = await callModel(primaryModel);
        const retryableStatuses = [429, 500, 502, 503, 504];
        if (!upstream.ok && retryableStatuses.includes(upstream.status) && fallbackModel !== primaryModel) {
          model = fallbackModel;
          fallbackUsed = true;
          upstream = await callModel(fallbackModel);
        }
      } catch {
        return json({ error: "Не удалось связаться с Gemini. Сетевой сбой не повторяется автоматически, чтобы избежать дублирования запроса." }, 502);
      }

      if (!upstream.ok) {
        const status = upstream.status === 429 ? 429 : 502;
        return json({
          error: status === 429
            ? "Лимит исчерпан и резервная модель тоже недоступна. Попробуйте позже."
            : "Основная и/или резервная модель Gemini вернула ошибку. Проверьте настройки и доступность моделей.",
          model,
          fallbackUsed,
          upstreamStatus: upstream.status
        }, status);
      }

      let payload;
      try {
        payload = await upstream.json();
        const raw = payload?.candidates?.[0]?.content?.parts?.map(part => part.text || "").join("").trim();
        if (!raw) throw new Error("Empty response");
        const plan = JSON.parse(raw);
        if (typeof plan.summary !== "string" || !Array.isArray(plan.steps)) throw new Error("Invalid plan");
        return json({ plan, model, primaryModel, fallbackUsed });
      } catch {
        return json({ error: "Gemini вернул ответ в неожиданном формате. Попробуйте переформулировать задачу.", model, fallbackUsed }, 502);
      }
    }

    if (url.pathname.startsWith("/api/")) return json({ error: "API-маршрут не найден." }, 404);
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return json({ error: "Статические файлы ещё не настроены." }, 404);
  }
};
