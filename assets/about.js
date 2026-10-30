// about.js: keeps the version on the About page in step with version.js
import { VERSION } from "./version.js";
document.querySelectorAll(".version").forEach((e) => (e.textContent = `v${VERSION}`));
// let a visit to the front page prepare the app for offline use too
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
