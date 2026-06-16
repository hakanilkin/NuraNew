# Deployment

How to deploy Nura to production and the pitfalls already encountered.

## Deploy sequence

Production serves the built React app and the API from the same Express
process (`NODE_ENV=production`). Each deploy must:

1. **Get the latest code** (deploy `main`).
2. **Install dependencies** — `node_modules` is NOT committed:
   ```bash
   npm install
   ```
3. **Build the client** (this also installs the client's deps):
   ```bash
   npm run build        # outputs client/dist
   ```
4. **Set environment variables** (see `.env.example`). Required in production:
   `NODE_ENV=production`, `SESSION_SECRET` (the server exits without it),
   the `DB_*` vars, `AUTH_DB_DATABASE`, `TENANT_DB_ENC_KEY`, `ANTHROPIC_API_KEY`.
   Leave `DB_TRUST_SERVER_CERT` unset for Azure SQL.
5. **Restart the app.**

## Pitfalls (learned the hard way)

### Old pages appear instead of the current app
A previous, pre-React version of Nura left HTML files in the server's
`public/` folder. The app now serves **only `public/data`** at `/data`, so
stray files can no longer shadow the React app — but if the prod server still
has those old files on disk from a past deployment, delete everything in
`public/` **except the `data/` folder`** once.

### Deployments don't take effect / browser shows stale UI
`index.html` is served with `Cache-Control: no-cache` and the hashed
`/assets/*` bundles are cached immutably, so new deploys are picked up
automatically. After deploying, do one hard refresh (Ctrl+F5) to flush any
old cached HTML in your own browser.

### "Cannot find module" on the server, or "Failed to resolve import" locally
A missed `npm install`. Run it in the relevant folder (root for the server,
`client/` for the frontend) after pulling changes that touch `package.json`.

### Use a clean/mirroring deploy method
Copy-based deploys (FTP/zip) can layer new files over old ones. Prefer a
method that replaces the target (e.g. `rsync --delete`, or Azure zip deploy /
`az webapp deploy --clean true`) so removed files actually disappear.

## Encrypting existing tenant passwords

After setting `TENANT_DB_ENC_KEY` for the first time, existing tenant rows are
still plaintext (they keep working). To encrypt them, open the Admin page,
edit each tenant, and re-enter its DB password — it is stored encrypted on save.

## Security follow-up

`Q1_2026_Discharge_Data.xlsx` was committed in the past and remains in git
history. It is untracked now, but anyone with the history can still retrieve
it. Purge it with `git filter-repo --invert-paths --path
Q1_2026_Discharge_Data.xlsx` (and force-push) before sharing the repo widely.
