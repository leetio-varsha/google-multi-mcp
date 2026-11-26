# google-multi-mcp

A local [MCP](https://modelcontextprotocol.io) server (TypeScript / Node.js)
that fronts **multiple Google accounts** through one connection. Every tool
takes an `account` (email) as its first argument; the server looks up that
account's OAuth credentials, refreshes the access token as needed, and calls the
relevant Google API (Gmail, Drive, Calendar) on its behalf.

Tokens are stored **encrypted at rest** (AES-256-GCM) in `tokens.enc`. Nothing
secret is committed to the repository.

Built with the official [`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk)
and [`googleapis`](https://github.com/googleapis/google-api-nodejs-client).

## Accounts (default registry)

Defined in [`config.json`](config.json):

- you@gmail.com
- you@yourcompany.com

Edit `config.json` to change the list, or create `config.local.json` (gitignored)
with the same shape to override it without touching the committed file.

## Tools

| Tool | Description |
| --- | --- |
| `list_accounts()` | Configured accounts and whether each is authorized. |
| `gmail_search(account, query, max_results=10)` | Search Gmail (Gmail query syntax). |
| `gmail_get_thread(account, thread_id)` | Full thread with plain-text bodies. |
| `gmail_create_draft(account, to, subject, body)` | Create a draft (does **not** send). |
| `drive_search(account, query, max_results=10)` | Search Drive by name / full text. |
| `drive_read_file(account, file_id)` | Read a file (Docs/Sheets/Slides exported to text). |
| `drive_list_recent(account, max_results=20)` | Most recently modified files. |
| `calendar_list_events(account, time_min?, time_max?)` | List primary-calendar events. |
| `calendar_create_event(account, summary, start, end, attendees?)` | Create an event. |

If an account has no token yet, the tool returns a clear error:
`No token for <account> — run: npm run auth -- <account>`.

## File layout

```
google-multi-mcp/
├── src/
│   ├── server.ts         # MCP server + tool definitions
│   ├── auth.ts           # OAuth CLI: authorize accounts, store refresh tokens
│   ├── accounts.ts       # registry (config.json) + encrypted token store
│   └── googleClients.ts  # builds authenticated Google API clients per account
├── config.json           # account registry + OAuth scopes
├── .env.example          # template for secrets (copy to .env)
├── package.json
├── tsconfig.json
├── .gitignore            # ignores .env, tokens.enc, config.local.json, dist, node_modules
└── README.md
```

---

## Setup

### 1. Create a Google Cloud project & enable APIs

1. Go to the [Google Cloud Console](https://console.cloud.google.com/) and
   create a project (or pick an existing one).
2. Enable these APIs (APIs & Services → Library):
   - **Gmail API**
   - **Google Drive API**
   - **Google Calendar API**

### 2. Configure the OAuth consent screen

1. APIs & Services → **OAuth consent screen**.
2. User type: **External** (unless all accounts are in one Google Workspace org,
   in which case **Internal** is simpler — no verification needed).
3. Fill in app name, support email, developer email.
4. **Scopes**: you can leave the scope list empty here; the server requests
   scopes at runtime. The scopes used are:
   - `gmail.readonly`, `gmail.compose`
   - `drive.readonly`, `drive.file`
   - `calendar`
5. **Test users**: while the app is in "Testing" status, add **every account**
   from the registry as a test user. Otherwise OAuth will refuse them.
   (Testing-mode refresh tokens expire after 7 days — publish the app to make
   them long-lived.)

### 3. Create an OAuth client (Desktop app)

1. APIs & Services → **Credentials** → **Create Credentials** → **OAuth client ID**.
2. Application type: **Desktop app**.
3. Copy the **Client ID** and **Client secret**.

> Note: `auth` runs a local redirect server on `http://localhost:<port>`
> (default `8765`). A Desktop-app client allows loopback redirects, so no extra
> redirect-URI configuration is normally required.

### 4. Install & build

```bash
cd google-multi-mcp
npm install
npm run build
```

### 5. Configure secrets

```bash
cp .env.example .env
```

Edit `.env`:

- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` — from step 3.
- `TOKEN_ENC_KEY` — generate one:

  ```bash
  node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
  ```

  Paste the output as `TOKEN_ENC_KEY`. Keep it safe; if you lose it, delete
  `tokens.enc` and re-run `auth`.

To keep secrets outside the checkout, put `.env` (and optionally
`config.local.json`) in a private directory and set `GMM_HOME` to it when
running `auth` and the server. `tokens.enc` is then written there too:

```bash
mkdir -m 700 ~/.config/google-multi-mcp
GMM_HOME=~/.config/google-multi-mcp npm run auth
```

### 6. Authorize the accounts

```bash
# Authorize every account in the registry (a browser opens for each):
npm run auth

# Or one at a time:
npm run auth -- you@gmail.com

# Check status:
npm run auth -- --status

# Revoke a stored token locally:
npm run auth -- --revoke you@gmail.com
```

For each account, sign in with **that specific Google account** and grant the
requested permissions. `auth` verifies the signed-in email matches the account
you asked for and warns if it doesn't.

> During development you can run the TypeScript directly without building:
> `npm run auth:dev -- <account>` and `npm run dev`.

### 7. Connect the server to Claude

**Claude Code** — register the server (adjust the path):

```bash
claude mcp add google-multi-mcp -- \
  node /absolute/path/to/google-multi-mcp/dist/server.js
```

**Claude Desktop** — add to `claude_desktop_config.json`
(`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):

```json
{
  "mcpServers": {
    "google-multi-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/google-multi-mcp/dist/server.js"]
    }
  }
}
```

Restart the client. Then try: *"List my connected Google accounts"* or
*"Search Gmail in you@gmail.com for unread invoices from this week."*

---

## How it works

- **`accounts.ts`** loads the registry/scopes from `config.json`, reads the
  OAuth client and `TOKEN_ENC_KEY` from `.env`, and provides `TokenStore` — an
  AES-256-GCM-encrypted JSON blob (`tokens.enc`) mapping each account to its
  token. File format is base64 of `iv(12) || authTag(16) || ciphertext`.
- **`auth.ts`** runs Google's installed-app OAuth flow per account
  (`access_type=offline`, `prompt=consent` to force a refresh token) using a
  one-shot loopback HTTP server to capture the redirect, then saves the result.
- **`googleClients.ts`** rebuilds an OAuth2 client from the stored token.
  google-auth-library refreshes the access token automatically when it expires;
  a `tokens` event listener persists the refreshed credentials back to the store.
- **`server.ts`** exposes the tools. Each call resolves the account, runs the
  API request with exponential-backoff retry on rate limits (HTTP 429/500/503),
  and returns structured JSON. Known failures are returned as `{ "error": ... }`
  rather than crashing the tool.

## Security notes

- `.env` and `tokens.enc` are gitignored — do not commit them.
- Or keep them out of the repo entirely with `GMM_HOME` (see step 5).
- `tokens.enc` is written with `0600` permissions.
- Scopes are minimal for the feature set: Gmail is read + compose (drafts only,
  **no send**); Drive is readonly + file; Calendar is full (needed to create
  events).

## Troubleshooting

- **`No token for <account>`** — run `npm run auth -- <account>`.
- **`Auth failed (HTTP 401)` / refresh errors** — re-run `auth` for that account.
  In Testing mode, tokens expire after 7 days; publish the consent screen to
  avoid this.
- **`Could not decrypt tokens.enc`** — `TOKEN_ENC_KEY` changed or the file is
  corrupt. Delete `tokens.enc` and re-authorize.
- **`access_denied` during OAuth** — the account isn't added as a test user on
  the consent screen (or the app isn't published).
- **No refresh_token returned** — revoke prior access at
  [myaccount.google.com/permissions](https://myaccount.google.com/permissions)
  and re-run; `auth` already passes `prompt=consent` to avoid this.
