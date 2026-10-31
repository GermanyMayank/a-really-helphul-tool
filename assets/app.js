// app.js
// All the UI logic. Read top to bottom:
//   1. setup + storage helpers
//   2. lock screen (password / token)
//   3. file list: decorate -> search -> category -> sort -> render
//   4. upload: button, drop anywhere, paste; skips exact duplicates
//   5. file actions: preview, favourite, copy, send to app, download, rename, delete (to the Trash, + undo)
//   6. actions menu (the ⋯ button)
//   7. clipboard: texts and links shared between your devices (+ the Documents / Clipboard tabs)
//   8. trash (restore, delete forever, 30-day clean-up), backup, install, What's new
//   9. small helpers (toast, modal, formatting)

import config from "../config.js";
import { Vault } from "./github.js";
import { decryptToken } from "./crypto.js";
import { ALL_CATEGORIES, categorize, kindOf, extOf, canPreview, searchFiles, sortFiles, thisDevice, formatDate } from "./organize.js";
import { cachedMeta, rememberMeta, resolveMeta } from "./meta.js";
import { SharedState, clearLocalState } from "./state.js";
import { Clipboard, MAX_CLIPS, clipLink, linkParts, clipAge, normalizeClip, clearLocalClips } from "./clips.js";
import { getBlob, prefetch, isReady, readyBlob, rememberBlob, clearBlobs, gitBlobSha } from "./blobs.js";
import { TRASH_FOLDER, TRASH_DAYS, trashName, parseTrashName, isExpired, trashLabel, freeName } from "./trash.js";
import { VERSION, RELEASES } from "./version.js";
import { makeZip } from "./zip.js";
import { sessionProgress, summaryText, isFinished } from "./progress.js";

const $ = (id) => document.getElementById(id);
const TOKEN_KEY = "docsync.token";
const SORT_KEY = "docsync.sort";
const LIST_KEY = "docsync.list.v1";
const VIEW_KEY = "docsync.view";          // last open tab on this device
const SEEN_KEY = "docsync.clips.seen";    // newest clip this device has seen
const VERSION_KEY = "docsync.version.seen"; // last version whose What's new this device showed
const PURGE_KEY = "docsync.trash.checked"; // day this device last cleaned up the trash
const CLIP_POLL_MS = 10000;               // check for new clips while the Clipboard is open
const MAX_BYTES = (config.maxFileMB || 25) * 1024 * 1024;
const DEVICE = thisDevice();

let vault = null;      // Vault instance once unlocked
let state = null;      // SharedState (favourites), synced through the vault
let clips = null;      // Clipboard (shared texts and links), synced through the vault
let files = [];        // raw list from GitHub: [{name, path, sha, size}]
let meta = {};         // path -> {date, device, via}
const view = { query: "", category: "all", sort: "newest" };

// ---------------------------------------------------------------------------
// 1. Local storage helpers. Everything is wrapped: private mode can throw.
// ---------------------------------------------------------------------------
function safe(fn) { try { return fn(); } catch { return null; } }
const local = {
  get: (k) => safe(() => localStorage.getItem(k)),
  set: (k, v) => safe(() => localStorage.setItem(k, v)),
  del: (k) => safe(() => localStorage.removeItem(k)),
};
const tokenStore = {
  get: () => local.get(TOKEN_KEY) || safe(() => sessionStorage.getItem(TOKEN_KEY)),
  set: (t, remember) => safe(() => (remember ? localStorage : sessionStorage).setItem(TOKEN_KEY, t)),
  clear: () => { local.del(TOKEN_KEY); safe(() => sessionStorage.removeItem(TOKEN_KEY)); },
};

function makeVault(t) {
  return new Vault({ owner: config.owner, repo: config.repo, folder: config.folder || "files", token: t });
}

// ---------------------------------------------------------------------------
// 2. Lock screen
// ---------------------------------------------------------------------------
function showLock(message = "") {
  vault = null;
  state = null;
  clips = null;
  stopClipPoll();
  clearInterval(autoTimer);
  if (sel.on) setSelecting(false);
  document.querySelectorAll(".modal:not([hidden])").forEach((m) => closeModal(m.id));
  closeMenu();
  $("app").hidden = true;
  $("lock").hidden = false;
  const usePassword = !!config.encryptedToken;
  $("lock-input").placeholder = usePassword ? "Password" : "GitHub access token";
  $("lock-input").autocomplete = usePassword ? "current-password" : "off";
  $("lock-hint").textContent = usePassword
    ? "Enter your password to open your documents."
    : "Paste your GitHub access token to open your documents.";
  $("lock-error").textContent = message;
  $("lock-input").value = "";
  if (!config.owner) {
    $("lock-hint").textContent = "This site is not set up yet. Open setup.html to configure it (see docs/SETUP.md).";
    $("lock-form").hidden = true;
  }
  setTimeout(() => $("lock-input").focus(), 50);
}

$("lock-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const value = $("lock-input").value.trim();
  if (!value) return;
  const btn = $("lock-btn");
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Unlocking';
  $("lock-error").textContent = "";
  try {
    const t = config.encryptedToken ? await decryptToken(config.encryptedToken, value) : value;
    const v = makeVault(t);
    await v.check();
    tokenStore.set(t, $("remember").checked);
    openApp(v);
  } catch (err) {
    $("lock-error").textContent = friendlyError(err);
  } finally {
    btn.disabled = false;
    btn.textContent = "Unlock";
  }
});

// Lock: forget the token AND everything cached on this device
$("logout-btn").addEventListener("click", async () => {
  tokenStore.clear();
  local.del(LIST_KEY);
  local.del(SEEN_KEY);
  clearLocalState();
  clearLocalClips();
  await clearBlobs();
  files = [];
  trashItems = [];
  showLock("Locked. Nothing from your documents or clipboard is left on this device.");
});

function openApp(v) {
  vault = v;
  state = new SharedState(v);
  clips = new Clipboard(v);
  $("lock").hidden = true;
  $("app").hidden = false;
  renderClips();            // last known clips, instantly
  setView(startView());     // #clipboard link, else the tab used last on this device
  refreshClips();
  // Instant start: draw the last known list right away, then refresh
  const cached = safe(() => JSON.parse(local.get(LIST_KEY)));
  if (Array.isArray(cached) && cached.length) {
    files = cached;
    meta = cachedMeta();
    renderFiles();
  }
  loadFiles();
  startAutoRefresh();
  maybeShowWhatsNew();
}

// ---------------------------------------------------------------------------
// 3. File list
// ---------------------------------------------------------------------------
// Design principle: instant first, network second (docs/DESIGN-PRINCIPLES.md).
// The list on screen is always the last known one; the network only ever
// updates it, and new files announce themselves with a glow.
async function loadFiles({ quiet = false, scrollToNew = false } = {}) {
  if (!quiet && !files.length) $("skeleton").hidden = false;
  try {
    const [list] = await Promise.all([vault.list(), state.load().catch(() => null)]);
    const added = applyList(list);
    meta = await resolveMeta(vault, files);
    renderFiles();            // then fill in dates and devices
    if (added.length) showNew(added, scrollToNew);
    warmFavourites();
    dailyTrashCleanup();
  } catch (err) {
    handleError(err);
  } finally {
    $("skeleton").hidden = true;
  }
}

/** Put a fresh listing on screen. Returns the files that weren't there before. */
const freshPaths = new Set();
function applyList(list) {
  const before = new Set(files.map((f) => f.path));
  const added = before.size ? list.filter((f) => !before.has(f.path)) : [];
  files = list;
  local.set(LIST_KEY, JSON.stringify(files));
  meta = cachedMeta();
  for (const f of added) {
    freshPaths.add(f.path);
    setTimeout(() => freshPaths.delete(f.path), 2600);
  }
  renderFiles();
  return added;
}

/** New files glow; bring them into view (own upload) or offer a pill (other device). */
function showNew(added, scroll) {
  const rows = added.map((f) => document.querySelector(`.file[data-path="${CSS.escape(f.path)}"]`)).filter(Boolean);
  const first = rows.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)[0];
  if (!first) return;
  const r = first.getBoundingClientRect();
  if (r.top >= 0 && r.bottom <= innerHeight) return;
  if (scroll) return first.scrollIntoView({ behavior: "smooth", block: "center" });
  const pill = $("new-pill");
  pill.textContent = `${r.top < 0 ? "↑" : "↓"} ${added.length} new file${added.length > 1 ? "s" : ""}`;
  pill.hidden = false;
  pill.onclick = () => { pill.hidden = true; first.scrollIntoView({ behavior: "smooth", block: "center" }); };
  clearTimeout(pill.timer);
  pill.timer = setTimeout(() => (pill.hidden = true), 8000);
}

