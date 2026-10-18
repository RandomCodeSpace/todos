# Tuck offline implementation

## Specification

Build an installable todo PWA for iPhone Safari and desktop browsers, deployed
to https://randomcodespace.github.io/tuck/. Store todos only in IndexedDB.
Support create, edit, complete, delete, filtering, search and portable JSON
backups. Cache the entire application for offline reloads after the first
successful online visit. Do not use third-party runtime services or fonts.

Use a fixed viewport shell, a contained scroll area, safe-area insets, dynamic
viewport sizing and at least 16px form text. Prevent overscroll bounce and
input-focus zoom without disabling accessibility pinch zoom. Physical iPhone
keyboard, home-screen installation and native bounce remain device checks.

Implementation choice: strict TypeScript compiled by `tsc` to native ES modules
(no bundler), plus HTML and CSS, with no runtime dependencies. The service worker
compiles separately as a classic script with WebWorker types. TypeScript
(Apache-2.0), @types/node (MIT) and Playwright (Apache-2.0) are exact-pinned
development dependencies.

Design (light mode), after Jakub Antalik's Dona references on Dribbble: cool
grey canvas (#eceef1), white cards (radius 16, 8px gaps), ink (#1f2328),
secondary text (#5f6670), soft square checkboxes, status rings (green today,
blue upcoming, purple anytime, red overdue), a floating composer pill, white
bottom sheets with a grabber, a grey info group and a pale note card. Status
bar style is default so dark glyphs sit on the light canvas. Safari 26 tints the
status bar from the fixed element at the top edge and keeps the last sampled
colour, so an opaque canvas-coloured strip sits there; without it, a closed
sheet's dimmed backdrop stays in the status bar. Desktop uses a sidebar and a white working panel. Optional record
fields: due (local YYYY-MM-DD), time (HH:MM), flagged (shown as Starred), notes,
completedAt, listId, parentId (one level of subtasks), blockedBy (ids of
top-level tasks), repeat and order. Lists live in a second object store added in
database version 2. Backups are version 2 (todos and lists); version 1 backups
still import.

## Plan

- [x] Write behavioral unit and browser tests; observe the missing app fail.
- [x] Implement data validation, IndexedDB transactions, accessible UI and PWA.
- [x] Verify offline CRUD/reload, import validation, storage failure, multiple
  tabs, iPhone viewport layout and desktop keyboard controls.
- [x] Add CI, dependency updates, code scanning and Pages deployment.
- [ ] Publish signed commits, copy applicable repository controls, and verify
  the deployed URL and final GitHub settings.

## Review focus

Tests must cover failed storage without false success, arbitrary todo text
rendered as text, invalid imports without data loss, no service-worker cache
interference with sibling Pages apps, and first-run/reload behavior offline.

## GitHub controls

Reference: RandomCodeSpace/unified-agent-manager. Match signed commits, PR-only
main, linear history, strict required checks, admin enforcement, resolved
conversations, no force pushes or deletion, protected release tags, read-only
workflow defaults, dependency review, Dependabot and secret push protection.
Adapt language-specific CI to JavaScript and browser testing. Only require
checks that exist for this repository. External integrations requiring their
own installation or credentials must be reported if unavailable.

## Verification record

Local Chromium desktop and iPhone-sized WebKit: 26 browser tests passed. The
independent review found four issues; regression tests failed before fixes and
passed afterward: deleted-record edit conflict, accessible modal error, committed
write with failed readback, and keyboard focus after mutations.

GitHub organization policy enforces CodeQL default setup. JavaScript reporting
uses that scan; the separate Actions scan rejects findings locally in its job
without submitting an incompatible advanced configuration. Socket is installed.
SonarCloud could not be configured without access to its project credentials.

Device-only verification remains outstanding for physical Dynamic Island layout,
iPhone keyboard animation, home-screen install and actual display frame rates.
