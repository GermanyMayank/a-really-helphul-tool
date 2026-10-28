# Contributing

Thanks for helping. The project stays small on purpose, so a few rules keep it that way.

## Ground rules

1. **No build step and no runtime dependencies.** Plain HTML, CSS and ES modules that GitHub Pages can serve as-is.
2. **No external scripts, fonts or CDNs.** The Content Security Policy blocks them anyway.
3. **Only `assets/github.js` talks to GitHub.**
4. **Render user data with `textContent`**, never `innerHTML`.
5. **Simple UI.** New file actions go in the ⋯ menu. Use the colour tokens in `assets/style.css`; keep the bandhani pattern subtle.
6. Every new feature gets a check in `tests/e2e.mjs` and a line in `CHANGELOG.md`.

## Run it

```bash
npm install
npx playwright install chromium
npm run build                                   # writes _site/
python3 -m http.server 8080 --directory _site &
npm test                                        # all checks must print "ok"
```

For quick edits you can also serve the repo root directly: `python3 -m http.server 8080`.

## Pull requests

- Keep them focused, one change per PR.
- CI runs the browser tests on every PR; the site only deploys from `main` when they pass.
- Screenshots of UI changes (phone and desktop) help a lot. CI uploads the test screenshots as an artifact. If the change is visible, run `npm run screenshots` to refresh the README images.

New to the code? Start with [docs/AI_HANDOFF.md](docs/AI_HANDOFF.md); it is a map written for humans and AIs alike.
