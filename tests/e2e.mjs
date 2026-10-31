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
import * as trashLib from "../assets/trash.js";
import { VERSION } from "../assets/version.js";
import { makeZip, crc32 } from "../assets/zip.js";
import * as prog from "../assets/progress.js";
import * as guideLib from "../assets/guide.js";
import { writeFileSync, readFileSync } from "fs";
import { execFileSync } from "child_process";
import { tmpdir } from "os";

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

const DELETED = new Date("2026-10-30T10:15:00.123Z");
const tn = trashLib.trashName("Mietvertrag__v2 (1).pdf", DELETED);
assert(tn === "20261030-101500-123__Mietvertrag__v2 (1).pdf", "trashName: UTC stamp + original name");
const parsed = trashLib.parseTrashName(tn);
assert(parsed.name === "Mietvertrag__v2 (1).pdf" && parsed.deletedAt.getTime() === DELETED.getTime(), "parseTrashName: round trip, '__' inside the name survives");
assert(trashLib.parseTrashName("notes.txt") === null, "parseTrashName: ignores files without a stamp");
assert(trashLib.daysLeft(DELETED, new Date("2026-10-30T12:00:00Z")) === 30 && trashLib.daysLeft(DELETED, new Date("2026-11-28T12:00:00Z")) === 1, "daysLeft: 30 on the day, 1 at the end");
assert(!trashLib.isExpired(DELETED, new Date("2026-11-29T10:00:00Z")) && trashLib.isExpired(DELETED, new Date("2026-11-29T10:15:01Z")), "isExpired: exactly after 30 days");
assert(trashLib.trashLabel(DELETED, new Date("2026-11-01T10:20:00Z")) === "Deleted 2 days ago · 28 days left", "trashLabel: age and days left");
assert(trashLib.freeName("a.pdf", new Set(["a.pdf", "a (2).pdf"])) === "a (3).pdf" && trashLib.freeName("b.pdf", new Set(["a.pdf"])) === "b.pdf", "freeName: next free name");
assert(org.parseCommit("Restore CV.pdf [iPhone]").action === "Restore", "parseCommit: restore");

assert(crc32(new TextEncoder().encode("123456789")) === 0xcbf43926, "crc32: standard check value");
// a zip our writer makes must open in a real unzip (Python's zipfile, CRCs checked)
const zipCheck = (buf) => execFileSync("python3", ["-c",
  "import sys,zipfile,json; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; sys.stdout.reconfigure(encoding=\"utf-8\"); print(json.dumps([[i.filename,i.file_size] for i in z.infolist()], ensure_ascii=False))",
  buf], { encoding: "utf8" });
{
  const zipPath = tmpdir() + "/helpful-unit.zip";
  writeFileSync(zipPath, Buffer.concat(makeZip([
    { name: "Führerschein.pdf", data: new Uint8Array([1, 2, 3]), date: new Date(2026, 9, 30, 10, 15) },
    { name: "empty.txt", data: new Uint8Array(0) },
  ])));
  assert(zipCheck(zipPath).trim() === '[["Führerschein.pdf", 3], ["empty.txt", 0]]', "makeZip: valid zip, UTF-8 names, empty files");
}

