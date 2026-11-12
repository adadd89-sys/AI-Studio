import worker from "./core.js";
import { AIStudioWorkflow } from "./workflow.js";

export { AIStudioWorkflow };

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });

async function authenticated(request, env) {
  if (!env.APP_PASSWORD || !env.SESSION_SECRET) return json({ error: "Авторизация AI Studio не настроена." }, 503);
  const cookie = request.headers.get("cookie") || "";
  const token = cookie.split(";").map(part => part.trim())
    .find(part => part.startsWith("ai_studio_session="))?.slice("ai_studio_session=".length);
  if (!token) return json({ error: "Требуется вход в AI Studio." }, 401);
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra) return json({ error: "Требуется вход в AI Studio." }, 401);
  try {
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.SESSION_SECRET),
      { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
    const base64 = signature.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64 + "=".repeat((4 - base64.length % 4) % 4);
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
    if (!await crypto.subtle.verify("HMAC", key, bytes, new TextEncoder().encode(payload))) {
      return json({ error: "Требуется вход в AI Studio." }, 401);
    }
    const decoded = payload.replace(/-/g, "+").replace(/_/g, "/");
    const paddedPayload = decoded + "=".repeat((4 - decoded.length % 4) % 4);
    const raw = atob(paddedPayload);
    const session = JSON.parse(new TextDecoder().decode(Uint8Array.from(raw, char => char.charCodeAt(0))));
    if (!Number.isInteger(session.exp) || session.exp <= Math.floor(Date.now() / 1000)) {
      return json({ error: "Сессия истекла. Войдите снова." }, 401);
    }
  } catch { return json({ error: "Требуется вход в AI Studio." }, 401); }
  return null;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/api/execute" && request.method === "POST") {
      const denied = await authenticated(request, env);
      if (denied) return denied;
      let origin;
      try { origin = new URL(request.headers.get("origin") || ""); } catch { return json({ error: "Недопустимый источник запроса." }, 403); }
      if (origin.host !== url.host) return json({ error: "Недопустимый источник запроса." }, 403);
      if (!env.GITHUB_TOKEN) return json({ error: "GitHub не подключён. Проверьте GITHUB_TOKEN." }, 503);
      if (!env.AI_STUDIO_WORKFLOW) return json({ error: "Cloudflare Workflow не настроен. Проверьте deployment конфигурацию." }, 503);
      const body = await request.json().catch(() => null);
      const task = typeof body?.task === "string" ? body.task.trim() : "";
      const rawSettings = body?.teamSettings && typeof body.teamSettings === "object" ? body.teamSettings : {};
      const teamSettings = {
        intensity: Math.max(0, Math.min(100, Number.isFinite(Number(rawSettings.intensity)) ? Math.round(Number(rawSettings.intensity) / 5) * 5 : 60)),
        mode: ["chat", "normal", "max"].includes(rawSettings.mode) ? rawSettings.mode : "normal",
        agents: {
          gemini: rawSettings.agents?.gemini !== false,
          qwen: rawSettings.agents?.qwen !== false,
          gemma: rawSettings.agents?.gemma !== false,
          north: rawSettings.agents?.north === true
        }
      };
      if (teamSettings.mode === "chat") return json({ error: "Для режима общения используйте отдельный маршрут /api/chat." }, 400);
      if (!teamSettings.agents.qwen && !teamSettings.agents.north) return json({ error: "Включите Qwen или Cohere North Mini Code — нужен хотя бы один разработчик." }, 400);
      if (teamSettings.agents.gemini && !env.GEMINI_API_KEY) return json({ error: "Gemini включён, но GEMINI_API_KEY не настроен." }, 503);
      if ((teamSettings.agents.qwen || teamSettings.agents.gemma) && !env.AI) return json({ error: "Для включённых Qwen/Gemma требуется Cloudflare Workers AI." }, 503);
      if (teamSettings.agents.north && !env.OPENROUTER_API_KEY) return json({ error: "Cohere North Mini Code включён, но OPENROUTER_API_KEY ещё не добавлен в секреты Cloudflare." }, 503);
      if (!task) return json({ error: "Опишите задачу." }, 400);
      if (task.length > 6000) return json({ error: "Задача слишком длинная. Максимум — 6000 символов." }, 413);
      try {
        const instance = await env.AI_STUDIO_WORKFLOW.create({ params: { task, teamSettings } });
        return json({ ok: true, jobId: await instance.id, status: "queued" }, 202);
      } catch (error) {
        return json({ error: "Не удалось создать асинхронную задачу.", detail: error?.message || null }, 502);
      }
    }
    if (url.pathname.startsWith("/api/execute/") && request.method === "GET") {
      const denied = await authenticated(request, env);
      if (denied) return denied;
      if (!env.AI_STUDIO_WORKFLOW) return json({ error: "Cloudflare Workflow не настроен." }, 503);
      const jobId = url.pathname.slice("/api/execute/".length);
      if (!/^[a-zA-Z0-9_-]{1,128}$/.test(jobId)) return json({ error: "Недопустимый идентификатор задачи." }, 400);
      try {
        const instance = await env.AI_STUDIO_WORKFLOW.get(jobId);
        const status = await instance.status();
        return json({ jobId, status: status.status, output: status.output || null, error: status.error || null });
      } catch (error) {
        return json({ error: "Не удалось получить статус задачи.", detail: error?.message || null }, 404);
      }
    }
    return worker.fetch(request, env, ctx);
  }
};
