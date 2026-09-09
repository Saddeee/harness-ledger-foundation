// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - TanStack devtools (dev-only, first), tanstackStart, viteReact, tailwindcss, tsConfigPaths,
//     nitro (build-only using cloudflare as a default target), VITE_* env injection, @ path alias,
//     React/TanStack dedupe, error logger plugins, and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... }, etc... }) if needed.
import { defineConfig } from "@lovable.dev/vite-tanstack-config";

// The shared config's sandbox detection defaults the dev server to binding
// all interfaces (0.0.0.0), which is convenient for Lovable's cloud editor
// but means anything else on the same network can reach a locally running
// copy -- including, as of checkpoint C, an authenticated Harness API
// surface holding real project history. Default to localhost-only instead;
// set DEV_HOST_OPEN=1 to opt back into the wide bind (e.g. to test from
// another device on the LAN) -- explicit opt-in, not the default.
const devHost = process.env["DEV_HOST_OPEN"] === "1" ? true : "127.0.0.1";

export default defineConfig({
  tanstackStart: {
    // Redirect TanStack Start's bundled server entry to src/server.ts (our SSR error wrapper).
    // nitro/vite builds from this
    server: { entry: "server" },
  },
  vite: {
    server: { host: devHost },
  },
});
