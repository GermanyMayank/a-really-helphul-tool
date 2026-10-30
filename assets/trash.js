// trash.js
// Pure helpers for the Trash (no DOM, no network).
//
// Deleting a document moves it to .trash/<stamp>__<name> in the vault with
// one Git Data API commit (no re-upload). The stamp is the deletion time in
// UTC, so the trash needs no index file: the folder listing alone says what
// was deleted and when. Anything older than TRASH_DAYS is removed for good
// the next time a device looks at the trash.

export const TRASH_FOLDER = ".trash";
export const TRASH_DAYS = 30;
const DAY = 864e5;

const pad = (n, w = 2) => String(n).padStart(w, "0");

/** "Passport.pdf" -> "20261030-101500-123__Passport.pdf" (UTC deletion time) */
export function trashName(name, date = new Date()) {
  const d = date;
  const stamp = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-` +
    `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}-${pad(d.getUTCMilliseconds(), 3)}`;
  return `${stamp}__${name}`;
}

/** "20261030-101500-123__Passport.pdf" -> {name: "Passport.pdf", deletedAt: Date} or null */
export function parseTrashName(fileName) {
  const m = String(fileName).match(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-(\d{3})__(.+)$/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, ms, name] = m;
  const deletedAt = new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s, +ms));
  if (isNaN(deletedAt)) return null;
  return { name, deletedAt };
}

/** Whole days since the file was deleted. */
export function daysAgo(deletedAt, now = new Date()) {
  return Math.max(0, Math.floor((now.getTime() - deletedAt.getTime()) / DAY));
}

/** Days until the file is removed for good: 30 on the day it was deleted, 1 on the last day. */
export function daysLeft(deletedAt, now = new Date()) {
  return Math.max(0, TRASH_DAYS - daysAgo(deletedAt, now));
}

export function isExpired(deletedAt, now = new Date()) {
  return now.getTime() - deletedAt.getTime() >= TRASH_DAYS * DAY;
}

/** "Deleted today · 30 days left" */
export function trashLabel(deletedAt, now = new Date()) {
  const ago = daysAgo(deletedAt, now);
  const when = ago === 0 ? "Deleted today" : ago === 1 ? "Deleted yesterday" : `Deleted ${ago} days ago`;
  const left = daysLeft(deletedAt, now);
  return `${when} · ${left <= 1 ? "last day" : `${left} days left`}`;
}

/** A name not in `taken`: "a.pdf", else "a (2).pdf", "a (3).pdf" ... */
export function freeName(name, taken) {
  if (!taken.has(name)) return name;
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  for (let n = 2; ; n++) {
    const candidate = `${stem} (${n})${ext}`;
    if (!taken.has(candidate)) return candidate;
  }
}
