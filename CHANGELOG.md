# Changelog

## 4.1.1 (2026-10-31) - smoother

- Upload bar glides frame by frame (requestAnimationFrame, 60-120 fps) instead of jumping: even an instant upload fills over about half a second, and while GitHub saves a file the bar keeps creeping (never past that file's share) instead of sitting still
- The bar moves with `transform` only (no layout per frame); the "saving" stripes slide with a transform animation too
- Windows, the actions menu and messages now slide and fade in; tabs fade between each other; rows in the upload list, Trash and What's new rise in; buttons press in slightly. All GPU-only (transform/opacity), and off when the device asks for reduced motion
- Tests: 226 checks, including a frame-rate check on the bar

## 4.1.0 (2026-10-30) - upload progress bar

- One bar for the whole batch under the header: "Uploading 2 of 5 · 48% · about 20 s left", weighted by file size
- Real progress from the bytes sent (XMLHttpRequest upload events); a moving stripe while GitHub saves the commit
- Each file row has its own thin bar and status: Preparing, Uploading %, Saving, Done
- Cancel stops the batch; a failed file stays with Retry and Dismiss
- The browser asks before you close the tab mid-upload
- New pure module `progress.js`; tests: 223 checks

## 4.0.0 (2026-10-30) - Trash, install as an app, backup, dark mode

**Trash**
- Delete now moves a file to the Trash instead of removing it. It stays there for 30 days and comes back with one tap; Undo in the toast still works right away
- The Trash opens from the link at the bottom of the app: Restore, Delete forever, or Empty trash (both ask first)
- Restoring never overwrites: if the name is taken by then, the file comes back as "name (2)"
- A restored file keeps its original upload date and device
- Files older than 30 days are removed for good when the Trash opens, and at most once a day per device

**Install as an app**
- Add it to the home screen (Android, laptops: "Install app" at the bottom of the app; iPhone and iPad: the same link explains Share > Add to Home Screen) and it opens full screen from its own icon
- Opens without a connection: a service worker (`sw.js`) keeps the app itself (pages, scripts, styles, icons, font) on the device. Files you opened before still open from their own cache. Nothing from GitHub is ever put in the app cache
- Updates arrive on the next visit: pages are fetched fresh when online, and every release has new versioned file names

**Backup**
- "Backup" at the bottom of the app downloads every document in one zip (`a-really-helpful-tool-backup-<date>.zip`), with original names and dates
- Built in the browser by a tiny zip writer (`zip.js`, no libraries); files you opened before come from the cache, so it is quick

**Dark mode**
- Follows the phone or laptop setting: warm maroon-black page, the kumkum header stays, haldi marks the selected category, kumkum text gets lighter so it stays readable

**Product polish**
- New front page at `about.html`: what the app is, why it is private, how it works, with a link to unlock
- What's new window: opens once on each device after an update, and from the links on the lock screen and at the bottom of the app
- Version number on the lock screen, at the bottom of the app and on the front page

**Under the hood**
- Trash entries are `.trash/<UTC stamp>__<name>` in the vault, moved with one Git Data API commit (no re-upload, no index file). New `Vault.listFolder`, `moveToTrash`, `restoreFromTrash`, `purge`
- New pure modules `trash.js` and `version.js`; `parseCommit` understands `Restore <name>`
- Nothing to migrate. Rolling back to 3.0.0 is safe: `.trash/` is simply ignored by older versions
- Tests: 198 checks (zip format checked by a real unzip, backup contents byte for byte, offline start of the app and front page, nothing from GitHub in the offline cache, dark mode, Install app link per device, trash names and 30-day rule, delete to Trash, clean-up of old entries, restore with a taken name, origin kept, delete forever, empty trash, What's new, version on every screen, front page on desktop and phone)

## 3.0.0 (2026-10-28) - new design

A full visual redesign, plus a clipboard fix. No change to how data is stored, so nothing to migrate.

**Design**
- Kumkum red header on every screen with a bandhani dot field and a bandhani hem; the section name ("Documents", "Clipboard") and a count sit in it in large type
- Headings in Bricolage Grotesque (SIL OFL 1.1), self-hosted in `assets/fonts/` so the strict CSP stays unchanged
- Documents | Clipboard is now a segmented control inside the header
- Search and sort float over the header edge as cards
- Favourites show as large cards above an "All documents" list
- Upload is a haldi pill in the header on laptops and a floating button with a haldi ring on phones (hidden on the Clipboard tab)
- Laptops: categories move into a sidebar next to the list
- The newest clip is a dark card with a full-width haldi Copy button; older clips form one card below
- Lock screen is fully red, with the logo in a ring of white and haldi dots and the password in a white card
- New file type tiles, softer shadows, larger radii; offline notice is now a floating pill; theme colour is kumkum

**Fixes**
- Links in the clipboard are now clickable: every web address in a clip, also inside a sentence ("details at www.example.com, thanks"), opens in a new tab. Before, only the separate Open button worked, and only when the whole clip was one link.

**Under the hood**
- `linkParts()` in `clips.js` splits clip text into text and safe http(s) links
- Tests: 136 checks (link parsing, clickable links in clips, favourite cards, header title and Upload button per tab)
- README images regenerated from the new design

## Repo page (2026-10-28)

- New README: hero image, framed phone and laptop screenshots, a Clipboard section, updated file map and test count
- `npm run screenshots` regenerates every README image from a fake vault with example documents (`scripts/screenshots.mjs`, `scripts/compose-images.mjs`); no real data is ever used
- `docs/images/social-preview.png` for the repo's link preview
- Old banner and v1.3 screenshots removed

## 1.4.0 (2026-10-28) - shared clipboard

- New **Clipboard** tab: save text or a link on one device, copy it on another with one tap
  - "Paste and save" reads this device's clipboard in one tap; Ctrl+V anywhere on the tab does the same; Ctrl+Enter saves from the box
  - Newest clip highlighted with a filled Copy button; shows which device it came from and when
  - Links get an Open button (http/https only); long clips fold to 4 lines with Show all
  - Delete with Undo, Clear all (asks first) with Undo
  - Same text again moves to the top instead of duplicating; max 50 clips, 10,000 characters each
  - Checks for new clips every 10 s while open and whenever the app comes back to the front; a haldi dot on the tab when a clip arrives from another device
  - `.../#clipboard` opens straight on it; Clipboard shortcut in the web app manifest; last tab remembered per device
  - Pasting plain text on the Documents tab offers to save it to the clipboard
- `state.js` refactored into a reusable `SyncedFile` engine; save errors on favourites are now reported instead of silently dropped
- Lock also wipes the cached clipboard from the device
- Generic confirm dialog (button names the action: Delete, Clear all)
- Tests: 120 checks (clipboard save, copy, paste, sync from another device, simultaneous saves, dot, duplicates, size limit, delete/undo, clear/undo, #clipboard link, lock wipe); `CHROMIUM_PATH` env to test with an installed Chromium

## 1.3.0 (2026-10-26) - production release

- Strict Content Security Policy on every page; setup page logic moved to `assets/setup.js` (no inline code)
- Setup refuses a public vault repo and weak passwords; fills in the GitHub username automatically
- Friendly messages for GitHub rate limits and offline mode; global error safety net
- GitHub Actions: browser tests on every push and PR, deploy to Pages only when green
- `scripts/build-site.sh`: deploys only app files, cache-busts every script so phones never mix versions
- Tests run against the exact deployed build and fail on any CSP violation
- Pinned dev dependency + lockfile, Dependabot, `.editorconfig`, `.gitattributes`
- Repo polish: banner, screenshots, badges, SECURITY.md, CONTRIBUTING.md, issue and PR templates

## 1.2.0 (2026-10-26)

- Renamed to "a really helpful tool"; subtle Saurashtra / Kathiyawad design (bandhani strip, kumkum + haldi accents, new icon)
- Favourites (heart), synced across devices via `.app/state.json`, pinned on top, own chip
- ⋯ actions menu (bottom sheet on phones): Preview, Favourite, Copy, Send to an app, Download, Rename, Delete
- Rename in one commit via Git Data API, keeps origin and favourite
- Undo delete
- Copy to clipboard (images as PNG, text); Send to an app via the system share sheet
- Tap previews only types the browser can show; others open the menu
- Instant preview: per-device file cache by sha, prefetch on hover/touch, warm favourites, list drawn from cache on start
- Exact-duplicate detection before upload; paste (Ctrl+V) to upload
- Lock now wipes cached files from the device
- Removed: iOS Shortcut guide, Android share target, service worker

## 1.1.0 (2026-10-26)

- Auto categories from file names (ID & Visa, Work, Education, Money, Home, Photos, Other), English + German keywords
- File origin: device, upload date and "shared" tag, read from commit messages `Upload <name> [<device>, <via>]`
- Smart search (typo tolerant; types, devices, categories, months, today/week/month)
- Sort: newest, oldest, name, largest
- Drag and drop anywhere on the page
- Android Share menu via installable app (manifest share_target + service worker)
- iPhone/iPad "Save to DocSync" Shortcut guide, in-app help with copy buttons
- PNG app icons for home screens

## 1.0.0 (2026-10-26)

First release.

- Password lock screen (AES-256 encrypted GitHub token in config.js), "remember this device" and lock button
- Upload button for phones and desktop, drag and drop, multi-file queue, no overwrite on duplicate names
- File list with type icons and sizes
- Preview for PDF, images and text; download fallback for other types
- Download and delete with confirmation
- setup.html to test the token and generate config.js
- Playwright end-to-end test with a mocked GitHub API
