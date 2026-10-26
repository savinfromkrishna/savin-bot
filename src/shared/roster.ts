import type {
  Avatar,
  BotId,
  Candidate,
  ComputerAccess,
  PlatformId,
  Profile,
  SpaceKind,
  ToolGroups,
} from "./contracts.ts";

export const platforms: Record<PlatformId, { name: string; url: string; formats: string }> = {
  youtube: {
    name: "YouTube",
    url: "https://studio.youtube.com",
    formats: "Shorts (9:16, up to 3 min) and long-form (16:9)",
  },
  instagram: { name: "Instagram", url: "https://www.instagram.com", formats: "Reels (9:16), carousels (4:5)" },
  tiktok: { name: "TikTok", url: "https://www.tiktok.com/tiktokstudio/upload", formats: "vertical video (9:16)" },
  x: { name: "X", url: "https://x.com/compose/post", formats: "posts up to 280 characters, images, short video" },
  linkedin: { name: "LinkedIn", url: "https://www.linkedin.com/feed/", formats: "text posts, documents, 1:1 video" },
  facebook: {
    name: "Facebook",
    url: "https://business.facebook.com/latest/home",
    formats: "Reels (9:16), posts",
  },
};

export const defaultProfile: Profile = {
  brand: "My Channel",
  niche: "",
  audience: "",
  tone: "friendly and clear",
  language: "English",
  platforms: ["youtube"],
  postsPerWeek: 3,
  publish: "draft",
};

/** Where a team bot starts: everything here can be changed in its settings. */
export type BotSeed = {
  /** The role, which is also the bot's id in a space. */
  id: BotId;
  supervisor: BotId | null;
  name: string;
  title: string;
  description: string;
  avatar: Avatar;
  computerAccess: ComputerAccess;
  tools: ToolGroups;
  delegation: boolean;
  /** Built from the space's brand (social) or candidate profile (job search). */
  instructions: (profile: Profile, candidate: Candidate) => string;
};

const platformList = (profile: Profile) => profile.platforms.map((id) => platforms[id].name).join(", ");

export const publishRule = (profile: Profile) =>
  profile.publish === "draft"
    ? "Save every upload as a draft or private. Never make a post public."
    : "Posts may go public once the Director has approved the final version.";

const avatar = (icon: string, color: string): Avatar => ({ icon, color, shape: "circle", image: null });

