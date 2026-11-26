#!/usr/bin/env node
/**
 * google-multi-mcp — one MCP server fronting several Google accounts.
 *
 * Every tool takes an `account` (email) as its first argument. The server looks
 * up that account's OAuth credentials, refreshes them if needed, and calls the
 * relevant Google API on its behalf. Configure accounts in `config.json` and
 * authorize them with `auth.ts` before use.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { gmail_v1 } from "googleapis";

import {
  AccountNotAuthorized,
  ConfigError,
  TokenStore,
  getAccounts,
} from "./accounts.js";
import {
  GoogleApiError,
  calendar,
  describeHttpError,
  drive,
  gmail,
  isTransient,
} from "./googleClients.js";

const server = new McpServer({ name: "google-multi-mcp", version: "1.0.0" });

/** Drive fields reused across search/recent listings. */
const DRIVE_FIELDS =
  "files(id, name, mimeType, modifiedTime, owners(emailAddress), webViewLink, size)";

/** Google Docs editor MIME types and the plain-text export used for each. */
const GOOGLE_EXPORTS: Record<string, string> = {
  "application/vnd.google-apps.document": "text/plain",
  "application/vnd.google-apps.spreadsheet": "text/csv",
  "application/vnd.google-apps.presentation": "text/plain",
};

/** Largest file body we return inline (chars). */
const MAX_INLINE_CHARS = 200_000;

// --------------------------------------------------------------------------- //
// Helpers
// --------------------------------------------------------------------------- //

/** Wrap an object as an MCP text result (pretty JSON). */
function jsonResult(obj: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] };
}

/** Run an async Google call with exponential backoff on transient failures. */
async function execute<T>(fn: () => Promise<T>, retries = 4): Promise<T> {
  let delay = 1000;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt < retries && isTransient(err)) {
        await new Promise((r) => setTimeout(r, delay));
        delay = Math.min(delay * 2, 16_000);
        continue;
      }
      throw err;
    }
  }
}

/** Wrap a tool handler so known failures return `{ error }` instead of throwing. */
function guard(
  handler: (args: any) => Promise<CallToolResult>,
): (args: any) => Promise<CallToolResult> {
  return async (args: any) => {
    try {
      return await handler(args);
    } catch (err) {
      if (err instanceof AccountNotAuthorized || err instanceof GoogleApiError) {
        return jsonResult({ error: err.message });
      }
      if (err instanceof ConfigError) {
        return jsonResult({ error: `Configuration problem: ${err.message}` });
      }
      // Treat anything with an HTTP shape as a Google API error.
      const e = err as { response?: unknown; code?: unknown };
      if (e.response !== undefined || e.code !== undefined) {
        return jsonResult({ error: describeHttpError(err) });
      }
      return jsonResult({
        error: `Unexpected error: ${(err as Error).name}: ${(err as Error).message}`,
      });
    }
  };
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(n, hi));

// --- Gmail parsing -------------------------------------------------------- //

function headersToDict(headers: gmail_v1.Schema$MessagePartHeader[] = []): Record<string, string> {
  const out: Record<string, string> = {};
  for (const h of headers) {
    if (h.name) out[h.name.toLowerCase()] = h.value ?? "";
  }
  return out;
}

function decodeBody(data: string): string {
  return Buffer.from(data, "base64url").toString("utf-8");
}

/** Walk a Gmail payload and return the best-effort plain-text body. */
function extractPlainText(payload?: gmail_v1.Schema$MessagePart): string {
  if (!payload) return "";
  const body = payload.body;
  if (payload.mimeType === "text/plain" && body?.data) {
    return decodeBody(body.data);
  }
  const parts = payload.parts ?? [];
  for (const part of parts) {
    if (part.mimeType === "text/plain" && part.body?.data) {
      return decodeBody(part.body.data);
    }
  }
  for (const part of parts) {
    const text = extractPlainText(part);
    if (text) return text;
  }
  return body?.data ? decodeBody(body.data) : "";
}

function summarizeMessage(msg: gmail_v1.Schema$Message): Record<string, unknown> {
  const h = headersToDict(msg.payload?.headers ?? []);
  return {
    id: msg.id,
    thread_id: msg.threadId,
    labels: msg.labelIds ?? [],
    from: h["from"] ?? "",
    to: h["to"] ?? "",
    subject: h["subject"] ?? "",
    date: h["date"] ?? "",
    snippet: msg.snippet ?? "",
  };
}

// --------------------------------------------------------------------------- //
// Tools
// --------------------------------------------------------------------------- //