// Auto refresh: ask GitHub "anything new?" when you come back to the app and
// every 20 s while it's open. Unchanged answers are free (ETag, HTTP 304).
let autoTimer = null;
let lastCheck = 0;
let pendingOps = 0;        // optimistic changes still being committed: don't overwrite them
async function checkForNew() {
  if (!vault || document.hidden || $("app").hidden || upRunning || pendingOps) return;
  if (Date.now() - lastCheck < 4000) return;
  lastCheck = Date.now();
  try {
    const list = await vault.listIfChanged();
    if (!list || pendingOps) return;
    const added = applyList(list);
    if (added.length) {
      meta = await resolveMeta(vault, files);
      renderFiles();
      showNew(added, false);
    }
  } catch { /* offline or rate limited: the next check will try again */ }
}
function startAutoRefresh() {
  clearInterval(autoTimer);
  autoTimer = setInterval(checkForNew, 20000);
}
document.addEventListener("visibilitychange", () => { if (!document.hidden) checkForNew(); });
window.addEventListener("focus", checkForNew);

// Favourites are what you open most, so fetch small ones in the background
function warmFavourites() {
  files.filter((f) => state.isFavorite(f.path) && f.size < 5e6).slice(0, 10).forEach((f) => prefetch(vault, f));
}

// Add category, date, device and favourite flag to each raw file
function decorate(f) {
  const m = meta[f.path] || {};
  return { ...f, date: m.date || null, device: m.device || null, via: m.via || null, category: categorize(f.name), fav: !!state?.isFavorite(f.path) };
}

function renderFiles() {
  const all = files.map(decorate);
  const found = searchFiles(all, view.query);
  renderChips(all, found);
  let shown = found;
  if (view.category === "fav") shown = found.filter((f) => f.fav);
  else if (view.category !== "all") shown = found.filter((f) => f.category.id === view.category);
  const sorted = sortFiles(shown, view.sort);
  // favourites stay on top, in the chosen order
  const ordered = [...sorted.filter((f) => f.fav), ...sorted.filter((f) => !f.fav)];
  shownPaths = ordered.map((f) => f.path);
  for (const p of sel.paths) if (!files.some((f) => f.path === p)) sel.paths.delete(p);

  $("file-list").replaceChildren(...ordered.map(fileRow));
  // Favourites as big cards above the list, on the plain "All" view only
  const favs = view.category === "all" && !view.query ? ordered.filter((f) => f.fav).slice(0, 4) : [];
  $("fav-grid").replaceChildren(...favs.map(favCard));
  $("favs").hidden = favs.length === 0;
  $("all-title").hidden = favs.length === 0;
  updateHero();
  syncSelBar();
  $("empty").hidden = files.length > 0;
  const none = files.length && !ordered.length;
  $("no-results").hidden = !none;
  if (none) {
    const label = view.category === "fav" ? "Favourites" : ALL_CATEGORIES.find((c) => c.id === view.category)?.label;
    $("no-results-text").textContent = view.query
      ? `Nothing matches "${view.query}"${label ? ` in ${label}` : ""}.`
      : view.category === "fav" ? "No favourites yet. Tap the heart on a document." : `Nothing in ${label || "this category"}.`;
  }
}

// Chips: All, Favourites (if any), then categories that have files.
// Counts follow the current search.
function renderChips(all, found) {
  const present = ALL_CATEGORIES.filter((c) => all.some((f) => f.category.id === c.id));
  const hasFav = all.some((f) => f.fav);
  if (view.category === "fav" && !hasFav) view.category = "all";
  if (!["all", "fav"].includes(view.category) && !present.some((c) => c.id === view.category)) view.category = "all";
  const chip = (id, label, n, cls = "") => {
    const b = el("button", `chip ${cls}`);
    b.type = "button";
    b.classList.toggle("on", view.category === id);
    b.classList.toggle("zero", n === 0 && view.category !== id);
    b.append(label, el("span", "n", String(n)));
    b.addEventListener("click", () => { view.category = id; renderFiles(); });
    return b;
  };
  const chips = [chip("all", "All", found.length)];
  if (hasFav) chips.push(chip("fav", "♥ Favourites", found.filter((f) => f.fav).length, "chip-fav"));
  if (present.length > 1) present.forEach((c) => chips.push(chip(c.id, c.label, found.filter((f) => f.category.id === c.id).length)));
  $("chips").replaceChildren(...chips);
  $("chips").hidden = !all.length;
}

const HEART = '<path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z"/>';
const DOTS = '<circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/>';

