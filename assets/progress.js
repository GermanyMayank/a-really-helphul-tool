// progress.js
// Pure maths for the upload bar (no DOM, no network).
//
// Every queued file is an item {size, state, sent}:
//   state: waiting | preparing | uploading | saving | done | skipped | failed | cancelled
//   sent:  0..1, how much of this file's request body has gone out
// The bar is weighted by size, so one big PDF doesn't look like "1 of 5".
// Each file also gets a small fixed weight, because every upload is a
// commit that takes a moment even for a tiny file.

const PER_FILE = 16 * 1024;           // weight of the commit itself, in "bytes"
const ETA_AFTER_MS = 2000;            // no time-left guess before this much data

const FINISHED = new Set(["done", "skipped", "failed", "cancelled"]);
export const isFinished = (item) => FINISHED.has(item.state);

/** How far one file is, 0..1. Sending is 0.05-0.95; GitHub saving the commit is the last 5 %. */
export function itemFraction(item) {
  if (isFinished(item)) return 1;
  if (item.state === "saving") return 0.95;
  if (item.state === "uploading") return 0.05 + 0.9 * Math.min(1, Math.max(0, item.sent || 0));
  if (item.state === "preparing") return 0.02;
  return 0;
}

const weight = (item) => Math.max(0, item.size || 0) + PER_FILE;

/**
 * Where the whole session stands.
 * Returns {pct (0-100, whole number), current (1-based), count, done, failed, etaSec|null}
 */
export function sessionProgress(items, startedAt, now = Date.now()) {
  const live = items.filter((i) => i.state !== "cancelled");
  const total = live.reduce((n, i) => n + weight(i), 0);
  const doneW = live.reduce((n, i) => n + weight(i) * itemFraction(i), 0);
  const finished = live.filter(isFinished).length;
  const pct = total ? Math.floor((doneW / total) * 100) : 0;
  return {
    pct: finished === live.length && live.length ? 100 : Math.min(99, pct),
    current: Math.min(live.length, finished + 1),
    count: live.length,
    done: live.filter((i) => i.state === "done" || i.state === "skipped").length,
    failed: live.filter((i) => i.state === "failed").length,
    etaSec: etaSeconds(doneW, total, now - startedAt),
  };
}

/** Seconds left at the current speed, or null while there isn't enough to go on. */
export function etaSeconds(doneBytes, totalBytes, elapsedMs) {
  if (elapsedMs < ETA_AFTER_MS || doneBytes <= 0 || doneBytes >= totalBytes) return null;
  const perMs = doneBytes / elapsedMs;
  return Math.max(1, Math.round((totalBytes - doneBytes) / perMs / 1000));
}

/** 4 -> "a few seconds left", 25 -> "about 25 s left", 130 -> "about 3 min left" */
export function formatEta(sec) {
  if (sec == null) return "";
  if (sec < 5) return "a few seconds left";
  if (sec < 60) return `about ${Math.ceil(sec / 5) * 5} s left`;
  return `about ${Math.round(sec / 60)} min left`;
}

/** The line above the bar. */
export function summaryText(p, finishedSession = false) {
  if (finishedSession) {
    if (p.failed) return `${p.done} uploaded, ${p.failed} failed`;
    return `Uploaded ${p.done} of ${p.count}`;
  }
  const eta = formatEta(p.etaSec);
  return [`Uploading ${p.current} of ${p.count}`, `${p.pct}%`, eta].filter(Boolean).join(" · ");
}
