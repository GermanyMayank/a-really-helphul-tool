// state.js
// Small JSON files in the vault that must sync across devices.
//
//   SyncedFile   the shared engine (load, change, save with conflict retry)
//   SharedState  favourites, in .app/state.json
//                { "version": 1, "favorites": ["files/CV.pdf"] }
//   (clips.js builds the clipboard on the same engine, in .app/clipboard.json)
//
// Both files live outside the documents folder, so they never show up as a
// document.
//
// Every change is an "operation" (a function that edits the data). It is
// applied locally at once (so the UI updates instantly), then saved. If
// another device saved in between (GitHub answers 409/422), we re-read the
// file, apply the same operation again and retry. That way two devices can
// change things at the same time without losing either change. Operations
// must therefore be safe to run twice (add-if-missing, remove-by-id).

export class SyncedFile {
  /**
   * @param vault     Vault instance
   * @param path      file in the vault, e.g. ".app/state.json"
   * @param cacheKey  localStorage key for the offline / instant-start copy
   * @param empty     () => fresh default data
   */
  constructor(vault, path, cacheKey, empty) {
    this.vault = vault;
    this.path = path;
    this.cacheKey = cacheKey;
    this.empty = empty;
    this.sha = null;
    this.data = { ...empty(), ...(readLocal(cacheKey) || {}) };
    this.queue = Promise.resolve();
    this.pending = 0; // local changes not yet saved to GitHub
  }

  /** Fetch the latest from GitHub. */
  async load() {
    const { data, sha } = await this.vault.readJSON(this.path);
    this.data = { ...this.empty(), ...(data || {}) };
    this.sha = sha;
    writeLocal(this.cacheKey, this.data);
    return this.data;
  }

  /**
   * Like load(), but never while one of our own changes is still being
   * saved: that would briefly drop the change from the screen. Returns
   * true if the data was refreshed.
   */
  async refresh() {
    if (this.pending) return false;
    const before = this.sha;
    await this.load();
    if (this.pending) return false;
    return this.sha !== before;
  }

  /** Apply `op` locally now, then save it (queued, with conflict retry). */
  change(op, message) {
    op(this.data);
    writeLocal(this.cacheKey, this.data);
    this.pending++;
    this.queue = this.queue
      .then(() => this.save(op, message))
      .finally(() => { this.pending--; });
    // keep the chain alive for the next change even if this save failed
    const result = this.queue;
    this.queue = this.queue.catch(() => {});
    return result;
  }

  async save(op, message) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        this.sha = await this.vault.writeJSON(this.path, this.data, this.sha, message);
        writeLocal(this.cacheKey, this.data);
        return;
      } catch (e) {
        if (e.status !== 409 && e.status !== 422) throw e;
        await this.load();   // someone else changed it: take theirs...
        op(this.data);       // ...and re-apply ours on top
      }
    }
    throw Object.assign(new Error("Another device kept saving at the same time. Please retry."), { status: 409 });
  }

  /** Forget the local copy (used by the lock button). */
  forgetLocal() {
    clearLocal(this.cacheKey);
  }
}

const STATE_CACHE = "docsync.state.v1";

export class SharedState extends SyncedFile {
  constructor(vault) {
    super(vault, ".app/state.json", STATE_CACHE, () => ({ version: 1, favorites: [] }));
  }

  isFavorite(path) {
    return this.data.favorites.includes(path);
  }

  toggleFavorite(path) {
    const on = !this.isFavorite(path);
    return this.change((s) => {
      s.favorites = s.favorites.filter((p) => p !== path);
      if (on) s.favorites.unshift(path);
    }, `${on ? "Favourite" : "Unfavourite"} ${path.split("/").pop()}`);
  }

  /** Favourite (on) or unfavourite several files in one save. */
  setFavorite(paths, on) {
    return this.change((s) => {
      s.favorites = s.favorites.filter((p) => !paths.includes(p));
      if (on) s.favorites.unshift(...paths);
    }, `${on ? "Favourite" : "Unfavourite"} ${paths.length} file${paths.length === 1 ? "" : "s"}`);
  }

  /** Keep favourites pointing at the right file after a rename / delete. */
  renamePath(oldPath, newPath) {
    if (!this.isFavorite(oldPath)) return Promise.resolve();
    return this.change((s) => { s.favorites = s.favorites.map((p) => (p === oldPath ? newPath : p)); }, "Update favourites");
  }
  forgetPath(path) {
    if (!this.isFavorite(path)) return Promise.resolve();
    return this.change((s) => { s.favorites = s.favorites.filter((p) => p !== path); }, "Update favourites");
  }
}

function readLocal(key) {
  try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
}
function writeLocal(key, data) {
  try { localStorage.setItem(key, JSON.stringify(data)); } catch { /* ignore */ }
}
function clearLocal(key) {
  try { localStorage.removeItem(key); } catch { /* ignore */ }
}
export function clearLocalState() {
  clearLocal(STATE_CACHE);
}