// A favourite as a card: the big, tappable way to reach your most-used files
function favCard(f) {
  const kind = kindOf(f.name);
  const b = el("button", "fav-card");
  b.type = "button";
  const previewable = canPreview(f.name);
  b.title = previewable ? `Preview ${f.name}` : `Options for ${f.name}`;
  const top = el("span", "fav-top");
  top.append(el("span", `fav-icon ${kind.cls}`, kind.label));
  const heart = el("span", "fav-heart");
  heart.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${HEART}</svg>`;
  top.append(heart);
  const text = el("span", "fav-text");
  text.append(el("span", "fav-name truncate", f.name), el("span", "fav-meta truncate", [f.category.label, f.device].filter(Boolean).join(", ")));
  b.append(top, text);
  b.addEventListener("click", () => (previewable ? preview(f) : openMenu(f, b)));
  if (previewable) b.addEventListener("pointerenter", () => prefetch(vault, f), { once: true });
  return b;
}

function fileRow(f) {
  const kind = kindOf(f.name);
  const li = el("li", "file");
  li.dataset.path = f.path;
  if (freshPaths.has(f.path)) li.classList.add("fresh");
  const picked = sel.paths.has(f.path);
  li.classList.toggle("selected", picked);
  const check = el("button", "check");
  check.type = "button";
  check.setAttribute("role", "checkbox");
  check.setAttribute("aria-checked", String(picked));
  check.setAttribute("aria-label", `Select ${f.name}`);
  check.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 12.5l3.2 3.2L17 9"/></svg>';
  check.addEventListener("click", (e) => { if (!sel.on) setSelecting(true); toggleSel(f.path, e.shiftKey); });

  const main = el("button", "file-main");
  main.type = "button";
  const previewable = canPreview(f.name);
  main.title = previewable ? `Preview ${f.name}` : `Options for ${f.name}`;
  const icon = el("span", `file-icon ${kind.cls}`, kind.label);
  const text = el("span", "file-text");
  const metaLine = el("span", "file-meta truncate", [formatSize(f.size), f.device, formatDate(f.date)].filter(Boolean).join(" · "));
  if (f.via === "share") metaLine.append(" ", el("span", "tag", "shared"));
  text.append(el("span", "file-name truncate", f.name), metaLine);
  main.append(icon, text);
  // Supported files open the preview; everything else opens the actions menu
  main.addEventListener("click", (e) => {
    if (li.dataset.noclick) return;
    if (e.metaKey || e.ctrlKey) { if (!sel.on) setSelecting(true); return toggleSel(f.path); }
    if (sel.on) return toggleSel(f.path, e.shiftKey);
    previewable ? preview(f) : openMenu(f, main);
  });
  addGestures(li, f);

  // Start downloading as soon as the pointer/finger lands, so the click is instant
  if (previewable) {
    const warm = () => prefetch(vault, f);
    li.addEventListener("pointerenter", warm, { once: true });
    li.addEventListener("touchstart", warm, { once: true, passive: true });
  }

  const actions = el("div", "file-actions");
  const heart = iconButton(f.fav ? "Remove from favourites" : "Add to favourites", HEART, () => toggleFavorite(f));
  heart.classList.add("heart");
  heart.setAttribute("aria-pressed", String(f.fav));
  const more = iconButton("More options", DOTS, (e) => openMenu(f, e.currentTarget));
  more.classList.add("more");
  actions.append(heart, more);

  li.append(check, main, actions);
  return li;
}

$("refresh-btn").addEventListener("click", () => (currentView === "clips" ? refreshClips({ announce: true }) : loadFiles()));

let searchTimer;
$("search").addEventListener("input", (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { view.query = e.target.value.trim(); renderFiles(); }, 120);
});
$("clear-search").addEventListener("click", () => {
  $("search").value = "";
  view.query = "";
  view.category = "all";
  renderFiles();
});

view.sort = local.get(SORT_KEY) || "newest";
$("sort").value = view.sort;
$("sort").addEventListener("change", (e) => {
  view.sort = e.target.value;
  local.set(SORT_KEY, view.sort);
  renderFiles();
});

// ---------------------------------------------------------------------------
// 4. Upload. Three ways in: the button, dropping files anywhere, pasting.
//    Files go one by one to avoid GitHub "409 conflict" errors.
// ---------------------------------------------------------------------------
$("file-input").addEventListener("change", (e) => {
  uploadAll([...e.target.files], "upload");
  e.target.value = ""; // allow picking the same file again
});

// Drop anywhere: show an overlay while files are dragged over the window
let dragDepth = 0;
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes("Files");
window.addEventListener("dragenter", (e) => {
  if (!hasFiles(e) || !vault) return;
  e.preventDefault();
  dragDepth++;
  $("drop-overlay").hidden = false;
});
window.addEventListener("dragleave", () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) $("drop-overlay").hidden = true;
});
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => {
  e.preventDefault();
  dragDepth = 0;
  $("drop-overlay").hidden = true;
  if (vault) uploadAll([...(e.dataTransfer?.files || [])], "drop");
});

// Paste: a screenshot or files copied in Finder / Explorer upload directly
document.addEventListener("paste", (e) => {
  if (!vault || /INPUT|TEXTAREA/.test(document.activeElement?.tagName)) return;
  const pasted = [...(e.clipboardData?.files || [])].map((f) =>
    // pasted screenshots are all called "image.png": give them a useful name
    f.name === "image.png" ? new File([f], `Screenshot ${new Date().toISOString().slice(0, 16).replace("T", " ").replace(":", ".")}.png`, { type: f.type }) : f
  );
  if (pasted.length) { e.preventDefault(); uploadAll(pasted, "paste"); return; }
  // Plain text: goes to the shared clipboard (asks first on the Documents tab)
  const text = e.clipboardData?.getData("text/plain");
  if (!normalizeClip(text)) return;
  e.preventDefault();
  if (currentView === "clips") saveClip(text);
  else toast("Save the pasted text to your clipboard?", false, { label: "Save", run: () => saveClip(text) });
});

// One worker sends files one at a time; everything dropped, pasted or picked
// while it runs joins the same session, so the bar covers all of it.
// Each item: {file, via, size, state, sent, li} (states: see progress.js).
let upItems = [];        // this session, in order
let upRunning = null;    // Promise while the worker runs
let upAbort = null;      // AbortController for the file being sent right now
let upStarted = 0;       // when this session began (for time left)
let upHideTimer = null;

function uploadAll(list, via = "upload") {
  if (!vault || !list.length) return upRunning || Promise.resolve();
  clearTimeout(upHideTimer);
  if (!upRunning && upItems.every(isFinished)) {
    // a new session starts from an empty bar, without sliding back from the last one
    upItems = [];
    upStarted = Date.now();
    $("upbar").classList.remove("finished", "leaving");
    barShown = barTarget = 0;
    paintBar();
  }
  for (const file of list) upItems.push(queueRow({ file, via, size: file.size, state: "waiting", sent: 0 }));
  renderUpBar();
  announce(`Uploading ${list.length} file${list.length > 1 ? "s" : ""}`);
  if (!upRunning) upRunning = runUploads().finally(() => { upRunning = null; });
  return upRunning;
}

async function runUploads() {
  let ok = 0;
  let item;
  while ((item = upItems.find((i) => i.state === "waiting"))) {
    const result = await uploadOne(item);
    if (result === "auth") return;
    if (result === "ok") ok++;
  }
  const p = sessionProgress(upItems, upStarted);
  renderUpBar(true);
  if (upItems.some((i) => i.state !== "cancelled")) announce(summaryText(p, true));
  if (ok) {
    toast(`${ok} file${ok > 1 ? "s" : ""} uploaded`);
    await loadFiles({ quiet: true, scrollToNew: true });
  }
}

async function uploadOne(item) {
  const { file, via } = item;
  setItem(item, "preparing", "Preparing");
  try {
    if (file.size > MAX_BYTES) throw new Error(`Too large (max ${config.maxFileMB || 25} MB)`);
    // Same bytes already in the vault? Don't store it twice.
    const sha = await gitBlobSha(file);
    if (item.state === "cancelled") return "cancelled";
    const twin = files.find((f) => f.sha === sha);
    if (twin) { finishItem(item, "skipped", `Already saved as ${twin.name}`, 6000); return "skip"; }

    const name = cleanName(file.name);
    const base64 = await readBase64(file);
    if (item.state === "cancelled") return "cancelled";
    upAbort = new AbortController();
    setItem(item, "uploading", "Uploading 0%");
    const saved = await vault.upload(name, base64, `${DEVICE}, ${via}`, {
      signal: upAbort.signal,
      onProgress: (loaded, total) => {
        if (item.state !== "uploading") return;
        item.sent = total ? loaded / total : 1;
        if (item.sent >= 1) setItem(item, "saving", "Saving on GitHub");
        else setItem(item, "uploading", `Uploading ${Math.floor(item.sent * 100)}%`);
      },
    });
    rememberMeta(saved.path, saved.sha, { date: new Date().toISOString(), device: DEVICE, via });
    rememberBlob(saved.sha || sha, file);
    finishItem(item, "done", saved.name === name ? "Done" : `Saved as ${saved.name}`, 4000);
    return "ok";
  } catch (err) {
    if (err.name === "AbortError" || item.state === "cancelled") { finishItem(item, "cancelled", "Cancelled", 0); return "cancelled"; }
    finishItem(item, "failed", friendlyError(err), 0);
    if (err.status === 401) { handleError(err); return "auth"; }
    return "failed";
  } finally {
    upAbort = null;
  }
}

// ----- one row per file in #queue -----
function queueRow(item) {
  const li = el("li", "waiting");
  const bar = el("span", "qbar");
  bar.append(el("span", "qbar-fill"));
  li.append(el("span", "spinner"), el("span", "name truncate", item.file.name), el("span", "state muted", "Waiting"), bar);
  $("queue").append(li);
  item.li = li;
  return item;
}

function setItem(item, state, text) {
  item.state = state;
  item.li.className = state;
  item.li.querySelector(".state").textContent = text;
  const frac = state === "uploading" ? item.sent : state === "saving" ? 1 : 0;
  item.li.querySelector(".qbar-fill").style.transform = `scaleX(${frac})`;
  renderUpBar();
}

function finishItem(item, state, text, ms) {
  setItem(item, state, text);
  item.li.querySelector(".spinner")?.remove();
  item.li.querySelector(".qbar")?.remove();
  if (state === "failed") {
    // stays until you retry or dismiss it
    const retry = el("button", "link-btn retry", "Retry");
    retry.type = "button";
    retry.addEventListener("click", () => { item.li.remove(); uploadAll([item.file], item.via); });
    const close = iconButton(`Dismiss ${item.file.name}`, '<path d="M6 6l12 12M18 6L6 18"/>', () => item.li.remove());
    item.li.append(retry, close);
  } else {
    setTimeout(() => item.li.remove(), ms);
  }
}

// ----- the bar -----
// The real numbers can jump (a small file is sent in a few milliseconds), so
// the bar never shows them directly: a requestAnimationFrame loop glides the
// shown value towards the real one, so it moves on every frame (60-120 fps).
// Only transform and opacity change, which the browser draws on the GPU.
const BAR_MIN_MS = 450;          // even an instant upload fills over at least this long
let barShown = 0;                // what the bar shows now, 0..100
let barTarget = 0;               // the real progress, 0..100
let barCeil = 0;                 // creep limit while waiting (end of the current file)
let barFrame = 0;
let barLast = 0;
let barFinished = false;
let barText = "";

function renderUpBar(finished = false) {
  if (!upItems.length) return;
  const p = sessionProgress(upItems, upStarted);
  if (!finished && !upItems.some((i) => !isFinished(i))) finished = true;
  if (upItems.every((i) => i.state === "cancelled")) { hideUpBar(); return; }
  const bar = $("upbar");
  if (bar.hidden) { bar.hidden = false; bar.classList.remove("leaving"); }
  barTarget = p.pct;
  // how far the bar may creep while it waits for the file in progress (GitHub
  // takes a moment to save each commit): never past where that file ends
  const cur = upItems.findIndex((i) => !isFinished(i));
  barCeil = cur < 0 ? p.pct : Math.max(p.pct, sessionProgress(upItems.map((i, n) => (n === cur ? { ...i, state: "done" } : i)), upStarted).pct - 1);
  barFinished = finished;
  barText = summaryText(p, finished);
  bar.classList.toggle("has-failed", finished && p.failed > 0);
  $("upbar-cancel").hidden = finished;
  $("upbar-track").setAttribute("aria-valuenow", String(p.pct));
  $("upbar-track").setAttribute("aria-valuetext", barText);
  if (!barFrame) { barLast = performance.now(); barFrame = requestAnimationFrame(barTick); }
}

function barTick(now) {
  if ($("upbar").hidden || $("upbar").classList.contains("leaving")) { barFrame = 0; return; }
  const dt = Math.min(64, now - barLast);
  barLast = now;
  const gap = barTarget - barShown;
  // ease out: cover ~1/4 of the gap every ~16 ms, but never slower than 100 % per BAR_MIN_MS
  const step = Math.max(gap * (1 - Math.exp(-dt / 70)), Math.min(gap, (100 / BAR_MIN_MS) * dt * 0.35));
  if (gap > 0.05) barShown += step;
  else if (!barFinished && barCeil > barShown) barShown += (barCeil - barShown) * (1 - Math.exp(-dt / 1800)); // slow creep, never reaches the ceiling
  else barShown = Math.max(barShown, barTarget);
  paintBar();
  if (!barFinished || barShown < barTarget - 0.05) {
    barFrame = requestAnimationFrame(barTick);
    return;
  }
  barShown = barTarget;
  paintBar();
  barFrame = 0;
  // done: let the full bar register, then slide away
  $("upbar").classList.add("finished");
  clearTimeout(upHideTimer);
  upHideTimer = setTimeout(hideUpBar, $("upbar").classList.contains("has-failed") ? 6000 : 1200);
}

function paintBar() {
  const shown = Math.round(barShown);
  // the fill is full width and slides in from the left: translateX only, no layout
  $("upbar-fill").style.transform = `translateX(${barShown - 100}%)`;
  // while uploading, the text counts along with the bar; at the end it shows the summary
  $("upbar-text").textContent = barFinished && shown >= barTarget ? barText : barText.replace(/\d+%/, `${shown}%`);
}

function hideUpBar() {
  const bar = $("upbar");
  if (bar.hidden) return;
  bar.classList.add("leaving");
  setTimeout(() => {
    if (!bar.classList.contains("leaving")) return; // a new upload started meanwhile
    bar.hidden = true;
    bar.classList.remove("leaving", "finished");
    barShown = barTarget = 0;
    paintBar();
  }, 260);
}

function announce(text) { $("upbar-live").textContent = text; }

// Cancel: stop the file being sent and drop everything still waiting
$("upbar-cancel").addEventListener("click", () => {
  for (const i of upItems) if (i.state === "waiting" || i.state === "preparing") finishItem(i, "cancelled", "Cancelled", 0);
  upAbort?.abort();
  announce("Upload cancelled");
  toast("Upload cancelled");
});

// Closing the tab mid-upload would lose the rest: ask first
window.addEventListener("beforeunload", (e) => {
  if (!upRunning) return;
  e.preventDefault();
  e.returnValue = "";
});

function readBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] || "");
    r.onerror = () => reject(new Error("Could not read file"));
    r.readAsDataURL(file);
  });
}

// Remove characters that break paths or look odd in a repo
function cleanName(name) {
  const n = name.replace(/[\/\\\u0000-\u001f]/g, "_").replace(/^\.+/, "").trim();
  return n || `file-${Date.now()}`;
}

// ---------------------------------------------------------------------------
// 5. File actions
// ---------------------------------------------------------------------------
const current = (path) => files.map(decorate).find((f) => f.path === path);

// ----- Preview (only for types this browser can show) -----
let previewUrl = null;
let previewing = null;

async function preview(f) {
  previewing = f.path;
  const kind = kindOf(f.name);
  $("preview-title").textContent = f.name;
  syncPreviewHeart();
  $("preview-copy").hidden = !copyKind(f);
  $("preview-share").hidden = !canShareFiles();
  const body = $("preview-body");
  // cached bytes render with no spinner at all
  if (!isReady(f)) body.replaceChildren(loadingEl());
  openModal("preview");

  try {
    const blob = await getBlob(vault, f);
    if ($("preview").hidden || previewing !== f.path) return; // closed or switched while loading
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = URL.createObjectURL(new Blob([blob], { type: kind.mime }));

    if (kind.view === "image") {
      const img = new Image();
      img.alt = f.name;
      img.decoding = "async";
      img.src = previewUrl;
      body.replaceChildren(img);
    } else if (kind.view === "pdf") {
      const frame = document.createElement("iframe");
      frame.title = f.name;
      frame.src = previewUrl;
      body.replaceChildren(frame);
    } else {
      body.replaceChildren(el("pre", "", await blob.text()));
    }
  } catch (err) {
    body.replaceChildren(el("div", "preview-msg", friendlyError(err)));
    if (err.status === 401) handleError(err);
  }
}

function syncPreviewHeart() {
  const on = !!state?.isFavorite(previewing);
  $("preview-fav").setAttribute("aria-pressed", String(on));
  $("preview-fav").title = on ? "Remove from favourites" : "Add to favourites";
}

function closePreview() {
  previewing = null;
  $("preview-body").replaceChildren();
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = null;
}

$("preview-fav").addEventListener("click", () => { const f = current(previewing); if (f) toggleFavorite(f); syncPreviewHeart(); });
$("preview-copy").addEventListener("click", () => { const f = current(previewing); if (f) copyFile(f); });
$("preview-share").addEventListener("click", () => { const f = current(previewing); if (f) shareFile(f); });
$("preview-download").addEventListener("click", () => { const f = current(previewing); if (f) download(f); });

// ----- Favourite (synced to every device through .app/state.json) -----
function toggleFavorite(f) {
  const on = !state.isFavorite(f.path);
  state.toggleFavorite(f.path).catch(handleError);
  renderFiles();
  toast(on ? "Added to favourites" : "Removed from favourites");
}

// ----- Copy to clipboard -----
// Browsers only allow images and text on the clipboard, not PDFs or Word
// files. For those, "Send to an app" is the way to hand the file over.
function copyKind(f) {
  if (!window.ClipboardItem || !navigator.clipboard?.write) return null;
  const { view } = kindOf(f.name);
  if (view === "text") return "text";
  if (view === "image" && !["svg", "heic"].includes(extOf(f.name))) return "image";
  return null;
}

async function copyFile(f) {
  const kind = copyKind(f);
  if (!kind) return toast("This file type can't go on the clipboard. Use Send to an app or Download.", true);
  // The ClipboardItem must be created inside the tap, with the data as a promise
  const data = getBlob(vault, f);
  const item = kind === "text"
    ? new ClipboardItem({ "text/plain": data.then((b) => new Blob([b], { type: "text/plain" })) })
    : new ClipboardItem({ "image/png": data.then(toPng) });
  try {
    await navigator.clipboard.write([item]);
    toast(kind === "text" ? "Text copied" : "Image copied. Paste it anywhere.");
  } catch {
    toast("Your browser blocked the copy. Try again, or use Download.", true);
  }
}

// Clipboards accept PNG only, so other image types are redrawn as PNG
async function toPng(blob) {
  const bmp = await createImageBitmap(blob);
  const c = document.createElement("canvas");
  c.width = bmp.width;
  c.height = bmp.height;
  c.getContext("2d").drawImage(bmp, 0, 0);
  return new Promise((res) => c.toBlob(res, "image/png"));
}

// ----- Send to an app (system share sheet: WhatsApp, Mail, AirDrop ...) -----
function canShareFiles() {
  return !!navigator.canShare && safe(() => navigator.canShare({ files: [new File(["x"], "x.pdf", { type: "application/pdf" })] }));
}

async function shareFile(f) {
  // The share sheet must open within the tap, so the bytes need to be ready.
  if (!isReady(f)) {
    toast("Getting the file ready…");
    await getBlob(vault, f).catch(handleError);
  }
  const blob = readyBlob(f);
  if (!blob) return;
  const file = new File([blob], f.name, { type: kindOf(f.name).mime });
  try {
    await navigator.share({ files: [file], title: f.name });
  } catch (err) {
    if (err.name === "NotAllowedError") toast("File is ready. Tap Send again.");
    else if (err.name !== "AbortError") toast("Couldn't open the share menu.", true);
  }
}

// ----- Download -----
async function download(f) {
  try {
    if (!isReady(f)) toast(`Downloading ${f.name}…`);
    const blob = await getBlob(vault, f);
    saveBlob(new Blob([blob], { type: kindOf(f.name).mime }), f.name);
  } catch (err) {
    handleError(err);
  }
}

/** Hand a Blob to the browser as a download called `name`. */
function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = el("a", "");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

// ----- Rename (one commit, no re-upload, keeps origin and favourite) -----
let renaming = null;
function askRename(f) {
  renaming = f;
  const input = $("rename-input");
  input.value = f.name;
  $("rename-error").textContent = "";
  openModal("rename");
  // select the name without the extension, like Finder / Explorer
  const dot = f.name.lastIndexOf(".");
  setTimeout(() => { input.focus(); input.setSelectionRange(0, dot > 0 ? dot : f.name.length); }, 30);
}

$("rename-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = renaming;
  let name = cleanName($("rename-input").value.trim());
  // keep the extension if it was removed by accident
  const oldExt = extOf(f.name);
  if (oldExt && !extOf(name)) name = `${name}.${oldExt}`;
  if (name === f.name) return closeModal("rename");
  if (files.some((x) => x.name.toLowerCase() === name.toLowerCase() && x.path !== f.path)) {
    $("rename-error").textContent = `"${name}" already exists.`;
    return;
  }
  // optimistic: the list changes now, GitHub catches up in the background
  const newPath = `${vault.folder}/${name}`;
  const m = meta[f.path];
  if (m) rememberMeta(newPath, f.sha, { date: m.date, device: m.device, via: m.via });
  state.renamePath(f.path, newPath).catch(() => {});
  files = files.map((x) => (x.path === f.path ? { ...x, name, path: newPath } : x));
  local.set(LIST_KEY, JSON.stringify(files));
  meta = cachedMeta();
  renderFiles();
  closeModal("rename");
  toast(`Renamed to ${name}`);
  pendingOps++;
  try {
    await vault.rename(f.path, f.sha, name, DEVICE);
  } catch (err) {
    files = files.map((x) => (x.path === newPath ? { ...x, name: f.name, path: f.path } : x));
    state.renamePath(newPath, f.path).catch(() => {});
    meta = cachedMeta();
    renderFiles();
    toast(`Couldn't rename ${f.name}: ${friendlyError(err)}`, true);
  } finally {
    pendingOps--;
  }
});

