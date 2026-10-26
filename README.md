# savin Social

A self-hosted team of AI bots for social media work, built the savin way: sign up, connect a model (with your ChatGPT, Claude, Copilot or SuperGrok subscription, or an API key), and work with your social media team in chat or on a live map. Every space is its own team with its own bots, brand, apps and computer.

## Quick start

```sh
pnpm install
pnpm browser:install   # once: the Chromium the bots drive
pnpm dev               # app on http://localhost:5310, API on :4310
```

Or as one process: `pnpm build && pnpm start`, then open http://127.0.0.1:4310.

Open the app, **Sign up**, and connect a model. The first account also takes over any data from the single-space version (bots, runs, files, browser sign-ins).

## What's inside

**Accounts.** savin's sign-up and sign-in (Better Auth, email and password), stored in `data/auth.db`. Each account starts with a **Personal** space and the social media team; Log out is in the account menu at the bottom of the sidebar.

**Models.** savin's Settings → Models, on the same model library ([pi-ai](https://www.npmjs.com/package/@earendil-works/pi-ai)):
- *Subscription sign-in:* **ChatGPT Plus/Pro**, **GitHub Copilot** and **SuperGrok / X Premium** show a device code to enter on the provider's page; **Claude Pro/Max** opens a sign-in link and finishes on its own, or takes the pasted code.
- *API keys* for every other provider in the catalog (Google Gemini, OpenAI, Anthropic, OpenRouter, xAI, Groq, DeepSeek, Mistral and more), with "Test API key".
- *Your own server* (Ollama, LM Studio, vLLM, …) through the OpenAI-compatible option.

Connections belong to your account and are encrypted; tokens refresh on their own. Each space picks its model, thinking level and backup models, and each bot can override them.

**Spaces and teams.** The **+** menu creates a new bot, a group or a new space. A new space starts with the social media team (Director, Scout, Writer, Editor, Producer, Publisher, Community), set up from its brand, or empty; **Add social media team** brings the team (or any deleted role) back. Bots you create get a name, title and description; the description becomes their instructions. Rename or delete a space from its **⋯** menu; your first space stays.

