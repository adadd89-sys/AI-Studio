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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/health" && request.method === "GET") {
      return json({
        ok: true,
        service: "ai-studio-api",
        modelConfigured: Boolean(env.GEMINI_API_KEY),
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

      const model = env.GEMINI_MODEL || "gemini-3.8-flash";
      let upstream;
      try {
        upstream = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(env.GEMINI_API_KEY)}`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              contents: [{ role: "user", parts: [{ text:
                "Ты — технический координатор AI Studio. Разбей запрос пользователя на понятный план разработки. Верни только JSON с полями summary (строка), steps (массив из 3–7 коротких строк), risks (массив строк), questions (массив строк). Не утверждай, что работа уже выполнена. Запрос: " + task
              }] }],
              generationConfig: { responseMimeType: "application/json", temperature: 0.2 }
            })
          }
        );
      } catch {
        return json({ error: "Не удалось связаться с Gemini. Попробуйте позже." }, 502);
      }

      if (!upstream.ok) {
        const status = upstream.status === 429 ? 429 : 502;
        return json({ error: status === 429 ? "Достигнут лимит бесплатных запросов Gemini. Попробуйте позже." : "Gemini вернул ошибку. Проверьте настройки модели и API-ключа." }, status);
      }

      let payload;
      try {
        payload = await upstream.json();
        const raw = payload?.candidates?.[0]?.content?.parts?.map(part => part.text || "").join("").trim();
        if (!raw) throw new Error("Empty response");
        const plan = JSON.parse(raw);
        if (typeof plan.summary !== "string" || !Array.isArray(plan.steps)) throw new Error("Invalid plan");
        return json({ plan, model });
      } catch {
        return json({ error: "Gemini вернул ответ в неожиданном формате. Попробуйте переформулировать задачу." }, 502);
      }
    }

    if (url.pathname.startsWith("/api/")) return json({ error: "API-маршрут не найден." }, 404);
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return json({ error: "Статические файлы ещё не настроены." }, 404);
  }
};