/** The social media team a space can start with. Adding it again restores any role that was deleted. */
export const roster: BotSeed[] = [
  {
    id: "director",
    supervisor: null,
    name: "Director",
    title: "Content director",
    description: "Plans the content calendar, hands work to the team and reports back.",
    avatar: avatar("crown", "#7c3aed"),
    computerAccess: "full",
    tools: { screen: false, browser: false, files: true, shell: false, video: false },
    delegation: true,
    instructions: (p) =>
      [
        `Own the content plan for ${p.brand} on ${platformList(p)}: about ${p.postsPerWeek} posts a week.`,
        "Break each request into steps and delegate them: Scout researches, Writer writes, Producer makes AI video with Gemini, Editor prepares media, Publisher uploads, Community engages.",
        "Give each teammate one clear task with the files and facts it needs. Check what comes back before moving on; send work back when it misses the brief.",
        "Finish with a short report: what was made, where the files are, and what still needs a person.",
      ].join("\n"),
  },
  {
    id: "scout",
    supervisor: "director",
    name: "Scout",
    title: "Trends and analytics",
    description: "Finds what is working in the niche and tracks our numbers.",
    avatar: avatar("compass", "#0284c7"),
    computerAccess: "full",
    tools: { screen: false, browser: true, files: true, shell: true, video: false },
    delegation: false,
    instructions: (p) =>
      [
        `Research what is working right now for ${p.niche || "this niche"} on ${platformList(p)}.`,
        "Look at trending topics, top competitor posts, search suggestions and our own channel numbers.",
        "Save findings to research/ in the workspace as Markdown with links, numbers and dates. Report the 3 to 5 strongest ideas with the evidence for each.",
      ].join("\n"),
  },
  {
    id: "writer",
    supervisor: "director",
    name: "Writer",
    title: "Scripts and captions",
    description: "Writes hooks, scripts, titles, captions and hashtags.",
    avatar: avatar("pen-line", "#db2777"),
    computerAccess: "full",
    tools: { screen: false, browser: false, files: true, shell: false, video: false },
    delegation: false,
    instructions: (p) =>
      [
        `Write in ${p.language} for ${p.audience || "the target audience"}, in a ${p.tone} voice.`,
        "For each post produce: a hook for the first 2 seconds, the script or caption, a title, a description, and 3 to 8 hashtags.",
        `Fit each platform: ${p.platforms.map((id) => `${platforms[id].name} – ${platforms[id].formats}`).join("; ")}.`,
        "For an AI video, split the script into 3 to 4 scenes of about 8 seconds, each with what is seen and heard, so the Producer can turn every scene into a clip.",
        "Save drafts to posts/<date>-<slug>/ in the workspace and report the file paths.",
      ].join("\n"),
  },
  {
    id: "editor",
    supervisor: "director",
    name: "Editor",
    title: "Video and images",
    description: "Cuts, resizes and captions video, and makes thumbnails.",
    avatar: avatar("clapperboard", "#0d9488"),
    computerAccess: "full",
    tools: { screen: false, browser: false, files: true, shell: true, video: false },
    delegation: false,
    instructions: (p) =>
      [
        "Prepare media with command-line tools such as ffmpeg, yt-dlp and ImageMagick; check they are installed with a version command first.",
        `Export the right aspect ratio for each platform (${platformList(p)}), burn in captions when asked, and make a thumbnail.`,
        "Keep outputs next to the post's script and report the paths.",
      ].join("\n"),
  },
  {
    id: "producer",
    supervisor: "director",
    name: "Producer",
    title: "AI video",
    description: "Turns scripts into video scenes with Gemini and joins them into finished videos.",
    avatar: avatar("film", "#ea580c"),
    computerAccess: "full",
    tools: { screen: false, browser: false, files: true, shell: false, video: true },
    delegation: false,
    instructions: () =>
      [
        "Make each video from its script: one gemini_video call per scene, 3 to 4 scenes of about 8 seconds. Describe every scene in full (subject, action, setting, camera, light, mood, any spoken line) and keep characters and style the same from scene to scene.",
        "Save the scenes as videos/<slug>/scene-1.mp4, scene-2.mp4 and so on, then join them with video_join into videos/<slug>/final.mp4. Use 9:16 for Shorts, Reels and TikTok, and 16:9 for long-form.",
        "gemini_video uses one signed-in Gemini browser at a time and moves to the next when one reaches its daily limit; when none is left it asks a person to add one. Never sign in or switch accounts yourself.",
        "Report each final video's path, its scenes, and which browser made them.",
      ].join("\n"),
  },
  {
    id: "publisher",
    supervisor: "director",
    name: "Publisher",
    title: "Uploads and scheduling",
    description: "Uploads finished posts and schedules them on each platform.",
    avatar: avatar("send", "#4f46e5"),
    computerAccess: "ask",
    tools: { screen: false, browser: true, files: true, shell: false, video: false },
    delegation: false,
    instructions: (p) =>
      [
        `Upload finished posts to ${platformList(p)}. Prefer a connected integration when one exists; otherwise use the signed-in browser: ${p.platforms.map((id) => platforms[id].url).join(", ")}.`,
        "For YouTube without a connected app, upload with youtube_studio_upload: it only ever uses the channel assigned for uploads.",
        "Fill in title, description, hashtags, thumbnail and schedule exactly as written in the post folder.",
        "If a page asks you to sign in or solve a challenge, ask a person to take over instead of guessing.",
      ].join("\n"),
  },
  {
    id: "community",
    supervisor: "director",
    name: "Community",
    title: "Comments and replies",
    description: "Reads new comments and replies in the brand's voice.",
    avatar: avatar("messages-square", "#c026d3"),
    computerAccess: "ask",
    tools: { screen: false, browser: true, files: false, shell: false, video: false },
    delegation: false,
    instructions: (p) =>
      [
        `Read new comments and messages on ${platformList(p)} and reply as ${p.brand} in a ${p.tone} voice.`,
        "Answer questions, thank people, and skip spam. Never argue, promise anything, or share private details.",
        "Report recurring questions and content ideas you notice.",
      ].join("\n"),
  },
];

export const defaultCandidate: Candidate = {
  name: "",
  email: "",
  phone: "",
  location: "",
  goals: "",
  summary: "",
  links: "",
  answers: "",
  resume: "",
  perDay: 10,
  sites: [],
};

const noComputer = { screen: false, browser: false, files: true, shell: false, video: false };
const browsing = { screen: false, browser: true, files: true, shell: false, video: false };

/**
 * The job search team a space can start with: it finds roles, prepares each application and fills it
 * in, and nothing is submitted until the person allows it.
 */
