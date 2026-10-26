import { openAsBlob } from "node:fs";
import { stat } from "node:fs/promises";
import { basename, extname } from "node:path";
import { z } from "zod";
import type { AuthField, CatalogItem, Channel, RuleCategory } from "../../shared/contracts.ts";
import type { ToolContext, ToolResult } from "../tools/tool.ts";
import { Workspace } from "../workspace/files.ts";
import { oauth1Header } from "./auth.ts";

export type ConnectorContext = {
  /** The connection's opened credential fields. */
  fields: Record<string, string>;
  /** A valid Google access token, for Google-authorized connectors. */
  googleToken?: () => Promise<string>;
  /** The calling bot's context, when a tool runs. */
  tool?: ToolContext;
  /** The YouTube channel the space uploads to; uploads anywhere else are refused. */
  channel?: Channel | null;
};

export type ConnectorTool = {
  action: string;
  description: string;
  readOnly?: boolean;
  category?: RuleCategory;
  input: z.ZodObject;
  run(input: Record<string, unknown>, context: ConnectorContext & { tool: ToolContext }): Promise<ToolResult>;
};

export type ConnectorDefinition = {
  item: Omit<CatalogItem, "tools">;
  /**
   * Checks the credentials; `store` adds non-secret details (such as an account id) to the connection,
   * and `channel` is the YouTube channel it signed in to.
   */
  verify(
    context: ConnectorContext,
  ): Promise<{ account: string | null; store?: Record<string, string>; channel?: Channel }>;
  tools: ConnectorTool[];
};

const tool = <S extends z.ZodObject>(
  definition: Omit<ConnectorTool, "input" | "run"> & {
    input: S;
    run(input: z.output<S>, context: ConnectorContext & { tool: ToolContext }): Promise<ToolResult>;
  },
) => definition as unknown as ConnectorTool;

const field = (key: string, label: string, secret: boolean, extra: Partial<AuthField> = {}): AuthField => ({
  key,
  label,
  secret,
  ...extra,
});

/** JSON (or text) from an API, with the status and a short body in the error. */
async function call<T = unknown>(url: string, init: RequestInit = {}, what = "Request"): Promise<T> {
  const response = await fetch(url, { ...init, signal: init.signal ?? AbortSignal.timeout(60_000) });
  const text = await response.text();
  let data: unknown = text;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {}
  if (!response.ok) {
    const detail = typeof data === "string" ? data : JSON.stringify(data);
    throw new Error(`${what} failed (${response.status}): ${detail.slice(0, 300)}`);
  }
  return data as T;
}

const json = (value: unknown) => ({ text: JSON.stringify(value, null, 2) });

async function workspaceFile(context: ToolContext, path: string) {
  const full = await new Workspace(context.workspaceDir).resolve(path);
  const info = await stat(full);
  return { full, size: info.size, name: basename(full), blob: await openAsBlob(full) };
}

const videoTypes = new Set([".mp4", ".mov", ".webm", ".m4v"]);
const imageTypes = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif"]);

