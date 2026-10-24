import { getCaseStudy } from "@/content/case-studies";
import { referenceDesigns } from "@/content/reference-designs";

/** Resolve only registered inputs; callers clone before saving a local draft. */
export function resolveDesignRequest(query: URLSearchParams) {
  const ref = query.get("ref");
  const study = query.get("case");
  if ((query.has("ref") && !ref) || (query.has("case") && !study)) throw new Error("A design ID is required.");
  if (ref && study) throw new Error("Choose either a reference design or a case study.");
  if (ref) {
    const reference = referenceDesigns.find((r) => r.id === ref);
    if (!reference) throw new Error(`Unknown reference design: ${ref}`);
    const pack = reference.scenarios.find((s) => s.id === (query.get("scenario") ?? "normal-day"));
    if (!pack) throw new Error("Unknown reference scenario.");
    return { design: reference.design, scenario: pack.scenario, reference, initialTab: "scale" as const };
  }
  if (study) {
    const entry = getCaseStudy(study);
    if (!entry) throw new Error(`Unknown case study: ${study}`);
    const scenario = query.get("scenario");
    const selected = scenario ? entry.failureScenarios.find((s) => s.id === scenario)?.scenario : entry.scenario;
    if (!selected) throw new Error("Unknown case-study scenario.");
    const alt = query.get("alt");
    const alternative = alt !== null && /^\d+$/.test(alt) ? entry.alternatives[Number(alt)]?.design : undefined;
    if (alt !== null && (!alternative || query.get("practice") === "1")) throw new Error("Unknown or incompatible alternative design.");
    const design = query.get("practice") === "1"
      ? { schemaVersion: 1 as const, id: entry.id, name: `${entry.title} — practice`, nodes: [], edges: [], endpoints: entry.design.endpoints }
      : alternative ?? entry.design;
    return { design, scenario: selected, reference: undefined, initialTab: "inspect" as const };
  }
  return null;
}
