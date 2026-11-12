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

The Worker serves the built Vite app and handles `/api/*`. Before exposing a public deployment, put the app behind an access-control layer (for example Cloudflare Access) and configure the API secret. Do not deploy a public unauthenticated endpoint with a personal API key.

## Planned next

- Persistent projects and task history with Cloudflare D1
- Multi-agent orchestration and review cycles
- GitHub repository operations, testing, and controlled publishing
- Additional model adapters

Dangerous operations such as deleting files or publishing projects must require owner confirmation.
