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

**Node version: this app requires Node `>=22.12.0`** (see `.nvmrc` for the
exact version this was last verified against). Two independent things break
below that floor, both before any project code runs:
- Below Node 20.19: `npm run dev` / `npm run build` fail immediately with a
  `node:util` `styleText` `SyntaxError` from `rolldown` (this repo's bundler).
- On Node 20.x specifically (which satisfies the above but not this): any
  server code that touches Supabase (e.g. `requireCronOrUser`'s JWT check)
  crashes with `Error: Node.js detected but native WebSocket not found` from
  `@supabase/realtime-js`, because Node's native `WebSocket` global doesn't
  exist until Node 22. This one won't show up until you actually sign in and
  hit an authenticated route — a plain `npm run dev` + homepage load looks
  fine on Node 20, which is why it's easy to miss.

Both errors mean "wrong Node version," not a bug in this app. If you use
nvm: `nvm install && nvm use` picks up `.nvmrc` automatically. **After
switching Node major versions, also reinstall in `harness/`** — its
`better-sqlite3` native binding is tied to the exact Node ABI it was built
under and segfaults instead of raising a normal error if you skip this
(see `harness/README.md`).

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