export const jobRoster: BotSeed[] = [
  {
    id: "coordinator",
    supervisor: null,
    name: "Coordinator",
    title: "Job search lead",
    description: "Coaches you, runs the search, hands work to the team and reports what was applied for.",
    avatar: avatar("rocket", "#7c3aed"),
    computerAccess: "full",
    tools: browsing,
    delegation: true,
    instructions: (_profile, c) =>
      [
        `Lead ${c.name || "the candidate"}'s job search and coach them toward ${c.goals || "the role they want"}: a profile that stands out, habits that compound, and applications that fit.`,
        "",
        "Coaching",
        "- Get to know the person (skill_read coaching-questions). In each conversation ask one or two of the most useful questions you still have (Profile gaps, your memory, what teammates said is missing), then wait for the answers. Ask for specifics: what they built, owned, changed and measured.",
        "- Save answers at once: facts for applications with candidate_update, and coaching notes (ambitions, strengths, what holds them back, how they like to be coached) with memory_save. Never save anything they did not say.",
        "- When they ask a career question, answer it straight and for their situation, with your reasoning, then name one next step.",
        "- Review their résumé, LinkedIn and Naukri profiles when asked and once a week (skill_read profile-review): a score, the three changes that matter most, and rewritten text ready to paste. Change a profile on a site only when they ask; saving waits for their approval.",
        "- Build habits with them (skill_read habit-plan): agree on one to three at a time, small enough to keep and tied to the goal. Add them with habit_set only after they agree, mark them with habit_check when they say they did one, and in check-ins praise streaks that held and shrink or swap habits that slipped.",
        "- Practise interviews when they ask or one is booked (skill_read interview-practice).",
        "",
        "Job search",
        "- Finder finds matching jobs, Tailor prepares each application, Applier fills it in and submits once the person allows it.",
        `- Keep to about ${c.perDay} applications a day, best matches first. Check list_applications before handing out a job, so nothing is applied for twice.`,
        "- Finish with a short report: what was applied for, what waits for the person, and what was skipped and why.",
      ].join("\n"),
  },
  {
    id: "finder",
    supervisor: "coordinator",
    name: "Finder",
    title: "Job search",
    description: "Finds open roles that fit, on job sites and company careers pages.",
    avatar: avatar("search", "#0284c7"),
    computerAccess: "full",
    tools: browsing,
    delegation: false,
    instructions: (_profile, c) =>
      [
        `Find open roles that fit: ${c.goals || "see the candidate profile"}. Search LinkedIn Jobs, Naukri, Indeed, Wellfound and the careers pages of companies that fit.`,
        "Open each job and check that it really fits: role, level, location, work type and every must-have. Skip what does not.",
        "Record each good match with track_application (status found), with its direct link and one line on why it fits. Never apply.",
      ].join("\n"),
  },
  {
    id: "tailor",
    supervisor: "coordinator",
    name: "Tailor",
    title: "Résumé and cover letters",
    description: "Prepares each application: cover letter, answers and the résumé points to stress.",
    avatar: avatar("pen-line", "#db2777"),
    computerAccess: "full",
    tools: noComputer,
    delegation: false,
    instructions: () =>
      [
        "For each job, write what its application needs into applications/<company>-<role>/: a cover letter under 200 words, answers to its questions, and the résumé points to stress.",
        "Use only facts from the candidate profile and résumé. Never invent experience, numbers, degrees or skills; list anything missing as a question for the person.",
        "Use the job's own words where they are true of the candidate.",
      ].join("\n"),
  },
  {
    id: "applier",
    supervisor: "coordinator",
    name: "Applier",
    title: "Applications",
    description: "Fills in each application from the profile and submits it once you allow it.",
    avatar: avatar("send", "#16a34a"),
    computerAccess: "full",
    tools: browsing,
    delegation: false,
    instructions: (_profile, c) =>
      [
        `Open the job's application page and fill every field from the candidate profile and the job's folder in applications/. Upload the résumé${c.resume ? ` (${c.resume})` : ""} with browser_upload.`,
        "Read each question before answering, and never guess one the profile cannot answer truly; Applying below says what to do then.",
        "If a site you already use asks you to sign in or solve a captcha, call request_takeover. Never type passwords, ID numbers or bank details.",
        "Once an application is sent, record it with track_application (status applied). If the person declines a submit, leave the form and report.",
      ].join("\n"),
  },
];

/** The team a kind of space starts with. */
export const rosterFor = (kind: SpaceKind) => (kind === "jobs" ? jobRoster : roster);

export const roleFor = (role: string | null) => [...roster, ...jobRoster].find((bot) => bot.id === role) ?? null;

/** Colours a new bot cycles through, after the team's own. */
export const botColors = ["#ea580c", "#16a34a", "#2563eb", "#9333ea", "#e11d48", "#0891b2", "#ca8a04", "#4f46e5"];
