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
GEMINI_MODEL=gemini-2.5-flash
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

## Gemini setup

Create a Gemini API key in Google AI Studio and keep it in a Worker secret for deployment:

```bash
npx wrangler secret put GEMINI_API_KEY
```

The default model is `gemini-2.5-flash`. Free-tier access and request limits depend on Google's current account and model quotas. Review Google's current pricing and data-use terms before sending private or sensitive project information.

## Deployment

After authenticating Wrangler with the Cloudflare account:

```bash
npm run deploy
```

The Worker serves the built Vite app and handles `/api/*`. The app has built-in password/session protection for the planning API. Keep `APP_PASSWORD`, `SESSION_SECRET`, and `GEMINI_API_KEY` as encrypted Worker secrets. The public static interface and health endpoint remain reachable; only planning and model usage require a valid session.

## Planned next

- Persistent projects and task history with Cloudflare D1
- Multi-agent orchestration and review cycles
- GitHub repository operations, testing, and controlled publishing
- Additional model adapters

Dangerous operations such as deleting files or publishing projects must require owner confirmation.
