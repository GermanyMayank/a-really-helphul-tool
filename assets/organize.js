// organize.js
// Pure helpers with no network and no DOM:
//   - categorize(name)       auto-sort a file into a category from its name
//   - searchFiles(list, q)   "smart" search (typos, file kinds, devices, dates)
//   - sortFiles(list, how)   newest / oldest / name / size
//   - thisDevice()           "iPhone", "Mac", "Windows PC" ...
//   - parseCommit(message)   read "Upload|Delete|Restore name [device, via]" commit messages
//   - formatDate(iso)
// To add a category or keyword, edit CATEGORIES below. Nothing else changes.

// ---------------------------------------------------------------------------
// Categories. A file goes to the category whose matching keyword is LONGEST
// (so "arbeitszeugnis" -> Work beats "zeugnis" -> Education).
// Keywords: English + German, lowercase, no umlauts (ä->a, ß->ss).
// ---------------------------------------------------------------------------
export const CATEGORIES = [
  {
    id: "id", label: "ID & Visa",
    aliases: "id identity visa passport permit papers",
    words: ["passport", "pass", "reisepass", "ausweis", "personalausweis", "visa", "visum", "aufenthalt",
      "aufenthaltstitel", "residence", "permit", "anmeldung", "meldebescheinigung", "ummeldung", "id", "aadhaar",
      "aadhar", "pan", "license", "licence", "fuhrerschein", "fuehrerschein", "driving", "birth",
      "geburtsurkunde", "bluecard", "fiktionsbescheinigung", "auslanderbehorde", "abh"],
  },
  {
    id: "work", label: "Work",
    aliases: "work job jobs career application",
    words: ["cv", "resume", "lebenslauf", "cover", "anschreiben", "motivation", "bewerbung", "application",
      "offer", "contract", "vertrag", "arbeitsvertrag", "job", "werkstudent", "internship", "praktikum",
      "reference", "arbeitszeugnis", "praktikumszeugnis", "kundigung", "employment", "payroll"],
  },
  {
    id: "edu", label: "Education",
    aliases: "education study school university uni",
    words: ["certificate", "zertifikat", "transcript", "degree", "diploma", "bachelor", "master", "masters",
      "thesis", "abschlussarbeit", "masterarbeit", "university", "uni", "ovgu", "semester", "enrollment",
      "enrolment", "immatrikulation", "immatrikulationsbescheinigung", "zeugnis", "marksheet", "grades",
      "noten", "course", "kurs", "exam", "prufung", "studienbescheinigung", "aps", "ielts", "toefl", "goethe"],
  },
  {
    id: "money", label: "Money",
    aliases: "money finance bank bills tax",
    words: ["invoice", "rechnung", "receipt", "quittung", "bank", "statement", "kontoauszug", "tax", "steuer",
      "steuererklarung", "payslip", "gehalt", "gehaltsabrechnung", "lohn", "salary", "insurance",
      "versicherung", "krankenkasse", "bill", "beleg", "sperrkonto", "blocked", "loan", "kredit"],
  },
  {
    id: "home", label: "Home",
    aliases: "home housing rent apartment flat",
    words: ["rent", "miete", "mietvertrag", "lease", "wohnung", "apartment", "flat", "nebenkosten", "kaution",
      "deposit", "wohnungsgeberbestatigung", "landlord", "vermieter", "strom", "electricity", "internet",
      "rundfunk", "rundfunkbeitrag", "gez", "hausrat"],
  },
];
export const PHOTOS = { id: "photos", label: "Photos", aliases: "photo photos picture pictures image images" };
export const OTHER = { id: "other", label: "Other", aliases: "other misc" };
export const ALL_CATEGORIES = [...CATEGORIES, PHOTOS, OTHER];