/** YYYYMM a couple of months back: LinkedIn only accepts versions it still supports. */
const linkedInVersion = () => {
  const date = new Date(Date.now() - 60 * 24 * 3600 * 1000);
  return `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
};

const YT = "https://www.googleapis.com/youtube/v3";

/** The channel a Google token belongs to, if it has one. */
async function ownChannel(token: string | undefined): Promise<Channel | null> {
  const data = await call<{ items?: { id?: string; snippet: { title: string } }[] }>(
    `${YT}/channels?part=snippet&mine=true`,
    { headers: { authorization: `Bearer ${token}` } },
    "YouTube",
  );
  const item = data.items?.[0];
  return item ? { id: item.id ?? "", title: item.snippet.title } : null;
}

export const connectors: ConnectorDefinition[] = [
  // ---------- Social ----------
  {
    item: {
      id: "youtube",
      name: "YouTube",
      description: "Upload videos, read channel and video stats, and reply to comments.",
      category: "Social",
      icon: "square-play",
      featured: true,
      auth: {
        kind: "google",
        scopes: [
          "https://www.googleapis.com/auth/youtube.upload",
          "https://www.googleapis.com/auth/youtube.readonly",
          "https://www.googleapis.com/auth/youtube.force-ssl",
        ],
      },
      docsUrl: "https://console.cloud.google.com/apis/library/youtube.googleapis.com",
    },
    async verify({ googleToken }) {
      const channel = await ownChannel(await googleToken?.());
      if (!channel) {
        throw new Error("This Google account has no YouTube channel. Sign in with the account that owns the channel.");
      }
      return { account: channel.title, channel };
    },
    tools: [
      tool({
        action: "channel_stats",
        description: "Your channel's title, subscribers, views and video count.",
        readOnly: true,
        input: z.object({}),
        async run(_input, { googleToken }) {
          const data = await call(`${YT}/channels?part=snippet,statistics&mine=true`, {
            headers: { authorization: `Bearer ${await googleToken?.()}` },
          });
          return json(data);
        },
      }),
      tool({
        action: "list_videos",
        description: "Your most recent uploads with views, likes and comments.",
        readOnly: true,
        input: z.object({ max: z.number().int().min(1).max(50).default(10) }),
        async run({ max }, { googleToken }) {
          const auth = { authorization: `Bearer ${await googleToken?.()}` };
          const channel = await call<{ items: { contentDetails: { relatedPlaylists: { uploads: string } } }[] }>(
            `${YT}/channels?part=contentDetails&mine=true`,
            { headers: auth },
          );
          const uploads = channel.items[0]?.contentDetails.relatedPlaylists.uploads;
          if (!uploads) return { text: "No uploads yet." };
          const items = await call<{ items: { contentDetails: { videoId: string } }[] }>(
            `${YT}/playlistItems?part=contentDetails&maxResults=${max}&playlistId=${uploads}`,
            { headers: auth },
          );
          const ids = items.items.map((item) => item.contentDetails.videoId).join(",");
          return json(await call(`${YT}/videos?part=snippet,statistics,status&id=${ids}`, { headers: auth }));
        },
      }),
      tool({
        action: "search",
        description: "Search public YouTube videos, for research and trends.",
        readOnly: true,
        input: z.object({
          query: z.string().min(1).max(200),
          max: z.number().int().min(1).max(25).default(10),
          order: z.enum(["relevance", "date", "viewCount"]).default("relevance"),
        }),
        async run({ query, max, order }, { googleToken }) {
          const params = new URLSearchParams({
            part: "snippet",
            type: "video",
            q: query,
            maxResults: String(max),
            order,
          });
          return json(
            await call(`${YT}/search?${params}`, { headers: { authorization: `Bearer ${await googleToken?.()}` } }),
          );
        },
      }),
      tool({
        action: "upload_video",
        description:
          "Upload a workspace video with title, description and tags. Keep privacy private unless told otherwise.",
        category: "publish",
        input: z.object({
          path: z.string().min(1),
          title: z.string().min(1).max(100),
          description: z.string().max(5000).default(""),
          tags: z.array(z.string()).max(30).default([]),
          privacy: z.enum(["private", "unlisted", "public"]).default("private"),
          publishAt: z.string().optional().describe("ISO time to publish; needs privacy private"),
          thumbnail: z.string().optional().describe("Workspace path of a JPG or PNG"),
        }),
        async run(input, { googleToken, tool: context, channel }) {
          const token = await googleToken?.();
          if (!channel) throw new Error("No channel is assigned for uploads yet. Choose it in Integrations → YouTube.");
          const own = await ownChannel(token);
          if (own?.id !== channel.id) {
            throw new Error(
              `Uploads go only to ${channel.title}; this account's channel is ${own?.title ?? "missing"}.`,
            );
          }
          const video = await workspaceFile(context, input.path);
          const start = await fetch(
            `https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status`,
            {
              method: "POST",
              headers: {
                authorization: `Bearer ${token}`,
                "content-type": "application/json; charset=UTF-8",
                "x-upload-content-length": String(video.size),
                "x-upload-content-type": "video/*",
              },
              body: JSON.stringify({
                snippet: { title: input.title, description: input.description, tags: input.tags, categoryId: "22" },
                status: {
                  privacyStatus: input.publishAt ? "private" : input.privacy,
                  ...(input.publishAt && { publishAt: input.publishAt }),
                  selfDeclaredMadeForKids: false,
                },
              }),
            },
          );
          const location = start.headers.get("location");
          if (!start.ok || !location)
            throw new Error(`YouTube upload could not start (${start.status}): ${(await start.text()).slice(0, 300)}`);
          const uploaded = await call<{ id: string; status: { privacyStatus: string } }>(
            location,
            {
              method: "PUT",
              headers: { "content-type": "video/*" },
              body: video.blob,
              signal: AbortSignal.timeout(30 * 60_000),
            },
            "YouTube upload",
          );
          if (input.thumbnail) {
            const thumbnail = await workspaceFile(context, input.thumbnail);
            await call(
              `https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=${uploaded.id}`,
              {
                method: "POST",
                headers: {
                  authorization: `Bearer ${token}`,
                  "content-type": extname(thumbnail.name).toLowerCase() === ".png" ? "image/png" : "image/jpeg",
                },
                body: thumbnail.blob,
              },
              "Thumbnail",
            );
          }
          return { text: `Uploaded as ${uploaded.status.privacyStatus}: https://youtu.be/${uploaded.id}` };
        },
      }),
      tool({
        action: "list_comments",
        description: "Recent comment threads on your channel, or on one video.",
        readOnly: true,
        input: z.object({ videoId: z.string().optional(), max: z.number().int().min(1).max(100).default(20) }),
        async run({ videoId, max }, { googleToken }) {
          const auth = { authorization: `Bearer ${await googleToken?.()}` };
          let filter = videoId ? `videoId=${videoId}` : "";
          if (!filter) {
            const channel = await call<{ items: { id: string }[] }>(`${YT}/channels?part=id&mine=true`, {
              headers: auth,
            });
            filter = `allThreadsRelatedToChannelId=${channel.items[0]?.id}`;
          }
          return json(
            await call(`${YT}/commentThreads?part=snippet&order=time&maxResults=${max}&${filter}`, { headers: auth }),
          );
        },
      }),
      tool({
        action: "reply_comment",
        description: "Reply to a comment (pass the top-level comment id).",
        category: "message",
        input: z.object({ parentId: z.string().min(1), text: z.string().min(1).max(10_000) }),
        async run({ parentId, text }, { googleToken }) {
          const data = await call<{ id: string }>(`${YT}/comments?part=snippet`, {
            method: "POST",
            headers: { authorization: `Bearer ${await googleToken?.()}`, "content-type": "application/json" },
            body: JSON.stringify({ snippet: { parentId, textOriginal: text } }),
          });
          return { text: `Replied (comment ${data.id}).` };
        },
      }),
    ],
  },
  {
    item: {
      id: "instagram",
      name: "Instagram",
      description: "Read profile and post stats, and publish images or Reels from public URLs.",
      category: "Social",
      icon: "camera",
      featured: true,
      auth: {
        kind: "fields",
        fields: [
          field("userId", "Instagram business account ID", false, { placeholder: "17841400000000000" }),
          field("token", "Access token", true, { placeholder: "EAAG…" }),
        ],
      },
      docsUrl: "https://developers.facebook.com/docs/instagram-platform",
    },
    async verify({ fields }) {
      const data = await call<{ username: string }>(
        `https://graph.facebook.com/${fields.userId}?fields=username&access_token=${encodeURIComponent(fields.token ?? "")}`,
        {},
        "Instagram",
      );
      return { account: `@${data.username}` };
    },
    tools: [
      tool({
        action: "profile_stats",
        description: "Followers, posts and recent media with likes and comments.",
        readOnly: true,
        input: z.object({ max: z.number().int().min(1).max(50).default(10) }),
        async run({ max }, { fields }) {
          const token = encodeURIComponent(fields.token ?? "");
          const profile = await call(
            `https://graph.facebook.com/${fields.userId}?fields=username,followers_count,media_count&access_token=${token}`,
          );
          const media = await call(
            `https://graph.facebook.com/${fields.userId}/media?fields=caption,media_type,like_count,comments_count,timestamp,permalink&limit=${max}&access_token=${token}`,
          );
          return json({ profile, media });
        },
      }),
      tool({
        action: "publish",
        description: "Publish an image or a Reel. Instagram fetches the media from a public https URL.",
        category: "publish",
        input: z.object({
          mediaUrl: z.url(),
          kind: z.enum(["image", "reel"]),
          caption: z.string().max(2200).default(""),
        }),
        async run({ mediaUrl, kind, caption }, { fields }) {
          const token = fields.token ?? "";
          const base = `https://graph.facebook.com/${fields.userId}`;
          const params = new URLSearchParams({
            caption,
            access_token: token,
            ...(kind === "image" ? { image_url: mediaUrl } : { media_type: "REELS", video_url: mediaUrl }),
          });
          const container = await call<{ id: string }>(`${base}/media`, { method: "POST", body: params }, "Instagram");
          for (let attempt = 0; kind === "reel" && attempt < 40; attempt++) {
            const status = await call<{ status_code: string }>(
              `https://graph.facebook.com/${container.id}?fields=status_code&access_token=${encodeURIComponent(token)}`,
            );
            if (status.status_code === "FINISHED") break;
            if (status.status_code === "ERROR") throw new Error("Instagram could not process the video");
            await new Promise((resolve) => setTimeout(resolve, 3000));
          }
          const published = await call<{ id: string }>(
            `${base}/media_publish`,
            { method: "POST", body: new URLSearchParams({ creation_id: container.id, access_token: token }) },
            "Instagram publish",
          );
          return { text: `Published (media ${published.id}).` };
        },
      }),
    ],
  },
  {
    item: {
      id: "facebook",
      name: "Facebook Pages",
      description: "Post to a Page and read its recent posts.",
      category: "Social",
      icon: "users",
      featured: false,
      auth: {
        kind: "fields",
        fields: [
          field("pageId", "Page ID", false),
          field("token", "Page access token", true, { placeholder: "EAAG…" }),
        ],
      },
      docsUrl: "https://developers.facebook.com/docs/pages-api",
    },
    async verify({ fields }) {
      const data = await call<{ name: string }>(
        `https://graph.facebook.com/${fields.pageId}?fields=name&access_token=${encodeURIComponent(fields.token ?? "")}`,
        {},
        "Facebook",
      );
      return { account: data.name };
    },
    tools: [
      tool({
        action: "list_posts",
        description: "The Page's recent posts.",
        readOnly: true,
        input: z.object({ max: z.number().int().min(1).max(50).default(10) }),
        async run({ max }, { fields }) {
          return json(
            await call(
              `https://graph.facebook.com/${fields.pageId}/posts?fields=message,created_time,permalink_url&limit=${max}&access_token=${encodeURIComponent(fields.token ?? "")}`,
            ),
          );
        },
      }),
      tool({
        action: "post",
        description: "Publish a post on the Page, optionally with a link.",
        category: "publish",
        input: z.object({ message: z.string().min(1).max(60_000), link: z.url().optional() }),
        async run({ message, link }, { fields }) {
          const body = new URLSearchParams({ message, access_token: fields.token ?? "", ...(link && { link }) });
          const data = await call<{ id: string }>(
            `https://graph.facebook.com/${fields.pageId}/feed`,
            { method: "POST", body },
            "Facebook",
          );
          return { text: `Posted (${data.id}).` };
        },
      }),
    ],
  },
  {
    item: {
      id: "x",
      name: "X",
      description: "Post to X from your account.",
      category: "Social",
      icon: "at-sign",
      featured: false,
      auth: {
        kind: "fields",
        fields: [
          field("consumerKey", "API key", true),
          field("consumerSecret", "API key secret", true),
          field("token", "Access token", true),
          field("tokenSecret", "Access token secret", true),
        ],
      },
      docsUrl: "https://developer.x.com/en/portal/dashboard",
    },
    async verify({ fields }) {
      const url = "https://api.x.com/2/users/me";
      const data = await call<{ data: { username: string } }>(
        url,
        { headers: { authorization: oauth1Header("GET", url, keysOf(fields)) } },
        "X",
      );
      return { account: `@${data.data.username}` };
    },
    tools: [
      tool({
        action: "post",
        description: "Publish a post (up to 280 characters), optionally as a reply.",
        category: "publish",
        input: z.object({ text: z.string().min(1).max(4000), replyTo: z.string().optional() }),
        async run({ text, replyTo }, { fields }) {
          const url = "https://api.x.com/2/tweets";
          const data = await call<{ data: { id: string } }>(
            url,
            {
              method: "POST",
              headers: { authorization: oauth1Header("POST", url, keysOf(fields)), "content-type": "application/json" },
              body: JSON.stringify({ text, ...(replyTo && { reply: { in_reply_to_tweet_id: replyTo } }) }),
            },
            "X",
          );
          return { text: `Posted: https://x.com/i/web/status/${data.data.id}` };
        },
      }),
    ],
  },
  {
    item: {
      id: "linkedin",
      name: "LinkedIn",
      description: "Share posts from your LinkedIn profile.",
      category: "Social",
      icon: "briefcase",
      featured: false,
      auth: { kind: "fields", fields: [field("token", "Access token", true, { placeholder: "With w_member_social" })] },
      docsUrl: "https://www.linkedin.com/developers/apps",
    },
    async verify({ fields }) {
      const data = await call<{ sub: string; name?: string }>(
        "https://api.linkedin.com/v2/userinfo",
        { headers: { authorization: `Bearer ${fields.token}` } },
        "LinkedIn",
      );
      return { account: data.name ?? null, store: { memberId: data.sub } };
    },
    tools: [
      tool({
        action: "post",
        description: "Publish a text post on your profile.",
        category: "publish",
        input: z.object({
          text: z.string().min(1).max(3000),
          visibility: z.enum(["PUBLIC", "CONNECTIONS"]).default("PUBLIC"),
        }),
        async run({ text, visibility }, { fields }) {
          const response = await fetch("https://api.linkedin.com/rest/posts", {
            method: "POST",
            headers: {
              authorization: `Bearer ${fields.token}`,
              "content-type": "application/json",
              "LinkedIn-Version": linkedInVersion(),
              "X-Restli-Protocol-Version": "2.0.0",
            },
            body: JSON.stringify({
              author: `urn:li:person:${fields.memberId}`,
              commentary: text,
              visibility,
              distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] },
              lifecycleState: "PUBLISHED",
              isReshareDisabledByAuthor: false,
            }),
            signal: AbortSignal.timeout(60_000),
          });
          if (!response.ok)
            throw new Error(`LinkedIn failed (${response.status}): ${(await response.text()).slice(0, 300)}`);
          return { text: `Posted (${response.headers.get("x-restli-id") ?? "ok"}).` };
        },
      }),
    ],
  },

  // ---------- Messaging ----------
  {
    item: {
      id: "telegram",
      name: "Telegram",
      description: "Send messages and files from your bot, and read what people sent it.",
      category: "Messaging",
      icon: "send",
      featured: true,
      auth: {
        kind: "fields",
        fields: [
          field("token", "Bot token", true, { placeholder: "123456:ABC-…" }),
          field("chatId", "Default chat ID", false, { optional: true, placeholder: "@channel or -100…" }),
        ],
      },
      docsUrl: "https://core.telegram.org/bots#how-do-i-create-a-bot",
    },
    async verify({ fields }) {
      const data = await call<{ result: { username: string } }>(
        `https://api.telegram.org/bot${fields.token}/getMe`,
        {},
        "Telegram",
      );
      return { account: `@${data.result.username}` };
    },
    tools: [
      tool({
        action: "send_message",
        description: "Send a text message to a chat or channel (defaults to the connection's chat).",
        category: "message",
        input: z.object({ text: z.string().min(1).max(4096), chatId: z.string().optional() }),
        async run({ text, chatId }, { fields }) {
          const chat = chatId ?? fields.chatId;
          if (!chat) return { text: "No chat ID given and no default chat on this connection." };
          await call(`https://api.telegram.org/bot${fields.token}/sendMessage`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ chat_id: chat, text }),
          });
          return { text: "Sent." };
        },
      }),
      tool({
        action: "send_file",
        description: "Send a workspace file (video, photo or document) with an optional caption.",
        category: "message",
        input: z.object({
          path: z.string().min(1),
          caption: z.string().max(1024).optional(),
          chatId: z.string().optional(),
        }),
        async run({ path, caption, chatId }, { fields, tool: context }) {
          const chat = chatId ?? fields.chatId;
          if (!chat) return { text: "No chat ID given and no default chat on this connection." };
          const file = await workspaceFile(context, path);
          const ext = extname(file.name).toLowerCase();
          const [method, key] = videoTypes.has(ext)
            ? ["sendVideo", "video"]
            : imageTypes.has(ext)
              ? ["sendPhoto", "photo"]
              : ["sendDocument", "document"];
          const form = new FormData();
          form.set("chat_id", chat);
          if (caption) form.set("caption", caption);
          form.set(key as string, file.blob, file.name);
          await call(`https://api.telegram.org/bot${fields.token}/${method}`, {
            method: "POST",
            body: form,
            signal: AbortSignal.timeout(10 * 60_000),
          });
          return { text: `Sent ${file.name}.` };
        },
      }),
      tool({
        action: "get_updates",
        description: "Recent messages people sent to the bot (shows chat IDs).",
        readOnly: true,
        input: z.object({}),
        async run(_input, { fields }) {
          const data = await call<{ result: unknown[] }>(
            `https://api.telegram.org/bot${fields.token}/getUpdates?limit=50`,
          );
          return json(data.result);
        },
      }),
    ],
  },
  {
    item: {
      id: "discord",
      name: "Discord",
      description: "Post messages and files to a channel through a webhook.",
      category: "Messaging",
      icon: "gamepad-2",
      featured: false,
      auth: {
        kind: "fields",
        fields: [field("url", "Webhook URL", true, { placeholder: "https://discord.com/api/webhooks/…" })],
      },
      docsUrl: "https://support.discord.com/hc/en-us/articles/228383668",
    },
    async verify({ fields }) {
      const data = await call<{ name: string }>(fields.url ?? "", {}, "Discord");
      return { account: data.name };
    },
    tools: [
      tool({
        action: "post",
        description: "Post a message to the channel, optionally with a workspace file.",
        category: "message",
        input: z.object({ content: z.string().min(1).max(2000), path: z.string().optional() }),
        async run({ content, path }, { fields, tool: context }) {
          if (!path) {
            await call(fields.url ?? "", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ content }),
            });
            return { text: "Posted." };
          }
          const file = await workspaceFile(context, path);
          const form = new FormData();
          form.set("payload_json", JSON.stringify({ content }));
          form.set("files[0]", file.blob, file.name);
          await call(fields.url ?? "", { method: "POST", body: form, signal: AbortSignal.timeout(10 * 60_000) });
          return { text: `Posted with ${file.name}.` };
        },
      }),
    ],
  },
  {
    item: {
      id: "slack",
      name: "Slack",
      description: "Post updates to a channel through an incoming webhook.",
      category: "Messaging",
      icon: "hash",
      featured: false,
      auth: {
        kind: "fields",
        fields: [field("url", "Incoming webhook URL", true, { placeholder: "https://hooks.slack.com/services/…" })],
      },
      docsUrl: "https://api.slack.com/messaging/webhooks",
    },
    async verify({ fields }) {
      if (!/^https:\/\/hooks\.slack\.com\/services\//.test(fields.url ?? ""))
        throw new Error("That is not a Slack webhook URL");
      return { account: "Webhook" };
    },
    tools: [
      tool({
        action: "post",
        description: "Post a message to the channel (Slack markdown works).",
        category: "message",
        input: z.object({ text: z.string().min(1).max(40_000) }),
        async run({ text }, { fields }) {
          await call(fields.url ?? "", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ text }),
          });
          return { text: "Posted." };
        },
      }),
    ],
  },
  {
    item: {
      id: "webhook",
      name: "Webhook",
      description: "Send events to n8n, Make, Zapier or any automation that accepts a webhook.",
      category: "Developer",
      icon: "webhook",
      featured: true,
      auth: {
        kind: "fields",
        fields: [
          field("url", "Webhook URL", true, { placeholder: "https://…/webhook/…" }),
          field("secret", "Secret header value", true, { optional: true, placeholder: "Sent as x-webhook-secret" }),
        ],
      },
      docsUrl: null,
    },
    async verify({ fields }) {
      const url = new URL(fields.url ?? "");
      if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Use an http or https URL");
      return { account: url.host };
    },
    tools: [
      tool({
        action: "send",
        description: "Send a JSON event to the automation, for example when a post is ready.",
        category: "message",
        input: z.object({ event: z.string().min(1).max(100), payload: z.record(z.string(), z.unknown()).default({}) }),
        async run({ event, payload }, { fields }) {
          const response = await fetch(fields.url ?? "", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              ...(fields.secret && { "x-webhook-secret": fields.secret }),
            },
            body: JSON.stringify({ event, payload, sentAt: new Date().toISOString() }),
            signal: AbortSignal.timeout(60_000),
          });
          return { text: `${response.status} ${response.statusText}\n${(await response.text()).slice(0, 4000)}` };
        },
      }),
    ],
  },

  // ---------- Media ----------
  {
    item: {
      id: "pexels",
      name: "Pexels",
      description: "Find and download free stock videos and photos.",
      category: "Media",
      icon: "image",
      featured: true,
      auth: { kind: "fields", fields: [field("key", "API key", true)] },
      docsUrl: "https://www.pexels.com/api/",
    },
    async verify({ fields }) {
      await call(
        "https://api.pexels.com/v1/search?query=coffee&per_page=1",
        { headers: { authorization: fields.key ?? "" } },
        "Pexels",
      );
      return { account: "API key" };
    },
    tools: [
      tool({
        action: "search_videos",
        description: "Search stock videos; returns ids, durations and download links.",
        readOnly: true,
        input: z.object({
          query: z.string().min(1).max(100),
          orientation: z.enum(["portrait", "landscape", "square"]).default("portrait"),
          max: z.number().int().min(1).max(40).default(10),
        }),
        async run({ query, orientation, max }, { fields }) {
          const data = await call<{
            videos: {
              id: number;
              duration: number;
              url: string;
              video_files: { link: string; width: number; height: number; quality: string }[];
            }[];
          }>(
            `https://api.pexels.com/videos/search?${new URLSearchParams({ query, orientation, per_page: String(max) })}`,
            {
              headers: { authorization: fields.key ?? "" },
            },
          );
          return json(
            data.videos.map((video) => {
              const best = [...video.video_files]
                .filter((file) => Math.max(file.width, file.height) <= 1920)
                .sort((a, b) => b.width * b.height - a.width * a.height)[0];
              return {
                id: video.id,
                duration: video.duration,
                page: video.url,
                download: best?.link,
                size: best && `${best.width}x${best.height}`,
              };
            }),
          );
        },
      }),
      tool({
        action: "search_photos",
        description: "Search stock photos; returns ids and download links.",
        readOnly: true,
        input: z.object({ query: z.string().min(1).max(100), max: z.number().int().min(1).max(40).default(10) }),
        async run({ query, max }, { fields }) {
          const data = await call<{
            photos: { id: number; alt: string; src: { large2x: string; portrait: string } }[];
          }>(`https://api.pexels.com/v1/search?${new URLSearchParams({ query, per_page: String(max) })}`, {
            headers: { authorization: fields.key ?? "" },
          });
          return json(
            data.photos.map((photo) => ({
              id: photo.id,
              alt: photo.alt,
              download: photo.src.large2x,
              portrait: photo.src.portrait,
            })),
          );
        },
      }),
      tool({
        action: "download",
        description: "Download a Pexels file into the workspace.",
        readOnly: true,
        input: z.object({ url: z.url(), saveTo: z.string().min(1) }),
        async run({ url, saveTo }, { tool: context }) {
          if (!/(^|\.)pexels\.com$/.test(new URL(url).hostname))
            return { text: "Only Pexels links can be downloaded here." };
          const response = await fetch(url, { signal: AbortSignal.timeout(10 * 60_000) });
          if (!response.ok || !response.body) throw new Error(`Download failed (${response.status})`);
          const path = await new Workspace(context.workspaceDir).upload(saveTo, response.body);
          context.activity("write", path);
          return { text: `Saved ${path}.` };
        },
      }),
    ],
  },
  {
    item: {
      id: "elevenlabs",
      name: "ElevenLabs",
      description: "Turn scripts into natural voiceovers.",
      category: "Media",
      icon: "audio-lines",
      featured: false,
      auth: { kind: "fields", fields: [field("key", "API key", true)] },
      docsUrl: "https://elevenlabs.io/app/settings/api-keys",
    },
    async verify({ fields }) {
      const data = await call<{ subscription?: { tier?: string } }>(
        "https://api.elevenlabs.io/v1/user",
        { headers: { "xi-api-key": fields.key ?? "" } },
        "ElevenLabs",
      );
      return { account: data.subscription?.tier ?? "API key" };
    },
    tools: [
      tool({
        action: "list_voices",
        description: "Available voices with their ids.",
        readOnly: true,
        input: z.object({}),
        async run(_input, { fields }) {
          const data = await call<{ voices: { voice_id: string; name: string; labels?: Record<string, string> }[] }>(
            "https://api.elevenlabs.io/v1/voices",
            { headers: { "xi-api-key": fields.key ?? "" } },
          );
          return json(data.voices.map((voice) => ({ id: voice.voice_id, name: voice.name, labels: voice.labels })));
        },
      }),
      tool({
        action: "speak",
        description: "Generate an MP3 voiceover from text and save it to the workspace. Uses account credits.",
        category: "spend",
        input: z.object({ text: z.string().min(1).max(5000), voiceId: z.string().min(1), saveTo: z.string().min(1) }),
        async run({ text, voiceId, saveTo }, { fields, tool: context }) {
          const response = await fetch(
            `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`,
            {
              method: "POST",
              headers: { "xi-api-key": fields.key ?? "", "content-type": "application/json" },
              body: JSON.stringify({ text, model_id: "eleven_multilingual_v2" }),
              signal: AbortSignal.timeout(5 * 60_000),
            },
          );
          if (!response.ok || !response.body)
            throw new Error(`ElevenLabs failed (${response.status}): ${(await response.text()).slice(0, 300)}`);
          const path = await new Workspace(context.workspaceDir).upload(saveTo, response.body);
          context.activity("write", path);
          return { text: `Saved voiceover to ${path}.` };
        },
      }),
    ],
  },

  // ---------- Developer ----------
  {
    item: {
      id: "custom-api",
      name: "Custom API",
      description: "Any REST API: the key stays here, bots only see the base URL.",
      category: "Developer",
      icon: "braces",
      featured: false,
      auth: {
        kind: "fields",
        fields: [
          field("baseUrl", "Base URL", false, { placeholder: "https://api.example.com/v1" }),
          field("auth", "Authentication", false, { options: ["None", "Bearer token", "API key header"] }),
          field("header", "Header name", false, { optional: true, placeholder: "x-api-key" }),
          field("credential", "Credential", true, { optional: true }),
        ],
      },
      docsUrl: null,
    },
    async verify({ fields }) {
      const url = new URL(fields.baseUrl ?? "");
      if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Use an http or https base URL");
      return { account: url.host };
    },
    tools: [
      tool({
        action: "get",
        description: "GET a path on the API (relative to its base URL).",
        readOnly: true,
        input: z.object({ path: z.string().default("/"), query: z.record(z.string(), z.string()).default({}) }),
        async run({ path, query }, { fields }) {
          return customRequest(fields, "GET", path, query);
        },
      }),
      tool({
        action: "request",
        description: "Send a POST, PUT, PATCH or DELETE to a path on the API with a JSON body.",
        input: z.object({
          method: z.enum(["POST", "PUT", "PATCH", "DELETE"]),
          path: z.string().default("/"),
          query: z.record(z.string(), z.string()).default({}),
          body: z.unknown().optional(),
        }),
        async run({ method, path, query, body }, { fields }) {
          return customRequest(fields, method, path, query, body);
        },
      }),
    ],
  },
];

