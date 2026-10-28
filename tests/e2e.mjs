// End-to-end test with a fake GitHub API (no real token needed).
//   1. start a static server:   python3 -m http.server 8080
//   2. run:                      npm test
// Uses Playwright (npm i -D playwright, then npx playwright install chromium).
// Screenshots are written to tests/screenshots/.

import { chromium, devices } from "playwright";
import { mkdirSync } from "fs";
import { createHash } from "crypto";
import * as org from "../assets/organize.js";
import * as clipsLib from "../assets/clips.js";

const BASE = process.env.BASE || "http://localhost:8080";
const SHOTS = new URL("./screenshots/", import.meta.url).pathname;
mkdirSync(SHOTS, { recursive: true });

const assert = (cond, msg) => { if (!cond) throw new Error("FAIL: " + msg); console.log("ok -", msg); };
// Any Content-Security-Policy violation or page error fails the run at the end
const problems = [];
const watch = (p) => {
  p.on("pageerror", (e) => problems.push("page error: " + e.message));
  p.on("console", (m) => { if (/Content Security Policy|Refused to/i.test(m.text())) problems.push("CSP: " + m.text()); });
};

// ---------------------------------------------------------------- unit checks
assert(org.categorize("Arbeitszeugnis_attocube.pdf").id === "work", "categorize: longest keyword wins (Arbeitszeugnis -> Work)");
assert(org.categorize("Mietvertrag Karlsfeld.pdf").id === "home", "categorize: German compound (Mietvertrag -> Home)");
assert(org.categorize("idea.txt").id === "other", "categorize: short keyword 'id' does not match 'idea'");
assert(org.categorize("IMG_1234.HEIC").id === "photos", "categorize: unknown images -> Photos");
assert(org.parseCommit("Upload a [1].pdf [Mac, drop]").name === "a [1].pdf", "parseCommit: brackets inside the name");
assert(org.parseCommit("Rename a.pdf -> b.pdf [Mac]").from === "a.pdf", "parseCommit: rename");
assert(org.thisDevice("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", 5) === "iPad", "thisDevice: iPadOS desktop UA -> iPad");
const SAFARI = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1";
const CHROME_ANDROID = "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/126.0 Mobile Safari/537.36";
assert(org.canPreview("a.heic", SAFARI) && !org.canPreview("a.heic", CHROME_ANDROID), "canPreview: HEIC only in Safari");
assert(!org.canPreview("a.pdf", CHROME_ANDROID) && !org.canPreview("a.docx", SAFARI), "canPreview: no PDF on Android, no Word anywhere");
assert(clipsLib.clipLink("https://example.com/a?b=1") === "https://example.com/a?b=1", "clipLink: a web link is a link");
assert(clipsLib.clipLink("www.attocube.com") === "https://www.attocube.com/", "clipLink: www. gets https://");
assert(clipsLib.clipLink("javascript:alert(1)") === null && clipsLib.clipLink("see https://x.com") === null, "clipLink: no javascript: links, no links inside sentences");
assert(JSON.stringify(clipsLib.linkParts("see https://x.com/a, thanks")) === JSON.stringify([{ text: "see " }, { text: "https://x.com/a", href: "https://x.com/a" }, { text: ", thanks" }]), "linkParts: a link inside a sentence, trailing comma stays text");
assert(clipsLib.linkParts("Termin (www.berlin.de/amt).")[1]?.href === "https://www.berlin.de/amt", "linkParts: www. link inside brackets gets https://");
assert(clipsLib.linkParts("https://en.wikipedia.org/wiki/Foo_(bar)")[0].href.endsWith("Foo_(bar)"), "linkParts: balanced brackets stay in the link");
assert(clipsLib.linkParts("javascript:alert(1) and ftp://x").every((p) => !p.href), "linkParts: only http(s) and www. become links");
assert(clipsLib.normalizeClip("  \r\n line 1\r\nline 2 \n") === "line 1\nline 2", "normalizeClip: trims and unifies line endings");
const NOW = new Date("2026-10-28T12:00:00Z");
assert(clipsLib.clipAge("2026-10-28T11:59:40Z", NOW) === "just now" && clipsLib.clipAge("2026-10-28T11:55:00Z", NOW) === "5 min ago", "clipAge: just now, minutes");

