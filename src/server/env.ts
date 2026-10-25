import "server-only";
import { z } from "zod";

const schema = z.object({
  DATABASE_URL: z.string().startsWith("postgres"),
  BETTER_AUTH_SECRET: z.string().min(32),
  BETTER_AUTH_URL: z.url(),
  GITHUB_CLIENT_ID: z.string().optional(),
  GITHUB_CLIENT_SECRET: z.string().optional(),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
});

let cached: z.infer<typeof schema> | undefined;

/** Validated server env; throws one readable error at first use instead of failing deep inside a request. */
export function env() {
  return (cached ??= schema.parse(process.env));
}
