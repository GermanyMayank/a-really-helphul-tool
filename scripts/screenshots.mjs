// Makes the README screenshots with a fake vault full of example documents.
// No real token or data is used.
//   npm run build && python3 -m http.server 8080 --directory _site &
//   node scripts/screenshots.mjs        (CHROMIUM_PATH=... to use your own Chromium)
// Writes raw shots to docs/images/raw/. scripts/compose-images.mjs turns them
// into the framed README images.

import { chromium, devices } from "playwright";
import { mkdirSync } from "fs";
import { createHash, webcrypto } from "crypto";

const BASE = process.env.BASE || "http://localhost:8080";
const OUT = new URL("../docs/images/raw/", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

// ----- a fake config, encrypted like setup.html does it
globalThis.crypto ??= webcrypto;
const { encryptToken } = await import("../assets/crypto.js");
const TOKEN = "github_pat_EXAMPLE", PASSWORD = "an example password";
const blob = await encryptToken(TOKEN, PASSWORD);
const CONFIG = `export default { owner: "example", repo: "docsync-vault", folder: "files", maxFileMB: 25, encryptedToken: ${JSON.stringify(blob)} };`;

// ----- example vault
const sha = (buf) => createHash("sha1").update(Buffer.concat([Buffer.from(`blob ${buf.length}\0`), buf])).digest("hex");
const vault = new Map();
const commits = [];
const ago = (h) => new Date(Date.now() - h * 36e5).toISOString();
const put = (path, buf) => vault.set(path, { buf, sha: sha(buf) });
const doc = (name, kb, device, how, hoursAgo) => {
  put("files/" + name, Buffer.alloc(Math.round(kb * 1024), name.length));
  commits.push({ path: "files/" + name, message: `Upload ${name} [${device}, ${how}]`, date: ago(hoursAgo) });
};
doc("Passport scan.jpg", 1840, "iPhone", "camera", 3);
doc("Aufenthaltstitel.pdf", 612, "iPhone", "share", 30);
doc("CV 2026.pdf", 214, "Windows PC", "drop", 52);
doc("Cover letter template.docx", 38, "Windows PC", "drop", 76);
doc("Arbeitszeugnis.pdf", 455, "Windows PC", "drop", 140);
doc("Master certificate.pdf", 980, "Windows PC", "drop", 300);
doc("Mietvertrag Wohnung.pdf", 2310, "Windows PC", "drop", 520);
doc("Payslip September.pdf", 120, "iPhone", "share", 700);
doc("Deutschlandticket.pdf", 88, "iPhone", "share", 900);
doc("Driving licence front.jpg", 1460, "iPhone", "camera", 1300);
commits.sort((a, b) => b.date.localeCompare(a.date));
put(".app/state.json", Buffer.from(JSON.stringify({ version: 1, favorites: ["files/Aufenthaltstitel.pdf", "files/CV 2026.pdf"] })));
const clip = (text, device, minAgo) => ({ id: "c" + minAgo, text, device, at: new Date(Date.now() - minAgo * 6e4).toISOString() });
put(".app/clipboard.json", Buffer.from(JSON.stringify({ version: 1, items: [
  clip("https://jobs.example.com/systems-engineer-munich", "Windows PC", 1),
  clip("Termin Bürgeramt, Thursday 14:30. Details: www.berlin.de/termin", "iPhone", 26),
  clip("Booking code: K7Q2MX", "Windows PC", 95),
  clip("Notes from the call\n- start date: 1 January\n- 3 days office, 2 days remote\n- send Zeugnisse by Friday\n- ask about the Deutschlandticket Job\n- second round with the team lead", "Windows PC", 240),
  clip("Hauptstraße 12, 80331 München", "iPhone", 2000),
] })));

async function mock(context) {
  await context.route(`${BASE}/config.js*`, (r) => r.fulfill({ status: 200, contentType: "text/javascript", body: CONFIG }));
  await context.route("https://api.github.com/**", async (route) => {
    const req = route.request();
    const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "*" };
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    const json = (status, body) => route.fulfill({ status, headers: { ...cors, "content-type": "application/json" }, body: JSON.stringify(body) });
    const url = new URL(req.url());
    const sub = url.pathname.replace(/^\/repos\/example\/docsync-vault/, "");
    if (sub === "") return json(200, { name: "docsync-vault", private: true, default_branch: "main" });
    if (sub === "/commits") {
      const p = url.searchParams.get("path");
      const list = commits.filter((c) => c.path === p || c.path.startsWith(p + "/"));
      return json(200, (url.searchParams.get("page") > 1 ? [] : list).map((c, i) => ({ sha: "c" + i, commit: { message: c.message, committer: { date: c.date } } })));
    }
    if (!sub.startsWith("/contents/")) return json(404, { message: "Not Found" });
    const path = decodeURIComponent(sub.slice(10));
    if (req.method() === "GET" && path === "files")
      return json(200, [...vault].filter(([p]) => p.startsWith("files/")).map(([p, f]) => ({ type: "file", name: p.slice(6), path: p, sha: f.sha, size: f.buf.length })));
    const f = vault.get(path);
    if (req.method() === "GET") {
      if (!f) return json(404, { message: "Not Found" });
      if ((req.headers().accept || "").includes("raw")) return route.fulfill({ status: 200, headers: cors, body: f.buf });
      return json(200, { type: "file", path, sha: f.sha, content: f.buf.toString("base64") });
    }
    if (req.method() === "PUT") { const { content } = req.postDataJSON(); put(path, Buffer.from(content, "base64")); return json(201, { content: { path, sha: vault.get(path).sha } }); }
    return json(405, { message: "not in screenshot mode" });
  });
}

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const WIN_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const shots = [
  ["desktop", { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2, userAgent: WIN_UA }],
  ["phone", { ...devices["iPhone 13"] }],
];
for (const [label, opts] of shots) {
  const c = await browser.newContext({ ...opts, colorScheme: "light" });
  await mock(c);
  const p = await c.newPage();
  await p.goto(BASE + "/");
  await p.waitForSelector("#lock:not([hidden])");
  await p.waitForTimeout(300);
  await p.screenshot({ path: OUT + `${label}-lock.png` });
  await p.fill("#lock-input", PASSWORD);
  await p.click("#lock-btn");
  await p.waitForSelector("#app:not([hidden]) .file", { timeout: 60000 });
  await p.waitForTimeout(1200);
  if (await p.isVisible("#rename")) await p.click("#rename [data-close]");
  await p.mouse.move(1, 1);
  await p.screenshot({ path: OUT + `${label}-documents.png` });
  await p.locator(".file", { hasText: "Aufenthaltstitel" }).first().getByLabel("More options").click();
  await p.waitForTimeout(400);
  await p.screenshot({ path: OUT + `${label}-menu.png` });
  await p.keyboard.press("Escape");
  await p.waitForTimeout(300);
  await p.fill("#search", "visa");
  await p.waitForTimeout(500);
  await p.screenshot({ path: OUT + `${label}-search.png` });
  await p.fill("#search", "");
  await p.click("#tab-clips");
  await p.waitForSelector("#clip-list .clip");
  await p.mouse.move(1, 1);
  await p.waitForTimeout(600);
  await p.screenshot({ path: OUT + `${label}-clipboard.png` });
  await c.close();
}
await browser.close();
console.log("Screenshots in", OUT);