server.tool(
  "list_accounts",
  "List configured Google accounts and whether each is authorized (has a stored refresh token).",
  {},
  guard(async () => {
    const store = new TokenStore();
    const authorized = new Set(store.accounts());
    const registry = getAccounts();
    const accounts: Record<string, unknown>[] = registry.map((acct) => ({
      account: acct,
      authorized: authorized.has(acct),
    }));
    for (const acct of [...authorized].filter((a) => !registry.includes(a)).sort()) {
      accounts.push({ account: acct, authorized: true, in_registry: false });
    }
    return jsonResult({
      accounts,
      authorized_count: registry.filter((a) => authorized.has(a)).length,
      total: registry.length,
      hint: "Run `npm run auth -- <account>` for any account that is not authorized.",
    });
  }),
);

server.tool(
  "gmail_search",
  "Search Gmail for an account using Gmail query syntax (e.g. 'from:boss is:unread newer_than:7d').",
  {
    account: z.string().describe("Account email (must be authorized)."),
    query: z.string().describe("Gmail search query."),
    max_results: z.number().int().optional().describe("Max messages to return (1-50, default 10)."),
  },
  guard(async ({ account, query, max_results }) => {
    const max = clamp(max_results ?? 10, 1, 50);
    const svc = gmail(account);
    const listing = await execute(() =>
      svc.users.messages.list({ userId: "me", q: query, maxResults: max }),
    );
    const ids = (listing.data.messages ?? []).map((m) => m.id!).filter(Boolean);
    const messages: Record<string, unknown>[] = [];
    for (const id of ids) {
      const full = await execute(() =>
        svc.users.messages.get({
          userId: "me",
          id,
          format: "metadata",
          metadataHeaders: ["From", "To", "Subject", "Date"],
        }),
      );
      messages.push(summarizeMessage(full.data));
    }
    return jsonResult({ account, query, count: messages.length, messages });
  }),
);

server.tool(
  "gmail_get_thread",
  "Fetch a full Gmail thread (all messages, headers, and plain-text bodies).",
  {
    account: z.string().describe("Account email (must be authorized)."),
    thread_id: z.string().describe("Gmail thread id (from gmail_search)."),
  },
  guard(async ({ account, thread_id }) => {
    const svc = gmail(account);
    const thread = await execute(() =>
      svc.users.threads.get({ userId: "me", id: thread_id, format: "full" }),
    );
    const messages = (thread.data.messages ?? []).map((msg) => ({
      ...summarizeMessage(msg),
      body: extractPlainText(msg.payload),
    }));
    return jsonResult({ account, thread_id, messages });
  }),
);

server.tool(
  "gmail_create_draft",
  "Create a Gmail draft (does NOT send it).",
  {
    account: z.string().describe("Account email (must be authorized)."),
    to: z.string().describe("Recipient address(es), comma-separated."),
    subject: z.string().describe("Email subject."),
    body: z.string().describe("Plain-text email body."),
  },
  guard(async ({ account, to, subject, body }) => {
    const mime = [
      `To: ${to}`,
      `From: ${account}`,
      `Subject: ${subject}`,
      "Content-Type: text/plain; charset=utf-8",
      "MIME-Version: 1.0",
      "",
      body,
    ].join("\r\n");
    const raw = Buffer.from(mime, "utf-8").toString("base64url");

    const svc = gmail(account);
    const draft = await execute(() =>
      svc.users.drafts.create({ userId: "me", requestBody: { message: { raw } } }),
    );
    return jsonResult({
      account,
      draft_id: draft.data.id,
      message_id: draft.data.message?.id,
      to,
      subject,
      status: "draft created (not sent)",
    });
  }),
);

server.tool(
  "drive_search",
  "Search Google Drive for an account by file name / full-text content.",
  {
    account: z.string().describe("Account email (must be authorized)."),
    query: z.string().describe("Free text matched against file name and content."),
    max_results: z.number().int().optional().describe("Max files to return (1-50, default 10)."),
  },
  guard(async ({ account, query, max_results }) => {
    const max = clamp(max_results ?? 10, 1, 50);
    const safe = query.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    const q = `(name contains '${safe}' or fullText contains '${safe}') and trashed = false`;
    const svc = drive(account);
    const res = await execute(() =>
      svc.files.list({
        q,
        pageSize: max,
        fields: DRIVE_FIELDS,
        orderBy: "modifiedTime desc",
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      }),
    );
    return jsonResult({ account, query, files: res.data.files ?? [] });
  }),
);

