import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

/**
 * AES-256-GCM for credentials at rest. The key comes from ENCRYPTION_KEY when set,
 * otherwise from a random key file created next to the data on first start.
 */
export class Secrets {
  private constructor(private readonly key: Buffer) {}

  static open(keyFile: string, passphrase = process.env.ENCRYPTION_KEY) {
    if (passphrase) return new Secrets(scryptSync(passphrase, "savin-social", 32));
    if (!existsSync(keyFile)) writeFileSync(keyFile, randomBytes(32).toString("base64"), { mode: 0o600 });
    return new Secrets(Buffer.from(readFileSync(keyFile, "utf8").trim(), "base64"));
  }

  seal(value: unknown): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const data = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
    return `v1.${Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64")}`;
  }

  open<T>(sealed: string): T {
    const raw = Buffer.from(sealed.replace(/^v1\./, ""), "base64");
    const decipher = createDecipheriv("aes-256-gcm", this.key, raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    return JSON.parse(Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8")) as T;
  }
}