// File kinds by extension: label shown on the icon, colour class, MIME type,
// how to preview, and words people might type when searching.
const KINDS = {
  pdf: ["PDF", "pdf", "application/pdf", "pdf", "pdf document"],
  png: ["PNG", "img", "image/png", "image", "image photo picture pic scan"],
  jpg: ["JPG", "img", "image/jpeg", "image", "image photo picture pic scan"],
  jpeg: ["JPG", "img", "image/jpeg", "image", "image photo picture pic scan"],
  gif: ["GIF", "img", "image/gif", "image", "image picture"],
  webp: ["WEBP", "img", "image/webp", "image", "image photo picture"],
  svg: ["SVG", "img", "image/svg+xml", "image", "image graphic"],
  heic: ["HEIC", "img", "image/heic", "image", "image photo picture pic"],
  txt: ["TXT", "", "text/plain", "text", "text note notes"],
  md: ["MD", "", "text/plain", "text", "text note notes markdown"],
  csv: ["CSV", "sheet", "text/plain", "text", "table spreadsheet sheet"],
  json: ["JSON", "", "text/plain", "text", "data"],
  xml: ["XML", "", "text/plain", "text", "data"],
  log: ["LOG", "", "text/plain", "text", "text"],
  doc: ["DOC", "doc", "application/msword", "none", "word document"],
  docx: ["DOCX", "doc", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "none", "word document"],
  odt: ["ODT", "doc", "application/vnd.oasis.opendocument.text", "none", "word document"],
  xls: ["XLS", "sheet", "application/vnd.ms-excel", "none", "excel spreadsheet sheet table"],
  xlsx: ["XLSX", "sheet", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "none", "excel spreadsheet sheet table"],
  ppt: ["PPT", "", "application/vnd.ms-powerpoint", "none", "powerpoint slides presentation"],
  pptx: ["PPTX", "", "application/vnd.openxmlformats-officedocument.presentationml.presentation", "none", "powerpoint slides presentation"],
  zip: ["ZIP", "", "application/zip", "none", "zip archive"],
};

export function extOf(name) {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i + 1).toLowerCase() : "";
}

export function kindOf(name) {
  const ext = extOf(name);
  const k = KINDS[ext];
  if (!k) return { label: (ext || "FILE").slice(0, 4).toUpperCase(), cls: "", mime: "application/octet-stream", view: "none", words: ext };
  return { label: k[0], cls: k[1], mime: k[2], view: k[3], words: k[4] };
}

// "Lebenslauf_Jay-Gohil (2).PDF" -> ["lebenslauf", "jay", "gohil", "2", "pdf"]
export function words(text) {
  return String(text)
    .replace(/([a-z])([A-Z])/g, "$1 $2") // split camelCase
    .toLowerCase()
    .replace(/ß/g, "ss")
    .normalize("NFD").replace(/[̀-ͯ]/g, "") // strip accents/umlauts
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

// Does a file-name word match a category keyword?
// Short keywords must match exactly ("id" should not hit "idea"),
// longer ones may start the word, and long ones may sit inside German compounds.
function keywordHit(word, kw) {
  if (kw.length <= 4) return word === kw;
  if (kw.length === 5) return word.startsWith(kw);
  return word.includes(kw);
}

export function categorize(name) {
  const ws = words(name.replace(/\.[^.]+$/, ""));
  let best = null, bestLen = 0;
  for (const cat of CATEGORIES) {
    for (const kw of cat.words) {
      if (kw.length > bestLen && ws.some((w) => keywordHit(w, kw))) { best = cat; bestLen = kw.length; }
    }
  }
  if (best) return best;
  return kindOf(name).view === "image" ? PHOTOS : OTHER;
}

// ---------------------------------------------------------------------------
// Smart search
//   - every typed word must match (AND), in any order
//   - matches name, file type ("pdf", "photo", "excel"), category ("visa",
//     "work"), device ("iphone"), "shared", month/year ("march", "2026")
//   - prefix and in-word matches ("leben" finds Lebenslauf)
//   - one-letter typos are forgiven for words of 4+ letters ("pasport")
//   - date words: today, yesterday, week, month, year
// ---------------------------------------------------------------------------
const STOP = new Set(["from", "the", "a", "an", "my", "of", "in", "on", "via", "and", "with", "last", "this", "files", "file", "documents", "all", "by"]);
const MONTHS = [
  ["january", "jan", "januar"], ["february", "feb", "februar"], ["march", "mar", "marz", "maerz"], ["april", "apr"],
  ["may", "mai"], ["june", "jun", "juni"], ["july", "jul", "juli"], ["august", "aug"], ["september", "sep", "sept"],
  ["october", "oct", "oktober", "okt"], ["november", "nov"], ["december", "dec", "dezember", "dez"],
];
const DATE_WORDS = new Set(["today", "heute", "yesterday", "gestern", "week", "woche", "month", "monat", "year", "jahr"]);

// true if a and b differ by at most one edit (insert, delete, replace, swap)
function oneEdit(a, b) {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  if (i === a.length || i === b.length) return Math.abs(a.length - b.length) <= 1;
  const rest = (x, y) => a.slice(x) === b.slice(y);
  return rest(i + 1, i + 1) || rest(i + 1, i) || rest(i, i + 1) || (a[i] === b[i + 1] && a[i + 1] === b[i] && rest(i + 2, i + 2));
}

function wordMatches(token, hay) {
  return hay.some((w) =>
    w.startsWith(token) ||
    (token.length >= 3 && w.includes(token)) ||
    (token.length >= 4 && (oneEdit(token, w) || oneEdit(token, w.slice(0, token.length))))
  );
}

function dateMatches(token, iso, now = new Date()) {
  if (!iso) return false;
  const d = new Date(iso);
  const day = 864e5;
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  switch (token) {
    case "today": case "heute": return d.getTime() >= startOfToday;
    case "yesterday": case "gestern": return d.getTime() >= startOfToday - day && d.getTime() < startOfToday;
    case "week": case "woche": return now - d <= 7 * day;
    case "month": case "monat": return now - d <= 31 * day;
    case "year": case "jahr": return now - d <= 366 * day;
  }
  return false;
}

/** Build the searchable words for one decorated file (see app.js decorate()). */
function haystack(f) {
  const parts = [f.name, kindOf(f.name).words, extOf(f.name), f.category.label, f.category.aliases, f.device || "", f.via === "share" ? "shared share" : ""];
  if (f.date) {
    const d = new Date(f.date);
    parts.push(MONTHS[d.getMonth()].join(" "), String(d.getFullYear()));
  }
  return words(parts.join(" "));
}

export function searchFiles(list, query, now = new Date()) {
  const tokens = words(query).filter((t) => !STOP.has(t));
  if (!tokens.length) return list;
  return list.filter((f) => {
    const hay = f._hay || (f._hay = haystack(f));
    return tokens.every((t) => (DATE_WORDS.has(t) ? dateMatches(t, f.date, now) : wordMatches(t, hay)));
  });
}

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------
export const SORTS = {
  newest: { label: "Newest", fn: (a, b) => (b.date || "").localeCompare(a.date || "") || byName(a, b) },
  oldest: { label: "Oldest", fn: (a, b) => (a.date || "9").localeCompare(b.date || "9") || byName(a, b) },
  name: { label: "Name", fn: (a, b) => byName(a, b) },
  size: { label: "Largest", fn: (a, b) => b.size - a.size || byName(a, b) },
};
function byName(a, b) {
  return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
}
export function sortFiles(list, how) {
  return [...list].sort((SORTS[how] || SORTS.newest).fn);
}

// ---------------------------------------------------------------------------
// Where a file came from
// ---------------------------------------------------------------------------
export function thisDevice(ua = navigator.userAgent, touch = navigator.maxTouchPoints || 0) {
  if (/iPhone|iPod/.test(ua)) return "iPhone";
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && touch > 1)) return "iPad";
  if (/Android/.test(ua)) return "Android";
  if (/CrOS/.test(ua)) return "Chromebook";
  if (/Windows/.test(ua)) return "Windows PC";
  if (/Macintosh|Mac OS X/.test(ua)) return "Mac";
  if (/Linux/.test(ua)) return "Linux PC";
  return "Browser";
}

