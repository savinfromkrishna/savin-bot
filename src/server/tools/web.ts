import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { z } from "zod";
import { Workspace } from "../workspace/files.ts";
import type { OpenCredential, Tool } from "./tool.ts";
import { defineTool } from "./tool.ts";

/** Loopback, private and link-local ranges: this machine and its network stay out of reach. */
export const privateAddress = (address: string) =>
  /^(127\.|10\.|192\.168\.|169\.254\.|0\.|172\.(1[6-9]|2\d|3[01])\.)/.test(address) ||
  /^(::1|::|f[cd][0-9a-f]{2}:|fe80:)/i.test(address) ||
  address === "localhost";

/** The same rule as a URL pattern, for blocking a browser tab's requests. */
export const privateUrlPattern =
  /^[a-z]+:\/\/(localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|169\.254\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|\[::1?\])(:\d+)?(\/|$)/i;

/** Refuses URLs that point at this machine or the local network, where this app's own API lives. */
export async function publicUrl(raw: string) {
  const url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Only http and https URLs are allowed");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host) ? [host] : (await lookup(host, { all: true })).map((entry) => entry.address);
  if (privateAddress(host) || addresses.some(privateAddress)) {
    throw new Error("Addresses on this machine or the local network are blocked");
  }
  return url;
}

const matches = (host: string, domain: string) => host === domain || host.endsWith(`.${domain}`);

/** Headers from the bot's saved credentials for this host; the model never sees their values. */
export function credentialHeaders(host: string, credentials: OpenCredential[]) {
  const headers: Record<string, string> = {};
  for (const credential of credentials) {
    if (credential.type === "variable" || credential.type === "login" || !matches(host, credential.domain)) continue;
    if (credential.type === "bearer") headers.authorization = `Bearer ${credential.token}`;
    if (credential.type === "header") headers[credential.header.toLowerCase()] = credential.value;
    if (credential.type === "basic") {
      headers.authorization = `Basic ${Buffer.from(`${credential.username}:${credential.password}`).toString("base64")}`;
    }
  }
  return headers;
}

const htmlToText = (html: string) =>
  html
    .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/(p|div|li|h[1-6]|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n\n")
    .trim();

const clip = (text: string, max = 20_000) =>
  text.length > max ? `${text.slice(0, max)}\n… ${text.length - max} more characters` : text;

/** Web access without a browser: quick reads and API calls, to the addresses `allowUrl` lets through. */
export function webTools(options: { allowUrl?: (url: string) => boolean } = {}): Tool[] {
  const allowed = (target: URL) => {
    if (options.allowUrl && !options.allowUrl(target.toString())) {
      throw new Error(`${target.hostname} is not a job site or careers page, so this team does not reach it.`);
    }
    return target;
  };
  return [
    defineTool({
      name: "web_fetch",
      group: "web",
      readOnly: true,
      description: "Read a web page or a JSON/text URL as plain text. Faster than the browser for simple reads.",
      input: z.object({ url: z.string().min(1).max(2000) }),
      async run({ url }, context) {
        const target = allowed(await publicUrl(url));
        const response = await fetch(target, {
          headers: {
            "user-agent": "Mozilla/5.0 savinSocial",
            ...credentialHeaders(target.hostname, context.credentials),
          },
          signal: AbortSignal.any([context.signal, AbortSignal.timeout(20_000)]),
        });
        const type = response.headers.get("content-type") ?? "";
        const body = await response.text();
        const text = type.includes("html") ? htmlToText(body) : body;
        return { text: `${response.status} ${response.statusText}\n${clip(text)}` };
      },
    }),
    defineTool({
      name: "http_request",
      group: "web",
      description:
        "Call an HTTP API. Saved credentials for the host are added automatically. Use saveTo to store a downloaded file in the workspace.",
      input: z.object({
        method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).default("GET"),
        url: z.string().min(1).max(4000),
        headers: z.record(z.string(), z.string()).optional(),
        body: z.string().max(1_000_000).optional(),
        saveTo: z.string().max(1000).optional().describe("Workspace path to save the response body to"),
      }),
      async run({ method, url, headers, body, saveTo }, context) {
        const target = allowed(await publicUrl(url));
        const response = await fetch(target, {
          method,
          headers: { ...headers, ...credentialHeaders(target.hostname, context.credentials) },
          body: method === "GET" ? undefined : body,
          signal: AbortSignal.any([context.signal, AbortSignal.timeout(60_000)]),
        });
        if (saveTo && response.body) {
          const path = await new Workspace(context.workspaceDir).upload(saveTo, response.body);
          context.activity("write", path);
          return { text: `${response.status} ${response.statusText}\nSaved to ${path}` };
        }
        return { text: `${response.status} ${response.statusText}\n${clip(await response.text())}` };
      },
    }),
  ];
}