// ----- Delete: moves files to the Trash (30 days), with Undo -----
// Optimistic: rows leave at once; one commit moves them all in the background.
function askDelete(f) {
  confirmAction(`Move "${f.name}" to the Trash? You can restore it for ${TRASH_DAYS} days.`, "Delete", () => trashFiles([f]));
}

async function trashFiles(fs) {
  fs = fs.filter(Boolean);
  if (!fs.length) return;
  const items = fs.map((f) => ({ f, wasFav: state.isFavorite(f.path), m: meta[f.path], trashPath: `${TRASH_FOLDER}/${trashName(f.name)}` }));
  const gone = new Set(fs.map((f) => f.path));
  files = files.filter((x) => !gone.has(x.path));
  local.set(LIST_KEY, JSON.stringify(files));
  const favPaths = items.filter((i) => i.wasFav).map((i) => i.f.path);
  if (favPaths.length) state.setFavorite(favPaths, false).catch(() => {});
  renderFiles();
  pendingOps++;
  const done = vault.moveManyToTrash(items.map((i) => ({ path: i.f.path, sha: i.f.sha, trashPath: i.trashPath })), DEVICE);
  toast(fs.length === 1 ? `Moved ${fs[0].name} to Trash` : `Moved ${fs.length} files to Trash`, false, { label: "Undo", run: () => undoTrash(items, done) });
  try {
    await done;
  } catch (err) {
    files = [...files, ...fs];
    if (favPaths.length) state.setFavorite(favPaths, true).catch(() => {});
    renderFiles();
    toast(`Couldn't move to Trash: ${friendlyError(err)}`, true);
  } finally {
    pendingOps--;
  }
}

