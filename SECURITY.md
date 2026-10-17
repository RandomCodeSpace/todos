# Security

Report vulnerabilities privately through this repository's Security tab. Do not
post private todo data or sensitive details in a public issue.

Tuck stores data in this browser's IndexedDB. There is no account, remote sync,
analytics or application server. Device/browser access can expose the list.
Backups are unencrypted JSON files; store them appropriately. Clearing browser
site data removes todos. Offline support requires a successful online load first.

The application treats todo text as text, validates imports before transactions,
and uses a restrictive Content Security Policy. Service worker caches are scoped
to this application to avoid deleting caches belonging to other Pages projects.

CI uses read-only defaults, SHA-pinned actions, dependency review, npm audit and
CodeQL. Deployment alone receives Pages write and OIDC permissions.
