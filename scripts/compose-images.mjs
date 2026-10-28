// Turns the raw screenshots from scripts/screenshots.mjs into the framed
// images used by the README and the GitHub social preview.
//   node scripts/compose-images.mjs      (CHROMIUM_PATH=... to use your own Chromium)

import { chromium } from "playwright";
import { readFileSync } from "fs";

const IMG = new URL("../docs/images/", import.meta.url).pathname;
const uri = (file, type = "image/png") => `data:${type};base64,${readFileSync(file).toString("base64")}`;
const raw = (n) => uri(IMG + "raw/" + n + ".png");
const FONT = uri(new URL("../node_modules/@fontsource-variable/bricolage-grotesque/files/bricolage-grotesque-latin-wght-normal.woff2", import.meta.url).pathname, "font/woff2");
const ICON = uri(new URL("../assets/icon.svg", import.meta.url).pathname, "image/svg+xml");

// Bandhani: four white dots around a haldi centre, like the strip in the app
const bandhani = (dot = "#fff", centre = "#e3a21a", op = 1) =>
  `url("data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' width='28' height='28' opacity='${op}'><g fill='${dot}'><circle cx='14' cy='9' r='1.6'/><circle cx='14' cy='19' r='1.6'/><circle cx='9' cy='14' r='1.6'/><circle cx='19' cy='14' r='1.6'/></g><circle cx='14' cy='14' r='1.5' fill='${centre}'/></svg>`)}")`;

const CSS = `
@font-face { font-family: Bricolage; src: url(${FONT}) format("woff2"); font-weight: 200 800; }
* { box-sizing: border-box; margin: 0; }
body { font-family: Bricolage, sans-serif; -webkit-font-smoothing: antialiased; }
.stage { position: relative; overflow: hidden; }
.red { background: #faf6f4; color: #1c1414; }
.red p { color: #5e5350; opacity: 1 !important; }
.dots { position: absolute; inset: 0; background-image: ${bandhani("#a3201b", "#e3a21a", 0.5)};
        -webkit-mask-image: radial-gradient(ellipse 55% 75% at 0% 100%, #000 0%, transparent 70%); }
.window { position: absolute; background: #fff; border-radius: 14px; overflow: hidden;
          box-shadow: 0 2px 0 rgba(0,0,0,.04), 0 30px 80px rgba(40,6,4,.35); }
.bar { height: 44px; background: #f4f1f0; display: flex; align-items: center; gap: 8px; padding: 0 16px; border-bottom: 1px solid #e7e1df; }
.bar i { width: 12px; height: 12px; border-radius: 50%; background: #d9d1ce; }
.bar .url { margin-left: 18px; flex: 1; height: 26px; border-radius: 7px; background: #fff; border: 1px solid #e7e1df;
            font: 13px/26px system-ui, sans-serif; color: #6f6461; padding-left: 12px; }
.window img { display: block; width: 100%; }
.phone { position: absolute; background: #1c1414; border-radius: 58px; padding: 13px;
         box-shadow: 0 30px 70px rgba(40,6,4,.38), inset 0 0 0 2px #3a2f2e; }
.screen { border-radius: 46px; overflow: hidden; background: #fff; position: relative; }
.status { height: 47px; display: flex; justify-content: space-between; align-items: center; padding: 6px 30px 0 34px;
          font: 600 16px system-ui, sans-serif; color: #1c1414; }
.island { position: absolute; top: 11px; left: 50%; transform: translateX(-50%); width: 120px; height: 34px; border-radius: 20px; background: #1c1414; }
.screen img { display: block; width: 100%; }
`;

const browserWindow = (shot, { x, y, w, url = "germanymayank.github.io/a-really-helphul-tool" }) =>
  `<div class="window" style="left:${x}px;top:${y}px;width:${w}px"><div class="bar"><i></i><i></i><i></i><div class="url">${url}</div></div><img src="${raw(shot)}"></div>`;
const phone = (shot, { x, y, w = 330, rot = 0 }) =>
  `<div class="phone" style="left:${x}px;top:${y}px;width:${w}px;transform:rotate(${rot}deg)"><div class="screen"><div class="island"></div><div class="status"><span>9:41</span><span>●●● ▮</span></div><img src="${raw(shot)}"></div></div>`;

const pages = {
  // README hero
  hero: { w: 1600, h: 860, html: `<div class="stage red" style="width:1600px;height:860px">
    <div class="dots"></div>
    <div style="position:absolute;left:96px;top:92px;width:500px">
      <img src="${ICON}" style="width:76px;height:76px;border-radius:18px;box-shadow:0 10px 24px rgba(120,18,12,.25)">
      <h1 style="font-size:84px;line-height:.98;font-weight:700;letter-spacing:-2.5px;margin-top:34px">a really<br>helpful tool</h1>
      <p style="font-size:27px;line-height:1.35;font-weight:400;margin-top:26px;opacity:.88">Your passport, CV and contracts on every device. A shared clipboard between laptop and phone. Private, free, and all on GitHub.</p>
    </div>
    ${browserWindow("desktop-documents", { x: 760, y: 196, w: 1000 })}
    ${phone("phone-clipboard", { x: 640, y: 360, w: 330 })}
  </div>` },

  // three phones: search, menu, clipboard
  phones: { w: 1600, h: 800, html: `<div class="stage" style="width:1600px;height:800px;background:#fbf8f7">
    <div style="position:absolute;inset:0 0 auto;height:12px;background:#a3201b ${bandhani()};background-size:14px 14px"></div>
    ${phone("phone-search", { x: 175, y: 80, w: 360 })}
    ${phone("phone-menu", { x: 620, y: 80, w: 360 })}
    ${phone("phone-clipboard", { x: 1065, y: 80, w: 360 })}
  </div>` },

  // clipboard on a laptop
  clipboard: { w: 1600, h: 900, html: `<div class="stage" style="width:1600px;height:900px;background:#fbf8f7">
    ${browserWindow("desktop-clipboard", { x: 150, y: 70, w: 1300, url: "germanymayank.github.io/a-really-helphul-tool/#clipboard" })}
  </div>` },

  // GitHub social preview (Settings > General > Social preview), 1280x640
  "social-preview": { w: 1280, h: 640, html: `<div class="stage red" style="width:1280px;height:640px">
    <div class="dots"></div>
    <div style="position:absolute;left:84px;top:96px;width:620px">
      <img src="${ICON}" style="width:84px;height:84px;border-radius:20px;box-shadow:0 10px 24px rgba(120,18,12,.25)">
      <h1 style="font-size:92px;line-height:.96;font-weight:700;letter-spacing:-3px;margin-top:38px">a really<br>helpful tool</h1>
      <p style="font-size:30px;line-height:1.3;margin-top:28px;opacity:.88">Private documents and a shared clipboard on every device. No server, no bill.</p>
    </div>
    ${phone("phone-documents", { x: 820, y: 70, w: 360, rot: 4 })}
  </div>` },
};

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
for (const [name, { w, h, html }] of Object.entries(pages)) {
  const p = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: name === "social-preview" ? 1 : 2 });
  await p.setContent(`<!doctype html><style>${CSS}</style>${html}`);
  await p.evaluate(() => document.fonts.ready);
  await p.waitForTimeout(200);
  await p.screenshot({ path: IMG + name + ".png" });
  await p.close();
}
await browser.close();
console.log("Composed:", Object.keys(pages).join(", "));
