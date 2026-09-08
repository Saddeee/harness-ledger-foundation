# Harness Ledger Foundation

Create an empty app called Harness Ledger: one placeholder page with the heading 'Harness Ledger' and nothing else. Do not add features, auth, styling work, or a database yet; a detailed brief follows in the next message.

This project was built with [Lovable](https://lovable.dev).

## Build with Lovable

Continue developing this project in the [Lovable editor](https://lovable.dev/projects/28bd5471-78e0-43af-a29b-5018198cb13c).

- **Ship faster**: describe what you want to build and Lovable handles the code.
- **Stay in sync**: every change made in Lovable is committed straight to this repository.
- **Full ownership**: this code is yours. Push to `main` on GitHub and your changes sync back into Lovable, ready for your next prompt.

## Development

Prefer working locally? You need Node.js and npm — [install with nvm](https://github.com/nvm-sh/nvm#installing-and-updating).

**Node version: this app requires Node `>=20.19.0`** (this repo's Vite/rolldown
toolchain declares that floor in its own `engines` field; see `.nvmrc` for the
exact version this was last verified against). Below that, `npm run dev` /
`npm run build` fail immediately with a `node:util` `styleText` `SyntaxError`
from `rolldown`, before any project code runs — that error means "wrong Node
version," not a bug in this app. If you use nvm: `nvm install && nvm use`
picks up `.nvmrc` automatically.

```sh
git clone <this-repository-url>
cd <repository-name>
nvm use          # or: nvm install && nvm use, if you don't have this version yet
npm i
npm run dev
```

## Local Harness runtime

The Corrections (`/inbox`) and Rules (`/ledger`) pages can read/write a local
SQLite store instead of (or alongside) the hosted Supabase data, when run
locally with `HARNESS_RUNTIME=local`. See `harness/README.md` for the full
setup (`npm run harness:build` once, then `HARNESS_RUNTIME=local HARNESS_DB_PATH=harness/data/harness.db npm run dev`).
Without that env var, those pages show a normal hosted-preview empty state
instead of crashing — nothing here is required for the hosted app to run.

## Connecting Lovable (OAuth)

The app hosts its OAuth client metadata at `/lovable-client.json`; that URL is
the `client_id` and the redirect URI is `/oauth/callback` on the same origin.
Both are derived from `APP_ORIGIN`. After publishing, add a secret named
`APP_ORIGIN` in Project Settings → Secrets set to the published origin
(e.g. `https://harness-ledger.lovable.app`, no trailing slash). Until it is set,
the origin of the incoming request is used, which works in the preview.
