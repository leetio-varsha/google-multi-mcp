/**
 * Interactive OAuth authorization CLI for google-multi-mcp.
 *
 * Runs Google's installed-app OAuth flow for one or more accounts and stores
 * the resulting refresh tokens (encrypted) in `tokens.enc`.
 *
 * Usage:
 *   npm run auth                      # authorize every account in the registry
 *   npm run auth -- user@gmail.com    # authorize a single account
 *   npm run auth -- --status          # show which accounts are authorized
 *   npm run auth -- --revoke EMAIL    # remove a stored token
 *
 * (During development use `npm run auth:dev -- ...` to run via tsx.)
 */

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { google } from "googleapis";
import {
  AccountNotAuthorized,
  ConfigError,
  TokenStore,
  getAccounts,
  getOAuthClient,
  getRedirectPort,
  getRedirectUri,
  getScopes,
  isKnownAccount,
} from "./accounts.js";

/** Best-effort: open `url` in the user's default browser. */
function openBrowser(url: string): void {
  const platform = process.platform;
  const cmd =
    platform === "darwin" ? "open" : platform === "win32" ? "start" : "xdg-open";
  try {
    const child = spawn(cmd, [url], {
      stdio: "ignore",
      detached: true,
      shell: platform === "win32",
    });
    child.unref();
  } catch {
    // Falls back to the printed URL below.
  }
}

/**
 * Start a one-shot loopback server, open the consent URL, and resolve with the
 * authorization `code` once Google redirects back.
 */
function waitForCode(authUrl: string): Promise<string> {
  const port = getRedirectPort();
  return new Promise<string>((resolve, reject) => {
    const server = createServer((req, res) => {
      try {
        const url = new URL(req.url ?? "/", `http://localhost:${port}`);
        const code = url.searchParams.get("code");
        const error = url.searchParams.get("error");
        if (error) {
          res.writeHead(400, { "Content-Type": "text/plain" });
          res.end(`Authorization failed: ${error}`);
          server.close();
          reject(new Error(`OAuth error: ${error}`));
          return;
        }
        if (!code) {
          res.writeHead(400, { "Content-Type": "text/plain" });
          res.end("Missing authorization code.");
          return;
        }
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(
          "<html><body><h2>Authorized.</h2>" +
            "<p>You can close this tab and return to the terminal.</p></body></html>",
        );
        server.close();
        resolve(code);
      } catch (err) {
        server.close();
        reject(err as Error);
      }
    });

    server.on("error", reject);
    server.listen(port, () => {
      console.log(`\nOpening browser for consent (listening on ${getRedirectUri()})`);
      console.log("If the browser does not open, visit this URL manually:\n");
      console.log(authUrl + "\n");
      openBrowser(authUrl);
    });
  });
}

/** Run the OAuth flow for a single account and persist its token. */
async function authorizeAccount(account: string, store: TokenStore): Promise<void> {
  console.log(`\n=== Authorizing ${account} ===`);
  const { clientId, clientSecret } = getOAuthClient();
  const client = new google.auth.OAuth2(clientId, clientSecret, getRedirectUri());

  const authUrl = client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent", // force a refresh_token even on re-auth
    scope: getScopes(),
    login_hint: account,
  });

  const code = await waitForCode(authUrl);
  const { tokens } = await client.getToken(code);

  if (!tokens.refresh_token) {
    console.error(
      "  ! No refresh_token returned. Revoke prior access at " +
        "https://myaccount.google.com/permissions and retry.",
    );
    return;
  }

  store.set(account, tokens);

  // Verify the signed-in identity matches the requested account.
  try {
    client.setCredentials(tokens);
    const gmail = google.gmail({ version: "v1", auth: client });
    const profile = await gmail.users.getProfile({ userId: "me" });
    const signedIn = profile.data.emailAddress ?? "";
    if (signedIn && signedIn.toLowerCase() !== account.toLowerCase()) {
      console.error(
        `  ! WARNING: you signed in as ${signedIn}, not ${account}. ` +
          "Token saved under the requested key anyway — re-run if wrong.",
      );
    } else {
      console.log(`  ✓ Saved token for ${account}`);
    }
  } catch (err) {
    console.log(
      `  ✓ Saved token for ${account} (identity check skipped: ${(err as Error).message})`,
    );
  }
}

/** Print authorization status for every registered account. */
function showStatus(store: TokenStore): void {
  const authorized = new Set(store.accounts());
  const registry = getAccounts();
  console.log("Account status:");
  for (const account of registry) {
    const mark = authorized.has(account) ? "✓ authorized" : "✗ missing";
    console.log(`  ${mark.padEnd(14)} ${account}`);
  }
  for (const account of [...authorized].filter((a) => !registry.includes(a)).sort()) {
    console.log(`  ✓ authorized   ${account}  (not in registry)`);
  }
}

async function main(argv: string[]): Promise<number> {
  try {
    const store = new TokenStore();

    if (argv.includes("--status")) {
      showStatus(store);
      return 0;
    }

    const revokeIdx = argv.indexOf("--revoke");
    if (revokeIdx !== -1) {
      const email = argv[revokeIdx + 1];
      if (!email) {
        console.error("--revoke requires an email argument");
        return 1;
      }
      const removed = store.delete(email);
      console.log(`${removed ? "Removed" : "No"} token for ${email}`);
      return 0;
    }

    const account = argv.find((a) => !a.startsWith("--"));
    if (account) {
      if (!isKnownAccount(account)) {
        console.error(`Note: ${account} is not in config.json. Authorizing anyway.`);
      }
      await authorizeAccount(account.trim().toLowerCase(), store);
    } else {
      const accounts = getAccounts();
      if (accounts.length === 0) {
        console.error("No accounts in config.json.");
        return 1;
      }
      console.log(`Authorizing ${accounts.length} account(s). A browser opens for each.`);
      for (const acct of accounts) {
        await authorizeAccount(acct, store);
      }
    }

    console.log("\nDone.");
    showStatus(store);
    return 0;
  } catch (err) {
    if (err instanceof ConfigError || err instanceof AccountNotAuthorized) {
      console.error(`Error: ${err.message}`);
    } else {
      console.error(`Error: ${(err as Error).message}`);
    }
    return 1;
  }
}

main(process.argv.slice(2)).then((code) => process.exit(code));
