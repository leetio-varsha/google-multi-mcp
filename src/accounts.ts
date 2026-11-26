/**
 * Account registry and encrypted token storage.
 *
 * Single source of truth for:
 *   - which Google accounts the server knows about (`config.json`),
 *   - which OAuth scopes are requested,
 *   - the OAuth client credentials (from `.env`), and
 *   - persisted OAuth tokens, encrypted at rest (AES-256-GCM) in `tokens.enc`.
 *
 * Nothing here talks to Google APIs directly — see `googleClients.ts`.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, renameSync, chmodSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
/** Project root — module lives in `src/` (tsx) or `dist/` (built), both one level down. */
export const BASE_DIR = path.resolve(moduleDir, "..");

/**
 * Where secrets and personal data live: `.env`, `tokens.enc` and
 * `config.local.json`. Defaults to the project root; set `GMM_HOME` to keep
 * them outside the checkout (e.g. a private 0700 directory).
 */
export const HOME_DIR = process.env.GMM_HOME
  ? path.resolve(process.env.GMM_HOME)
  : BASE_DIR;

export const CONFIG_PATH = path.join(BASE_DIR, "config.json");
export const CONFIG_LOCAL_PATH = path.join(HOME_DIR, "config.local.json");
export const TOKENS_PATH = path.join(HOME_DIR, "tokens.enc");

// Load .env once on import so every entry point (server, auth) sees it.
dotenv.config({ path: path.join(HOME_DIR, ".env") });

/** Raised when configuration or environment is missing/invalid. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/**
 * Raised when an account has no stored token yet.
 * The message is actionable so it can be surfaced verbatim to the MCP client.
 */
export class AccountNotAuthorized extends Error {
  constructor(public readonly account: string) {
    super(`No token for ${account} — run: npm run auth -- ${account}`);
    this.name = "AccountNotAuthorized";
  }
}

export interface AppConfig {
  accounts: string[];
  scopes: string[];
}

/** Shape of a persisted OAuth token (matches google-auth-library credentials). */
export interface StoredToken {
  refresh_token?: string | null;
  access_token?: string | null;
  expiry_date?: number | null;
  scope?: string | null;
  token_type?: string | null;
  id_token?: string | null;
}

// --------------------------------------------------------------------------- //
// Configuration
// --------------------------------------------------------------------------- //

/** Load `config.json` (overridden by `config.local.json` if present). */
export function loadConfig(): AppConfig {
  const file = existsSync(CONFIG_LOCAL_PATH) ? CONFIG_LOCAL_PATH : CONFIG_PATH;
  if (!existsSync(file)) {
    throw new ConfigError(`Config not found: ${file}`);
  }
  return JSON.parse(readFileSync(file, "utf-8")) as AppConfig;
}

/** Configured account emails, normalized to lowercase. */
export function getAccounts(): string[] {
  return (loadConfig().accounts ?? [])
    .map((a) => a.trim().toLowerCase())
    .filter((a) => a.length > 0);
}

/** OAuth scopes requested for every account. */
export function getScopes(): string[] {
  const scopes = loadConfig().scopes ?? [];
  if (scopes.length === 0) {
    throw new ConfigError("No scopes defined in config.json");
  }
  return scopes;
}

/** Whether `account` is part of the configured registry. */
export function isKnownAccount(account: string): boolean {
  return getAccounts().includes(account.trim().toLowerCase());
}

/** Return `{ clientId, clientSecret }` from the environment. */
export function getOAuthClient(): { clientId: string; clientSecret: string } {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new ConfigError(
      "GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are not set. " +
        "Copy .env.example to .env and fill them in.",
    );
  }
  return { clientId, clientSecret };
}

/** Local redirect port used by the OAuth installed-app flow. */
export function getRedirectPort(): number {
  const raw = process.env.OAUTH_REDIRECT_PORT ?? "8765";
  const port = Number.parseInt(raw, 10);
  if (Number.isNaN(port)) {
    throw new ConfigError("OAUTH_REDIRECT_PORT must be an integer");
  }
  return port;
}

/** Loopback redirect URI for the OAuth flow. */
export function getRedirectUri(): string {
  return `http://localhost:${getRedirectPort()}`;
}

// --------------------------------------------------------------------------- //
// Encrypted token store (AES-256-GCM)
// --------------------------------------------------------------------------- //

const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

type StoreData = Record<string, StoredToken>;

/**
 * Encrypted, file-backed store of per-account OAuth tokens.
 *
 * File format (base64): `iv(12) || authTag(16) || ciphertext`.
 * Decrypted payload is a JSON object keyed by lowercased account email.
 */
export class TokenStore {
  private readonly key: Buffer;

  constructor(
    key: string | undefined = process.env.TOKEN_ENC_KEY,
    private readonly filePath: string = TOKENS_PATH,
  ) {
    if (!key) {
      throw new ConfigError(
        "TOKEN_ENC_KEY is not set. Generate one with:\n" +
          "  node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\"",
      );
    }
    const buf = Buffer.from(key, "base64");
    if (buf.length !== 32) {
      throw new ConfigError(
        "TOKEN_ENC_KEY must be 32 random bytes encoded as base64 (got " +
          `${buf.length} bytes).`,
      );
    }
    this.key = buf;
  }

  /** Decrypt and return the whole store (empty object if no file yet). */
  load(): StoreData {
    if (!existsSync(this.filePath)) {
      return {};
    }
    let blob: Buffer;
    try {
      blob = Buffer.from(readFileSync(this.filePath, "utf-8"), "base64");
      const iv = blob.subarray(0, IV_LENGTH);
      const authTag = blob.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
      const ciphertext = blob.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
      const decipher = createDecipheriv("aes-256-gcm", this.key, iv);
      decipher.setAuthTag(authTag);
      const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      return JSON.parse(plain.toString("utf-8")) as StoreData;
    } catch (err) {
      throw new ConfigError(
        `Could not decrypt ${path.basename(this.filePath)}: wrong TOKEN_ENC_KEY ` +
          "or corrupted file. Delete it and re-run auth. " +
          `(${(err as Error).message})`,
      );
    }
  }

  /** Encrypt and atomically write the whole store with 0600 perms. */
  save(data: StoreData): void {
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(data, null, 2), "utf-8"),
      cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();
    const blob = Buffer.concat([iv, authTag, ciphertext]).toString("base64");

    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, blob, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.filePath);
  }

  /** Token for `account` or `undefined`. */
  get(account: string): StoredToken | undefined {
    return this.load()[account.trim().toLowerCase()];
  }

  /** Insert/update the token for `account` and persist. */
  set(account: string, token: StoredToken): void {
    const data = this.load();
    data[account.trim().toLowerCase()] = token;
    this.save(data);
  }

  /** Remove `account`'s token. Returns true if it existed. */
  delete(account: string): boolean {
    const data = this.load();
    const key = account.trim().toLowerCase();
    if (!(key in data)) return false;
    delete data[key];
    this.save(data);
    return true;
  }

  /** Accounts that currently have a stored token. */
  accounts(): string[] {
    return Object.keys(this.load()).sort();
  }
}
