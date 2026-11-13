# AI Studio

AI Studio is a multi-agent workspace for planning, building, reviewing, and testing digital products.

## Current milestone

- React + Vite Russian-language workspace UI
- Cloudflare Worker API
- Gemini task-planning endpoint
- Automated Worker tests and frontend production build in GitHub Actions

## Local development

Requirements: Node.js 20 or newer.

```bash
npm install
```

Create a local `.dev.vars` file (never commit it):

```ini
GEMINI_API_KEY=your_gemini_api_key
GEMINI_MODEL=gemini-3.8-flash
```

Run the Worker and frontend in two terminals:

```bash
npm run dev:worker
npm run dev
```

Open the Vite URL shown in the terminal. The frontend proxies `/api/*` requests to the local Worker.

Run checks:

```bash
npm test
npm run build
```

## Access protection

The Worker protects `POST /api/plan` with a signed, HttpOnly session cookie. Before using the app, add these secrets in Cloudflare Workers & Pages → `ai-studio` → Settings → Variables and Secrets:

- `APP_PASSWORD`: choose a long, unique password for the private workspace.
- `SESSION_SECRET`: generate a random secret of at least 32 bytes (for example, with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`).

Add both as encrypted **Secrets**, not plain text variables. The session expires after 7 days. Never commit either value or send it in chat. The public health endpoint reveals only whether model/auth secrets are configured; it does not expose their values.

## Telegram login and shared task history

Shared task history is scoped to the verified Telegram user ID. Password-only sessions can still use the private workspace, but cannot read or start tasks that require cross-device history.

For Telegram Mini App login, add these encrypted Worker secrets:

- `TELEGRAM_BOT_TOKEN`: token from the Telegram bot that owns the Mini App.
- `SESSION_SECRET`: the same strong signing secret used for session cookies.

Create a free Cloudflare Workers KV namespace:

```bash
npx wrangler kv namespace create AI_STUDIO_TASKS
```

Copy the returned namespace ID into `wrangler.jsonc`:

```jsonc
"kv_namespaces": [
  {
    "binding": "TASKS",
    "id": "PASTE_THE_NAMESPACE_ID_HERE"
  }
]
```

Keep the real namespace ID in your private deployment configuration; do not commit credentials. After configuring the binding, deploy the Worker. The app stores up to 100 recent tasks per Telegram account and automatically expires KV records after 90 days. Task status and completed results are refreshed from Cloudflare Workflows when the app polls them.

## Gemini setup

Create a Gemini API key in Google AI Studio and keep it in a Worker secret for deployment:

```bash
npx wrangler secret put GEMINI_API_KEY
```

The default model is `gemini-3.8-flash`. Google currently lists free input and output tokens for this model on the Gemini API Free Tier, subject to rate limits and availability. Review Google's current pricing and data-use terms before sending private or sensitive project information. Review Google's current pricing and data-use terms before sending private or sensitive project information.

## Gemini model availability check

After deployment and login, open `/api/models/check` to check whether the API key can see `gemini-4-hydrogen` and whether the model advertises `generateContent`. This uses the read-only Models list endpoint; it does not generate text or establish whether the model is free for the project. The app keeps `gemini-3.8-flash` as its default unless the owner deliberately changes the model configuration.

## Deployment

After authenticating Wrangler with the Cloudflare account:

```bash
npm run deploy
```

The Worker serves the built Vite app and handles `/api/*`. The app has built-in password/session protection for the planning API. Keep `APP_PASSWORD`, `SESSION_SECRET`, and `GEMINI_API_KEY` as encrypted Worker secrets. The public static interface and health endpoint remain reachable; only planning and model usage require a valid session.

## Planned next

- Persistent projects and richer task metadata
- Multi-agent orchestration and review cycles
- GitHub repository operations, testing, and controlled publishing
- Additional model adapters

Dangerous operations such as deleting files or publishing projects must require owner confirmation.
