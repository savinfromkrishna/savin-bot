import type { Credential, CredentialStore } from "@earendil-works/pi-ai";
import type { Secrets } from "../secrets.ts";

/** Where one account keeps its sealed model credentials, by provider id. */
export type SealedRecords = {
  read(): Record<string, string>;
  write(change: (records: Record<string, string>) => Record<string, string>): Promise<void>;
};

/**
 * pi's credential store over sealed records. Every write for a provider runs in turn, so a token
 * refresh during a run can never race a new sign-in and drop the newer token.
 */
export function sealedCredentials(records: SealedRecords, secrets: Secrets): CredentialStore {
  const queues = new Map<string, Promise<unknown>>();
  const inTurn = <T>(providerId: string, work: () => Promise<T>) => {
    const next = (queues.get(providerId) ?? Promise.resolve()).then(work, work);
    queues.set(
      providerId,
      next.catch(() => {}),
    );
    return next;
  };
  const read = (providerId: string) => {
    const sealed = records.read()[providerId];
    return sealed ? secrets.open<Credential>(sealed) : undefined;
  };
  return {
    read: async (providerId) => read(providerId),
    list: async () =>
      Object.keys(records.read()).flatMap((providerId) => {
        const credential = read(providerId);
        return credential ? [{ providerId, type: credential.type }] : [];
      }),
    modify: (providerId, change) =>
      inTurn(providerId, async () => {
        const next = await change(read(providerId));
        if (!next) return read(providerId);
        await records.write((all) => ({ ...all, [providerId]: secrets.seal(next) }));
        return next;
      }),
    delete: (providerId) => inTurn(providerId, () => records.write(({ [providerId]: _removed, ...rest }) => rest)),
  };
}