// Undo = everything back from the trash in one commit, favourites and origin included
async function undoTrash(items, done) {
  try { await done; } catch { return; } // it never left
  const taken = new Set(files.map((x) => x.name));
  const back = items.map((i) => {
    const name = freeName(i.f.name, taken);
    taken.add(name);
    return { ...i, name, path: `${vault.folder}/${name}` };
  });
  files = [...files, ...back.map((b) => ({ name: b.name, path: b.path, sha: b.f.sha, size: b.f.size }))];
  for (const b of back) if (b.m) rememberMeta(b.path, b.f.sha, b.m);
  const favs = back.filter((b) => b.wasFav).map((b) => b.path);
  if (favs.length) state.setFavorite(favs, true).catch(() => {});
  meta = cachedMeta();
  renderFiles();
  toast(back.length === 1 ? `Restored ${back[0].name}` : `Restored ${back.length} files`);
  pendingOps++;
  try {
    await vault.restoreMany(back.map((b) => ({ trashPath: b.trashPath, sha: b.f.sha, name: b.name })), DEVICE);
  } catch (err) {
    handleError(err);
  } finally {
    pendingOps--;
    loadFiles({ quiet: true });
  }
}

/** Put a trashed file back under its old name (or "name (2)" if that is taken now). */
async function restoreFile(trashPath, sha, name, m) {
  const saved = await vault.restoreFromTrash(trashPath, sha, freeName(name, new Set(files.map((x) => x.name))), DEVICE);
  if (m) rememberMeta(saved.path, sha, m);
  return saved;
}

// ---------------------------------------------------------------------------
// 6. Actions menu (⋯). Shows only what works for this file on this device.
// ---------------------------------------------------------------------------
let menuFile = null;
function openMenu(f, anchor) {
  menuFile = f;
  const menu = $("menu");
  $("menu-title").textContent = f.name;
  const show = {
    preview: canPreview(f.name),
    favorite: true,
    copy: !!copyKind(f),
    share: canShareFiles(),
    download: true,
    rename: true,
    delete: true,
  };
  menu.querySelectorAll("[data-act]").forEach((b) => (b.hidden = !show[b.dataset.act]));
  menu.querySelector('[data-act="favorite"] span').textContent = f.fav ? "Remove from favourites" : "Add to favourites";
  if (show.share || show.copy) prefetch(vault, f); // so Send/Copy work on the first tap

  menu.hidden = false;
  $("menu-backdrop").hidden = false;
  // Phones: bottom sheet (CSS). Larger screens: next to the button.
  if (matchMedia("(min-width: 601px)").matches) {
    const r = anchor.getBoundingClientRect();
    const h = menu.offsetHeight, w = menu.offsetWidth;
    const top = r.bottom + 4 + h > innerHeight ? Math.max(8, r.top - h - 4) : r.bottom + 4;
    menu.style.top = `${top}px`;
    menu.style.left = `${Math.max(8, Math.min(r.right - w, innerWidth - w - 8))}px`;
  } else {
    menu.style.top = menu.style.left = "";
  }
  menu.querySelector("button:not([hidden])")?.focus({ preventScroll: true });
}
function closeMenu() {
  $("menu").hidden = true;
  $("menu-backdrop").hidden = true;
}
$("menu-backdrop").addEventListener("click", closeMenu);
$("menu").addEventListener("click", (e) => {
  const b = e.target.closest("[data-act]");
  if (!b || !menuFile) return;
  const f = menuFile;
  closeMenu();
  ({
    preview: () => preview(f),
    favorite: () => toggleFavorite(f),
    copy: () => copyFile(f),
    share: () => shareFile(f),
    download: () => download(f),
    rename: () => askRename(f),
    delete: () => askDelete(f),
  })[b.dataset.act]();
});
window.addEventListener("resize", closeMenu);

// ---------------------------------------------------------------------------
// 7. Clipboard. Save a text or link on one device, copy it on another.
//    Lives in .app/clipboard.json (see clips.js). While the Clipboard tab is
//    open it checks for new clips every few seconds; on the Documents tab a
//    small haldi dot says a new clip arrived from another device.
// ---------------------------------------------------------------------------
let currentView = "docs";

function startView() {
  if (location.hash === "#clipboard") return "clips";
  if (location.hash === "#documents") return "docs";
  return local.get(VIEW_KEY) === "clips" ? "clips" : "docs";
}

function setView(name, { focus = false } = {}) {
  currentView = name === "clips" ? "clips" : "docs";
  document.querySelectorAll(".tab").forEach((tab) => {
    const on = tab.dataset.view === currentView;
    tab.setAttribute("aria-selected", String(on));
    tab.tabIndex = on ? 0 : -1;
  });
  $("docs-view").hidden = currentView !== "docs";
  $("clip-view").hidden = currentView !== "clips";
  document.body.dataset.view = currentView;
  updateHero();
  local.set(VIEW_KEY, currentView);
  // keep the address bookmarkable: .../#clipboard opens straight here
  const hash = currentView === "clips" ? "#clipboard" : "";
  if (location.hash !== hash) safe(() => history.replaceState(null, "", location.pathname + location.search + hash));
  if (focus) document.querySelector(`.tab[data-view="${currentView}"]`)?.focus();
  if (currentView === "clips") {
    markClipsSeen();
    markLongClips();
    refreshClips();
  }
  scheduleClipPoll();
}

// The red header names the section and how much is in it
function updateHero() {
  const docs = currentView === "docs";
  $("view-title").textContent = docs ? "Documents" : "Clipboard";
  const n = docs ? files.length : clips?.items.length ?? 0;
  const noun = docs ? "document" : "clip";
  const count = `${n} ${noun}${n === 1 ? "" : "s"}`;
  $("view-sub").textContent = docs
    ? `${count}${matchMedia("(hover: hover)").matches ? ". Drop files anywhere or paste with Ctrl+V." : ", on all your devices."}`
    : `${count}, on all your devices.`;
}

document.querySelectorAll(".tab").forEach((tab) => tab.addEventListener("click", () => setView(tab.dataset.view)));
// arrow keys move between tabs, as screen reader users expect
$("tab-docs").parentElement.addEventListener("keydown", (e) => {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
  e.preventDefault();
  setView(currentView === "docs" ? "clips" : "docs", { focus: true });
});
window.addEventListener("hashchange", () => {
  if (vault && ["#clipboard", "#documents"].includes(location.hash)) setView(startView());
});

// ----- Render -----
const COPY_ICON = '<svg viewBox="0 0 24 24"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>';
const CHECK_ICON = '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
const OPEN_ICON = '<svg viewBox="0 0 24 24"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>';
const TRASH = '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>';
const openClips = new Set(); // ids of long clips the user expanded

function renderClips() {
  if (!clips) return;
  const items = clips.items;
  $("clip-list").replaceChildren(...items.map((item, i) => clipRow(item, i === 0)));
  $("clip-empty").hidden = items.length > 0;
  $("clip-foot").hidden = items.length === 0;
  $("clip-count").textContent = `${items.length} clip${items.length === 1 ? "" : "s"}. The newest ${MAX_CLIPS} are kept.`;
  markLongClips();
  updateClipDot();
  updateHero();
}

