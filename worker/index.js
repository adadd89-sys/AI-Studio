import worker, { getSessionIdentity, hasAuthProvider, isValidSession } from "./core.js";
import { AIStudioWorkflow } from "./workflow.js";

export { AIStudioWorkflow };

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
const TASK_TTL_SECONDS = 60 * 60 * 24 * 90;

async function authenticated(request, env) {
  if (!hasAuthProvider(env)) return json({ error: "Авторизация AI Studio не настроена." }, 503);
  if (!await isValidSession(request, env.SESSION_SECRET)) return json({ error: "Требуется вход в AI Studio." }, 401);
  return null;
}

async function taskOwner(request, env) {
  const identity = await getSessionIdentity(request, env.SESSION_SECRET);
  return identity?.telegramUserId ?? null;
}

function taskKey(userId, jobId) {
  return "user:" + userId + ":task:" + jobId;
}

async function readTask(env, userId, jobId) {
  const raw = await env.TASKS.get(taskKey(userId, jobId));
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/api/projects" && request.method === "GET") {
      const denied = await authenticated(request, env);
      if (denied) return denied;
      if (!env.TASKS) return json({ error: "Серверное хранилище не настроено. Добавьте Cloudflare KV binding TASKS." }, 503);
      const userId = await taskOwner(request, env);
      if (!userId) return json({ error: "Проекты доступны через Telegram Mini App." }, 403);
      try {
        const listed = await env.TASKS.list({ prefix: "user:" + userId + ":project:", limit: 100 });
        const projects = await Promise.all((listed.keys || []).map(async key => {
          const raw = await env.TASKS.get(key.name);
          try { return raw ? JSON.parse(raw) : null; } catch { return null; }
        }));
        return json({ ok: true, projects: projects.filter(Boolean).sort((a, b) => b.updatedAt - a.updatedAt) });
      } catch {
        return json({ error: "Не удалось загрузить проекты." }, 502);
      }
    }

    if (url.pathname === "/api/projects" && request.method === "POST") {
      const denied = await authenticated(request, env);
      if (denied) return denied;
      if (!env.TASKS) return json({ error: "Серверное хранилище не настроено. Добавьте Cloudflare KV binding TASKS." }, 503);
      const userId = await taskOwner(request, env);
      if (!userId) return json({ error: "Создание проектов доступно через Telegram Mini App." }, 403);
      if (new URL(request.headers.get("origin") || "https://invalid.local").host !== new URL(request.url).host) return json({ error: "Недопустимый источник запроса." }, 403);
      const body = await request.json().catch(() => null);
      const name = typeof body?.name === "string" ? body.name.trim() : "";
      const description = typeof body?.description === "string" ? body.description.trim() : "";
      if (!name || name.length > 100) return json({ error: "Название проекта обязательно и не должно превышать 100 символов." }, 400);
      if (description.length > 1000) return json({ error: "Описание проекта не должно превышать 1000 символов." }, 400);
      const id = crypto.randomUUID();
      const now = Date.now();
      const project = { id, name, description, status: "active", createdAt: now, updatedAt: now, taskCount: 0 };
      try {
        await env.TASKS.put("user:" + userId + ":project:" + id, JSON.stringify(project), { expirationTtl: TASK_TTL_SECONDS });
        return json({ ok: true, project }, 201);
      } catch {
        return json({ error: "Не удалось сохранить проект." }, 502);
      }
    }

    if (url.pathname.startsWith("/api/projects/") && request.method === "PATCH") {
      const denied = await authenticated(request, env);
      if (denied) return denied;
      if (!env.TASKS) return json({ error: "Серверное хранилище не настроено." }, 503);
      const userId = await taskOwner(request, env);
      if (!userId) return json({ error: "Изменение проектов доступно через Telegram Mini App." }, 403);
      if (new URL(request.headers.get("origin") || "https://invalid.local").host !== new URL(request.url).host) return json({ error: "Недопустимый источник запроса." }, 403);
      const id = url.pathname.slice("/api/projects/".length);
      if (!/^[a-f0-9-]{36}$/i.test(id)) return json({ error: "Недопустимый ID проекта." }, 400);
      const key = "user:" + userId + ":project:" + id;
      const raw = await env.TASKS.get(key);
      if (!raw) return json({ error: "Проект не найден." }, 404);
      let project;
      try { project = JSON.parse(raw); } catch { return json({ error: "Запись проекта повреждена." }, 500); }
      const body = await request.json().catch(() => null);
      if (!body || typeof body !== "object") return json({ error: "Ожидается JSON с изменениями проекта." }, 400);
      if (body.name !== undefined) {
        if (typeof body.name !== "string" || !body.name.trim() || body.name.trim().length > 100) return json({ error: "Название должно содержать от 1 до 100 символов." }, 400);
        project.name = body.name.trim();
      }
      if (body.description !== undefined) {
        if (typeof body.description !== "string" || body.description.trim().length > 1000) return json({ error: "Описание не должно превышать 1000 символов." }, 400);
        project.description = body.description.trim();
      }
      if (body.status !== undefined) {
        if (!["active", "paused", "completed"].includes(body.status)) return json({ error: "Недопустимый статус проекта." }, 400);
        project.status = body.status;
      }
      project.updatedAt = Date.now();
      await env.TASKS.put(key, JSON.stringify(project), { expirationTtl: TASK_TTL_SECONDS });
      return json({ ok: true, project });
    }

    if (url.pathname === "/api/tasks" && request.method === "GET") {
      const denied = await authenticated(request, env);
      if (denied) return denied;
      if (!env.TASKS) return json({ error: "Серверная история не настроена. Добавьте Cloudflare KV binding TASKS." }, 503);
      const userId = await taskOwner(request, env);
      if (!userId) return json({ error: "Для общей истории войдите через Telegram Mini App." }, 403);
      try {
        const listed = await env.TASKS.list({ prefix: "user:" + userId + ":task:", limit: 100 });
        const records = await Promise.all((listed.keys || []).map(async key => {
          const raw = await env.TASKS.get(key.name);
          try { return raw ? JSON.parse(raw) : null; } catch { return null; }
        }));
        return json({ ok: true, tasks: records.filter(Boolean).sort((a, b) => b.createdAt - a.createdAt) });
      } catch {
        return json({ error: "Не удалось загрузить серверную историю задач." }, 502);
      }
    }

    if (url.pathname === "/api/execute" && request.method === "POST") {
      const denied = await authenticated(request, env);
      if (denied) return denied;
      if (!env.TASKS) return json({ error: "Серверная история не настроена. Добавьте Cloudflare KV binding TASKS." }, 503);
      const userId = await taskOwner(request, env);
      if (!userId) return json({ error: "Запуск задач доступен через Telegram Mini App для привязки истории к аккаунту." }, 403);
      let origin;
      try { origin = new URL(request.headers.get("origin") || ""); } catch { return json({ error: "Недопустимый источник запроса." }, 403); }
      if (origin.host !== url.host) return json({ error: "Недопустимый источник запроса." }, 403);
      if (!env.GITHUB_TOKEN) return json({ error: "GitHub не подключён. Проверьте GITHUB_TOKEN." }, 503);
      if (!env.AI_STUDIO_WORKFLOW) return json({ error: "Cloudflare Workflow не настроен. Проверьте deployment конфигурацию." }, 503);
      const body = await request.json().catch(() => null);
      const task = typeof body?.task === "string" ? body.task.trim() : "";
      const rawSettings = body?.teamSettings && typeof body.teamSettings === "object" ? body.teamSettings : {};
      const teamSettings = {
        intensity: rawSettings.mode === "max" ? 100 : Math.max(0, Math.min(100, Number.isFinite(Number(rawSettings.intensity)) ? Math.round(Number(rawSettings.intensity) / 5) * 5 : 60)),
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
      if ((teamSettings.agents.qwen || (teamSettings.agents.gemma && teamSettings.intensity >= 50)) && !env.AI) return json({ error: "Для включённых Qwen/Gemma требуется Cloudflare Workers AI." }, 503);
      if (teamSettings.agents.north && !env.OPENROUTER_API_KEY) return json({ error: "Cohere North Mini Code включён, но OPENROUTER_API_KEY ещё не добавлен в секреты Cloudflare." }, 503);
      if (!task) return json({ error: "Опишите задачу." }, 400);
      if (task.length > 6000) return json({ error: "Задача слишком длинная. Максимум — 6000 символов." }, 413);
      let project = null;
      const bodyProjectId = body?.projectId;
      if (bodyProjectId !== undefined && bodyProjectId !== null && bodyProjectId !== "") {
        if (typeof bodyProjectId !== "string" || !/^[a-f0-9-]{36}$/i.test(bodyProjectId)) return json({ error: "Недопустимый ID проекта." }, 400);
        const projectRaw = await env.TASKS.get("user:" + userId + ":project:" + bodyProjectId);
        if (!projectRaw) return json({ error: "Выбранный проект не найден." }, 404);
        try { project = JSON.parse(projectRaw); } catch { return json({ error: "Запись проекта повреждена." }, 500); }
      }
      try {
        const instance = await env.AI_STUDIO_WORKFLOW.create({ params: { task, teamSettings } });
        const jobId = await instance.id;
        const record = {
          jobId,
          title: task.slice(0, 180),
          createdAt: Date.now(),
          state: "queued",
          status: "В очереди",
          teamSettings,
          projectId: project?.id || null,
          projectName: project?.name || null
        };
        await env.TASKS.put(taskKey(userId, jobId), JSON.stringify(record), { expirationTtl: TASK_TTL_SECONDS });
        if (project) {
          project.taskCount = (Number(project.taskCount) || 0) + 1;
          project.updatedAt = Date.now();
          await env.TASKS.put("user:" + userId + ":project:" + project.id, JSON.stringify(project), { expirationTtl: TASK_TTL_SECONDS });
        }
        return json({ ok: true, jobId, status: "queued", task: record }, 202);
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
      let ownerId = null;
      let taskRecord = null;
      if (env.TASKS) {
        ownerId = await taskOwner(request, env);
        if (!ownerId) return json({ error: "История задач доступна только пользователям Telegram." }, 403);
        taskRecord = await readTask(env, ownerId, jobId);
        if (!taskRecord) return json({ error: "Задача не найдена." }, 404);
      }
      try {
        const instance = await env.AI_STUDIO_WORKFLOW.get(jobId);
        const status = await instance.status();
        if (taskRecord) {
          const state = status.status === "complete" ? "complete"
            : ["errored", "terminated"].includes(status.status) ? "failed"
              : status.status === "queued" ? "queued" : "running";
          const outputData = status.output?.data || null;
          const errorMessage = status.error?.message || outputData?.error || null;
          const updated = {
            ...taskRecord,
            state,
            status: state === "complete" ? (outputData?.branch ? "Код подготовлен" : "Задача завершена")
              : state === "failed" ? "Ошибка выполнения" : state === "queued" ? "В очереди" : "Выполняется",
            ...(state === "complete" && outputData ? { result: outputData } : {}),
            ...(state === "failed" && errorMessage ? { error: errorMessage } : {})
          };
          await env.TASKS.put(taskKey(ownerId, jobId), JSON.stringify(updated), { expirationTtl: TASK_TTL_SECONDS });
        }
        return json({ jobId, status: status.status, output: status.output || null, error: status.error || null });
      } catch (error) {
        return json({ error: "Не удалось получить статус задачи.", detail: error?.message || null }, 404);
      }
    }
    return worker.fetch(request, env, ctx);
  }
};