// ---------------------------------------------------------------- fake GitHub
// Behaves like the real API for everything the app uses, including real git
// blob shas (so duplicate detection works) and the Git Data API (rename/undo).
const OWNER = "tester", REPO = "docsync-vault", TOKEN = "github_pat_TEST";
const gitSha = (buf) => createHash("sha1").update(Buffer.concat([Buffer.from(`blob ${buf.length}\0`), buf])).digest("hex");
const blobs = new Map();   // sha -> buf (git never forgets a blob)
const vault = new Map();   // path -> {buf, sha}  (the current tree)
const commits = [];        // newest first: {path, message, date}
const trees = new Map();   // pending tree sha -> Map(path -> sha|null)
const gitCommits = new Map(); // commit sha -> tree sha
let head = "c0", seq = 0;
const daysAgo = (d) => new Date(Date.now() - d * 864e5).toISOString();
function setFile(path, buf) { const sha = gitSha(buf); blobs.set(sha, buf); vault.set(path, { buf, sha }); return sha; }
function seed(name, buf, message, date) { setFile("files/" + name, buf); commits.unshift({ path: "files/" + name, message, date }); }

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
seed("Lebenslauf.docx", Buffer.alloc(48000), "Add files via upload", daysAgo(40));          // added on github.com
seed("notes.txt", Buffer.from("Hello from the tool\nLine 2"), "Upload notes.txt [Mac, drop]", daysAgo(10));
seed("passport-scan.png", PNG, "Upload passport-scan.png [iPhone, share]", daysAgo(2));
const SEEDED = new Map([...vault].map(([p, f]) => [p, f.buf]));

