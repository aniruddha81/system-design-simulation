import { z } from "zod";
import { anomalyNames, isolationLevels } from "@/models";
import { templateIds, templates } from "./variants";

export const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";
export const SITE_NAME = "System Design Simulator";

export const TRACKS = [
  { id: "foundations", n: 0, title: "Foundations" },
  { id: "building-blocks", n: 1, title: "Building blocks" },
  { id: "distributed-systems", n: 2, title: "Distributed systems" },
  { id: "reliability", n: 3, title: "Reliability and operations" },
  { id: "security", n: 4, title: "Security and data" },
  { id: "case-studies", n: 5, title: "Case studies" },
  { id: "interview", n: 6, title: "Interview craft" },
] as const;
export type TrackId = (typeof TRACKS)[number]["id"];
const trackId = z.enum(TRACKS.map((t) => t.id) as [TrackId, ...TrackId[]]);

const stableId = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "lowercase-kebab-case id");
const activity = z.enum(["R", "M", "V", "C", "Q"]);

/** Lesson frontmatter (PLAN §9). Lives in a leading MDX comment `{/* yaml *\/}`. */
export const frontmatterSchema = z.strictObject({
  id: stableId,
  slug: stableId,
  track: trackId,
  title: z.string().min(3),
  description: z.string().min(20).max(200),
  objectives: z.array(z.strictObject({ id: stableId, text: z.string().min(10) })).min(2).max(5),
  requires: z.array(stableId),
  activities: z.array(activity).min(1),
  limitations: z.array(z.string().min(3)),
  sources: z
    .array(z.strictObject({ title: z.string(), url: z.url(), authors: z.string().optional(), year: z.number().int().optional() }))
    .min(1),
  reviewedBy: z.string().min(2),
  lastReviewed: z.iso.date(),
  revision: z.number().int().positive(),
  estimatedMinutes: z.number().int().positive(),
});
export type Frontmatter = z.infer<typeof frontmatterSchema>;

/** Completeness matrix (PLAN Appendix A); `content/matrix.json`. */
export const matrixSchema = z.strictObject({
  lessons: z.array(
    z.strictObject({
      id: stableId,
      track: trackId,
      title: z.string(),
      status: z.enum(["live", "planned"]),
      requires: z.array(stableId),
    }),
  ),
  rows: z.array(
    z.strictObject({
      concept: z.string(),
      lesson: stableId,
      activities: z.array(activity).min(1),
      assessment: z.string(),
      capability: z.string(),
      limitations: z.string(),
    }),
  ),
});
export type Matrix = z.infer<typeof matrixSchema>;

// ---- Widget registry: every MDX component a lesson may use, with its props schema. ----
// Unknown components fail MDX rendering; invalid props fail `parse` at build and in the content test.

const children = z.any().optional();
const objective = stableId;
const choiceOption = z.strictObject({ id: stableId, text: z.string(), correct: z.boolean().optional(), feedback: z.string().min(5) });

export const widgetSchemas = {
  Step: z.strictObject({ id: stableId, title: z.string(), children }),
  Choice: z
    .strictObject({
      id: stableId,
      objective,
      prompt: z.string(),
      multiple: z.boolean().optional(),
      options: z.array(choiceOption).min(2),
    })
    .refine((p) => p.options.some((o) => o.correct), "at least one option must be correct")
    .refine((p) => p.multiple || p.options.filter((o) => o.correct).length === 1, "single choice needs exactly one correct option"),
  Ordering: z.strictObject({
    id: stableId,
    objective,
    prompt: z.string(),
    items: z.array(z.strictObject({ id: stableId, text: z.string() })).min(3),
    explanation: z.string(),
  }),
  VariantQuestion: z.strictObject({ template: z.enum(templateIds) }),
  HitRateCalculator: z.strictObject({}),
  MasteryCheck: z.strictObject({ templates: z.array(z.enum(templateIds)).min(1), count: z.number().int().min(3).max(10) }),
  HashRingPlayer: z.strictObject({ seed: z.number().int().optional() }),
  IsolationPlayer: z.strictObject({ anomaly: z.enum(anomalyNames).optional(), level: z.enum(isolationLevels).optional(), seed: z.number().int().optional() }),
  RaftPlayer: z.strictObject({ seed: z.number().int().optional() }),
  ClocksPlayer: z.strictObject({ seed: z.number().int().optional() }),
  TwoPhasePlayer: z.strictObject({ seed: z.number().int().optional() }),
  GossipPlayer: z.strictObject({ seed: z.number().int().optional() }),
  QuorumPlayer: z.strictObject({ seed: z.number().int().optional() }),
  CrdtPlayer: z.strictObject({ seed: z.number().int().optional() }),
  MatchingPlayer: z.strictObject({ seed: z.number().int().optional() }),
  SpatialPlayer: z.strictObject({ seed: z.number().int().optional() }),
  SketchesPlayer: z.strictObject({ seed: z.number().int().optional() }),
  WindowingPlayer: z.strictObject({ seed: z.number().int().optional() }),
  ModelQuestion: z.strictObject({ id: stableId, objective, model: z.enum(["hashRing", "isolation", "raft", "clocks", "twoPhase", "gossip", "quorum", "crdt", "matching", "spatial", "sketches", "windowing"]), seed: z.number().int().optional() }),
} as const;
export type WidgetName = keyof typeof widgetSchemas;

/** The objective a widget instance assesses, if any. */
export function assessedObjectives(name: WidgetName, props: Record<string, unknown>): string[] {
  if (name === "Choice" || name === "Ordering" || name === "ModelQuestion") return [props.objective as string];
  if (name === "VariantQuestion") return [templates[props.template as string].objective];
  if (name === "MasteryCheck") return (props.templates as string[]).map((t) => templates[t].objective);
  return [];
}
