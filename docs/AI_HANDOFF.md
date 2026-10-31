# AI handoff brief

Paste this file (and whichever source files are relevant) into ChatGPT, Claude or any coding AI to continue the project.

Read `docs/DESIGN-PRINCIPLES.md` first: instant first, network second.

## What this is

"a really helpful tool" (repo name docsync): a static web app on GitHub Pages that stores documents in a private GitHub repo through the GitHub REST Contents API. Owner unlocks with a password that decrypts a fine-grained GitHub token kept in `config.js`. Read `README.md` and `docs/ARCHITECTURE.md` for the full picture.

## Hard constraints (do not break)

1. **Static only.** Must run on GitHub Pages: no server code, no build step, no npm runtime dependencies. Plain HTML/CSS/JS with native ES modules.
2. **No external scripts or CDNs.** Everything is local in `assets/`.
3. **Never put a raw token in the repo.** Only the encrypted blob from `setup.html`.
4. **Render user data with `textContent`**, never `innerHTML` (file names are untrusted).
5. **Uploads stay sequential** (parallel commits cause 409 conflicts).
6. **Clean white UI with subtle Saurashtra touches.** Reuse the tokens in `assets/style.css` (`--kumkum` red, `--haldi` yellow, warm neutrals) and classes (`.btn`, `.btn-primary`, `.btn-ghost`, `.icon-btn`, `.input`, `.modal`, `.modal-box`, `.menu`, `.chip`). Keep the bandhani pattern to the thin strip, the logo and the lock screen ring; don't spread it. Mobile first, tap targets at least 40px.
9. **Strict CSP.** No inline `<script>`, no inline `style=""`, no `eval`. Network only to `https://api.github.com`. A CSP violation fails the tests.
10. **Deploys go through CI.** `.github/workflows/ci.yml` builds with `scripts/build-site.sh` (cache-busting `?v=`), tests that build, then deploys to Pages. New site files must be added to the copy list in that script.
8. **Simplicity first.** New actions go in the ⋯ menu; the row itself only has the heart and ⋯.
7. `config.js` is the only file a user should need to edit.

## Code map

- `assets/github.js` - `Vault` class. Add new GitHub API calls here, nowhere else.
- `assets/organize.js` - pure functions (no DOM, no network): categories + keywords, smart search, sorting, device detection, commit-message parsing. Add categories/keywords here.
- `assets/meta.js` - file origins from commit history, cached in localStorage.
- `assets/state.js` - `SyncedFile` engine (local-first change, save with sha, re-apply on 409/422) and `SharedState` favourites in `.app/state.json`. Build new synced data on `SyncedFile`; operations must be safe to run twice.
- `assets/clips.js` - shared clipboard in `.app/clipboard.json` (`Clipboard extends SyncedFile`) plus pure helpers `clipLink`, `clipAge`, `normalizeClip`.
- `assets/trash.js` - pure Trash helpers (names with a UTC stamp, 30-day rule, free names on restore). Deleting moves a file to `.trash/` via `Vault.moveToTrash`; see ARCHITECTURE.md.
- `assets/version.js` - `VERSION` and the What's new notes. Bump it (and `package.json`, `CHANGELOG.md`) with every release.
- `about.html` + `assets/about.css` - the public front page. Keep it static; it must never load the vault.
- `make-your-own.html` + `assets/guide.js` - the fork guide. Static, no network, no storage. If setup steps, setup.html messages or the CI change, update this page too.
- `sw.js` - service worker for offline start. Only same-origin GETs; never cache anything from api.github.com. Its version and file list are filled in by `scripts/build-site.sh`.
- `assets/zip.js` - pure zip writer for Backup.
- `assets/blobs.js` - file cache and prefetch. Keyed by sha; cleared on lock.
- `assets/app.js` - UI. Sections are numbered 1 to 9 in comments; keep that order. Menu actions are wired in section 6, the Clipboard tab (views, polling, copy/paste) in section 7, Trash and What's new in section 8.
- Commit message contract: `Upload <name> [<device>, <via>]`, `Rename <old> -> <new> [<device>]`, `Delete <name> [<device>]` and `Restore <name> [<device>]`. `meta.js` depends on it; keep it backwards compatible.
- `assets/crypto.js` - do not change the format without bumping `v` and keeping `v: 1` decryptable.
- `tests/e2e.mjs` - Playwright test with a mocked GitHub API. Extend the mock when you add API calls, and add assertions for new features.

## How to verify a change

```bash
npm run build && python3 -m http.server 8080 --directory _site &
npm test
```

All checks must print `ok`. Look at `tests/screenshots/` for desktop and iPhone layouts.

## Roadmap (ideas, in rough priority order)

Done: search, sort, auto categories, origins (1.1); favourites, rename, copy, send, undo delete, duplicate check, paste, instant preview, new name and design (1.2); production hardening, CI (1.3); shared clipboard tab (1.4); full redesign with red header, favourite cards, floating upload, sidebar on laptops, clickable links in clips (3.0); Trash with 30-day restore, About page, What's new, version number, install as app + offline start, backup zip, dark mode (4.0). Removed in 1.2 on purpose: iOS Shortcut and Android share target (owner didn't want them).

1. **Expiry reminders** - optional expiry date per file in `state.json` (passport, visa, residence permit, insurance); a "Due soon" chip and a banner 60/30/7 days before.
2. **Recent** - "Recently opened" chip from a per-device list (localStorage), so the last few files are one tap away.
3. **Notes / tags per file** - a short note or extra keywords in `state.json`, included in search.
4. **Multi-select** - long-press / checkbox to download, favourite or delete several files at once.
5. **Manual category override** - `state.json` map name -> category, set from a "Move to..." menu item.
6. Done in 4.1: upload progress bar (`progress.js`, `Vault.send` with XHR).
7. **Bigger files** - upload through the Git Data API (create blob) for up to 100 MB.
8. **Content search inside PDFs** - pdf.js text extraction, cached per sha. Heavier; only if needed.

## Conventions

- Small functions, comments explaining *why*.
- User-facing errors go through `friendlyError()` in `app.js`.
- Update `CHANGELOG.md` and the feature list in `README.md` with every feature.