/**
 * Commit messages written by this app look like:
 *   "Upload CV.pdf [iPhone, share]"
 * Returns {action, name, device, via} or null for other messages.
 */
export function parseCommit(message) {
  const line = String(message || "").split("\n")[0].trim();
  // "Rename old.pdf -> new.pdf [Mac]"
  const r = line.match(/^Rename (.+?) -> (.+?)(?: \[([^\]]+)\])?$/);
  if (r) return { action: "Rename", from: r[1], name: r[2], device: r[3] || null, via: null };
  const m = line.match(/^(Upload|Delete|Restore) (.+?)(?: \[([^\],\]]+?)(?:, *([^\]]+?))?\])?$/);
  if (!m) return null;
  return { action: m[1], name: m[2], device: m[3] || null, via: m[4] || null };
}

/**
 * Can this browser show the file inline? Only then does a tap open the
 * preview; other files open the actions menu instead.
 */
export function canPreview(name, ua = navigator.userAgent) {
  const { view } = kindOf(name);
  const ext = extOf(name);
  if (view === "text") return true;
  if (view === "image") return ext !== "heic" || isSafari(ua); // only Safari decodes HEIC
  if (view === "pdf") return !/Android/i.test(ua) && (typeof navigator === "undefined" || navigator.pdfViewerEnabled !== false);
  return false;
}
const isSafari = (ua) => /Safari/.test(ua) && !/Chrome|Chromium|CriOS|Android/.test(ua);

export function formatDate(iso, now = new Date()) {
  if (!iso) return "";
  const d = new Date(iso);
  const sameDay = (a, b) => a.toDateString() === b.toDateString();
  const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  if (sameDay(d, now)) return `Today ${time}`;
  if (sameDay(d, new Date(now.getTime() - 864e5))) return `Yesterday ${time}`;
  const opts = { day: "numeric", month: "short" };
  if (d.getFullYear() !== now.getFullYear()) opts.year = "numeric";
  return d.toLocaleDateString("en-GB", opts);
}