function clipRow(item, latest) {
  const li = el("li", latest ? "clip latest" : "clip");
  li.dataset.id = item.id;
  const link = clipLink(item.text);

  const body = el("div", "clip-body");
  const text = el("p", `clip-text${link ? " is-link" : ""}${openClips.has(item.id) ? " open" : ""}`);
  text.append(...linkParts(item.text).map((part) => {
    if (!part.href) return document.createTextNode(part.text);
    const a = el("a", "clip-link", part.text);
    a.href = part.href;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    return a;
  }));
  body.append(text, el("span", "clip-meta", [item.device, clipAge(item.at)].filter(Boolean).join(" · ")));

  const actions = el("div", "clip-actions");
  const copy = el("button", `btn ${latest ? "btn-primary" : "btn-ghost"} clip-copy`);
  copy.type = "button";
  copy.title = "Copy to this device's clipboard";
  setCopyLabel(copy, false);
  copy.addEventListener("click", () => copyClip(item, copy));
  // Open sits left of Copy, so every Copy button lines up in one column
  if (link) {
    const a = el("a", "icon-btn");
    a.href = link;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.title = "Open link";
    a.setAttribute("aria-label", "Open link");
    a.innerHTML = OPEN_ICON;
    actions.append(a);
  }
  actions.append(copy, iconButton("Delete clip", TRASH, () => deleteClip(item)));

  li.append(body, actions);
  return li;
}

function setCopyLabel(btn, done) {
  btn.classList.toggle("done", done);
  btn.innerHTML = done ? CHECK_ICON : COPY_ICON;
  btn.append(done ? "Copied" : "Copy");
}

// Long clips show 4 lines plus "Show all". Needs layout, so only when visible.
function markLongClips() {
  if (!clips || $("clip-view").hidden) return;
  $("clip-list").querySelectorAll(".clip").forEach((li) => {
    const text = li.querySelector(".clip-text");
    const existing = li.querySelector(".clip-more");
    const long = text.classList.contains("open") || text.scrollHeight > text.clientHeight + 2;
    if (!long || existing) return;
    const more = el("button", "clip-more", text.classList.contains("open") ? "Show less" : "Show all");
    more.type = "button";
    more.addEventListener("click", () => {
      const open = text.classList.toggle("open");
      if (open) openClips.add(li.dataset.id); else openClips.delete(li.dataset.id);
      more.textContent = open ? "Show less" : "Show all";
    });
    text.after(more);
  });
}

// Times like "2 min ago" go stale; refresh them without rebuilding the list
function updateClipAges() {
  if (!clips) return;
  $("clip-list").querySelectorAll(".clip").forEach((li) => {
    const item = clips.items.find((i) => i.id === li.dataset.id);
    if (item) li.querySelector(".clip-meta").textContent = [item.device, clipAge(item.at)].filter(Boolean).join(" · ");
  });
}

// ----- Sync -----
let pollTimer = null;
let refreshingClips = false;

function scheduleClipPoll() {
  stopClipPoll();
  if (vault && currentView === "clips" && document.visibilityState === "visible") {
    pollTimer = setInterval(() => refreshClips(), CLIP_POLL_MS);
  }
}
function stopClipPoll() {
  clearInterval(pollTimer);
  pollTimer = null;
}

async function refreshClips({ announce = false } = {}) {
  if (!clips || refreshingClips) return;
  refreshingClips = true;
  const signature = () => clips.items.map((i) => i.id).join(",");
  const before = signature();
  try {
    await clips.refresh();
    if (signature() !== before) renderClips();
    else updateClipAges();
    if (currentView === "clips") markClipsSeen();
    else updateClipDot();
    if (announce) toast("Clipboard is up to date");
  } catch (err) {
    // Background checks stay quiet (the next one retries); a tap on Refresh says what happened
    if (err.status === 401 || announce) handleError(err);
  } finally {
    refreshingClips = false;
  }
}

function markClipsSeen() {
  const newest = clips?.items[0];
  if (newest) local.set(SEEN_KEY, newest.id);
  updateClipDot();
}

function updateClipDot() {
  const newest = clips?.items[0];
  $("clip-dot").hidden = !newest || currentView === "clips" || newest.device === DEVICE || newest.id === local.get(SEEN_KEY);
}

// Coming back to the app (switching from another app or tab) is exactly when
// a clip from the other device is expected, so check right away.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") refreshClips();
  scheduleClipPoll();
});
window.addEventListener("focus", () => refreshClips());

// ----- Save -----
function saveClip(text) {
  if (!clips) return null;
  let added;
  try {
    added = clips.add(text, DEVICE);
  } catch (err) {
    toast(err.message, true);
    return null;
  }
  renderClips();
  markClipsSeen();
  added.save
    .then(() => toast("Saved. It's on your other devices now."))
    .catch((err) => {
      handleError(err);
      // put the text back so nothing typed is lost, and show what GitHub really has
      if (!$("clip-input").value) $("clip-input").value = added.item.text;
      refreshClips();
    });
  return added.item;
}

$("clip-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const input = $("clip-input");
  if (saveClip(input.value)) {
    input.value = "";
    input.blur(); // closes the phone keyboard so the list is visible
  }
});

// Ctrl+Enter / Cmd+Enter saves, like sending a message
$("clip-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    $("clip-form").requestSubmit();
  }
});

// One tap: read this device's clipboard and save it
$("clip-paste").hidden = !navigator.clipboard?.readText;
$("clip-paste").addEventListener("click", async () => {
  let text;
  try {
    text = await navigator.clipboard.readText();
  } catch {
    return toast("Your browser didn't allow reading the clipboard. Paste into the box instead.", true);
  }
  if (!normalizeClip(text)) return toast("There's no text on your clipboard to save.", true);
  saveClip(text);
});

// ----- Copy, delete, clear -----
async function copyClip(item, btn) {
  if (!(await writeClipboardText(item.text))) {
    return toast("Your browser blocked the copy. Select the text and copy it by hand.", true);
  }
  setCopyLabel(btn, true);
  setTimeout(() => btn.isConnected && setCopyLabel(btn, false), 1600);
}

// The modern API first; the old select-and-copy trick for older browsers.
// Must run straight from the tap (iPhone only allows copying inside a tap).
async function writeClipboardText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch { /* fall back below */ }
  const ta = el("textarea", "offscreen");
  ta.value = text;
  ta.setAttribute("readonly", "");
  document.body.append(ta);
  ta.select();
  ta.setSelectionRange(0, text.length);
  const ok = safe(() => document.execCommand("copy")) || false;
  ta.remove();
  return ok;
}

function deleteClip(item) {
  const index = clips.items.findIndex((i) => i.id === item.id);
  clips.remove(item.id, DEVICE).catch((err) => { handleError(err); refreshClips(); });
  renderClips();
  toast("Clip deleted", false, { label: "Undo", run: () => restoreClips([{ item, index }]) });
}

function restoreClips(entries) {
  if (!clips) return;
  clips.restore(entries, DEVICE).catch((err) => { handleError(err); refreshClips(); });
  renderClips();
}

$("clip-clear").addEventListener("click", () => {
  const n = clips?.items.length || 0;
  if (!n) return;
  confirmAction(`Clear all ${n} clip${n === 1 ? "" : "s"} from every device?`, "Clear all", () => {
    const entries = clips.items.map((item, index) => ({ item, index }));
    clips.clear(DEVICE).catch((err) => { handleError(err); refreshClips(); });
    renderClips();
    toast("Clipboard cleared", false, { label: "Undo", run: () => restoreClips(entries) });
  });
});

// ---------------------------------------------------------------------------
// 7b. Select mode, swipe, long-press, pull to refresh
// ---------------------------------------------------------------------------
const sel = { on: false, paths: new Set(), anchor: null };
let shownPaths = [];       // paths in the order they're on screen (for Shift ranges, Select all)

function setSelecting(on) {
  sel.on = on;
  if (!on) { sel.paths.clear(); sel.anchor = null; }
  document.body.classList.toggle("selecting", on);
  $("select-btn").setAttribute("aria-pressed", String(on));
  renderFiles();
}

function toggleSel(path, range = false) {
  if (range && sel.anchor && shownPaths.includes(sel.anchor)) {
    const [a, b] = [shownPaths.indexOf(sel.anchor), shownPaths.indexOf(path)].sort((x, y) => x - y);
    shownPaths.slice(a, b + 1).forEach((p) => sel.paths.add(p));
  } else {
    sel.paths.has(path) ? sel.paths.delete(path) : sel.paths.add(path);
    sel.anchor = path;
  }
  // update rows in place (no re-render: keeps it instant and keeps focus)
  document.querySelectorAll("#file-list .file").forEach((li) => {
    const on = sel.paths.has(li.dataset.path);
    li.classList.toggle("selected", on);
    li.querySelector(".check")?.setAttribute("aria-checked", String(on));
  });
  syncSelBar();
}

const selected = () => files.filter((f) => sel.paths.has(f.path)).map(decorate);

function syncSelBar() {
  const bar = $("selbar");
  bar.hidden = !sel.on;
  if (!sel.on) return;
  const list = selected();
  const n = list.length;
  $("sel-count").textContent = n ? `${n} selected` : "Select files";
  const allShown = shownPaths.length > 0 && shownPaths.every((p) => sel.paths.has(p));
  $("sel-all").textContent = allShown ? "None" : "All";
  for (const id of ["sel-download", "sel-fav", "sel-share", "sel-trash"]) $(id).disabled = n === 0;
  const allFav = n > 0 && list.every((f) => f.fav);
  $("sel-fav").setAttribute("aria-pressed", String(allFav));
  $("sel-fav").setAttribute("aria-label", allFav ? "Remove selected from favourites" : "Favourite selected");
  $("sel-share").hidden = !canShareFiles();
}

