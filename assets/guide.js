// guide.js: the "Make your own" page. Fills the reader's GitHub username,
// copy name and vault name into every address and link as they type, and
// wires the Copy buttons. Nothing is stored or sent: this page has
// connect-src 'none' and no storage.

const $ = (id) => document.getElementById(id);
const PLACEHOLDER = { user: "YOUR-USERNAME", userlc: "your-username" };

// What GitHub allows in a username / repository name. Anything else is
// dropped so a typo can't turn into a strange link.
export const cleanUser = (s) => s.trim().replace(/^@/, "").replace(/[^A-Za-z0-9-]/g, "").slice(0, 39);
export const cleanRepo = (s) => s.trim().replace(/[^A-Za-z0-9._-]/g, "").slice(0, 100);

export function values(userIn, repoIn, vaultIn) {
  const user = cleanUser(userIn);
  const repo = cleanRepo(repoIn) || "a-really-helphul-tool";
  const vault = cleanRepo(vaultIn) || "docsync-vault";
  const host = `${user ? user.toLowerCase() : PLACEHOLDER.user}.github.io`;
  // a repo called <user>.github.io is served from the root of the address
  const site = repo.toLowerCase() === `${user.toLowerCase()}.github.io` && user ? `https://${host}/` : `https://${host}/${repo}/`;
  return { user, repo, vault, site };
}

function render() {
  const v = values($("g-user").value, $("g-repo").value, $("g-vault").value);
  const text = {
    user: v.user || PLACEHOLDER.user,
    userlc: v.user ? v.user.toLowerCase() : PLACEHOLDER.userlc,
    repo: v.repo,
    vault: v.vault,
    site: v.site,
    setup: v.site + "setup.html",
  };
  document.querySelectorAll("[data-f]").forEach((el) => (el.textContent = text[el.dataset.f]));
  document.querySelectorAll("a[data-link]").forEach((a) => {
    const t = a.dataset.link;
    if (!v.user && /\{(user|site)\}/.test(t)) {
      a.href = "#you"; // no username yet: the link takes you to the box instead
      a.removeAttribute("target");
      a.classList.add("g-wait");
      return;
    }
    a.href = t.replace("{user}", v.user).replace("{repo}", v.repo).replace("{vault}", v.vault).replace("{site}", v.site);
    a.target = "_blank";
    a.classList.remove("g-wait");
  });
}

// The helpers above are pure (the tests import them in Node); the page
// wiring below runs only in the browser.
if (typeof document !== "undefined" && document.getElementById("g-user")) init();

function init() {
  for (const id of ["g-user", "g-repo", "g-vault"]) $(id).addEventListener("input", render);
  document.addEventListener("click", (e) => {
    const a = e.target.closest("a.g-wait");
    if (!a) return;
    e.preventDefault();
    $("you").scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
    $("g-user").focus({ preventScroll: true });
  });
  render();

  // Copy buttons copy the text right before them
  document.querySelectorAll(".g-copy").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const text = btn.previousElementSibling.textContent;
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        const r = document.createRange();
        r.selectNodeContents(btn.previousElementSibling);
        getSelection().removeAllRanges();
        getSelection().addRange(r);
        document.execCommand("copy");
      }
      btn.textContent = "Copied";
      btn.classList.add("done");
      setTimeout(() => { btn.textContent = "Copy"; btn.classList.remove("done"); }, 1600);
    });
  });
}
