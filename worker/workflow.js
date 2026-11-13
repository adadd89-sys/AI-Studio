import { WorkflowEntrypoint } from "cloudflare:workers";
import worker, { assertWorkflowExecutionSucceeded } from "./core.js";

async function sign(value, secret) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const bytes = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export class AIStudioWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    const task = event.payload?.task;
    const teamSettings = event.payload?.teamSettings || {};
    if (typeof task !== "string" || !task.trim()) throw new Error("Workflow получил пустую задачу.");
    const jobId = event.instanceId;
    return step.do("Выполнение команды AI Studio", {
      retries: { limit: 0, delay: "1 second" }
    }, async () => {
      const timestamp = Date.now();
      const signedPayload = JSON.stringify({ task, teamSettings });
      const signature = await sign(jobId + "." + timestamp + "." + signedPayload, this.env.SESSION_SECRET);
      const request = new Request("https://studio.internal/api/execute-internal", {
        method: "POST",
        headers: { "content-type": "application/json", "x-ai-studio-workflow-signature": signature },
        body: JSON.stringify({ task, teamSettings, jobId, timestamp })
      });
      const response = await worker.fetch(request, this.env);
      const data = await response.json().catch(() => ({ error: "Worker вернул некорректный JSON." }));
      return assertWorkflowExecutionSucceeded(response.status, data);
    });
  }
}