let stateWrites = 0;
let publicVault = false;
async function mockGitHub(context) {
  await context.route("https://api.github.com/**", async (route) => {
    const req = route.request();
    const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "*" };
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    const json = (status, body) => route.fulfill({ status, headers: { ...cors, "content-type": "application/json" }, body: JSON.stringify(body) });

    if (req.headers()["authorization"] !== `Bearer ${TOKEN}`) return json(401, { message: "Bad credentials" });
    const url = new URL(req.url());
    const base = `/repos/${OWNER}/${REPO}`;
    const m = req.method();
    const sub = url.pathname.slice(base.length);
    if (sub === "") return json(200, { name: REPO, private: !publicVault, default_branch: "main" });

    // ----- commits list
    if (sub === "/commits") {
      const p = url.searchParams.get("path");
      const per = +url.searchParams.get("per_page") || 30, page = +url.searchParams.get("page") || 1;
      const list = commits.filter((c) => c.path === p || c.path.startsWith(p + "/")).slice((page - 1) * per, page * per);
      return json(200, list.map((c, i) => ({ sha: "c" + i, commit: { message: c.message, committer: { date: c.date } } })));
    }

    // ----- Git Data API
    if (sub === "/git/ref/heads/main") return json(200, { object: { sha: head } });
    if (sub.startsWith("/git/commits/") && m === "GET") return json(200, { tree: { sha: "t-" + sub.split("/").pop() } });
    if (sub === "/git/trees" && m === "POST") {
      const { tree } = req.postDataJSON();
      const sha = "t" + ++seq;
      trees.set(sha, new Map(tree.map((e) => [e.path, e.sha])));
      return json(201, { sha });
    }
    if (sub === "/git/commits" && m === "POST") {
      const { tree, message, parents } = req.postDataJSON();
      if (parents[0] !== head) return json(422, { message: "stale parent" });
      const sha = "c" + ++seq;
      gitCommits.set(sha, { tree, message });
      return json(201, { sha });
    }
    if (sub === "/git/refs/heads/main" && m === "PATCH") {
      const { sha } = req.postDataJSON();
      const c = gitCommits.get(sha);
      for (const [path, blobSha] of trees.get(c.tree)) {
        if (blobSha === null) vault.delete(path);
        else vault.set(path, { buf: blobs.get(blobSha), sha: blobSha });
        commits.unshift({ path, message: c.message, date: new Date().toISOString() });
      }
      head = sha;
      return json(200, { object: { sha } });
    }

    // ----- Contents API
    if (!sub.startsWith("/contents/")) return json(404, { message: "Not Found" });
    const path = decodeURIComponent(sub.slice("/contents/".length));
    const raw = (req.headers()["accept"] || "").includes("raw");

    if (m === "GET" && path === "files") {
      const items = [...vault].filter(([p]) => p.startsWith("files/")).map(([p, f]) => ({ type: "file", name: p.split("/").pop(), path: p, sha: f.sha, size: f.buf.length }));
      return items.length ? json(200, items) : json(404, { message: "Not Found" });
    }
    if (m === "GET") {
      const f = vault.get(path);
      if (!f) return json(404, { message: "Not Found" });
      if (raw) return route.fulfill({ status: 200, headers: cors, body: f.buf });
      return json(200, { type: "file", path, sha: f.sha, content: f.buf.toString("base64") });
    }
    if (m === "PUT") {
      const { content, message, sha } = req.postDataJSON();
      const existing = vault.get(path);
      if (existing && !sha) return json(422, { message: '"sha" wasn\'t supplied.' });
      if (existing && sha !== existing.sha) return json(409, { message: "conflict" });
      if (path.startsWith(".app/")) stateWrites++;
      const newSha = setFile(path, Buffer.from(content, "base64"));
      if (path.startsWith("files/")) commits.unshift({ path, message, date: new Date().toISOString() });
      return json(201, { content: { path, sha: newSha } });
    }
    if (m === "DELETE") {
      const { sha, message } = req.postDataJSON();
      if (vault.get(path)?.sha !== sha) return json(409, { message: "sha mismatch" });
      vault.delete(path);
      commits.unshift({ path, message, date: new Date().toISOString() });
      return json(200, {});
    }
    return json(405, { message: "nope" });
  });
}
const lastMessage = (name) => commits.find((c) => c.path === "files/" + name)?.message || "";
// Wait (in Node) until the fake vault reaches a state
const until = async (cond, ms = 8000) => { const end = Date.now() + ms; while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 50)); };
const favorites = () => JSON.parse(vault.get(".app/state.json")?.buf.toString() || '{"favorites":[]}').favorites;
const clipItems = () => JSON.parse(vault.get(".app/clipboard.json")?.buf.toString() || '{"items":[]}').items;
// Another device saving a clip (written straight into the fake vault)
let remoteSeq = 0;
const remoteClip = (text, device = "Windows PC") => {
  const items = [{ id: "remote" + ++remoteSeq, text, at: new Date().toISOString(), device }, ...clipItems()];
  setFile(".app/clipboard.json", Buffer.from(JSON.stringify({ version: 1, items })));
};

// CHROMIUM_PATH lets you test with a Chromium you already have installed
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});

