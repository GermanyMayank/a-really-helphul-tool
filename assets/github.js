// github.js
// Thin wrapper around the GitHub REST API. Every document is one file at
// <folder>/<name> in the private vault repo. Nothing else talks to GitHub.
//
//   Contents API  (list, upload, download, delete, small JSON state file)
//     https://docs.github.com/en/rest/repos/contents
//   Git Data API  (rename, move to / restore from the trash, purge: each one
//                  atomic commit that only changes tree entries, no re-upload)
//     https://docs.github.com/en/rest/git

const API = "https://api.github.com";

function tidyListing(items) {
  return (Array.isArray(items) ? items : [])
    .filter((i) => i.type === "file" && i.name !== ".gitkeep")
    .map(({ name, path, sha, size }) => ({ name, path, sha, size }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
}

export class GitHubError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Encode each path segment but keep the slashes.
const encPath = (p) => p.split("/").map(encodeURIComponent).join("/");

// UTF-8 safe base64 for JSON state
const textToB64 = (s) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));

export class Vault {
  constructor({ owner, repo, folder, token }) {
    this.owner = owner;
    this.repo = repo;
    this.folder = folder.replace(/^\/+|\/+$/g, "");
    this.token = token;
    this.branch = null; // default branch, learned in check() or commitTree()
  }

  get repoUrl() {
    return `${API}/repos/${this.owner}/${this.repo}`;
  }

  url(path = "") {
    return `${this.repoUrl}/contents/${encPath(path)}`;
  }

