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

AI Studio supports an owner account and invited Telegram users. The owner is configured with `TELEGRAM_OWNER_ID`; invited user IDs are stored in the existing Cloudflare KV namespace bound as `TASKS` under the key `access:telegram-users`.

The owner can manage invited accounts in the **Пользователи** section of the app. Add a numeric Telegram user ID to grant access, or revoke it to block the account. The Worker checks the allowlist on every authenticated request. Because Cloudflare KV is eventually consistent, a newly granted or revoked account may take a short time to propagate globally; after propagation, the next request reflects the updated access.

Invited users receive the ordinary-user role:
- They can use the AI chat.
- They cannot access GitHub routes, code editing, task execution, or owner settings.
- Repository/code-editing requests are rejected server-side, even if sent directly to the chat API.
- Chat history is stored in browser local storage under a key scoped to the Telegram user ID.

Configure these as encrypted Cloudflare Worker secrets:

- `TELEGRAM_BOT_TOKEN`: token of the Telegram bot that owns the Mini App.
- `TELEGRAM_OWNER_ID`: your numeric Telegram user ID (not your username).
- `SESSION_SECRET`: a random secret of at least 32 bytes.

The Cloudflare KV namespace bound as `TASKS` must be available in the deployed Worker. If it is missing, invited-user management fails closed with a configuration error; the owner account remains available. Telegram Mini App initData signatures and their 10-minute freshness are verified before access is granted. Sessions are HttpOnly, Secure, SameSite=Strict, and expire after 7 days. Never commit secrets or send them in chat.

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

The Worker serves the built Vite app and handles `/api/*`. The owner retains GitHub and code-execution privileges; invited Telegram users are restricted to AI chat by server-side authorization.

Dangerous operations such as deleting files or publishing projects must require owner confirmation.

## Planned next

- Persistent projects and richer task metadata
- Multi-agent orchestration and review cycles
- GitHub repository operations, testing, and controlled publishing
- Additional model adapters

Dangerous operations such as deleting files or publishing projects must require owner confirmation.