$("select-btn").addEventListener("click", () => setSelecting(!sel.on));
$("sel-done").addEventListener("click", () => setSelecting(false));
$("sel-all").addEventListener("click", () => {
  const allShown = shownPaths.every((p) => sel.paths.has(p));
  shownPaths.forEach((p) => (allShown ? sel.paths.delete(p) : sel.paths.add(p)));
  renderFiles();
});
$("sel-download").addEventListener("click", async () => {
  const list = selected();
  if (list.length === 1) return download(list[0]);
  try {
    await zipFiles(list, `a-really-helpful-tool-${list.length}-files-${new Date().toISOString().slice(0, 10)}.zip`, "Preparing download", "Download ready");
  } catch (err) {
    handleError(err);
  }
});
$("sel-fav").addEventListener("click", () => {
  const list = selected();
  const on = !list.every((f) => f.fav);
  state.setFavorite(list.map((f) => f.path), on).catch(handleError);
  renderFiles();
  toast(on ? `Added ${list.length} to favourites` : `Removed ${list.length} from favourites`);
});
$("sel-share").addEventListener("click", async () => {
  try {
    const list = selected();
    const fileObjs = await Promise.all(list.map(async (f) => new File([await getBlob(vault, f)], f.name, { type: kindOf(f.name).mime })));
    await navigator.share({ files: fileObjs });
  } catch (err) {
    if (err.name !== "AbortError") handleError(err);
  }
});
$("sel-trash").addEventListener("click", () => {
  const list = selected();
  const n = list.length;
  confirmAction(`Move ${n === 1 ? `"${list[0].name}"` : `${n} files`} to the Trash? You can restore ${n === 1 ? "it" : "them"} for ${TRASH_DAYS} days.`, "Delete", () => {
    setSelecting(false);
    trashFiles(list);
  });
});

// Touch gestures on a row: long-press selects, swipe left = Trash, swipe right = favourite
function addGestures(li, f) {
  let x0 = 0, y0 = 0, dx = 0, mode = null, timer = 0, id = null;
  const noClick = () => { li.dataset.noclick = "1"; setTimeout(() => delete li.dataset.noclick, 450); };
  li.addEventListener("pointerdown", (e) => {
    if (e.pointerType !== "touch" || id !== null) return;
    id = e.pointerId; x0 = e.clientX; y0 = e.clientY; dx = 0; mode = null;
    timer = setTimeout(() => {
      mode = "press";
      navigator.vibrate?.(12);
      noClick();
      if (!sel.on) setSelecting(true);
      toggleSel(f.path);
    }, 450);
  });
  li.addEventListener("pointermove", (e) => {
    if (e.pointerId !== id || mode === "press" || mode === "scroll") return;
    const mx = e.clientX - x0, my = e.clientY - y0;
    if (!mode) {
      if (Math.abs(mx) < 10 && Math.abs(my) < 10) return;
      clearTimeout(timer);
      if (sel.on || Math.abs(my) >= Math.abs(mx)) { mode = "scroll"; return; }
      mode = "swipe";
      try { li.setPointerCapture(id); } catch { /* synthetic or finished pointer */ }
      li.classList.add("swiping");
    }
    dx = mx;
    const w = li.offsetWidth;
    const arm = Math.min(110, w * 0.3);
    // follows the finger, then gets heavier past the threshold
    const shown = Math.abs(dx) <= arm ? dx : Math.sign(dx) * (arm + (Math.abs(dx) - arm) * 0.35);
    li.style.setProperty("--dx", `${shown}px`);
    li.classList.toggle("swipe-left", dx < 0);
    li.classList.toggle("swipe-right", dx > 0);
    const armed = Math.abs(dx) > arm;
    if (armed !== li.classList.contains("armed")) {
      li.classList.toggle("armed", armed);
      if (armed) navigator.vibrate?.(8);
    }
  });
  const end = (e) => {
    if (e.pointerId !== id) return;
    clearTimeout(timer);
    id = null;
    if (mode !== "swipe") { mode = null; return; }
    mode = null;
    noClick();
    const armed = li.classList.contains("armed");
    li.classList.remove("swiping");
    if (armed && dx < 0) {
      li.style.setProperty("--dx", `${-li.offsetWidth}px`);
      li.classList.add("leaving");
      setTimeout(() => trashFiles([current(f.path)]), 200);
      return;
    }
    li.style.setProperty("--dx", "0px");
    setTimeout(() => li.classList.remove("armed", "swipe-left", "swipe-right"), 260);
    if (armed && dx > 0) setTimeout(() => { const c = current(f.path); if (c) toggleFavorite(c); }, 200);
  };
  li.addEventListener("pointerup", end);
  li.addEventListener("pointercancel", end);
  li.addEventListener("contextmenu", (e) => { if (e.pointerType === "touch" || sel.on || li.dataset.noclick) e.preventDefault(); });
}

// Pull to refresh (phones): pull down at the top of Documents
let ptr = null;
document.addEventListener("touchstart", (e) => {
  if (!vault || currentView !== "docs" || $("app").hidden || scrollY > 0 || sel.on || e.touches.length !== 1 || document.querySelector(".modal:not([hidden])")) return;
  ptr = { x0: e.touches[0].clientX, y0: e.touches[0].clientY, pull: 0 };
}, { passive: true });
document.addEventListener("touchmove", (e) => {
  if (!ptr) return;
  const dy = e.touches[0].clientY - ptr.y0;
  const dxAbs = Math.abs(e.touches[0].clientX - ptr.x0);
  if (scrollY > 0 || (ptr.pull === 0 && (dy <= 0 || dxAbs > dy))) { ptr = null; resetPtr(); return; }
  ptr.pull = Math.max(0, Math.min(96, dy * 0.5));
  const ind = $("ptr");
  ind.classList.add("pulling");
  ind.classList.toggle("ready", ptr.pull >= 64);
  ind.style.setProperty("--pull", `${ptr.pull}px`);
  ind.style.setProperty("--turn", `${dy * 1.6}deg`);
}, { passive: true });
document.addEventListener("touchend", async () => {
  if (!ptr) return;
  const ready = ptr.pull >= 64;
  ptr = null;
  if (!ready) return resetPtr();
  const ind = $("ptr");
  ind.classList.add("refreshing");
  ind.style.setProperty("--pull", "64px");
  navigator.vibrate?.(10);
  await loadFiles({ quiet: true });
  resetPtr();
});
function resetPtr() {
  const ind = $("ptr");
  ind.classList.remove("pulling", "ready", "refreshing");
  ind.style.setProperty("--pull", "0px");
}

// ---------------------------------------------------------------------------
// 8. Trash and What's new
//    Trash lives in .trash/<stamp>__<name> in the vault (see trash.js). Files
//    older than 30 days are removed for good when the Trash is opened, and
//    at most once a day after the file list loads.
// ---------------------------------------------------------------------------
let trashItems = [];   // [{path, sha, size, name, deletedAt}] newest first

async function readTrash() {
  const raw = await vault.listFolder(TRASH_FOLDER);
  const items = raw
    .map((f) => ({ ...f, ...parseTrashName(f.name) }))
    .filter((f) => f.deletedAt)
    .sort((a, b) => b.deletedAt - a.deletedAt);
  const old = items.filter((f) => isExpired(f.deletedAt));
  if (old.length) {
    await vault.purge(old.map((f) => f.path), `Empty trash: ${old.length} file${old.length > 1 ? "s" : ""} older than ${TRASH_DAYS} days [${DEVICE}]`);
  }
  local.set(PURGE_KEY, new Date().toDateString());
  return items.filter((f) => !isExpired(f.deletedAt));
}

function dailyTrashCleanup() {
  if (local.get(PURGE_KEY) === new Date().toDateString()) return;
  readTrash().catch(() => { /* try again next time, never bother the user */ });
}

async function openTrash() {
  openModal("trash");
  $("trash-loading").hidden = trashItems.length > 0;
  renderTrash();
  try {
    trashItems = await readTrash();
  } catch (err) {
    handleError(err);
  } finally {
    $("trash-loading").hidden = true;
    renderTrash();
  }
}

function renderTrash() {
  $("trash-list").replaceChildren(...trashItems.map(trashRow));
  const loading = !$("trash-loading").hidden;
  $("trash-empty").hidden = loading || trashItems.length > 0;
  $("trash-foot").hidden = trashItems.length === 0;
  $("trash-count").textContent = `${trashItems.length} file${trashItems.length === 1 ? "" : "s"}`;
}

function trashRow(f) {
  const kind = kindOf(f.name);
  const li = el("li", "trash-item");
  const icon = el("span", `file-icon ${kind.cls}`, kind.label);
  const text = el("span", "file-text");
  text.append(el("span", "file-name truncate", f.name), el("span", "file-meta", trashLabel(f.deletedAt)));
  const restore = el("button", "btn btn-ghost btn-sm", "Restore");
  restore.type = "button";
  restore.addEventListener("click", () => restoreFromTrash(f, restore));
  const forever = iconButton(`Delete ${f.name} forever`, TRASH, () => askDeleteForever(f));
  li.append(icon, text, restore, forever);
  return li;
}