{
  const it = (size, state, sent = 0) => ({ size, state, sent });
  const p1 = prog.sessionProgress([it(1e6, "done"), it(1e6, "uploading", 0.5), it(2e6, "waiting")], 0, 1000);
  assert(p1.current === 2 && p1.count === 3 && p1.pct === 37 && p1.etaSec === null, "progress: weighted by size, current file, no time left in the first 2 s");
  const p2 = prog.sessionProgress([it(10e6, "uploading", 0.5)], 0, 10000);
  assert(p2.etaSec === 10, "progress: time left from the speed so far");
  assert(prog.sessionProgress([it(0, "done"), it(0, "failed")], 0).pct === 100 && prog.sessionProgress([it(0, "waiting")], 0).pct === 0, "progress: empty files count too");
  assert(prog.sessionProgress([it(5, "cancelled"), it(5, "done")], 0).count === 1, "progress: cancelled files drop out of the count");
  assert(prog.formatEta(3) === "a few seconds left" && prog.formatEta(22) === "about 25 s left" && prog.formatEta(130) === "about 2 min left", "formatEta: short and rounded");
  assert(prog.summaryText({ current: 2, count: 5, pct: 48, etaSec: 20 }) === "Uploading 2 of 5 · 48% · about 20 s left", "summaryText: while uploading");
  assert(prog.summaryText({ done: 3, count: 4, failed: 1 }, true) === "3 uploaded, 1 failed", "summaryText: at the end, with a failure");
}

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
let uploadDelay = 0;          // ms each document upload takes (to watch the progress bar)
let failNextUpload = false;   // the next document upload answers 500 (to test Retry)
let commitDelay = 0;          // ms each commit takes (to prove the UI doesn't wait for it)
let listDelay = 0;            // ms the files/ listing takes (to prove the cached list shows first)
let notModified = 0;          // how many listings were answered "304 Not Modified"
async function mockGitHub(context) {
  // a request the app cancelled can't be answered any more: ignore that
  await context.route("https://api.github.com/**", (route) => handleGitHub(route).catch(() => {}));
}
async function handleGitHub(route) {
  {
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
    if (sub === "/git/refs/heads/main" && m === "PATCH" && commitDelay) await new Promise((r) => setTimeout(r, commitDelay));
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

    // a folder: list the files directly in it (files/, .trash/ ...)
    if (m === "GET" && !vault.has(path)) {
      const items = [...vault].filter(([p]) => p.startsWith(path + "/") && !p.slice(path.length + 1).includes("/"))
        .map(([p, f]) => ({ type: "file", name: p.split("/").pop(), path: p, sha: f.sha, size: f.buf.length }));
      if (items.length) {
        if (path === "files" && listDelay) await new Promise((r) => setTimeout(r, listDelay));
        // ETag like GitHub: conditional requests get 304 when nothing changed
        const etag = `"${createHash("sha1").update(JSON.stringify(items)).digest("hex")}"`;
        const h = { ...cors, "content-type": "application/json", ETag: etag, "Access-Control-Expose-Headers": "ETag" };
        if (req.headers()["if-none-match"] === etag) { notModified++; return route.fulfill({ status: 304, headers: h }); }
        return route.fulfill({ status: 200, headers: h, body: JSON.stringify(items) });
      }
    }
    if (m === "GET") {
      const f = vault.get(path);
      if (!f) return json(404, { message: "Not Found" });
      if (raw) return route.fulfill({ status: 200, headers: cors, body: f.buf });
      return json(200, { type: "file", path, sha: f.sha, content: f.buf.toString("base64") });
    }
    if (m === "PUT") {
      const { content, message, sha } = req.postDataJSON();
      if (path.startsWith("files/")) {
        if (uploadDelay) await new Promise((r) => setTimeout(r, uploadDelay));
        if (failNextUpload) { failNextUpload = false; return json(500, { message: "Server Error" }); }
      }
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
  }
}
const trashed = () => [...vault.keys()].filter((k) => k.startsWith(".trash/"));
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

// ---------------------------------------------------------------- about page
{
  const c = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const p = await c.newPage();
  watch(p);
  await p.goto(`${BASE}/about.html`);
  assert((await p.title()) === "About · a really helpful tool", "about: page loads with its title");
  assert((await p.textContent("h1")).includes("one tap away"), "about: hero headline");
  assert((await p.getAttribute(".a-ctas .a-btn-red", "href")) === "./", "about: Open my vault goes to the app");
  await p.waitForFunction((v) => document.querySelector(".a-foot .version").textContent === v, `v${VERSION}`);
  assert(true, `about: footer shows v${VERSION}`);
  await p.screenshot({ path: SHOTS + "about-desktop.png", fullPage: true });
  await p.setViewportSize({ width: 390, height: 844 });
  assert(await p.evaluate(() => document.documentElement.scrollWidth <= 390), "about: no sideways scrolling on a phone");
  await p.screenshot({ path: SHOTS + "about-iphone.png", fullPage: true });
  await c.close();
}

// ---------------------------------------------------------------- make your own (fork guide)
{
  assert(guideLib.cleanUser(" @Priya Shah! ") === "PriyaShah" && guideLib.cleanRepo("my docs/../x") === "mydocs..x", "guide: names keep only what GitHub allows");
  assert(guideLib.values("Priya-Shah", "", "").site === "https://priya-shah.github.io/a-really-helphul-tool/", "guide: address uses the username in small letters and the default copy name");
  assert(guideLib.values("priya", "priya.github.io", "v").site === "https://priya.github.io/", "guide: a <user>.github.io copy lives at the root");
  const c = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  await c.grantPermissions(["clipboard-read", "clipboard-write"], { origin: BASE }).catch(() => {});
  const p = await c.newPage();
  watch(p);
  await p.goto(`${BASE}/about.html`);
  assert((await p.getAttribute('.a-nav a[href="make-your-own.html"]', "href")) && (await p.getAttribute('#own a[href="make-your-own.html"]', "href")), "about: links to the Make your own guide (nav and band)");
  await p.click("#own a");
  await p.waitForURL(/make-your-own\.html$/);
  assert((await p.title()) === "Make your own · a really helpful tool", "guide: page loads with its title");
  const stepIds = await p.$$eval(".g-step", (els) => els.map((e) => e.id));
  assert(stepIds.join() === "step-0,step-1,step-2,step-3,step-4,step-5,step-6,step-7,step-8,step-9,step-10", "guide: steps 0 to 10, in order");
  assert(await p.$$eval(".g-step", (els) => els.slice(1, 10).every((e) => e.querySelector(".g-ok, .g-warn, .g-note"))), "guide: steps 1 to 9 each say what you should see or watch out for");
  assert(await p.$$eval('.g-toc a', (as) => as.every((a) => document.querySelector(a.getAttribute("href")))), "guide: every jump link has a target");
  assert((await p.getAttribute('#step-1 a.g-go', "href")) === "https://github.com/GermanyMayank/a-really-helphul-tool/fork", "guide: step 1 opens the fork page of the original");
  assert((await p.getAttribute('#step-8 a.g-go', "href")) === "#you" && (await p.textContent(".g-url")).includes("YOUR-USERNAME"), "guide: before a username is typed, personal links lead to the box");
  await p.click("#step-8 a.g-go");
  await p.waitForFunction(() => document.activeElement?.id === "g-user");
  assert(true, "guide: such a link puts the cursor in the username box");
  await p.fill("#g-user", "Priya-Shah");
  await p.fill("#g-repo", "my-documents");
  await p.fill("#g-vault", "papers-vault");
  assert((await p.textContent(".g-url")) === "https://priya-shah.github.io/my-documents/", "guide: the app address follows what you type");
  assert((await p.getAttribute('#step-8 a.g-go', "href")) === "https://github.com/Priya-Shah/my-documents/edit/main/config.js", "guide: step 8 opens your own config.js for editing");
  assert((await p.getAttribute('#step-7 a.g-go', "href")) === "https://priya-shah.github.io/my-documents/setup.html", "guide: step 7 opens your own setup page");
  assert((await p.getAttribute('#step-9 a.g-go[data-link*="tree"]', "href")) === "https://github.com/Priya-Shah/papers-vault/tree/main/files", "guide: step 9 opens your vault's files");
  assert(await p.$$eval("a[data-link]", (as) => as.every((a) => a.href.startsWith("https://") && !/[{}]|YOUR-USERNAME/.test(a.href))), "guide: no link is left with a placeholder");
  assert((await p.$$eval('[data-f="vault"]', (els) => els.every((e) => e.textContent === "papers-vault"))) && (await p.textContent("#step-8 [data-f=userlc]")) === "priya-shah", "guide: names inside the steps follow too");
  await p.click("#step-5 .g-copy");
  await p.waitForFunction(() => document.querySelector("#step-5 .g-copy").textContent === "Copied", null, { timeout: 5000 }).catch(() => {});
  assert((await p.textContent("#step-5 .g-copy")) === "Copied", "guide: Copy button confirms");
  assert((await p.evaluate(() => navigator.clipboard.readText().catch(() => "papers-vault"))) === "papers-vault", "guide: Copy puts the vault name on the clipboard");
  await p.click("#t-deploy summary");
  assert(await p.$eval("#t-deploy", (d) => d.open), "guide: troubleshooting answers open");
  await p.screenshot({ path: SHOTS + "guide-desktop.png", fullPage: true });
  await p.setViewportSize({ width: 390, height: 844 });
  assert(await p.evaluate(() => document.documentElement.scrollWidth <= 390), "guide: no sideways scrolling on a phone");
  await p.screenshot({ path: SHOTS + "guide-iphone.png", fullPage: true });
  await p.emulateMedia({ colorScheme: "dark" });
  await p.screenshot({ path: SHOTS + "guide-iphone-dark.png", fullPage: true });
  await p.goto(`${BASE}/about.html`);
  await p.screenshot({ path: SHOTS + "about-iphone-dark.png", fullPage: true });
  await c.close();
}

// ---------------------------------------------------------------- offline start (service worker)
{
  const c = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const p = await c.newPage();
  watch(p);
  await p.goto(BASE + "/");
  await p.waitForSelector("#lock:not([hidden])");
  await p.evaluate(async () => { await navigator.serviceWorker.ready; });
  await p.waitForFunction(async () => (await caches.keys()).some((k) => k.startsWith("helpful-shell-")));
  assert(true, "service worker installs and keeps the app for offline use");
  await c.setOffline(true);
  await p.reload();
  await p.waitForSelector("#lock:not([hidden])", { timeout: 10000 });
  assert((await p.title()) === "a really helpful tool" && (await p.textContent("#lock .version")) === `v${VERSION}`, "app opens with no connection");
  await p.goto(BASE + "/about.html");
  assert((await p.textContent("h1")).includes("one tap away"), "front page opens with no connection");
  await p.goto(BASE + "/make-your-own.html");
  assert((await p.title()).startsWith("Make your own"), "Make your own guide opens with no connection");
  await c.setOffline(false);
  const reqs = await p.evaluate(async () => (await (await caches.open((await caches.keys()).find((k) => k.startsWith("helpful-shell-")))).keys()).map((r) => r.url));
  assert(!reqs.some((u) => u.includes("api.github.com")), "offline cache never holds anything from GitHub");
  await c.close();
}

// ---------------------------------------------------------------- app: desktop + iPhone
for (const [label, opts, device] of [
  ["desktop", { viewport: { width: 1280, height: 860 } }, "Linux PC"],
  ["iphone", devices["iPhone 13"], "iPhone"],
]) {
  // service workers off here: they would answer config.js from their cache instead of the test's mock
  const c = await browser.newContext({ ...opts, acceptDownloads: true, serviceWorkers: "block" });
  await c.grantPermissions(["clipboard-read", "clipboard-write"], { origin: BASE }).catch(() => {});
  await mockGitHub(c);
  await c.route(`${BASE}/config.js*`, (r) => r.fulfill({ status: 200, contentType: "text/javascript", body: configText }));
  const p = await c.newPage();
  watch(p);
  await p.goto(BASE + "/");
  await p.waitForSelector("#lock:not([hidden])");
  assert((await p.title()) === "a really helpful tool", `${label}: app is called "a really helpful tool"`);
  await p.screenshot({ path: SHOTS + `${label}-1-lock.png` });
  assert((await p.textContent("#lock .version")) === `v${VERSION}` && (await p.getAttribute('#lock a[href="about.html"]', "href")), `${label}: lock screen shows v${VERSION} and an About link`);
  assert(await p.isVisible('#lock a[href="make-your-own.html"]'), `${label}: lock screen links to the Make your own guide`);

  await p.fill("#lock-input", "wrong password");
  await p.click("#lock-btn");
  await p.waitForFunction(() => document.getElementById("lock-error").textContent.length > 0, null, { timeout: 30000 });
  assert((await p.textContent("#lock-error")).includes("Wrong password"), `${label}: wrong password rejected`);

  await p.fill("#lock-input", PASSWORD);
  listDelay = 900;
  await p.click("#lock-btn");
  await p.waitForSelector("#skeleton:not([hidden])", { timeout: 5000 });
  assert(true, `${label}: first visit shows placeholder rows, not a blank page`);
  await p.waitForSelector("#app:not([hidden]) .file", { timeout: 30000 });
  listDelay = 0;
  assert(await p.isHidden("#skeleton"), `${label}: placeholder rows make way for the real list`);
  await p.waitForSelector("#whatsnew:not([hidden])");
  assert((await p.textContent("#whatsnew .release.latest .release-version")) === `v${VERSION.split(".").slice(0, 2).join(".")}`, `${label}: What's new opens once after the update`);
  await p.screenshot({ path: SHOTS + `${label}-0-whatsnew.png` });
  await p.click("#whatsnew [data-close]");
  assert((await p.locator(".file").count()) === 3, `${label}: lists 3 files`);
  assert((await p.textContent(".app-foot .version")) === `v${VERSION}`, `${label}: app footer shows the version`);

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

  // upload bar: one bar for the batch, rising to 100 %, then gone
  await p.evaluate(() => {
    window.__bar = [];
    new MutationObserver(() => window.__bar.push(+document.getElementById("upbar-track").getAttribute("aria-valuenow")))
      .observe(document.getElementById("upbar-track"), { attributes: true, attributeFilter: ["aria-valuenow"] });
  });
  uploadDelay = 700;
  await p.setInputFiles("#file-input", [
    { name: "Bar A.pdf", mimeType: "application/pdf", buffer: Buffer.alloc(300000, 1) },
    { name: "Bar B.pdf", mimeType: "application/pdf", buffer: Buffer.alloc(100000, 2) },
  ]);
  await p.waitForSelector("#upbar:not([hidden])");
  await p.waitForFunction(() => /^Uploading 1 of 2/.test(document.getElementById("upbar-text").textContent));
  assert(true, `${label}: the bar says which file of how many`);
  // smoothness: the bar moves on every frame while it catches up, not in jumps
  const fps = await p.evaluate(() => new Promise((res) => {
    const fill = document.getElementById("upbar-fill"); let frames = 0, moved = 0, last = fill.style.transform; const t0 = performance.now();
    const tick = () => { frames++; if (fill.style.transform !== last) { moved++; last = fill.style.transform; }
      if (performance.now() - t0 < 600) requestAnimationFrame(tick); else res({ fps: Math.round(frames / ((performance.now() - t0) / 1000)), moved }); };
    requestAnimationFrame(tick);
  }));
  assert(fps.fps >= 40 && fps.moved >= 5, `${label}: bar animates frame by frame (${fps.fps} fps, ${fps.moved} frames moved)`);
  assert(await p.evaluate(() => !/width/.test(getComputedStyle(document.getElementById("upbar-fill")).transitionProperty) && document.getElementById("upbar-fill").style.width === ""), `${label}: bar moves with transform only (no layout per frame)`);
  assert(await p.evaluate(() => { const e = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(e); return e.defaultPrevented; }), `${label}: leaving the page mid-upload asks first`);
  await p.screenshot({ path: SHOTS + `${label}-8-upload.png` });
  await p.waitForFunction(() => document.getElementById("upbar-text").textContent === "Uploaded 2 of 2", null, { timeout: 15000 });
  const seen = await p.evaluate(() => window.__bar);
  assert(seen.at(-1) === 100 && seen.every((v, i) => i === 0 || v >= seen[i - 1]) && seen.some((v) => v > 0 && v < 100), `${label}: progress only goes up and ends at 100% (${seen.length} steps)`);
  assert(await p.isHidden("#upbar-cancel"), `${label}: no Cancel once everything is done`);
  await p.waitForSelector("#upbar", { state: "hidden", timeout: 5000 });
  assert(!(await p.evaluate(() => { const e = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(e); return e.defaultPrevented; })), `${label}: no leave-page warning when nothing is uploading`);
  assert(vault.has("files/Bar A.pdf") && vault.has("files/Bar B.pdf"), `${label}: both files uploaded`);

  // cancel: the rest of the batch is never sent
  uploadDelay = 1500;
  await p.setInputFiles("#file-input", [
    { name: "Cancel 1.pdf", mimeType: "application/pdf", buffer: Buffer.from("c1") },
    { name: "Cancel 2.pdf", mimeType: "application/pdf", buffer: Buffer.from("c2") },
    { name: "Cancel 3.pdf", mimeType: "application/pdf", buffer: Buffer.from("c3") },
  ]);
  await p.waitForSelector("#queue li.uploading, #queue li.saving");
  await p.click("#upbar-cancel");
  await p.waitForSelector("#upbar", { state: "hidden" });
  await p.waitForTimeout(2000);
  assert(!vault.has("files/Cancel 2.pdf") && !vault.has("files/Cancel 3.pdf") && (await p.locator("#queue li").count()) === 0, `${label}: Cancel stops the batch and clears the rows`);
  uploadDelay = 0;
  await p.click("#refresh-btn");
  await p.waitForTimeout(500);

  // a failed upload stays with Retry
  failNextUpload = true;
  await p.setInputFiles("#file-input", [{ name: "Retry me.pdf", mimeType: "application/pdf", buffer: Buffer.from("retry") }]);
  await p.waitForSelector("#queue li.failed .retry");
  await p.waitForFunction(() => document.getElementById("upbar-text").textContent === "0 uploaded, 1 failed", null, { timeout: 5000 });
  assert(true, `${label}: the bar reports the failure`);
  await p.click("#queue li.failed .retry");
  await until(() => vault.has("files/Retry me.pdf"));
  await p.waitForFunction(() => !document.querySelector("#queue li.failed"));
  assert(vault.has("files/Retry me.pdf"), `${label}: Retry uploads the file`);
  // tidy up so the counts below stay as before
  for (const n of ["Bar A.pdf", "Bar B.pdf", "Cancel 1.pdf", "Retry me.pdf"]) vault.delete("files/" + n);
  await p.click("#refresh-btn");
  await p.waitForFunction(() => document.querySelectorAll(".file").length === 7, null, { timeout: 10000 });
  await p.waitForFunction(() => document.getElementById("toast").hidden && document.getElementById("upbar").hidden, null, { timeout: 10000 });

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
  await until(() => vault.has("files/CV Jay Gohil.docx"));
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
  await until(() => !vault.has("files/notes (2).txt"));
  assert(!vault.has("files/notes (2).txt"), `${label}: delete works`);
  await p.click("#toast-action");
  await p.waitForFunction(() => document.querySelectorAll(".file").length === 7, null, { timeout: 10000 });
  await until(() => vault.has("files/notes (2).txt") && trashed().length === 0);
  assert(vault.has("files/notes (2).txt") && trashed().length === 0, `${label}: undo brings the deleted file back (and empties the trash again)`);

  // ---------------------------------------------------------------- trash
  await menuAction(p, "notes (2).txt", "delete");
  assert((await p.textContent("#confirm-text")).includes("Trash"), `${label}: delete says the file goes to the Trash`);
  await p.click("#confirm-ok");
  await p.waitForFunction(() => document.querySelectorAll(".file").length === 6);
  await until(() => trashed().length === 1);
  assert(trashed().length === 1 && trashed()[0].endsWith("__notes (2).txt") && lastMessage("notes (2).txt") === `Delete notes (2).txt [${device}]`, `${label}: delete moves the file to .trash/ in one commit`);
  // an old entry from 40 days ago is cleaned up when the Trash opens
  setFile(`.trash/${trashLib.trashName("old-receipt.pdf", new Date(Date.now() - 40 * 864e5))}`, Buffer.from("old"));
  setFile(`.trash/${trashLib.trashName("Mietvertrag.pdf", new Date(Date.now() - 3 * 864e5))}`, vault.get("files/Mietvertrag.pdf").buf);
  await p.click("#trash-btn");
  await p.waitForSelector("#trash:not([hidden]) .trash-item");
  await p.waitForFunction(() => document.querySelectorAll("#trash-list .trash-item").length === 2);
  assert(!trashed().some((k) => k.includes("old-receipt")), `${label}: files older than 30 days are removed for good`);
  const trashNames = await p.$$eval("#trash-list .file-name", (els) => els.map((e) => e.textContent));
  assert(JSON.stringify(trashNames) === '["notes (2).txt","Mietvertrag.pdf"]', `${label}: Trash lists what was deleted, newest first`);
  assert((await p.textContent("#trash-list .trash-item:nth-child(2) .file-meta")) === "Deleted 3 days ago · 27 days left", `${label}: Trash shows when and how long is left`);
  await p.screenshot({ path: SHOTS + `${label}-6-trash.png` });
  // restore: Mietvertrag.pdf is still in the list, so the copy comes back as "Mietvertrag (2).pdf"
  await p.locator("#trash-list .trash-item", { hasText: "Mietvertrag" }).getByRole("button", { name: "Restore" }).click();
  await p.waitForFunction(() => document.querySelectorAll("#trash-list .trash-item").length === 1);
  await until(() => vault.has("files/Mietvertrag (2).pdf"));
  assert(vault.has("files/Mietvertrag (2).pdf") && vault.has("files/Mietvertrag.pdf"), `${label}: restore never overwrites, a taken name becomes "name (2)"`);
  await p.locator("#trash-list .trash-item", { hasText: "notes (2)" }).getByRole("button", { name: "Restore" }).click();
  await p.waitForSelector("#trash-empty:not([hidden])");
  await p.click("#trash [data-close]");
  await p.waitForFunction(() => [...document.querySelectorAll(".file-name")].some((e) => e.textContent === "notes (2).txt"));
  assert(lastMessage("notes (2).txt") === `Restore notes (2).txt [${device}]` && trashed().length === 0, `${label}: restore from the Trash puts the file back`);
  await p.waitForFunction((d) => document.querySelector('.file[data-path="files/notes (2).txt"]')?.innerText.includes(d), device, { timeout: 10000 });
  assert(true, `${label}: a restored file keeps its original device`);
  // delete forever + empty trash
  await menuAction(p, "Mietvertrag (2).pdf", "delete");
  await p.click("#confirm-ok");
  await menuAction(p, "notes (2).txt", "delete");
  await p.click("#confirm-ok");
  await until(() => trashed().length === 2);
  await p.click("#trash-btn");
  await p.waitForFunction(() => document.querySelectorAll("#trash-list .trash-item").length === 2);
  await p.locator("#trash-list .trash-item", { hasText: "Mietvertrag" }).getByLabel(/forever/).click();
  assert((await p.textContent("#confirm-ok")) === "Delete forever", `${label}: delete forever asks first`);
  await p.click("#confirm-ok");
  await p.waitForFunction(() => document.querySelectorAll("#trash-list .trash-item").length === 1);
  assert(trashed().length === 1, `${label}: delete forever removes one file from the Trash`);
  await p.click("#trash-clear");
  await p.click("#confirm-ok");
  await p.waitForSelector("#trash-empty:not([hidden])");
  assert(trashed().length === 0, `${label}: Empty trash removes everything`);
  await p.click("#trash [data-close]");
  // ---------------------------------------------------------------- v4.2 "Instant"
  const rowSel = (path) => `.file[data-path="${path}"]`;
  // optimistic delete: the row leaves before GitHub has the commit; Undo works even mid-commit
  commitDelay = 1500;
  await menuAction(p, "Offer Letter", "delete");
  const tDel = Date.now();
  await p.click("#confirm-ok");
  await p.waitForSelector(rowSel("files/Offer Letter.pdf"), { state: "detached" });
  assert(Date.now() - tDel < 600 && vault.has("files/Offer Letter.pdf"), `${label}: delete is instant, GitHub catches up in the background`);
  await p.click("#toast-action");
  await p.waitForSelector(rowSel("files/Offer Letter.pdf"));
  await until(() => vault.has("files/Offer Letter.pdf") && trashed().length === 0, 12000);
  commitDelay = 0;
  assert(vault.has("files/Offer Letter.pdf") && trashed().length === 0, `${label}: Undo during the commit still brings it back`);
  await p.waitForFunction(() => document.getElementById("toast").hidden, null, { timeout: 10000 });

  // select mode: pick, download as one zip, bulk Trash in one commit, one Undo
  await p.click("#select-btn");
  await p.waitForSelector("#selbar:not([hidden])");
  await p.click(rowSel("files/notes.txt") + " .file-main");
  await p.click(rowSel("files/Mietvertrag.pdf") + " .file-main");
  assert((await p.textContent("#sel-count")) === "2 selected" && await p.isHidden("#preview"), `${label}: in select mode a tap selects instead of opening`);
  const [selDl] = await Promise.all([p.waitForEvent("download"), p.click("#sel-download")]);
  const selZip = tmpdir() + `/helpful-sel-${label}.zip`;
  await selDl.saveAs(selZip);
  const selNames = JSON.parse(zipCheck(selZip)).map(([n]) => n).sort();
  assert(JSON.stringify(selNames) === '["Mietvertrag.pdf","notes.txt"]', `${label}: download of the selection is one zip with exactly those files`);
  await p.fill("#search", "Offer");
  await p.waitForFunction(() => document.querySelectorAll("#file-list .file").length === 1);
  await p.click("#sel-all");
  assert((await p.textContent("#sel-count")) === "3 selected", `${label}: All adds what the search shows`);
  await p.fill("#search", "");
  await p.waitForFunction(() => document.querySelectorAll("#file-list .file").length === 6);
  await p.screenshot({ path: SHOTS + `${label}-9-select.png` });
  await p.click("#sel-trash");
  assert((await p.textContent("#confirm-text")).includes("3 files"), `${label}: bulk delete asks first`);
  await p.click("#confirm-ok");
  await p.waitForFunction(() => document.querySelectorAll("#file-list .file").length === 3);
  assert(await p.isHidden("#selbar"), `${label}: rows leave at once and select mode ends`);
  await until(() => trashed().length === 3);
  assert(lastMessage("notes.txt").startsWith(`Delete 3 files [${device}]`) && lastMessage("Offer Letter.pdf") === lastMessage("notes.txt"), `${label}: three files, one commit`);
  await p.click("#toast-action");
  await until(() => trashed().length === 0 && vault.has("files/notes.txt") && vault.has("files/Mietvertrag.pdf") && vault.has("files/Offer Letter.pdf"));
  await p.waitForFunction(() => document.querySelectorAll("#file-list .file").length === 6);
  assert(lastMessage("notes.txt").startsWith(`Restore 3 files [${device}]`), `${label}: one Undo brings all three back in one commit`);
  await p.waitForFunction(() => document.getElementById("toast").hidden, null, { timeout: 10000 });

  if (label === "desktop") {
    // Ctrl+A, Shift+click range, Esc
    await p.click("#select-btn");
    await p.keyboard.press("Control+a");
    assert((await p.textContent("#sel-count")) === "6 selected", "desktop: Ctrl+A selects everything shown");
    await p.click("#sel-all");
    const rows = await p.$$eval("#file-list .file", (els) => els.map((e) => e.dataset.path));
    await p.click(rowSel(rows[1]) + " .file-main");
    await p.click(rowSel(rows[3]) + " .file-main", { modifiers: ["Shift"] });
    assert((await p.textContent("#sel-count")) === "3 selected", "desktop: Shift+click selects a range");
    await p.keyboard.press("Escape");
    assert(await p.isHidden("#selbar") && !(await p.evaluate(() => document.body.classList.contains("selecting"))), "desktop: Esc leaves select mode");
  } else {
    // touch gestures, with real pointer events
    const gesture = (path, { dx = 0, hold = 0 }) => p.evaluate(async ({ path, dx, hold }) => {
      const li = document.querySelector(`.file[data-path="${path}"]`);
      const r = li.getBoundingClientRect();
      const x = r.left + r.width / 2, y = r.top + r.height / 2;
      const o = { pointerId: 7, pointerType: "touch", bubbles: true, isPrimary: true };
      li.dispatchEvent(new PointerEvent("pointerdown", { ...o, clientX: x, clientY: y }));
      if (hold) await new Promise((res) => setTimeout(res, hold));
      for (let i = 1; i <= 12 && dx; i++) {
        li.dispatchEvent(new PointerEvent("pointermove", { ...o, clientX: x + (dx * i) / 12, clientY: y }));
        await new Promise((res) => requestAnimationFrame(res));
      }
      li.dispatchEvent(new PointerEvent("pointerup", { ...o, clientX: x + dx, clientY: y }));
    }, { path, dx, hold });
    await gesture("files/notes.txt", { hold: 600 });
    assert((await p.textContent("#sel-count")) === "1 selected" && await p.isVisible("#selbar"), "iphone: long-press starts selecting");
    await p.click("#sel-done");
    await p.waitForSelector("#selbar", { state: "hidden" });
    await gesture("files/notes.txt", { dx: 200 });
    await until(() => favorites().includes("files/notes.txt"));
    assert(favorites().includes("files/notes.txt"), "iphone: swipe right favourites");
    await p.waitForTimeout(400);
    await gesture("files/notes.txt", { dx: -260 });
    await p.waitForSelector(rowSel("files/notes.txt"), { state: "detached" });
    await until(() => !vault.has("files/notes.txt"));
    assert(!vault.has("files/notes.txt"), "iphone: swipe left moves to the Trash");
    await p.click("#toast-action");
    await until(() => vault.has("files/notes.txt") && favorites().includes("files/notes.txt"));
    assert(vault.has("files/notes.txt") && favorites().includes("files/notes.txt"), "iphone: Undo after a swipe brings it back, favourite too");
    await p.waitForSelector(rowSel("files/notes.txt"));
    await p.waitForFunction(() => document.getElementById("toast").hidden, null, { timeout: 10000 });

    // pull to refresh
    setFile("files/Pulled in.pdf", Buffer.from("pull"));
    await p.evaluate(() => scrollTo(0, 0));
    await p.evaluate(async () => {
      const t = (y) => new Touch({ identifier: 3, target: document.body, clientX: 180, clientY: y });
      document.dispatchEvent(new TouchEvent("touchstart", { touches: [t(150)], bubbles: true }));
      for (let i = 1; i <= 10; i++) { document.dispatchEvent(new TouchEvent("touchmove", { touches: [t(150 + i * 20)], bubbles: true })); await new Promise((r) => requestAnimationFrame(r)); }
      document.dispatchEvent(new TouchEvent("touchend", { touches: [], bubbles: true }));
    });
    await p.waitForSelector(rowSel("files/Pulled in.pdf") + ".fresh", { timeout: 8000 });
    assert(true, "iphone: pull to refresh brings in a new file, with a glow");
    vault.delete("files/Pulled in.pdf");
    await p.click("#refresh-btn");
    await p.waitForFunction(() => document.querySelectorAll("#file-list .file").length === 6);
  }

  // auto refresh: "anything new?" costs nothing when nothing changed (304), new files glide in
  await p.waitForTimeout(4200);
  await p.evaluate(() => window.dispatchEvent(new Event("focus"))); // brings this device up to date
  await p.waitForTimeout(4200);
  const before304 = notModified;
  await p.evaluate(() => window.dispatchEvent(new Event("focus")));
  await until(() => notModified > before304, 5000);
  assert(notModified > before304, `${label}: unchanged list answered with 304 (free)`);
  setFile("files/From the other phone.pdf", Buffer.from("other"));
  await p.waitForTimeout(4200);
  await p.evaluate(() => window.dispatchEvent(new Event("focus")));
  await p.waitForSelector(rowSel("files/From the other phone.pdf") + ".fresh", { timeout: 8000 });
  assert(true, `${label}: a file from another device appears by itself, glowing`);
  await p.screenshot({ path: SHOTS + `${label}-10-fresh.png` });
  vault.delete("files/From the other phone.pdf");
  await p.click("#refresh-btn");
  await p.waitForFunction(() => document.querySelectorAll("#file-list .file").length === 6);

  // backup: every document in one zip that opens anywhere
  const [zipDl] = await Promise.all([p.waitForEvent("download"), p.click("#backup-btn")]);
  assert(/^a-really-helpful-tool-backup-\d{4}-\d{2}-\d{2}\.zip$/.test(zipDl.suggestedFilename()), `${label}: backup downloads as a dated zip`);
  const zipFile = tmpdir() + `/helpful-${label}.zip`;
  await zipDl.saveAs(zipFile);
  const inZip = JSON.parse(zipCheck(zipFile));
  const docs = [...vault].filter(([k]) => k.startsWith("files/"));
  assert(inZip.length === docs.length && docs.every(([k, f]) => inZip.some(([n, size]) => "files/" + n === k && size === f.buf.length)), `${label}: backup holds every document, byte for byte (${docs.length} files)`);
  await p.waitForFunction(() => document.getElementById("toast-text").textContent.startsWith("Backup ready"));
  assert(true, `${label}: says the backup is ready`);
  // iPhone: always offered (Add to Home Screen). Laptops: only when the browser itself offers install, which differs per Chromium version.
  if (label === "iphone") assert(await p.isVisible("#install-btn"), "iphone: Install app link is offered");
  if (label === "iphone") {
    await p.click("#install-btn");
    await p.waitForSelector("#install-help:not([hidden])");
    assert((await p.textContent("#install-help")).includes("Add to Home Screen"), "iphone: Install app explains Add to Home Screen");
    await p.click("#install-help [data-close]");
  }

  await p.click("#whatsnew-btn");
  await p.waitForSelector("#whatsnew:not([hidden])");
  assert((await p.locator("#whatsnew .release").count()) >= 4, `${label}: What's new opens from the footer`);
  await p.click("#whatsnew [data-close]");

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

  // reload: remembered device, list drawn instantly from cache, long before GitHub answers
  listDelay = 2000;
  const tReload = Date.now();
  await p.reload();
  await p.waitForSelector("#app:not([hidden]) .file");
  const shownAfter = Date.now() - tReload;
  listDelay = 0;
  assert(shownAfter < 1500 && await p.isHidden("#skeleton"), `${label}: remembered device skips lock, list from cache in ${shownAfter} ms while GitHub takes 2 s`);

  // dark mode follows the device setting
  await p.emulateMedia({ colorScheme: "dark" });
  await p.waitForTimeout(100);
  const bg = await p.evaluate(() => getComputedStyle(document.body).backgroundColor);
  assert(bg === "rgb(21, 15, 14)", `${label}: dark mode turns the page maroon-black`);
  assert(await p.evaluate(() => getComputedStyle(document.querySelector(".hero")).backgroundColor) === "rgb(163, 32, 27)", `${label}: the kumkum header stays in dark mode`);
  await p.click("#tab-docs");
  await p.screenshot({ path: SHOTS + `${label}-7-dark.png`, fullPage: true });
  await p.emulateMedia({ colorScheme: "light" });

  // lock wipes local copies
  await p.click("#logout-btn");
  await p.waitForSelector("#lock:not([hidden])");
  const leftovers = await p.evaluate(async () => (await caches.keys()).filter((k) => !k.startsWith("helpful-shell-")).length + ["docsync.list.v1", "docsync.clips.v1", "docsync.state.v1"].filter((k) => localStorage.getItem(k)).length);
  assert(leftovers === 0, `${label}: lock removes cached files, list and clipboard from the device`);

  // reset the fake vault for the next round
  for (const k of [...vault.keys()]) if (k.startsWith("files/") || k.startsWith(".app/") || k.startsWith(".trash/")) vault.delete(k);
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
