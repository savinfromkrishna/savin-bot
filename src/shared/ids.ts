/** Plain identifiers, free of schema code so the browser bundle stays small. */
export const platformIds = ["youtube", "instagram", "tiktok", "x", "linkedin", "facebook"] as const;
/** The social media team's roles, which are also the ids of its bots. */
export const teamRoles = ["director", "scout", "writer", "editor", "producer", "publisher", "community"] as const;
/** What a space is for: social media, or a job search with its own, locked-down team. */
export const spaceKinds = ["social", "jobs"] as const;
/** The job search team's roles. */
export const jobRoles = ["coordinator", "finder", "tailor", "applier"] as const;
/** Tool groups a job search space never gives its bots: the terminal, the desktop and Gemini video reach beyond it. */
export const jobsLockedGroups = ["screen", "shell", "video"] as const;
export const applicationStatuses = ["found", "ready", "applied", "interview", "offer", "rejected", "skipped"] as const;
/** The languages voice typing listens for; "auto" lets the speech model tell which one is spoken. */
export const dictationLanguages = {
  en: "English",
  auto: "Detect automatically",
  hi: "Hindi",
  mr: "Marathi",
  gu: "Gujarati",
  bn: "Bengali",
  pa: "Punjabi",
  ur: "Urdu",
  ta: "Tamil",
  te: "Telugu",
  kn: "Kannada",
  ml: "Malayalam",
  es: "Spanish",
  fr: "French",
  de: "German",
  pt: "Portuguese",
  it: "Italian",
  ru: "Russian",
  ar: "Arabic",
  ja: "Japanese",
  zh: "Chinese",
} as const;
export type DictationLanguage = keyof typeof dictationLanguages;

/** How often a job seeker's habit is due: every day, or a number of times a week. */
export const habitCadences = ["daily", "weekly"] as const;

/** savin's computer tool groups, switched per bot, plus Video (Gemini scenes and joining clips). */
export const toolGroups = ["screen", "browser", "files", "shell", "video"] as const;
export const computerAccessLevels = ["off", "ask", "full"] as const;
/** pi's thinking levels; each model supports a subset. */
export const thinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export const credentialTypes = ["bearer", "header", "basic", "login", "variable"] as const;
export const ruleCategories = ["publish", "message", "spend"] as const;

/** The browser every space starts with, where the bots browse and the platforms are signed in. */
export const MAIN_BROWSER = "main";

/** A tab across a space's browsers: its own key in the main browser, `<browser>.<key>` in another. */
export const tabKey = (browser: string, key: string) => (browser === MAIN_BROWSER ? key : `${browser}.${key}`);

export const parseTabKey = (key: string) => {
  const dot = key.indexOf(".");
  return dot < 0 ? { browser: MAIN_BROWSER, key } : { browser: key.slice(0, dot), key: key.slice(dot + 1) };
};
