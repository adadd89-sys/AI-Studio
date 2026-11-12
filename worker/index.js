const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/health" && request.method === "GET") {
      return json({ ok: true, service: "ai-studio-api", modelConfigured: Boolean(env.GEMINI_API_KEY) });
    }

    if (url.pathname === "/api/plan" && request.method === "POST") {
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

      const model = env.GEMINI_MODEL || "gemini-2.5-flash";
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