function keysOf(fields: Record<string, string>) {
  return {
    consumerKey: fields.consumerKey ?? "",
    consumerSecret: fields.consumerSecret ?? "",
    token: fields.token ?? "",
    tokenSecret: fields.tokenSecret ?? "",
  };
}

async function customRequest(
  fields: Record<string, string>,
  method: string,
  path: string,
  query: Record<string, string>,
  body?: unknown,
) {
  const base = (fields.baseUrl ?? "").replace(/\/+$/, "");
  const url = new URL(`${base}/${path.replace(/^\/+/, "")}`);
  if (!url.href.startsWith(base)) throw new Error("The path must stay under the base URL");
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  const headers: Record<string, string> = { accept: "application/json" };
  if (fields.auth === "Bearer token" && fields.credential) headers.authorization = `Bearer ${fields.credential}`;
  if (fields.auth === "API key header" && fields.credential)
    headers[(fields.header || "x-api-key").toLowerCase()] = fields.credential;
  if (body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await response.text();
  return {
    text: `${response.status} ${response.statusText}\n${text.length > 20_000 ? `${text.slice(0, 20_000)}\n…` : text}`,
  };
}

export const catalog = (): CatalogItem[] =>
  connectors.map(({ item, tools }) => ({
    ...item,
    tools: tools.map((entry) => ({
      name: `${item.id.replace(/-/g, "_")}_${entry.action}`,
      description: entry.description,
      readOnly: Boolean(entry.readOnly),
    })),
  }));

export const connectorFor = (id: string) => connectors.find((connector) => connector.item.id === id) ?? null;
