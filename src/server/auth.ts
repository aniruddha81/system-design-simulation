import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { APIError } from "better-auth/api";
import { z } from "zod";
import { getDb } from "./db";
import * as schema from "./db/schema";
import { env } from "./env";
import { accountEmail, emailEnforced, sendEmail } from "./email";

const e = env();
const profile = z.object({ name: z.string().trim().min(1).max(80).optional(), image: z.url({ protocol: /^https?$/ }).max(2048).nullable().optional() });
async function validateProfile(user: { name?: string; image?: string | null }) {
  const parsed = profile.safeParse(user);
  if (!parsed.success) throw new APIError("BAD_REQUEST", { message: "Name must be 1–80 characters and image must be a URL of at most 2048 characters." });
  return { data: { ...user, ...parsed.data } };
}
const social = {
  ...(e.GITHUB_CLIENT_ID && e.GITHUB_CLIENT_SECRET ? { github: { clientId: e.GITHUB_CLIENT_ID, clientSecret: e.GITHUB_CLIENT_SECRET } } : {}),
  ...(e.GOOGLE_CLIENT_ID && e.GOOGLE_CLIENT_SECRET ? { google: { clientId: e.GOOGLE_CLIENT_ID, clientSecret: e.GOOGLE_CLIENT_SECRET } } : {}),
};

export const auth = betterAuth({
  baseURL: e.BETTER_AUTH_URL,
  secret: e.BETTER_AUTH_SECRET,
  database: drizzleAdapter(getDb(), { provider: "pg", schema }),
  databaseHooks: { user: { create: { before: validateProfile }, update: { before: validateProfile } } },
  emailAndPassword: {
    enabled: true, minPasswordLength: 10, maxPasswordLength: 128,
    requireEmailVerification: emailEnforced(),
    revokeSessionsOnPasswordReset: true,
    sendResetPassword: async ({ user, url }) => {
      await sendEmail({ to: user.email, ...accountEmail("Reset your password", url) });
    },
  },
  emailVerification: {
    sendOnSignUp: emailEnforced(),
    sendVerificationEmail: async ({ user, url }) => {
      await sendEmail({ to: user.email, ...accountEmail("Verify your email", url) });
    },
  },
  socialProviders: social,
  user: {
    deleteUser: {
      enabled: true,
      // Without the password, deletion needs a confirmation link sent to the account email, so a stolen session cannot erase the account.
      sendDeleteAccountVerification: async ({ user, url }) => {
        await sendEmail({ to: user.email, ...accountEmail("Confirm account deletion", url) });
      },
    },
  }, // privacy: learners can erase their account and every synced record (cascade)
  session: { expiresIn: 60 * 60 * 24 * 30, updateAge: 60 * 60 * 24 },
  // Counters live in Postgres so limits hold across serverless instances.
  rateLimit: { enabled: true, window: 60, max: 60, storage: "database", customRules: { "/sign-in/email": { window: 60, max: 8 }, "/sign-up/email": { window: 3600, max: 10 } } },
  plugins: [nextCookies()], // last: lets server actions set cookies
});
