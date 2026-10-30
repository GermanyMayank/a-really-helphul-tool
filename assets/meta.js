// meta.js
// Works out WHEN and FROM WHERE each file was uploaded, without any database.
//
// Every upload commit is written as "Upload <name> [<device>, <via>]"
// (see github.js upload). To show a file's origin we read the commit history
// of the documents folder and pick the newest "Upload <name>" for each file.
// Files added some other way (e.g. on github.com) fall back to the last commit
// that touched them and show "GitHub" as the source.
//
// Results are cached in localStorage keyed by file path + sha, so after the
// first load only new or changed files cost API calls.

import { parseCommit } from "./organize.js";

const META_KEY = "docsync.meta.v1";
const MAX_PAGES = 5;        // up to 500 commits scanned per refresh
const MAX_SINGLE = 30;      // per-file fallback lookups per refresh

function readMetaCache() {
  try { return JSON.parse(localStorage.getItem(META_KEY)) || {}; } catch { return {}; }
}
function writeMetaCache(cache) {
  try { localStorage.setItem(META_KEY, JSON.stringify(cache)); } catch { /* storage full or blocked */ }
}

/** Origins we already know, without network: {path: {sha, date, device, via}} */
export function cachedMeta() {
  return readMetaCache();
}

/** Save what we know right after this device uploaded a file. */
export function rememberMeta(path, sha, info) {
  const cache = readMetaCache();
  cache[path] = { sha, ...info };
  writeMetaCache(cache);
}

/**
 * Fill in origins for every file in `files` that isn't cached yet.
 * Returns the full meta map (path -> info).
 */
export async function resolveMeta(vault, files) {
  const cache = readMetaCache();
  // forget deleted files
  const live = new Set(files.map((f) => f.path));
  for (const p of Object.keys(cache)) if (!live.has(p)) delete cache[p];

  // A cached entry without a sha (just uploaded) is trusted and gets the real sha.
  for (const f of files) if (cache[f.path] && !cache[f.path].sha) cache[f.path].sha = f.sha;

  const want = new Map(files.filter((f) => cache[f.path]?.sha !== f.sha).map((f) => [f.name, f]));

  // 1. scan the folder history (one call per 100 commits, newest first).
  //    "Rename A -> B": the file now called B was uploaded as A, so keep
  //    looking further back for "Upload A". "Restore A" (back from the
  //    trash) is skipped the same way as "Delete A", so a restored file keeps
  //    the date and device of its original upload.
  for (let page = 1; page <= MAX_PAGES && want.size; page++) {
    const commits = await vault.history(page);
    for (const c of commits) {
      const p = parseCommit(c.message);
      if (p?.action === "Rename" && want.has(p.name)) {
        const f = want.get(p.name);
        want.delete(p.name);
        want.set(p.from, f);
        continue;
      }
      if (p?.action !== "Upload" || !want.has(p.name)) continue;
      const f = want.get(p.name);
      cache[f.path] = { sha: f.sha, date: c.date, device: p.device || "Unknown", via: p.via || "upload" };
      want.delete(p.name);
    }
    if (commits.length < 100) break;
  }

  // 2. anything left: ask for that file's last commit
  const rest = [...want.values()].slice(0, MAX_SINGLE);
  await Promise.all(rest.map(async (f) => {
    const c = await vault.lastCommit(f.path).catch(() => null);
    const p = c && parseCommit(c.message);
    cache[f.path] = { sha: f.sha, date: c?.date || null, device: p?.device || "GitHub", via: p?.via || "upload" };
  }));

  writeMetaCache(cache);
  return cache;
}
