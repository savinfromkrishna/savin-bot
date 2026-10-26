import { z } from "zod";

export class HttpError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 413 | 415 | 422 | 503,
    message: string,
  ) {
    super(message);
  }
}

/** Parses a JSON body against a schema, answering 400 with readable errors when it does not fit. */
export async function body<T extends z.ZodType>(c: { req: { json(): Promise<unknown> } }, schema: T) {
  const parsed = schema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new HttpError(400, z.prettifyError(parsed.error));
  return parsed.data as z.output<T>;
}