// ---------------------------------------------------------------- setup page
const ctx = await browser.newContext();
await mockGitHub(ctx);
const page = await ctx.newPage();
watch(page);
await page.goto(`${BASE}/setup.html`);
await page.fill("#owner", OWNER);
await page.fill("#token", "wrong");
await page.fill("#pw", "blue tram to Karlsfeld 42");
await page.fill("#pw2", "blue tram to Karlsfeld 42");
await page.click("#go");
await page.waitForFunction(() => document.getElementById("err").textContent.length > 0);
assert(/not valid/.test(await page.textContent("#err")), "setup rejects a bad token");
await page.fill("#token", TOKEN);
publicVault = true;
await page.click("#go");
await page.waitForFunction(() => /is public/.test(document.getElementById("err").textContent), null, { timeout: 15000 });
assert(true, "setup refuses a PUBLIC vault repo");
publicVault = false;
await page.fill("#pw", "password123");
await page.fill("#pw2", "password123");
await page.click("#go");
await page.waitForFunction(() => /stronger password/.test(document.getElementById("err").textContent));
assert(true, "setup refuses a weak password");
await page.fill("#pw", "blue tram to Karlsfeld 42");
await page.fill("#pw2", "blue tram to Karlsfeld 42");
await page.click("#go");
await page.waitForSelector("#result:not([hidden])", { timeout: 30000 });
const configText = await page.inputValue("#out");
assert(configText.includes("encryptedToken") && !configText.includes(TOKEN), "config is generated and does not contain the raw token");
await page.screenshot({ path: SHOTS + "setup.png", fullPage: true });
await ctx.close();

const PASSWORD = "blue tram to Karlsfeld 42";
const names = (p) => p.$$eval(".file-name", (els) => els.map((e) => e.textContent));
const search = async (p, q) => { await p.fill("#search", q); await p.waitForTimeout(250); return names(p); };
const row = (p, n) => p.locator(".file", { hasText: n }).first();
const menuAction = async (p, n, act) => { await row(p, n).getByLabel("More options").click(); await p.click(`#menu [data-act="${act}"]`); };

