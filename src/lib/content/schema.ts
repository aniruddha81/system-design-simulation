import { z } from "zod";
import { anomalyNames, isolationLevels } from "@/models";
import { templateIds, templates } from "./variants";

export const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? "https://sds.aniruddha81.tech";
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
    .array(z.strictObject({ title: z.string(), url: z.url({ protocol: /^https?$/ }), authors: z.string().optional(), year: z.number().int().optional() }))
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

const kind = z.enum(["client", "loadBalancer", "service", "cache", "database", "rateLimiter", "dns", "cdn", "apiGateway", "kvStore", "queue", "worker", "objectStore", "searchIndex", "dedupStore", "autoscaler", "circuitBreaker"]);
const tone = z.enum(["ok", "warn", "bad", "info", "muted"]);
const vTitle = z.string().min(3);

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
  Flow: z.strictObject({
    title: vTitle,
    nodes: z.array(z.strictObject({ id: z.string(), label: z.string(), kind, x: z.number().min(0).max(100), y: z.number().min(0).max(100), note: z.string().optional() })).min(2),
    edges: z.array(z.strictObject({ from: z.string(), to: z.string(), label: z.string().optional(), dashed: z.boolean().optional() })),
    failed: z.array(z.string()).optional(),
    hot: z.array(z.string()).optional(),
    height: z.number().min(120).max(520).optional(),
    caption: z.string().optional(),
  }),
  Bars: z.strictObject({ title: vTitle, items: z.array(z.strictObject({ label: z.string(), value: z.number().positive(), unit: z.string().optional(), tone: tone.optional() })).min(2), log: z.boolean().optional(), caption: z.string().optional() }),
  Stats: z.strictObject({ title: vTitle, items: z.array(z.strictObject({ label: z.string(), value: z.string(), sub: z.string().optional(), tone: tone.optional() })).min(1), caption: z.string().optional() }),
  Sequence: z.strictObject({ title: vTitle, actors: z.array(z.string()).min(2), messages: z.array(z.strictObject({ from: z.string(), to: z.string(), label: z.string(), lost: z.boolean().optional(), tone: tone.optional() })).min(1), caption: z.string().optional() }),
  Timeline: z.strictObject({ title: vTitle, events: z.array(z.strictObject({ at: z.string(), label: z.string(), tone: tone.optional() })).min(2), caption: z.string().optional() }),
  Compare: z.strictObject({ title: vTitle, sides: z.array(z.strictObject({ title: z.string(), points: z.array(z.string()).min(1), tone: tone.optional() })).min(2).max(4), caption: z.string().optional() }),
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
