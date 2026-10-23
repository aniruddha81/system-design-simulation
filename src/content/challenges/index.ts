import { cachingChallenge, noCacheDesign } from "@/engine/fixtures";
import type { ChallengeSpec, Design } from "@/engine/types";

export type Challenge = {
  id: string;
  title: string;
  /** Short paragraphs shown above the editor. */
  brief: string[];
  spec: ChallengeSpec;
  start: Design;
  /** Fallback hint ladder; the grader's own hints win when present. */
  hints: [string, string, string];
};

export const challenges: Challenge[] = [
  {
    id: cachingChallenge.id,
    title: cachingChallenge.title,
    brief: [
      "Users read their profiles far more often than they update them, and a few profiles are very hot. The database has only a handful of workers, so every read hitting it queues behind the others.",
      "Seven seconds in, the cache node restarts empty. Your design has to keep reads fast and successful through that cold start — without blowing the budget.",
    ],
    spec: cachingChallenge,
    start: noCacheDesign,
    hints: [
      "Look at which component is busiest in the results. Is every read paying for a database round trip?",
      "The services can already call the cache. Change the GET route to check the cache first and only call the database on a miss — then store what you read.",
      "GET: cacheGet → if hit respond 200, else call DB → cacheSet → respond 200. PUT: call DB → cacheDelete → respond 200. Turn on request coalescing so the cold start doesn't stampede the database.",
    ],
  },
];

export function getChallenge(id: string): Challenge | undefined {
  return challenges.find((c) => c.id === id);
}
