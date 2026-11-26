/**
 * Factory for authenticated Google API clients, keyed by account email.
 *
 * Builds an OAuth2 client from the account's stored token. google-auth-library
 * transparently refreshes the access token when it expires; we listen for the
 * `tokens` event and persist the refreshed credentials back to the store.
 */

import { google } from "googleapis";
import type { OAuth2Client, Credentials } from "google-auth-library";
import type { gmail_v1, drive_v3, calendar_v3 } from "googleapis";
import {
  AccountNotAuthorized,
  TokenStore,
  getOAuthClient,
  getRedirectUri,
} from "./accounts.js";

/** A Google API call failed in a way worth reporting to the caller. */
export class GoogleApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoogleApiError";
  }
}

// Created on first use: a missing TOKEN_ENC_KEY must come back as a tool error, not kill the
// server at startup (the client would only see the connection close).
let cachedStore: TokenStore | undefined;
const tokenStore = (): TokenStore => (cachedStore ??= new TokenStore());

/**
 * Build an authenticated OAuth2 client for `account`, with auto-refresh +
 * persistence wired in.
 *
 * @throws AccountNotAuthorized if no token is stored for the account.
 */
export function makeAuthClient(account: string): OAuth2Client {
  const token = tokenStore().get(account);
  if (!token?.refresh_token) {
    throw new AccountNotAuthorized(account);
  }

  const { clientId, clientSecret } = getOAuthClient();
  const client = new google.auth.OAuth2(clientId, clientSecret, getRedirectUri());
  client.setCredentials(token as Credentials);

  // Persist refreshed tokens. The event fires on access-token refresh and may
  // or may not include a new refresh_token — merge to avoid losing it.
  client.on("tokens", (fresh) => {
    try {
      const existing = tokenStore().get(account) ?? {};
      tokenStore().set(account, { ...existing, ...fresh });
    } catch {
      // Persisting is best-effort; the in-memory client still works this run.
    }
  });

  return client;
}

export function gmail(account: string): gmail_v1.Gmail {
  return google.gmail({ version: "v1", auth: makeAuthClient(account) });
}

export function drive(account: string): drive_v3.Drive {
  return google.drive({ version: "v3", auth: makeAuthClient(account) });
}

export function calendar(account: string): calendar_v3.Calendar {
  return google.calendar({ version: "v3", auth: makeAuthClient(account) });
}

/** Extract HTTP status + reason from a googleapis (Gaxios) error. */
export function describeHttpError(err: unknown): string {
  const e = err as {
    code?: number | string;
    status?: number;
    response?: { status?: number; data?: { error?: { message?: string } } };
    errors?: Array<{ message?: string; reason?: string }>;
    message?: string;
  };
  const status = e.response?.status ?? e.status ?? e.code ?? "?";
  const reason =
    e.response?.data?.error?.message ??
    e.errors?.[0]?.message ??
    e.message ??
    "";

  const statusStr = String(status);
  if (statusStr === "429" || /rateLimit/i.test(reason)) {
    return `Rate limit hit (HTTP ${statusStr}): ${reason}. Retry shortly.`;
  }
  if (statusStr === "403") {
    return (
      `Permission denied (HTTP ${statusStr}): ${reason}. ` +
      "Check the API is enabled and the scope was granted."
    );
  }
  if (statusStr === "401") {
    return `Auth failed (HTTP ${statusStr}): ${reason}. Re-run auth for this account.`;
  }
  return `Google API error (HTTP ${statusStr}): ${reason}`;
}

/** Whether an error is a transient failure worth retrying. */
export function isTransient(err: unknown): boolean {
  const e = err as { code?: number | string; response?: { status?: number } };
  const status = String(e.response?.status ?? e.code ?? "");
  return (
    status === "429" ||
    status === "500" ||
    status === "503" ||
    /rateLimit/i.test(String((e as Error)?.message ?? ""))
  );
}
