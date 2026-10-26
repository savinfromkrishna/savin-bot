import { randomUUID } from "node:crypto";
import type { Hono } from "hono";
import { BrowserInput } from "../../shared/contracts.ts";
import { MAIN_BROWSER, tabKey } from "../../shared/ids.ts";
import type { Store } from "../store.ts";
import { newBrowser, today } from "../store.ts";
import type { Browsers } from "../tools/browser.ts";
import { GEMINI_SIGN_IN, GEMINI_URL } from "../tools/video.ts";
import { detectChannel } from "../tools/youtube.ts";
import { body, HttpError } from "./util.ts";

/** The space's browsers, each its own signed-in profile, and the one YouTube channel uploads go to. */
export function browserRoutes(
  app: Hono,
  { store, browsers, announce }: { store: Store; browsers: Browsers; announce: () => void },
) {
  const find = (id: string) => {
    if (!store.state.browsers.some((browser) => browser.id === id)) throw new HttpError(404, "No such browser");
    return id;
  };

  /** Opens a browser in the person's own tab: at Gemini once a Google account is in, at Google's sign-in before. */
  const show = async (id: string) => {
    const { google } = await browsers.get(id).signIns();
    await browsers.open([google ? GEMINI_URL : GEMINI_SIGN_IN], id);
    return tabKey(id, "you");
  };

  app.post("/api/browsers", async (c) => {
    const id = randomUUID().slice(0, 8);
    const names = new Set(store.state.browsers.map((browser) => browser.name));
    let number = store.state.browsers.length + 1;
    while (names.has(`Browser ${number}`)) number++;
    await store.update((state) => ({ ...state, browsers: [...state.browsers, newBrowser(id, `Browser ${number}`)] }));
    announce();
    return c.json({ id, tab: await show(id) }, 201);
  });

  app.post("/api/browsers/:id/open", async (c) => c.json({ tab: await show(find(c.req.param("id"))) }));

  app.patch("/api/browsers/:id", async (c) => {
    const id = find(c.req.param("id"));
    const change = await body(c, BrowserInput);
    await store.update((state) => ({
      ...state,
      browsers: state.browsers.map((browser) =>
        browser.id === id
          ? {
              ...browser,
              ...(change.name && { name: change.name }),
              ...(change.videoLimit !== undefined && { videoLimit: change.videoLimit }),
              ...(change.reset && { videos: { day: today(), made: 0, stopped: null } }),
            }
          : browser,
      ),
    }));
    announce();
    return c.json({ ok: true });
  });

  app.delete("/api/browsers/:id", async (c) => {
    const id = find(c.req.param("id"));
    if (id === MAIN_BROWSER) throw new HttpError(400, "The main browser stays");
    await store.update((state) => ({ ...state, browsers: state.browsers.filter((browser) => browser.id !== id) }));
    await browsers.remove(id);
    announce();
    return c.json({ ok: true });
  });

  /** Uploads go to the channel YouTube Studio opens on in the main browser. */
  app.post("/api/channel/detect", async (c) => {
    const channel = await detectChannel(browsers.main);
    if (!channel) throw new HttpError(400, "The bots' browser isn't signed in to a YouTube channel yet.");
    await store.update((state) => ({ ...state, channel }));
    announce();
    return c.json(channel);
  });

  app.delete("/api/channel", async (c) => {
    await store.update((state) => ({ ...state, channel: null }));
    announce();
    return c.json({ ok: true });
  });
}
