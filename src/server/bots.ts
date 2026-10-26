import type { Bot, BotId, CredentialInput, CredentialView } from "../shared/contracts.ts";
import { jobRoles, teamRoles } from "../shared/ids.ts";
import { roleFor } from "../shared/roster.ts";
import type { Secrets } from "./secrets.ts";
import type { BotRecord, StoredState } from "./store.ts";
import type { OpenCredential } from "./tools/tool.ts";

/** What a bot's automatic instructions are built from: the brand, or the candidate profile. */
type Source = Pick<StoredState, "profile" | "candidate">;

/** The instructions a bot follows while nobody has edited them: its role's, built from the space's profile. */
export const automaticInstructions = (record: BotRecord, source: Source) =>
  roleFor(record.role)?.instructions(source.profile, source.candidate) ?? record.description;

const roleOrder: readonly string[] = [...teamRoles, ...jobRoles];

export function botView(id: BotId, record: BotRecord, source: Source): Bot {
  return {
    id,
    role: record.role,
    supervisor: record.supervisor,
    name: record.name,
    title: record.title,
    description: record.description,
    avatar: record.avatar,
    notifications: record.notifications,
    computerAccess: record.computerAccess,
    tools: record.tools,
    delegation: record.delegation,
    instructions: record.instructions ?? automaticInstructions(record, source),
    instructionsAutomatic: record.instructions === null,
    instructionHistory: record.instructionHistory,
    model: record.model,
    thinking: record.thinking,
    memory: record.memory,
    openWork: record.openWork,
    disabledTools: record.disabledTools,
    credentials: record.credentials.map(({ id: credentialId, type, target, detail }) => ({
      id: credentialId,
      type,
      target,
      detail,
    })),
    readAloud: record.readAloud,
    voice: record.voice,
    historyClearedAt: record.historyClearedAt,
    autoApply: record.autoApply ?? false,
  };
}

/** The team in role order, then the bots you created, oldest first. */
export function botViews(state: StoredState): Bot[] {
  const rank = (id: string, record: BotRecord) => {
    const index = roleOrder.indexOf(record.role ?? "");
    return index >= 0 ? `0${String(index).padStart(2, "0")}` : `1${record.createdAt}${id}`;
  };
  return Object.entries(state.bots)
    .sort(([a, left], [b, right]) => rank(a, left).localeCompare(rank(b, right)))
    .map(([id, record]) => {
      const view = botView(id, record, state);
      return view.supervisor && !state.bots[view.supervisor] ? { ...view, supervisor: null } : view;
    });
}

/** What the settings list shows about a credential: where it applies, never its secret. */
export function describeCredential(input: CredentialInput): Pick<CredentialView, "target" | "detail"> {
  switch (input.type) {
    case "bearer":
      return { target: input.domain, detail: "Bearer token" };
    case "header":
      return { target: input.domain, detail: input.header };
    case "basic":
      return { target: input.domain, detail: input.username };
    case "login":
      return { target: input.domain, detail: input.username };
    case "variable":
      return { target: input.name, detail: "Command variable" };
  }
}

export const openCredentials = (record: BotRecord, secrets: Secrets): OpenCredential[] =>
  record.credentials.flatMap((credential) => {
    try {
      return [secrets.open<OpenCredential>(credential.secret)];
    } catch {
      return [];
    }
  });
