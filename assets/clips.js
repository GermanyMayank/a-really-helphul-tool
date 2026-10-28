// clips.js
// The shared clipboard: short texts and links you want on another device.
// Copy on the laptop, open the app on the phone, tap Copy. Stored in the
// vault at .app/clipboard.json (private, like your documents):
//
//   { "version": 1,
//     "items": [ { "id": "k3x9…", "text": "https://…", "at": "2026-10-28T09:12:00Z", "device": "Windows PC" } ] }
//
// Newest first. Built on SyncedFile (state.js), so two devices adding a clip
// at the same moment both survive.

import { SyncedFile } from "./state.js";

export const MAX_CLIPS = 50;          // oldest fall off the end
export const MAX_CLIP_CHARS = 10000;  // keeps the file small and fast on phones
const CACHE_KEY = "docsync.clips.v1";

export class Clipboard extends SyncedFile {
  constructor(vault) {
    super(vault, ".app/clipboard.json", CACHE_KEY, () => ({ version: 1, items: [] }));
  }

  get items() {
    return Array.isArray(this.data.items) ? this.data.items : [];
  }

  /** Add a clip. Returns {item, save}; save is the promise of the GitHub write. */
  add(text, device) {
    const clean = normalizeClip(text);
    if (!clean) throw new Error("Nothing to save. Type or paste some text first.");
    if (clean.length > MAX_CLIP_CHARS) {
      throw new Error(`That's too long for the clipboard (max ${MAX_CLIP_CHARS.toLocaleString("en-GB")} characters). Save it as a document instead.`);
    }
    // Same text again? Move it to the top instead of storing it twice.
    const twin = this.items.find((i) => i.text === clean);
    const item = { id: newId(), text: clean, at: new Date().toISOString(), device };
    const save = this.change((s) => {
      s.items = Array.isArray(s.items) ? s.items : [];
      if (s.items.some((i) => i.id === item.id)) return;      // already applied
      s.items = s.items.filter((i) => i.text !== clean);       // de-duplicate
      s.items.unshift(item);
      s.items = s.items.slice(0, MAX_CLIPS);
    }, `${twin ? "Re-send" : "Add"} clip [${device}]`);
    return { item, save };
  }

  remove(id, device) {
    return this.change((s) => {
      s.items = (s.items || []).filter((i) => i.id !== id);
    }, `Delete clip [${device}]`);
  }

  /** Put deleted clips back where they were (Undo). entries: [{item, index}] */
  restore(entries, device) {
    const sorted = [...entries].sort((a, b) => a.index - b.index);
    return this.change((s) => {
      s.items = s.items || [];
      for (const { item, index } of sorted) {
        if (s.items.some((i) => i.id === item.id)) continue;
        s.items.splice(Math.min(index, s.items.length), 0, item);
      }
      s.items = s.items.slice(0, MAX_CLIPS);
    }, `Restore clip${entries.length > 1 ? "s" : ""} [${device}]`);
  }

  /** Remove the clips shown right now (not ones another device adds meanwhile). */
  clear(device) {
    const ids = new Set(this.items.map((i) => i.id));
    return this.change((s) => {
      s.items = (s.items || []).filter((i) => !ids.has(i.id));
    }, `Clear clipboard [${device}]`);
  }
}

// ---------------------------------------------------------------------------
// Pure helpers (no DOM, no network): unit-tested in tests/e2e.mjs
// ---------------------------------------------------------------------------

/** Trim outer whitespace and unify line endings; keep inner formatting. */
export function normalizeClip(text) {
  return String(text ?? "").replace(/\r\n?/g, "\n").replace(/^\s+|\s+$/g, "");
}

/**
 * If the whole clip is one web link, return it as a safe URL string.
 * Only http(s): a clip like "javascript:…" must never become a link.
 */
export function clipLink(text) {
  const t = normalizeClip(text);
  if (!t || /\s/.test(t)) return null;
  const candidate = /^www\./i.test(t) ? `https://${t}` : t;
  try {
    const u = new URL(candidate);
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : null;
  } catch {
    return null;
  }
}

/**
 * Split a clip into plain text and links, so every web address in it can be
 * tapped, also inside a sentence: "see https://x.com, thanks" ->
 *   [{text:"see "}, {text:"https://x.com", href:"https://x.com/"}, {text:", thanks"}]
 * Only http(s) and www. addresses become links; trailing punctuation stays text.
 */
export function linkParts(text) {
  const parts = [];
  const re = /(?:https?:\/\/|www\.)[^\s<>"']+/gi;
  let last = 0, m;
  while ((m = re.exec(text))) {
    let url = m[0];
    // "(see https://x.com/a)." -> keep ")." outside the link, but keep balanced (...) inside
    while (/[.,;:!?)\]}'"]$/.test(url)) {
      if (url.endsWith(")") && (url.match(/\(/g) || []).length >= (url.match(/\)/g) || []).length) break;
      url = url.slice(0, -1);
    }
    const href = clipLink(url);
    if (!href) continue;
    if (m.index > last) parts.push({ text: text.slice(last, m.index) });
    parts.push({ text: url, href });
    last = m.index + url.length;
    re.lastIndex = last;
  }
  if (last < text.length) parts.push({ text: text.slice(last) });
  return parts;
}

/** "just now", "5 min ago", "3 h ago", "Yesterday 14:05", "12 Oct". */
export function clipAge(iso, now = new Date()) {
  if (!iso) return "";
  const d = new Date(iso);
  const secs = Math.round((now - d) / 1000);
  if (secs < 45) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 12 && d.toDateString() === now.toDateString()) return `${hours} h ago`;
  const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  if (d.toDateString() === now.toDateString()) return `Today ${time}`;
  if (d.toDateString() === new Date(now.getTime() - 864e5).toDateString()) return `Yesterday ${time}`;
  const opts = { day: "numeric", month: "short" };
  if (d.getFullYear() !== now.getFullYear()) opts.year = "numeric";
  return d.toLocaleDateString("en-GB", opts);
}

function newId() {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return [...bytes].map((b) => b.toString(36).padStart(2, "0")).join("").slice(0, 12);
}

export function clearLocalClips() {
  try { localStorage.removeItem(CACHE_KEY); } catch { /* ignore */ }
}