async function restoreFromTrash(f, btn) {
  btn.disabled = true;
  try {
    const saved = await restoreFile(f.path, f.sha, f.name, null);
    trashItems = trashItems.filter((x) => x.path !== f.path);
    renderTrash();
    toast(`Restored ${saved.name}`);
    await loadFiles({ quiet: true });
  } catch (err) {
    btn.disabled = false;
    handleError(err);
  }
}

function askDeleteForever(f) {
  confirmAction(`Delete "${f.name}" forever? This can't be undone.`, "Delete forever", async () => {
    try {
      await vault.purge([f.path], `Delete forever ${f.name} [${DEVICE}]`);
      trashItems = trashItems.filter((x) => x.path !== f.path);
      renderTrash();
      toast(`Deleted ${f.name} forever`);
    } catch (err) {
      handleError(err);
    }
  });
}

$("trash-btn").addEventListener("click", openTrash);
$("trash-clear").addEventListener("click", () => {
  const n = trashItems.length;
  confirmAction(`Delete all ${n} file${n === 1 ? "" : "s"} in the Trash forever? This can't be undone.`, "Empty trash", async () => {
    try {
      await vault.purge(trashItems.map((f) => f.path), `Empty trash: ${n} file${n === 1 ? "" : "s"} [${DEVICE}]`);
      trashItems = [];
      renderTrash();
      toast("Trash emptied");
    } catch (err) {
      handleError(err);
    }
  });
});

// ----- Backup: every document in one zip, straight from the vault -----
async function backup() {
  if (!files.length) return toast("Nothing to back up yet.");
  const btn = $("backup-btn");
  btn.disabled = true;
  try {
    await zipFiles(files, `a-really-helpful-tool-backup-${new Date().toISOString().slice(0, 10)}.zip`, "Preparing backup", "Backup ready");
  } catch (err) {
    handleError(err);
  } finally {
    btn.disabled = false;
  }
}

/** Download several documents as one zip. */
async function zipFiles(list, fileName, busy, ready) {
  {
    const entries = [];
    for (const [i, f] of list.entries()) {
      toast(`${busy}: ${i + 1} of ${list.length}`);
      const blob = await getBlob(vault, f);
      const date = meta[f.path]?.date ? new Date(meta[f.path].date) : new Date();
      entries.push({ name: f.name, data: new Uint8Array(await blob.arrayBuffer()), date });
    }
    const zip = new Blob(makeZip(entries), { type: "application/zip" });
    saveBlob(zip, fileName);
    toast(`${ready}: ${list.length} document${list.length === 1 ? "" : "s"}, ${formatSize(zip.size)}`);
  }
}
$("backup-btn").addEventListener("click", backup);

// ----- Install as an app (+ offline start through sw.js) -----
let installPrompt = null;
const isStandalone = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
function syncInstall() {
  $("install-btn").hidden = isStandalone() || !(installPrompt || isIOS());
}
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();          // show our own quiet link instead of the browser banner
  installPrompt = e;
  syncInstall();
});
window.addEventListener("appinstalled", () => { installPrompt = null; syncInstall(); toast("Installed. Open it from your home screen."); });
$("install-btn").addEventListener("click", async () => {
  if (installPrompt) {
    installPrompt.prompt();
    await installPrompt.userChoice.catch(() => null);
    installPrompt = null;
    syncInstall();
  } else {
    openModal("install-help");
  }
});
syncInstall();
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => { /* still works online */ });

// ----- What's new: opens once per device after an update, and from the links -----
function renderWhatsNew() {
  const body = $("whatsnew-body");
  if (body.childElementCount) return;
  body.append(...RELEASES.map((r, i) => {
    const sec = el("section", i === 0 ? "release latest" : "release");
    const head = el("div", "release-head");
    head.append(el("h4", "release-version", `v${r.version}`));
    if (i === 0) head.append(el("span", "release-badge", "Latest"));
    const ul = el("ul", "release-items");
    for (const [lead, rest] of r.items) {
      const li = el("li");
      li.append(el("strong", null, lead), document.createTextNode(`: ${rest}`));
      ul.append(li);
    }
    sec.append(head, ul);
    return sec;
  }));
}
function openWhatsNew() {
  renderWhatsNew();
  local.set(VERSION_KEY, VERSION);
  openModal("whatsnew");
}
function maybeShowWhatsNew() {
  if (local.get(VERSION_KEY) !== VERSION) openWhatsNew();
}
$("whatsnew-btn").addEventListener("click", openWhatsNew);
$("lock-whatsnew").addEventListener("click", openWhatsNew);
document.querySelectorAll(".version").forEach((e) => (e.textContent = `v${VERSION}`));

// ---------------------------------------------------------------------------
// 9. Helpers
// ---------------------------------------------------------------------------
function openModal(id) { $(id).hidden = false; }
function closeModal(id) {
  $(id).hidden = true;
  if (id === "preview") closePreview();
}

/** Ask before something destructive. `label` names the action: "Delete", "Clear all". */
function confirmAction(text, label, run) {
  $("confirm-text").textContent = text;
  $("confirm-ok").textContent = label;
  $("confirm-ok").onclick = () => { closeModal("confirm"); run(); };
  openModal("confirm");
}
document.querySelectorAll(".modal").forEach((m) => {
  m.addEventListener("click", (e) => {
    if (e.target === m || e.target.closest("[data-close]")) closeModal(m.id);
  });
});
document.addEventListener("keydown", (e) => {
  const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName);
  const modalOpen = !!document.querySelector(".modal:not([hidden])");
  if (e.key === "Escape" && sel.on && !modalOpen) return setSelecting(false);
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "a" && vault && currentView === "docs" && !typing && !modalOpen) {
    e.preventDefault();
    if (!sel.on) setSelecting(true);
    shownPaths.forEach((p) => sel.paths.add(p));
    return renderFiles();
  }
  if (e.key === "Escape") {
    closeMenu();
    document.querySelectorAll(".modal:not([hidden])").forEach((m) => closeModal(m.id));
  }
  // "/" jumps to search, like on GitHub
  if (e.key === "/" && vault && currentView === "docs" && !/INPUT|TEXTAREA/.test(document.activeElement?.tagName)) { e.preventDefault(); $("search").focus(); }
});

let toastTimer;
/** toast("Saved") or toast("Deleted x", false, {label: "Undo", run}) */
function toast(text, isError = false, action = null) {
  const t = $("toast");
  $("toast-text").textContent = text;
  const btn = $("toast-action");
  btn.hidden = !action;
  if (action) {
    btn.textContent = action.label;
    btn.onclick = () => { t.hidden = true; action.run(); };
  }
  t.className = isError ? "toast err" : "toast";
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), action ? 8000 : isError ? 6000 : 3000);
}

function handleError(err) {
  if (err?.status === 401) {
    tokenStore.clear();
    showLock("Your access token expired or was revoked. Unlock again (or create a new token, see docs/SETUP.md).");
  } else {
    toast(friendlyError(err), true);
  }
}

function friendlyError(err) {
  if (err.message === "Wrong password") return "Wrong password.";
  if (err.rateLimited) {
    const mins = err.resetAt ? Math.max(1, Math.ceil((err.resetAt - Date.now()) / 60000)) : null;
    return `GitHub's hourly limit is reached. Try again${mins ? ` in ${mins} min` : " later"}.`;
  }
  switch (err.status) {
    case 401: return "Token not valid (expired or revoked).";
    case 403: return "Access denied. Check the token has Contents read/write on the vault repo.";
    case 404: return `Vault repo "${config.owner}/${config.repo}" not found, or the token can't see it.`;
    case 409: return "GitHub was busy, please retry.";
    case 413: return "File too large for GitHub.";
    case 422: return err.message || "GitHub rejected the request.";
  }
  if (err instanceof TypeError) return "Network error. Check your connection.";
  return err.message || "Something went wrong.";
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function iconButton(label, path, onClick) {
  const b = el("button", "icon-btn");
  b.type = "button";
  b.title = label;
  b.setAttribute("aria-label", label);
  b.innerHTML = `<svg viewBox="0 0 24 24">${path}</svg>`;
  b.addEventListener("click", onClick);
  return b;
}

function loadingEl() {
  const d = el("div", "loading");
  d.append(el("span", "spinner"), document.createTextNode(" Loading…"));
  return d;
}

function formatSize(b) {
  if (b < 1024) return `${b} B`;
  if (b < 1024 ** 2) return `${(b / 1024).toFixed(0)} KB`;
  return `${(b / 1024 ** 2).toFixed(1)} MB`;
}

// Offline notice + a safety net so no error ever fails silently
const syncOnline = () => ($("offline").hidden = navigator.onLine);
window.addEventListener("online", () => { syncOnline(); if (vault) loadFiles({ quiet: true }); });
window.addEventListener("offline", syncOnline);
syncOnline();
window.addEventListener("unhandledrejection", (e) => {
  console.error(e.reason);
  if (vault) toast(friendlyError(e.reason || {}), true);
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
const savedToken = tokenStore.get();
if (savedToken && config.owner) openApp(makeVault(savedToken));
else showLock();
