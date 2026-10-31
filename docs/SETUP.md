# Setup guide: a really helpful tool

About 10 minutes, all in the browser. You need a free GitHub account.

The friendlier version of this guide, with a check after every step, troubleshooting and your own links filled in, is the app's **Make your own** page: https://germanymayank.github.io/a-really-helphul-tool/make-your-own.html

Throughout this guide, replace `YOUR-USERNAME` with your GitHub username.

---

## Step 1. Put the app on GitHub

The app repo is **public** (it only holds code; free GitHub Pages needs a public repo). Your documents go in a separate **private** repo in step 3.

The owner's copy already lives at `https://github.com/GermanyMayank/a-really-helphul-tool`. To make your own, fork it, or:

```bash
gh repo create my-helpful-tool --public --source=. --push
```

## Step 2. Turn on GitHub Pages

1. Open the repo > **Settings** > **Pages**.
2. *Source*: **GitHub Actions**. (Not "Deploy from a branch": the workflow tests the app first and only deploys when everything passes.)
3. Open the **Actions** tab and wait for "Test and deploy" to turn green (about 2 minutes). If it ran before you changed the setting, click it and **Re-run all jobs**.
4. The app is at `https://YOUR-USERNAME.github.io/REPO-NAME/`, for the owner: `https://germanymayank.github.io/a-really-helphul-tool/`.

It will say "This site is not set up yet". That's expected.

## Step 3. Create the private vault repo

1. Go to https://github.com/new
2. Name: `docsync-vault`
3. Visibility: **Private** (important)
4. Tick **Add a README file** (the repo must not be completely empty).
5. Create repository.

## Step 4. Create an access token

This token lets the app read and write files in the vault, and nothing else.

1. Go to https://github.com/settings/personal-access-tokens/new (Settings > Developer settings > Personal access tokens > **Fine-grained tokens** > Generate new token).
2. **Token name**: `docsync`
3. **Expiration**: pick the longest you're comfortable with (up to 1 year, or "No expiration"). When it expires you redo steps 4 and 5.
4. **Repository access**: **Only select repositories** > choose `docsync-vault`.
5. **Permissions** > Repository permissions > **Contents**: **Read and write**. (Metadata: Read-only gets added automatically.) Leave everything else as "No access".
6. Generate token and copy it (starts with `github_pat_`). You will not see it again.

## Step 5. Generate your config

1. Open `https://YOUR-USERNAME.github.io/REPO-NAME/setup.html`
2. Fill in your username, `docsync-vault`, the token, and choose a password.
   - Use at least 10 characters. A short sentence is easy to type on a phone and hard to guess.
3. Click **Test token and generate config**, then **Copy**.

## Step 6. Save the config

1. Open `https://github.com/YOUR-USERNAME/REPO-NAME/blob/main/config.js`
2. Click the pencil icon (Edit).
3. Select everything, paste the copied config, **Commit changes**.
4. The commit starts the "Test and deploy" workflow. After about 2 minutes (green tick in the Actions tab) the site is updated.

## Step 7. Use it

Open `https://YOUR-USERNAME.github.io/REPO-NAME/` on any device, enter your password, done.

Tip for phones: use the browser's **Add to Home Screen** for one-tap access.
- iPhone (Safari): Share button > Add to Home Screen
- Android (Chrome): menu ⋮ > Install app

---

## Everyday questions

**I lost/changed phone.** Nothing to do. On the new device open the link and type the password. To cut off the old device, change the password (redo step 5 and 6 with a new token, then delete the old token on GitHub).

**Change password.** Redo step 5 with the same token and a new password, then step 6.

**Token expired.** The app will ask you to unlock again and fail. Create a new token (step 4), then steps 5 and 6.

**I deleted a file by mistake.** Tap **Undo** in the message that appears right after deleting. Later than that: go to `github.com/YOUR-USERNAME/docsync-vault/commits`, open the "Delete ..." commit, and view the file in the parent commit to download it.

**Where are my files really?** `github.com/YOUR-USERNAME/docsync-vault/tree/main/files`. You can also upload there directly; the app will show them.

**Upload fails with "too large".** The limit is 25 MB per file. Compress the PDF or split it. You can raise `maxFileMB` in `config.js` up to about 50.

**Does someone with the link see my files?** No. They see a password box. Your documents are in a private repo, and the token to reach it is encrypted with your password.
