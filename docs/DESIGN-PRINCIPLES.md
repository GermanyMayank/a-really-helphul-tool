# Design principles

## 1. Instant first, network second

**Nothing the user does ever waits on GitHub.** The screen changes in the same
frame as the tap; the network catches up in the background and only speaks up
when something actually went wrong. The app should feel faster than it is.

Every change is checked against these rules:

1. **Show something immediately.** Every screen opens from the last known state
   (file list, favourites, clipboard, trash) and refreshes quietly. Never a blank
   screen. On a device's very first visit, placeholder rows shaped like the real
   list stand in.
2. **Optimistic actions.** Delete, rename, favourite and bulk actions update the
   screen at once. The commit runs in the background; if it fails, the change
   rolls back with a clear message. Undo is always offered and works even while
   the first commit is still running.
3. **Feedback within one frame.** Every tap shows something within ~16 ms: a
   press state, a check, a row moving.
4. **Motion hides the wait.** A 200 ms slide covers a 200 ms network call.
   Progress glides, never jumps. Animate only `transform` and `opacity` so the
   GPU can draw at the screen's own rate (60 to 120 fps). Respect "reduce motion".
5. **Prefetch the likely next step.** Start downloading a file when the finger
   lands or the pointer hovers, not when the tap ends.
6. **Sync in the background.** The app checks for new files when it comes back
   into view and every 20 s while open, with conditional requests (ETag), so an
   unchanged answer is free. New files arrive by themselves, with a glow.
7. **Spinners are a last resort.** Prefer placeholders shaped like the content.
8. **Measure it.** The tests hold the line: the cached list appears while
   GitHub is still answering, a delete leaves the screen before its commit
   lands, the upload bar animates frame by frame. A change that makes the app
   feel slower fails CI.

## 2. Simple first

One link, one password, nothing to install. New features go where they are
found without explanation (a menu, a gesture people already know) and never
add a setting.

## 3. Your data stays yours

Documents live in the user's own private repo. The app is static; the token is
encrypted with the user's password; nothing is sent anywhere else.