  async request(url, { method = "GET", body, accept = "application/vnd.github+json", etag } = {}) {
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: accept,
        "X-GitHub-Api-Version": "2022-11-28",
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...(etag ? { "If-None-Match": etag } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store",
    });
    if (res.status === 304) return res; // unchanged (conditional request: free, no rate limit used)
    if (!res.ok) {
      let msg = res.statusText;
      try { msg = (await res.json()).message || msg; } catch { /* not json */ }
      const err = new GitHubError(res.status, msg);
      // 403/429 with no requests left = rate limited, not a permission problem
      if ((res.status === 403 || res.status === 429) && res.headers.get("x-ratelimit-remaining") === "0") {
        err.rateLimited = true;
        err.resetAt = Number(res.headers.get("x-ratelimit-reset")) * 1000 || null;
      }
      throw err;
    }
    return res;
  }

  /**
   * Like request(), but with XMLHttpRequest so uploads can report progress
   * (fetch can't). Used for document uploads only. Resolves to the parsed
   * JSON body; rejects with GitHubError, or a DOMException "AbortError".
   */
  send(url, { method, body, onProgress, signal }) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new DOMException("Upload cancelled", "AbortError"));
      const xhr = new XMLHttpRequest();
      xhr.open(method, url);
      xhr.setRequestHeader("Authorization", `Bearer ${this.token}`);
      xhr.setRequestHeader("Accept", "application/vnd.github+json");
      xhr.setRequestHeader("X-GitHub-Api-Version", "2022-11-28");
      xhr.setRequestHeader("Content-Type", "application/json");
      if (onProgress) {
        xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded, e.total); };
        xhr.upload.onload = () => onProgress(1, 1); // every byte is out; GitHub is saving now
      }
      const onAbort = () => xhr.abort();
      signal?.addEventListener("abort", onAbort, { once: true });
      const done = () => signal?.removeEventListener("abort", onAbort);
      xhr.onabort = () => { done(); reject(new DOMException("Upload cancelled", "AbortError")); };
      xhr.onerror = () => { done(); reject(new TypeError("Network error")); };
      xhr.onload = () => {
        done();
        let data = {};
        try { data = JSON.parse(xhr.responseText || "{}"); } catch { /* not json */ }
        if (xhr.status >= 200 && xhr.status < 300) return resolve(data);
        const err = new GitHubError(xhr.status, data.message || xhr.statusText);
        if ((xhr.status === 403 || xhr.status === 429) && xhr.getResponseHeader("x-ratelimit-remaining") === "0") {
          err.rateLimited = true;
          err.resetAt = Number(xhr.getResponseHeader("x-ratelimit-reset")) * 1000 || null;
        }
        reject(err);
      };
      xhr.send(JSON.stringify(body));
    });
  }

  /** Checks the token can see the repo. Throws GitHubError otherwise. */
  async check() {
    const repo = await (await this.request(this.repoUrl)).json();
    this.branch = repo.default_branch || "main";
    this.isPrivate = repo.private;
  }

  /** List documents: [{name, path, sha, size}] sorted by name. */
  async list() {
    return this.listFolder(this.folder);
  }

  /**
   * Has the document list changed since the last call? Uses the listing's
   * ETag, so a "no" answer costs nothing against the API rate limit.
   * Returns the new list, or null when nothing changed.
   */
  async listIfChanged() {
    let res;
    try {
      res = await this.request(this.url(this.folder), { etag: this.listEtag });
    } catch (e) {
      if (e.status === 404) return this.listEtag === "none" ? null : ((this.listEtag = "none"), []);
      throw e;
    }
    if (res.status === 304) return null;
    this.listEtag = res.headers.get("ETag") || null;
    return tidyListing(await res.json());
  }

  /** Files directly in one folder of the vault, sorted by name. Missing folder = []. */
  async listFolder(folder) {
    try {
      const res = await this.request(this.url(folder));
      if (folder === this.folder) this.listEtag = res.headers.get("ETag") || null;
      return tidyListing(await res.json());
    } catch (e) {
      if (e.status === 404) return []; // folder not created yet = no files
      throw e;
    }
  }

  /** Download a document as a Blob (works up to 100 MB). */
  async download(path) {
    const res = await this.request(this.url(path), { accept: "application/vnd.github.raw+json" });
    return res.blob();
  }

  /**
   * Upload a new document. If the name is taken, adds " (2)", " (3)" ...
   * `tag` goes into the commit message so other devices can show where the
   * file came from: "Upload CV.pdf [iPhone, upload]". See organize.parseCommit.
   * `onProgress(loaded, total)` reports the bytes sent; `signal` cancels.
   * Returns {name, path, sha} of the saved file.
   */
  async upload(name, base64, tag = "", { onProgress, signal } = {}) {
    const dot = name.lastIndexOf(".");
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : "";
    for (let n = 1; n < 100; n++) {
      const candidate = n === 1 ? name : `${stem} (${n})${ext}`;
      const path = `${this.folder}/${candidate}`;
      try {
        const data = await this.send(this.url(path), {
          method: "PUT",
          body: { message: `Upload ${candidate}${tag ? ` [${tag}]` : ""}`, content: base64 },
          onProgress,
          signal,
        });
        return { name: candidate, path, sha: data.content?.sha || null };
      } catch (e) {
        // 422 = file exists (no sha given). Try the next name.
        if (e.status !== 422) throw e;
      }
    }
    throw new Error("Too many files with the same name");
  }

  /** Delete a document. */
  async remove(path, sha, tag = "") {
    await this.request(this.url(path), {
      method: "DELETE",
      body: { message: `Delete ${path.split("/").pop()}${tag ? ` [${tag}]` : ""}`, sha },
    });
  }

  /**
   * Rename without re-uploading: one commit that points the new path at the
   * same blob and removes the old path. Returns {name, path, sha}.
   */
  async rename(oldPath, sha, newName, tag = "") {
    const newPath = `${this.folder}/${newName}`;
    await this.commitTree(
      [
        { path: newPath, mode: "100644", type: "blob", sha },
        { path: oldPath, mode: "100644", type: "blob", sha: null },
      ],
      `Rename ${oldPath.split("/").pop()} -> ${newName}${tag ? ` [${tag}]` : ""}`
    );
    return { name: newName, path: newPath, sha };
  }

  /** Undo a delete: git keeps the old blob, so we just point the path at it again. */
  async restore(path, sha, tag = "") {
    await this.commitTree([{ path, mode: "100644", type: "blob", sha }], `Upload ${path.split("/").pop()}${tag ? ` [${tag}]` : ""}`);
  }

  /**
   * Move a document to the trash: one commit that points `trashPath` at the
   * same blob and removes the document. The commit message keeps the
   * "Delete <name>" contract, so meta.js and the history read the same.
   */
  async moveToTrash(path, sha, trashPath, tag = "") {
    await this.commitTree(
      [
        { path: trashPath, mode: "100644", type: "blob", sha },
        { path, mode: "100644", type: "blob", sha: null },
      ],
      `Delete ${path.split("/").pop()}${tag ? ` [${tag}]` : ""}`
    );
  }

  /**
   * Bring a file back from the trash as <folder>/<name>. The message is
   * "Restore <name>", which meta.js skips, so the file keeps its original
   * upload date and device. Returns {name, path, sha}.
   */
  async restoreFromTrash(trashPath, sha, name, tag = "") {
    const path = `${this.folder}/${name}`;
    await this.commitTree(
      [
        { path, mode: "100644", type: "blob", sha },
        { path: trashPath, mode: "100644", type: "blob", sha: null },
      ],
      `Restore ${name}${tag ? ` [${tag}]` : ""}`
    );
    return { name, path, sha };
  }

  /** Move several documents to the trash in one commit. items: [{path, sha, trashPath}] */
  async moveManyToTrash(items, tag = "") {
    const n = items.length;
    await this.commitTree(
      items.flatMap(({ path, sha, trashPath }) => [
        { path: trashPath, mode: "100644", type: "blob", sha },
        { path, mode: "100644", type: "blob", sha: null },
      ]),
      n === 1 ? `Delete ${items[0].path.split("/").pop()}${tag ? ` [${tag}]` : ""}` : `Delete ${n} files${tag ? ` [${tag}]` : ""}\n\n${items.map((i) => `Delete ${i.path.split("/").pop()}`).join("\n")}`
    );
  }

  /** Bring several files back from the trash in one commit. items: [{trashPath, sha, name}] */
  async restoreMany(items, tag = "") {
    await this.commitTree(
      items.flatMap(({ trashPath, sha, name }) => [
        { path: `${this.folder}/${name}`, mode: "100644", type: "blob", sha },
        { path: trashPath, mode: "100644", type: "blob", sha: null },
      ]),
      items.length === 1 ? `Restore ${items[0].name}${tag ? ` [${tag}]` : ""}` : `Restore ${items.length} files${tag ? ` [${tag}]` : ""}`
    );
    return items.map(({ name, sha }) => ({ name, path: `${this.folder}/${name}`, sha }));
  }

  /** Remove trash entries for good, all in one commit. */
  async purge(paths, message) {
    if (!paths.length) return;
    await this.commitTree(paths.map((path) => ({ path, mode: "100644", type: "blob", sha: null })), message);
  }

  /** Make one commit on the default branch that changes the given tree entries. */
  async commitTree(entries, message, retry = true) {
    if (!this.branch) await this.check();
    const refUrl = `${this.repoUrl}/git/refs/heads/${encodeURIComponent(this.branch)}`;
    const ref = await (await this.request(`${this.repoUrl}/git/ref/heads/${encodeURIComponent(this.branch)}`)).json();
    const head = await (await this.request(`${this.repoUrl}/git/commits/${ref.object.sha}`)).json();
    const tree = await (await this.request(`${this.repoUrl}/git/trees`, { method: "POST", body: { base_tree: head.tree.sha, tree: entries } })).json();
    const commit = await (await this.request(`${this.repoUrl}/git/commits`, { method: "POST", body: { message, tree: tree.sha, parents: [ref.object.sha] } })).json();
    try {
      await this.request(refUrl, { method: "PATCH", body: { sha: commit.sha } });
    } catch (e) {
      // 422 = someone else committed in between; start again once
      if (e.status === 422 && retry) return this.commitTree(entries, message, false);
      throw e;
    }
  }

  /** Read a small JSON file outside the documents folder: {data, sha} or {data: null}. */
  async readJSON(path) {
    try {
      // The default JSON response has the content (base64) and the sha we need to update it later
      const file = await (await this.request(this.url(path))).json();
      const bytes = Uint8Array.from(atob(file.content.replace(/\s/g, "")), (c) => c.charCodeAt(0));
      return { data: JSON.parse(new TextDecoder().decode(bytes)), sha: file.sha };
    } catch (e) {
      if (e.status === 404) return { data: null, sha: null };
      throw e;
    }
  }

  /** Create or replace a small JSON file. Returns the new sha. Throws 409/422 on conflict. */
  async writeJSON(path, data, sha, message) {
    const res = await this.request(this.url(path), {
      method: "PUT",
      body: { message, content: textToB64(JSON.stringify(data, null, 2) + "\n"), ...(sha ? { sha } : {}) },
    });
    return (await res.json()).content?.sha || null;
  }

  /** One page (100) of commits touching the documents folder, newest first: [{message, date}]. */
  async history(page = 1) {
    const q = `path=${encodeURIComponent(this.folder)}&per_page=100&page=${page}`;
    const res = await this.request(`${this.repoUrl}/commits?${q}`);
    return (await res.json()).map(simplifyCommit);
  }

  /** Latest commit that touched one file: {message, date} or null. */
  async lastCommit(path) {
    const q = `path=${encodeURIComponent(path)}&per_page=1`;
    const res = await this.request(`${this.repoUrl}/commits?${q}`);
    const [c] = await res.json();
    return c ? simplifyCommit(c) : null;
  }
}

const simplifyCommit = (c) => ({
  message: c.commit?.message || "",
  date: c.commit?.committer?.date || c.commit?.author?.date || null,
});
