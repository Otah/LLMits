# Repository Guidelines

## Project Shape

- `server.js` is the Express server and API proxy.
- `public/index.html` is the no-build browser UI.
- `public/sw.js` is the service worker.
- Keep this repository simple: prefer plain Node, plain HTML/CSS/JS, and existing dependencies over adding build tooling.

## Local Development

- Requires Node 18+.
- Install dependencies with `npm install`.
- Run locally with `npm run dev`; it listens on port `3600` unless `PORT` is set.

## Validation

- There is no automated test suite currently.
- For server changes, run `npm run dev` and exercise the affected endpoint or UI path.
- For frontend/service-worker changes, check the browser console and reload/update behavior manually when relevant.

## Documentation And Deployment

- Do not add shared deployment instructions, deployment URLs, or environment-specific process names to committed documentation.
- Contributors may run their own deployment, so keep docs focused on local development and project behavior.
- If deployment-specific notes are needed, keep them outside the shared repository or in untracked local notes.
