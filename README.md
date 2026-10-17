# Todos

A private, offline-ready todo PWA for iPhone and desktop.

**Open the app:** https://randomcodespace.github.io/todos/

## Features

- Create, edit, complete, delete and undo deletion.
- Search and filter active or completed todos.
- IndexedDB persistence, including offline edits and reloads.
- JSON backup export and validated, atomic import. Newer local changes win.
- Installable app with an offline shell and explicit update prompt.
- iPhone safe-area support for the Dynamic Island, landscape and home indicator.
- Keyboard-aware viewport, 16px inputs, contained scrolling and edge fallback for
  older WebKit. Pinch zoom remains available for accessibility.
- Native scrolling, no animation loop, no external fonts or runtime dependencies.
  Refresh rate is controlled by the device and browser; 120 fps is not forced and
  a 30 fps floor cannot be guaranteed. Reduce Motion is respected.

## Install on iPhone

Open the app in Safari, tap Share, then **Add to Home Screen**. Wait for
**Ready for offline** during the first online visit. On desktop, use the browser's
install control when available.

Todos are stored per browser and device, not synced. Clearing site data deletes
them. Export a backup periodically; persistent storage is requested only when
you choose **Protect local storage** and the browser decides whether to grant it.

## Develop

Use the Node version in `.node-version`.

```sh
npm ci --ignore-scripts
npm run dev
```

Open http://127.0.0.1:4173/todos/. For a fresh development session, unregister the
service worker in browser developer tools after changing cached source files.
Production builds use a content-derived cache version.

```sh
npm run lint
npm test
npx playwright install chromium webkit
npm run test:e2e
npm run build
```

The build copies `public/` into `dist/` and versions the offline cache. No bundler
or runtime dependency is required. Playwright is the sole development dependency.

## Deployment and controls

GitHub Actions deploys `dist/` to Pages after syntax, unit, browser and dependency
checks pass on main. Pull requests run the same checks plus dependency review.
CodeQL scans JavaScript and Actions on PRs, main and a weekly schedule.

Repository settings mirror the applicable controls of
https://github.com/RandomCodeSpace/unified-agent-manager: signed commits,
PR-required main, strict checks, linear history, resolved conversations, admin
enforcement, blocked force pushes/deletions and protected release tags.
Dependabot, secret scanning and push protection complement those rules.

External SonarCloud/Socket checks depend on their installed GitHub apps and
credentials. They are required only when configured and producing results here.

Automated WebKit checks emulate an iPhone viewport. Physical iPhone home-screen
installation, keyboard animation, Dynamic Island geometry and actual display
frame rate must still be checked on a device.

Licensed under MIT.
