# Changelog

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
