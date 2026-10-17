# Offline todos implementation

## Specification

Build an installable todo PWA for iPhone Safari and desktop browsers, deployed
to https://randomcodespace.github.io/todos/. Store todos only in IndexedDB.
Support create, edit, complete, delete, filtering, search and portable JSON
backups. Cache the entire application for offline reloads after the first
successful online visit. Do not use third-party runtime services or fonts.

Use a fixed viewport shell, a contained scroll area, safe-area insets, dynamic
viewport sizing and at least 16px form text. Prevent overscroll bounce and
input-focus zoom without disabling accessibility pinch zoom. Physical iPhone
keyboard, home-screen installation and native bounce remain device checks.

Implementation choice: native JavaScript modules, HTML and CSS, with no runtime
dependencies. Playwright is an exact-pinned Apache-2.0 development dependency.
Use a white notebook surface, blue ink (#2455db), slate text (#203047), muted
text (#59677c), rules (#dde3ef) and pale blue canvas (#f2f5fb). Use the native
system sans-serif stack for an iPhone-native feel. Left-aligned list and composer
are the main content; status and installation tools sit beside them on desktop
and below the list on narrow screens.

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
