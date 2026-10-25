import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { getDb } from "./db";
import * as schema from "./db/schema";
import { env } from "./env";
import { accountEmail, emailEnforced, sendEmail } from "./email";

const e = env();
const social = {
  ...(e.GITHUB_CLIENT_ID && e.GITHUB_CLIENT_SECRET ? { github: { clientId: e.GITHUB_CLIENT_ID, clientSecret: e.GITHUB_CLIENT_SECRET } } : {}),
  ...(e.GOOGLE_CLIENT_ID && e.GOOGLE_CLIENT_SECRET ? { google: { clientId: e.GOOGLE_CLIENT_ID, clientSecret: e.GOOGLE_CLIENT_SECRET } } : {}),
};

export const auth = betterAuth({
  baseURL: e.BETTER_AUTH_URL,
  secret: e.BETTER_AUTH_SECRET,
  database: drizzleAdapter(getDb(), { provider: "pg", schema }),
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
  user: { deleteUser: { enabled: true } }, // privacy: learners can erase their account and every synced record (cascade)
  session: { expiresIn: 60 * 60 * 24 * 30, updateAge: 60 * 60 * 24, cookieCache: { enabled: true, maxAge: 5 * 60 } },
  // Counters live in Postgres so limits hold across serverless instances.
  rateLimit: { enabled: true, window: 60, max: 60, storage: "database", customRules: { "/sign-in/email": { window: 60, max: 8 }, "/sign-up/email": { window: 3600, max: 10 } } },
  plugins: [nextCookies()], // last: lets server actions set cookies
});
