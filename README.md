# Tuck

A private, offline-ready todo PWA for iPhone and desktop.

**Open the app:** https://randomcodespace.github.io/tuck/

## Features

- Smart lists: Today, Upcoming, Starred, All and Completed, plus your own
  coloured lists. Overdue tasks stay on Today, tasks finished today fold into a
  completed group, and Upcoming groups tasks by day.
- Quick add in one line: type `tomorrow 9am`, `friday`, `oct 20`, `in 3 days`,
  `#list` or `!` (star) and the words turn into chips you can tap to change.
  Add subtask lines in the same draft. Return adds and keeps the keyboard open.
- Subtasks: one level, shown with a progress bar, expandable inline, reordered
  by drag. Completing a task completes its subtasks.
- Dependencies: a task can wait on other tasks. It shows a lock and what it is
  waiting on, cannot be completed early, and unlocks when they are done. Cycles
  are refused.
- Due dates with optional times and repeats (daily, weekdays, weekly, monthly,
  yearly). Completing a repeating task moves it to its next date.
- Thumb-first phone layout: Today, Upcoming, Lists, Search and + sit in a bottom
  dock; sheets keep their main actions at the bottom edge. Gestures, each with a
  tap or keyboard equivalent: swipe a task right to complete it, left for Later
  and Delete (a long swipe deletes, with undo); hold a task for quick actions or
  hold and drag it onto a day in the week strip; pull the list down to add;
  slide along the dock to switch views and swipe it up for lists; swipe a sheet
  down to close it. Desktop uses a sidebar and a white working panel, with
  shortcuts `N` (new), `/` (search) and `1`-`5` (views).
- Task sheet for text, list, star, date, time, repeat, subtasks, dependencies
  and a note. Closing it saves.
- Search across tasks, notes and subtasks.
- iPhone integration where the web platform allows it: haptic feedback on
  iOS 18 (via the native switch control), an optional app icon badge for tasks
  due today (home-screen app, notification permission required), share sheet
  for tasks and backups, native date and time pickers and safe areas.
- IndexedDB persistence, offline use, JSON backup export and validated, atomic
  import. Newer local changes win. Older backups and records still load.
- Installable app with an offline shell. New versions install in the
  background and reload automatically once no draft or open sheet would be
  lost; otherwise an Update available pill waits. The app checks for updates
  at launch, on return to the foreground and hourly. Reduce Motion is
  respected. Pinch zoom remains available.

Web apps cannot schedule reminders, use Live Activities or widgets without a
push server or native code, so Tuck does not promise them. A task's time is
shown and sorted, but it does not alert you.

## Install on iPhone

Open the app in Safari, tap Share, then **Add to Home Screen**. Wait for
**Ready for offline** during the first online visit. On desktop, use the browser's
install control when available.

Your todos are stored per browser and device, not synced. Clearing site data deletes
them. Export a backup periodically; persistent storage is requested only when
you choose **Protect local storage** and the browser decides whether to grant it.

If you installed the app before the Tuck rename, export a backup from that
installation first, then add the new address to your home screen. Existing records
in the same browser profile and old JSON backups remain compatible. Home-screen
installations may have separate storage; import your backup there if needed.

## Develop

Use the Node version in `.node-version`.

```sh
npm ci --ignore-scripts
npm run dev
```

Open http://127.0.0.1:4173/tuck/. Application code is TypeScript in `src/`;
`npm run dev` compiles it into `.build/` and serves it with the static files in
`public/`. Run `npm run compile` after changing `src/`. For a fresh development
session, unregister the service worker in browser developer tools after changing
cached source files. Production builds use a content-derived cache version.

```sh
npm run lint
npm test
npx playwright install chromium webkit
npm run test:e2e
npm run build
```

The build compiles `src/` with `tsc`, copies `public/` and the compiled scripts
into `dist/`, and versions the offline cache. No bundler or runtime dependency is
required. Development dependencies are TypeScript, Node type definitions and
Playwright. Node runs the TypeScript build scripts and tests directly.

## Deployment and controls

GitHub Actions deploys `dist/` to Pages after syntax, unit, browser and dependency
checks pass on main. Pull requests run the same checks plus dependency review.
The organization's enforced CodeQL default setup scans JavaScript. A separate
SHA-pinned workflow scans Actions and rejects findings without uploading a
second configuration that would conflict with organization policy.

Repository settings mirror the applicable controls of
https://github.com/RandomCodeSpace/unified-agent-manager: signed commits,
PR-required main, strict checks, linear history, resolved conversations, admin
enforcement, blocked force pushes/deletions and protected release tags.
Dependabot, secret scanning and push protection complement those rules.

Socket Security is installed for this repository. SonarCloud is not configured:
no repository Sonar token is available and this session cannot inspect organization
secrets. No nonfunctional Sonar check is added to branch protection.

Automated WebKit checks emulate an iPhone viewport. Physical iPhone home-screen
installation, keyboard animation, Dynamic Island geometry and actual display
frame rate must still be checked on a device.

Licensed under MIT.