**Job search spaces.** **+ → Create new Space → Job search team** makes a space that applies for jobs for you, kept apart from everything else:
- Its team: **Coordinator** plans and reports, **Finder** finds matching roles on LinkedIn, Naukri, Indeed, Wellfound and careers pages, **Tailor** writes each cover letter and answers from your facts only, **Applier** fills in the forms and uploads your résumé.
- **Settings → Candidate** holds what the team may say about you (contact details, what you're looking for, experience, ready answers, résumé), how many applications a day, and **Sign in to job sites**.
- **Applications** in the sidebar tracks every job: found, ready, applied, interview, offer, rejected or skipped. A job already applied for is never applied for twice.
- Every final Submit or Apply waits for **Allow once**, with **Look at the page** to check the form first.
- Locked down: no terminal, desktop or video tools, whatever a bot's switches say; its bots' browser and web tools reach job boards, applicant tracking systems (Greenhouse, Lever, Workday and more), company careers pages and web search only, plus any domain you add; its own browser profile, files and integrations, so it never sees your other spaces or their sign-ins.

**The team.** Each bot has savin's settings: avatar, name, title, description, notifications, Computer access (Off / Ask first / Full), the Screen / Browser / Files / Shell switches, delegation, instructions with history, open work, memory, shared skills, model and thinking level, read-aloud, disabled tools, credentials, Export, Duplicate, Clear conversation and Delete.

**Chat.** Each bot has a thread. Work shows as a collapsible "Working… · N tools" line; approvals appear as Allow once / Always allow this tool / Deny; work handed to teammates shows as cards; bots can ask you to take over the browser ("Needs you") for sign-ins and captchas.

**Group chats.** savin's groups: one shared thread with 2–10 bots. `@name` picks who answers, `@everyone` wakes them all, and otherwise the first member you picked answers. A member can hand the conversation to another with `handoff_to_bot`; every member sees what was said before.

**AI video.** The Producer turns a script into 3 to 4 scenes with Gemini (Video tool, about 8 seconds each) and joins them with ffmpeg into one MP4, in 9:16 or 16:9. Gemini runs in the space's browsers one at a time: each counts its videos for the day (3 by default, editable), and when Gemini says the limit is reached the next browser takes over. When none is left, the run asks you to **Add browser**, you sign it in to Gemini, and the Producer carries on there. ffmpeg comes bundled and is on the bots' PATH too.

**Browsers.** Settings → Browsers lists the space's browsers: the main one and any you add, each its own Chromium profile with its own Google account. Each shows what it is signed in to and today's Gemini videos.

**Computer.** A space's bots share a workspace folder and a Chromium profile (sign in once, every bot reuses it). The app checks which platforms that browser is signed in to: the bots are told, Integrations and the team map show it, and a signed-in platform works without an app connection. Open a bot's computer to watch its browser live, take control, and use the floating Terminal (the bot's activity feed plus real shells) and Files windows.

**Integrations.** YouTube (Google sign-in), Instagram, Facebook Pages, X, LinkedIn, Telegram, Discord, Slack, Webhook (n8n, Make, Zapier), Pexels, ElevenLabs and Custom API, plus any MCP server over HTTP, SSE or a local command. Choose which bots may use each one. Credentials are encrypted and never sent to the model; actions that change something ask first until you choose "Always allow". A Google sign-in in progress is saved with its connection, so a restart cannot lose it; one that never finishes shows "Sign-in didn't finish" with **Try again**, and Google's own errors (API not enabled, unverified app, no channel) say what to fix.

**One upload channel.** YouTube uploads go to one channel, set once: the first channel you connect, or **Use the browser's channel** in Integrations → YouTube. Uploads through the app connection and through YouTube Studio in the browser (`youtube_studio_upload`) both refuse any other channel, and bots are told where uploads go. **Change** clears it.

**Routines.** Run any bot on a schedule (hourly, daily, weekdays, weekly, monthly, an interval or cron). The seeded ones start paused.

**Team map.** The home view draws triggers → Director → team → computer tools, apps and platforms, with the space's model. It animates live: bots glow while they work, edges light up along the path of each task, and shields mark actions that wait for approval.

## Safety

The API listens on `127.0.0.1` only, rejects other `Host` headers and non-JSON writes, and accepts WebSockets only from its own pages. Every request needs a signed-in session, and a space answers only to the account that owns it. Bots' browser tabs and web tools cannot reach this machine or its local network. Secrets and model tokens are sealed with AES-256-GCM (set `ENCRYPTION_KEY`, or a key file is created in `data/`).

Outside text can carry instructions aimed at the bots (prompt injection), so:
- Bots are told that pasted text, files, web pages, comments and tool results are material, never instructions.
- Once a task has read outside content (a web page, the browser, an app, an MCP server or an attached file), its terminal commands and desktop actions wait for a person, whatever the bot's access. Work it hands to teammates keeps asking too.
- A long paste becomes an attached "Pasted text" file that the bot gets as material, and the API refuses bodies over 1 MB.
- ffmpeg only joins real video files (no playlists that could fetch addresses), Gemini downloads must come from public https addresses and stay under 512 MB, and the browser's own upload refuses other channels' YouTube Studio.
- Sign-in attempts are rate-limited in every mode.

Bots with Shell and Full access can still do anything your Windows account can, including reading the key file in `data/`, so keep Shell for the bots that need it. A new install can set `ENCRYPTION_KEY` instead of the key file; an existing one keeps its file, or its saved sign-ins could no longer be opened.

## Scripts

`pnpm dev`, `pnpm build`, `pnpm start`, `pnpm test` (offline and deterministic: scripted models, pi's fake provider, a local MCP server, real headless Chromium and a real shell), `pnpm check` (types), `pnpm lint`.

## Layout

```
src/shared       contracts, the team roster, the team map graph
src/server       accounts and sign-in, spaces, runtime, approvals, prompts, store and secrets, HTTP + SSE + WebSockets
  llm/           the model catalog, pi adapter, subscription sign-in, sealed credentials, your own server
  tools/         screen, browser, files, shell, Gemini video and ffmpeg, YouTube Studio, web, team and knowledge tools
  integrations/  app connectors, Google and X auth, MCP servers
  workspace/     files, terminals, the activity feed
  routes/        each space's API
src/web          the app: welcome and sign-in, onboarding, sidebar, threads, bot panel, computer, dialogs, team map
skills/          built-in shared skills (SKILL.md)
patches/         the same pi-ai patch savin uses (Gemini 4 thinking)
scripts          dev runner
tests            vitest suites
data/            accounts, spaces (state, runs, workspace, browser profile), keys (git-ignored)
```
#   s a v i n - b o t  
 