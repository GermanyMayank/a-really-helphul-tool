// version.js
// The app's version and the "What's new" notes. Bump VERSION with every
// release (also in package.json and CHANGELOG.md); the What's new window opens
// once on each device after the version changes.

export const VERSION = "4.2.0";

// Newest first. Plain text only (rendered with textContent).
export const RELEASES = [
  {
    version: "4.2",
    items: [
      ["Select", "tap Select (or long-press on a phone) to download, favourite, send or delete many files at once."],
      ["Swipe", "on a phone, swipe a file left to move it to the Trash, right to favourite it."],
      ["Instant", "deletes and renames happen right away; GitHub catches up in the background."],
      ["Always up to date", "files from your other devices appear by themselves, glowing. Pull down to refresh."],
    ],
  },
  {
    version: "4.1",
    items: [
      ["Upload progress", "one bar shows the whole batch: file 2 of 5, percent and time left."],
      ["Cancel and Retry", "stop a batch any time; a failed file waits with Retry."],
      ["Smoother", "the bar glides at your screen's frame rate; windows, menus and messages slide in."],
    ],
  },
  {
    version: "4.0",
    items: [
      ["Trash", "deleted files wait 30 days before they are gone, and come back with one tap."],
      ["Install as an app", "add it to your home screen; it opens full screen, even offline."],
      ["Backup", "download every document in one zip, any time."],
      ["Dark mode", "follows your phone or laptop setting."],
      ["About page", "the link now has a front page that explains what the app is."],
      ["What's new", "this window, so you always know what changed."],
      ["Version number", "shown on the lock screen and at the bottom of the app."],
    ],
  },
  {
    version: "3.0",
    items: [
      ["New design", "bold kumkum red with haldi accents, favourite cards, sidebar on laptops."],
      ["Clickable links", "every web address in a clip opens in a new tab."],
    ],
  },
  {
    version: "1.4",
    items: [["Shared clipboard", "save a link or text on one device, copy it on another."]],
  },
  {
    version: "1.3",
    items: [
      ["Safer", "strict security rules and automatic tests before every release."],
      ["Quicker", "favourites, rename, undo delete, duplicate check, paste or drop to upload, smart search."],
    ],
  },
];