server.tool(
  "drive_read_file",
  "Read a Drive file's content (Google Docs/Sheets/Slides are exported to text). Binary or oversized files return metadata only.",
  {
    account: z.string().describe("Account email (must be authorized)."),
    file_id: z.string().describe("Drive file id (from drive_search / drive_list_recent)."),
  },
  guard(async ({ account, file_id }) => {
    const svc = drive(account);
    const metaRes = await execute(() =>
      svc.files.get({
        fileId: file_id,
        fields: "id, name, mimeType, size, modifiedTime, webViewLink",
        supportsAllDrives: true,
      }),
    );
    const meta = metaRes.data;
    const mime = meta.mimeType ?? "";
    const result: Record<string, unknown> = { account, metadata: meta };

    if (mime in GOOGLE_EXPORTS) {
      const exp = await execute(() =>
        svc.files.export(
          { fileId: file_id, mimeType: GOOGLE_EXPORTS[mime] },
          { responseType: "text" },
        ),
      );
      const text = String(exp.data ?? "");
      result.content = text.slice(0, MAX_INLINE_CHARS);
      result.truncated = text.length > MAX_INLINE_CHARS;
      return jsonResult(result);
    }

    if (mime.startsWith("text/") || mime === "application/json" || mime === "application/xml") {
      const size = Number(meta.size ?? 0);
      if (size && size > MAX_INLINE_CHARS) {
        result.note = `File too large to return inline (${size} bytes).`;
        return jsonResult(result);
      }
      const media = await execute(() =>
        svc.files.get({ fileId: file_id, alt: "media" }, { responseType: "text" }),
      );
      result.content = String(media.data ?? "");
      return jsonResult(result);
    }

    result.note = `Binary file (${mime}) not returned inline. Open via webViewLink.`;
    return jsonResult(result);
  }),
);

server.tool(
  "drive_list_recent",
  "List the most recently modified Drive files for an account.",
  {
    account: z.string().describe("Account email (must be authorized)."),
    max_results: z.number().int().optional().describe("Max files to return (1-50, default 20)."),
  },
  guard(async ({ account, max_results }) => {
    const max = clamp(max_results ?? 20, 1, 50);
    const svc = drive(account);
    const res = await execute(() =>
      svc.files.list({
        q: "trashed = false",
        pageSize: max,
        fields: DRIVE_FIELDS,
        orderBy: "modifiedTime desc",
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      }),
    );
    return jsonResult({ account, files: res.data.files ?? [] });
  }),
);

server.tool(
  "calendar_list_events",
  "List primary-calendar events for an account within an optional time window.",
  {
    account: z.string().describe("Account email (must be authorized)."),
    time_min: z.string().optional().describe("RFC3339 lower bound, e.g. 2026-05-29T00:00:00Z."),
    time_max: z.string().optional().describe("RFC3339 upper bound."),
  },
  guard(async ({ account, time_min, time_max }) => {
    const svc = calendar(account);
    const res = await execute(() =>
      svc.events.list({
        calendarId: "primary",
        singleEvents: true,
        orderBy: "startTime",
        maxResults: 50,
        timeMin: time_min,
        timeMax: time_max,
      }),
    );
    const events = (res.data.items ?? []).map((ev) => ({
      id: ev.id,
      summary: ev.summary ?? "",
      start: ev.start?.dateTime ?? ev.start?.date,
      end: ev.end?.dateTime ?? ev.end?.date,
      location: ev.location ?? "",
      attendees: (ev.attendees ?? []).map((a) => a.email),
      htmlLink: ev.htmlLink ?? "",
    }));
    return jsonResult({ account, count: events.length, events });
  }),
);

server.tool(
  "calendar_create_event",
  "Create an event on an account's primary calendar.",
  {
    account: z.string().describe("Account email (must be authorized)."),
    summary: z.string().describe("Event title."),
    start: z.string().describe("RFC3339 start datetime, e.g. 2026-05-29T15:00:00Z."),
    end: z.string().describe("RFC3339 end datetime."),
    attendees: z.array(z.string()).optional().describe("Optional attendee email addresses."),
  },
  guard(async ({ account, summary, start, end, attendees }) => {
    const svc = calendar(account);
    const res = await execute(() =>
      svc.events.insert({
        calendarId: "primary",
        sendUpdates: "none",
        requestBody: {
          summary,
          start: { dateTime: start },
          end: { dateTime: end },
          attendees: attendees?.map((email: string) => ({ email })),
        },
      }),
    );
    const ev = res.data;
    return jsonResult({
      account,
      event_id: ev.id,
      summary: ev.summary,
      start: ev.start?.dateTime,
      end: ev.end?.dateTime,
      htmlLink: ev.htmlLink,
    });
  }),
);

// --------------------------------------------------------------------------- //
// Entry point
// --------------------------------------------------------------------------- //

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Logs must go to stderr — stdout is the MCP stdio channel.
  console.error("google-multi-mcp running on stdio");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
