import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import matrixJson from "../../../content/matrix.json";
import { buildDag } from "./curriculum";
import { frontmatterSchema, matrixSchema, TRACKS, type Frontmatter, type TrackId } from "./schema";

// Server/build only. Synchronous reads keep pages prerenderable under cacheComponents.

const CONTENT_DIR = path.join(process.cwd(), "content", "en");
/** Frontmatter sits in a leading MDX comment so @next/mdx renders nothing for it. */
const DELIMITERS: [string, string] = ["{/*", "*/}"];

export type Lesson = Frontmatter & { stepIds: string[]; stepTitles: string[]; source: string; file: string };
export type CurriculumLesson = {
  id: string;
  track: TrackId;
  title: string;
  status: "live" | "planned";
  requires: string[];
  /** Present for live lessons. */
  slug?: string;
  description?: string;
  estimatedMinutes?: number;
};

export function parseLesson(file: string, raw: string): Lesson {
  if (!raw.startsWith(DELIMITERS[0])) throw new Error(`${file}: lesson must start with a {/* frontmatter */} block`);
  const { data, content } = matter(raw, { delimiters: DELIMITERS });
  const parsed = frontmatterSchema.safeParse(data);
  if (!parsed.success) throw new Error(`${file}: invalid frontmatter\n${parsed.error.message}`);
  const steps = [...content.matchAll(/<Step\s+id="([^"]+)"\s+title="([^"]+)"/g)];
  const stepIds = steps.map((m) => m[1]);
  if (new Set(stepIds).size !== stepIds.length) throw new Error(`${file}: duplicate step id`);
  if (stepIds.length === 0) throw new Error(`${file}: a lesson needs at least one <Step>`);
  return { ...parsed.data, stepIds, stepTitles: steps.map((m) => m[2]), source: raw, file };
}

let lessons: Lesson[] | undefined;
export function loadLessons(): Lesson[] {
  if (lessons) return lessons;
  const out: Lesson[] = [];
  for (const track of TRACKS) {
    const dir = path.join(CONTENT_DIR, track.id);
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir).filter((f) => f.endsWith(".mdx")).sort()) {
      const file = path.join(dir, name);
      const lesson = parseLesson(file, fs.readFileSync(file, "utf8"));
      if (lesson.track !== track.id) throw new Error(`${file}: track "${lesson.track}" does not match folder "${track.id}"`);
      if (`${lesson.slug}.mdx` !== name) throw new Error(`${file}: slug "${lesson.slug}" does not match file name`);
      out.push(lesson);
    }
  }
  return (lessons = out);
}

export function getLesson(track: string, slug: string): Lesson | undefined {
  return loadLessons().find((l) => l.track === track && l.slug === slug);
}

export const matrix = matrixSchema.parse(matrixJson);

/** Every lesson (live and planned) in topological order, with depth, validated as a DAG. */
export function loadCurriculum() {
  const live = new Map(loadLessons().map((l) => [l.id, l]));
  const nodes: CurriculumLesson[] = matrix.lessons.map((m) => {
    const l = live.get(m.id);
    if (m.status === "live" && !l) throw new Error(`matrix.json: lesson "${m.id}" is marked live but has no MDX file`);
    if (l && m.status !== "live") throw new Error(`matrix.json: lesson "${m.id}" has an MDX file but is marked planned`);
    return l
      ? { ...m, title: l.title, requires: l.requires, slug: l.slug, description: l.description, estimatedMinutes: l.estimatedMinutes }
      : m;
  });
  for (const id of live.keys()) {
    if (!nodes.some((n) => n.id === id)) throw new Error(`Lesson "${id}" is missing from matrix.json`);
  }
  return { lessons: nodes, ...buildDag(nodes) };
}