// ---------------------------------------------------------------- app: desktop + iPhone
for (const [label, opts, device] of [
  ["desktop", { viewport: { width: 1280, height: 860 } }, "Linux PC"],
  ["iphone", devices["iPhone 13"], "iPhone"],
]) {
  const c = await browser.newContext({ ...opts, acceptDownloads: true });
  await c.grantPermissions(["clipboard-read", "clipboard-write"], { origin: BASE }).catch(() => {});
  await mockGitHub(c);
  await c.route(`${BASE}/config.js*`, (r) => r.fulfill({ status: 200, contentType: "text/javascript", body: configText }));
  const p = await c.newPage();
  watch(p);
  await p.goto(BASE + "/");
  await p.waitForSelector("#lock:not([hidden])");
  assert((await p.title()) === "a really helpful tool", `${label}: app is called "a really helpful tool"`);
  await p.screenshot({ path: SHOTS + `${label}-1-lock.png` });

  await p.fill("#lock-input", "wrong password");
  await p.click("#lock-btn");
  await p.waitForFunction(() => document.getElementById("lock-error").textContent.length > 0, null, { timeout: 30000 });
  assert((await p.textContent("#lock-error")).includes("Wrong password"), `${label}: wrong password rejected`);

  await p.fill("#lock-input", PASSWORD);
  await p.click("#lock-btn");
  await p.waitForSelector("#app:not([hidden]) .file", { timeout: 30000 });
  assert((await p.locator(".file").count()) === 3, `${label}: lists 3 files`);

  // origins
  await p.waitForFunction(() => document.body.innerText.includes("GitHub"), null, { timeout: 10000 });
  assert((await row(p, "passport").innerText()).includes("iPhone"), `${label}: passport shows "iPhone"`);
  assert((await row(p, "Lebenslauf").innerText()).includes("GitHub"), `${label}: file added on github.com shows "GitHub"`);

  // upload + duplicate name + duplicate content
  await p.setInputFiles("#file-input", [
    { name: "Offer Letter.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4 fake") },
    { name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("second notes") },
    { name: "passport-copy.png", mimeType: "image/png", buffer: PNG },
  ]);
  await p.waitForFunction(() => document.querySelectorAll(".file").length === 5, null, { timeout: 15000 });
  assert(vault.has("files/notes (2).txt"), `${label}: duplicate name saved as "notes (2).txt"`);
  assert(!vault.has("files/passport-copy.png"), `${label}: identical file is not uploaded twice`);
  assert((await p.textContent("#queue")).includes("Already saved as passport-scan.png"), `${label}: says where the identical file already is`);
  assert(lastMessage("Offer Letter.pdf") === `Upload Offer Letter.pdf [${device}, upload]`, `${label}: commit message records device "${device}"`);

  // drop anywhere + paste
  await p.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(["rent"], "Mietvertrag.pdf", { type: "application/pdf" }));
    window.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
  });
  await p.waitForFunction(() => document.querySelectorAll(".file").length === 6, null, { timeout: 15000 });
  assert(lastMessage("Mietvertrag.pdf").endsWith("drop]"), `${label}: drop anywhere uploads`);
  await p.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(["png-bytes-" + Math.random()], "image.png", { type: "image/png" }));
    document.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  await p.waitForFunction(() => document.querySelectorAll(".file").length === 7, null, { timeout: 15000 });
  assert([...vault.keys()].some((k) => k.startsWith("files/Screenshot ")), `${label}: paste uploads a screenshot with a useful name`);

  // favourites: heart, synced to .app/state.json, pinned on top, chip
  await row(p, "Lebenslauf").getByLabel("Add to favourites").click({ force: true });
  await p.waitForFunction(() => document.querySelector(".file .heart[aria-pressed=true]"));
  await p.waitForTimeout(400);
  assert(favorites().includes("files/Lebenslauf.docx"), `${label}: favourite saved to the vault (syncs to other devices)`);
  assert((await names(p))[0] === "Lebenslauf.docx", `${label}: favourites pinned to the top`);
  assert(await p.isVisible("#favs") && (await p.locator(".fav-card .fav-name").allTextContents()).join() === "Lebenslauf.docx", `${label}: favourites show as cards above the list`);
  await p.locator(".chip", { hasText: "Favourites" }).click();
  assert(JSON.stringify(await names(p)) === '["Lebenslauf.docx"]', `${label}: Favourites chip`);
  assert(await p.isHidden("#favs"), `${label}: favourite cards only on the All view`);
  await p.locator(".chip", { hasText: "All" }).click();
  await p.screenshot({ path: SHOTS + `${label}-2-list.png`, fullPage: true });

  // search still smart
  assert(JSON.stringify(await search(p, "pasport")) === '["passport-scan.png"]', `${label}: search forgives typos`);
  await search(p, "");

  // tap a previewable file -> instant preview; tap a Word file -> actions menu
  await row(p, "notes.txt").locator(".file-main").click();
  await p.waitForSelector("#preview-body pre");
  assert((await p.textContent("#preview-body pre")).includes("Hello from the tool"), `${label}: text preview`);
  await p.keyboard.press("Escape");
  await row(p, "Lebenslauf").locator(".file-main").click();
  await p.waitForSelector("#menu:not([hidden])");
  assert(await p.isHidden('#menu [data-act="preview"]'), `${label}: Word file opens the menu, no preview option`);
  await p.screenshot({ path: SHOTS + `${label}-3-menu.png` });
  await p.keyboard.press("Escape");

  // second open of the image comes from cache: no spinner, no network
  await row(p, "passport-scan").locator(".file-main").click();
  await p.waitForSelector("#preview-body img");
  await p.click("#preview [data-close]");
  let downloads = 0;
  p.on("request", (r) => { if (r.url().includes("contents/files/passport")) downloads++; });
  await row(p, "passport-scan").locator(".file-main").click();
  await p.waitForSelector("#preview-body img");
  assert(downloads === 0 && !(await p.$("#preview-body .loading")), `${label}: reopening a file is instant (cached)`);
  await p.screenshot({ path: SHOTS + `${label}-4-preview.png` });

  // copy image to clipboard (desktop Chromium supports image clipboard)
  if (label === "desktop") {
    await p.click("#preview-copy");
    await p.waitForFunction(() => document.getElementById("toast-text").textContent.includes("copied"), null, { timeout: 5000 });
    const types = await p.evaluate(async () => (await navigator.clipboard.read())[0].types);
    assert(types.includes("image/png"), "desktop: image copied to clipboard as PNG");
  }
  await p.click("#preview [data-close]");

  // rename (one commit, keeps origin + favourite)
  await menuAction(p, "Lebenslauf", "rename");
  await p.waitForSelector("#rename:not([hidden])");
  await p.waitForTimeout(100);
  assert(await p.evaluate(() => document.getElementById("rename-input").selectionEnd === "Lebenslauf".length), `${label}: rename selects the name, not the extension`);
  await p.fill("#rename-input", "CV Jay Gohil");
  await p.click("#rename-ok");
  await p.waitForFunction(() => [...document.querySelectorAll(".file-name")].some((e) => e.textContent === "CV Jay Gohil.docx"));
  assert(vault.has("files/CV Jay Gohil.docx") && !vault.has("files/Lebenslauf.docx"), `${label}: rename keeps the extension and moves the file`);
  await p.waitForTimeout(400);
  assert(favorites().includes("files/CV Jay Gohil.docx"), `${label}: renamed file is still a favourite`);
  assert((await row(p, "CV Jay Gohil").innerText()).includes("GitHub"), `${label}: renamed file keeps its origin`);

  // rename to an existing name is refused
  await menuAction(p, "Mietvertrag", "rename");
  await p.fill("#rename-input", "notes.txt");
  await p.click("#rename-ok");
  await p.waitForFunction(() => document.getElementById("rename-error").textContent.includes("already exists"));
  assert(true, `${label}: rename refuses an existing name`);
  await p.click("#rename [data-close]");

  // download from the menu
  const [dl] = await Promise.all([p.waitForEvent("download"), menuAction(p, "notes (2).txt", "download")]);
  assert(dl.suggestedFilename() === "notes (2).txt", `${label}: download has right name`);

  // delete + undo
  await menuAction(p, "notes (2).txt", "delete");
  await p.click("#confirm-ok");
  await p.waitForFunction(() => document.querySelectorAll(".file").length === 6);
  assert(!vault.has("files/notes (2).txt"), `${label}: delete works`);
  await p.click("#toast-action");
  await p.waitForFunction(() => document.querySelectorAll(".file").length === 7, null, { timeout: 10000 });
  assert(vault.has("files/notes (2).txt"), `${label}: undo brings the deleted file back`);

  // ---------------------------------------------------------------- clipboard
  const clipTexts = () => p.$$eval("#clip-list .clip-text", (els) => els.map((e) => e.textContent));
  await p.click("#tab-clips");
  await p.waitForSelector("#clip-view:not([hidden])");
  assert(new URL(p.url()).hash === "#clipboard" && (await p.isVisible("#clip-empty")), `${label}: Clipboard tab opens (empty, bookmarkable #clipboard)`);
  assert(await p.isHidden("#docs-view"), `${label}: documents are hidden on the Clipboard tab`);
  assert((await p.textContent("#view-title")) === "Clipboard" && await p.isHidden("#upload-btn"), `${label}: header says Clipboard, Upload button hidden`);

  // save a link from the box
  const LINK = "https://jobs.example.com/offer?id=42";
  await p.fill("#clip-input", LINK);
  await p.click("#clip-save");
  await p.waitForFunction(() => document.querySelectorAll("#clip-list .clip").length === 1);
  await p.waitForFunction(() => document.getElementById("toast-text").textContent.includes("other devices"), null, { timeout: 5000 });
  assert(clipItems()[0]?.text === LINK && clipItems()[0]?.device === device, `${label}: clip saved to the vault with device "${device}"`);
  assert((await p.inputValue("#clip-input")) === "", `${label}: box is cleared after saving`);
  assert((await p.getAttribute("#clip-list .clip a.icon-btn", "href")) === LINK, `${label}: links get an Open button`);

  // copy puts the exact text on this device's clipboard
  await p.click("#clip-list .clip.latest .clip-copy");
  await p.waitForFunction(() => document.querySelector("#clip-list .clip-copy").textContent.includes("Copied"));
  assert((await p.evaluate(() => navigator.clipboard.readText())) === LINK, `${label}: Copy puts the clip on the system clipboard`);

  // a clip from another device shows up on refresh, on top, highlighted
  remoteClip("WLAN Passwort: blue-tram-42");
  await p.click("#refresh-btn");
  await p.waitForFunction(() => document.querySelector("#clip-list .clip.latest .clip-meta")?.textContent.includes("Windows PC"));
  assert((await clipTexts())[0] === "WLAN Passwort: blue-tram-42", `${label}: clip from another device appears on top`);

  // every web address in a clip is a real link, also inside a sentence
  remoteClip("Appointment details: https://service.berlin.de/termin/123, bring passport");
  await p.click("#refresh-btn");
  await p.waitForSelector("#clip-list .clip.latest a.clip-link");
  assert((await p.getAttribute("#clip-list .clip.latest a.clip-link", "href")) === "https://service.berlin.de/termin/123"
    && (await p.getAttribute("#clip-list .clip.latest a.clip-link", "target")) === "_blank", `${label}: links inside clip text are clickable and open in a new tab`);
  assert((await p.textContent("#clip-list .clip.latest .clip-text")) === "Appointment details: https://service.berlin.de/termin/123, bring passport", `${label}: clip text is unchanged around the link`);

  // the haldi dot tells you a new clip arrived while on Documents
  await p.click("#tab-docs");
  assert((await p.textContent("#view-title")) === "Documents" && await p.isVisible("#upload-btn"), `${label}: header says Documents, Upload button back`);
  assert(await p.isHidden("#clip-dot"), `${label}: no dot for clips already seen`);
  remoteClip("Termin Bürgeramt 14:30");
  await p.evaluate(() => window.dispatchEvent(new Event("focus")));
  await p.waitForSelector("#clip-dot:not([hidden])");
  assert(true, `${label}: new clip from another device shows a dot on the Clipboard tab`);
  await p.click("#tab-clips");
  assert(await p.isHidden("#clip-dot"), `${label}: opening the Clipboard clears the dot`);

  // Ctrl+V anywhere on the Clipboard tab saves the text
  await p.evaluate(() => {
    document.activeElement?.blur();
    const dt = new DataTransfer();
    dt.setData("text/plain", "  pasted from the laptop  ");
    document.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  await p.waitForFunction(() => document.querySelector("#clip-list .clip-text")?.textContent === "pasted from the laptop");
  await p.waitForTimeout(400);
  assert(clipItems()[0]?.text === "pasted from the laptop", `${label}: paste on the Clipboard tab saves (trimmed)`);

  // two devices saving at the same moment: neither clip is lost
  remoteClip("saved on the PC at the same time");          // the app's copy is now stale
  await p.fill("#clip-input", "saved on this device");
  await p.click("#clip-save");
  await until(() => clipItems()[0]?.text === "saved on this device");
  const both = clipItems().map((i) => i.text);
  assert(both.includes("saved on the PC at the same time") && both[0] === "saved on this device", `${label}: simultaneous saves on two devices both survive`);

  // saving the same text again moves it to the top instead of duplicating it
  await p.fill("#clip-input", LINK);
  await p.click("#clip-save");
  await p.waitForTimeout(500);
  assert(clipItems()[0].text === LINK && clipItems().filter((i) => i.text === LINK).length === 1, `${label}: same text again moves to the top, no duplicate`);

  // too long is refused with a clear message
  const countBefore = clipItems().length;
  await p.fill("#clip-input", "x".repeat(clipsLib.MAX_CLIP_CHARS + 1));
  await p.click("#clip-save");
  await p.waitForFunction(() => document.querySelector("#toast.err")?.textContent.includes("too long"));
  assert(clipItems().length === countBefore, `${label}: over-long clip refused`);
  await p.fill("#clip-input", "");

  // long clips are clamped with Show all
  remoteClip(Array.from({ length: 12 }, (_, i) => `Line ${i + 1} of a long note`).join("\n"));
  await p.click("#refresh-btn");
  await p.waitForSelector("#clip-list .clip.latest .clip-more");
  await p.click("#clip-list .clip.latest .clip-more");
  assert(await p.$eval("#clip-list .clip.latest .clip-text", (e) => e.classList.contains("open")), `${label}: long clip expands with Show all`);
  await p.screenshot({ path: SHOTS + `${label}-5-clipboard.png`, fullPage: true });

  // delete + undo
  const n = clipItems().length;
  await p.locator("#clip-list .clip", { hasText: "Termin Bürgeramt" }).getByLabel("Delete clip").click();
  await p.waitForFunction((k) => document.querySelectorAll("#clip-list .clip").length === k, n - 1);
  await p.waitForTimeout(400);
  assert(!clipItems().some((i) => i.text.startsWith("Termin")), `${label}: delete clip`);
  await p.click("#toast-action");
  await p.waitForFunction((k) => document.querySelectorAll("#clip-list .clip").length === k, n);
  await p.waitForTimeout(400);
  assert(clipItems().some((i) => i.text.startsWith("Termin")) && clipItems().length === n, `${label}: undo brings the clip back`);

  // clear all (asks first) + undo
  await p.click("#clip-clear");
  await p.waitForSelector("#confirm:not([hidden])");
  assert((await p.textContent("#confirm-ok")) === "Clear all", `${label}: clear all asks first`);
  await p.click("#confirm-ok");
  await p.waitForSelector("#clip-empty:not([hidden])");
  await p.waitForTimeout(400);
  assert(clipItems().length === 0, `${label}: clear all empties the clipboard everywhere`);
  await p.click("#toast-action");
  await p.waitForFunction((k) => document.querySelectorAll("#clip-list .clip").length === k, n);
  await p.waitForTimeout(400);
  assert(clipItems().length === n && clipItems()[0].text.startsWith("Line 1"), `${label}: undo restores every clip in order`);

  // a #clipboard link opens straight on the Clipboard, drawn from cache
  await p.goto(BASE + "/#clipboard");
  await p.waitForSelector("#clip-view:not([hidden]) .clip");
  assert(await p.isHidden("#docs-view"), `${label}: opening .../#clipboard goes straight to the Clipboard`);
  await p.click("#tab-docs");
  await p.waitForSelector("#docs-view:not([hidden]) .file");
  assert(await p.isHidden("#clip-view"), `${label}: back to Documents`);

  // reload: remembered device, list drawn instantly from cache
  await p.reload();
  await p.waitForSelector("#app:not([hidden]) .file");
  assert(true, `${label}: remembered device skips lock`);

  // lock wipes local copies
  await p.click("#logout-btn");
  await p.waitForSelector("#lock:not([hidden])");
  const leftovers = await p.evaluate(async () => (await caches.keys()).length + ["docsync.list.v1", "docsync.clips.v1", "docsync.state.v1"].filter((k) => localStorage.getItem(k)).length);
  assert(leftovers === 0, `${label}: lock removes cached files, list and clipboard from the device`);

  // reset the fake vault for the next round
  for (const k of [...vault.keys()]) if (k.startsWith("files/") || k.startsWith(".app/")) vault.delete(k);
  for (const [k, buf] of SEEDED) setFile(k, buf);
  commits.length = 0;
  seed("Lebenslauf.docx", Buffer.alloc(48000), "Add files via upload", daysAgo(40));
  seed("notes.txt", Buffer.from("Hello from the tool\nLine 2"), "Upload notes.txt [Mac, drop]", daysAgo(10));
  seed("passport-scan.png", PNG, "Upload passport-scan.png [iPhone, share]", daysAgo(2));
  await c.close();
}

await browser.close();
assert(problems.length === 0, `no CSP violations or page errors${problems.length ? ":\n  " + problems.join("\n  ") : ""}`);
console.log("\nAll tests passed.");
