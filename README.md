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

AI Studio uses Telegram identity and server-enforced roles. The configured `TELEGRAM_OWNER_ID` is the owner and always has full access. The owner can add or revoke other Telegram accounts from the **Пользователи** section using their numeric Telegram IDs. Approved users can use the AI workspace and chat, but cannot open the GitHub editor, call code-execution endpoints, or access Gemini's GitHub write tools. These restrictions are enforced by the Worker, not just by hiding interface controls. Password login is disabled. The allowlist is stored in the existing `TASKS` KV namespace under a dedicated key.

Configure these as encrypted Cloudflare Worker secrets:

- `TELEGRAM_BOT_TOKEN`: token of the Telegram bot that owns the Mini App.
- `TELEGRAM_OWNER_ID`: your numeric Telegram user ID (not your username).
- `SESSION_SECRET`: a random secret of at least 32 bytes.

If `TELEGRAM_OWNER_ID` is missing or invalid, authentication fails closed and no account can sign in. Telegram Mini App initData signatures and their 10-minute freshness are verified before the owner or allowlist membership is checked. Revoking a user removes them from the allowlist, so their next API request is rejected even if their browser still holds an unexpired session. Sessions are HttpOnly, Secure, SameSite=Strict, and expire after 7 days. Never commit secrets or send them in chat.

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
