import { describe, expect, it } from "vitest";
import { caseStudies } from "@/content/case-studies";
import { referenceDesigns } from "@/content/reference-designs";
import { designSchema } from "@/lib/persistence";
import { resolveDesignRequest } from "./open-design";

describe("sandbox design links", () => {
  it("resolves every reference scenario into Scale mode without mutating templates", () => {
    for (const ref of referenceDesigns) {
      expect(resolveDesignRequest(new URLSearchParams({ ref: ref.id }))?.scenario.id).toBe(`${ref.id}-normal-day`);
      for (const pack of ref.scenarios) {
        const request = resolveDesignRequest(new URLSearchParams({ ref: ref.id, scenario: pack.id }))!;
        expect(request.initialTab).toBe("scale");
        expect(request.scenario).toBe(pack.scenario);
        expect(request.reference).toBe(ref);
        const draft = structuredClone(request.design);
        expect(() => designSchema.parse(draft), ref.id).not.toThrow();
        draft.nodes.length = 0;
        expect(ref.design.nodes.length).toBeGreaterThan(0);
      }
    }
  });

  it("resolves all case-study baselines, failures and empty practice boards", () => {
    for (const c of caseStudies) {
      expect(resolveDesignRequest(new URLSearchParams({ case: c.id }))?.scenario).toBe(c.scenario);
      expect(() => designSchema.parse(c.design), c.id).not.toThrow();
      for (const f of c.failureScenarios) expect(resolveDesignRequest(new URLSearchParams({ case: c.id, scenario: f.id }))?.scenario).toBe(f.scenario);
      const practice = resolveDesignRequest(new URLSearchParams({ case: c.id, practice: "1" }))!;
      expect(practice.design.nodes).toEqual([]);
      expect(practice.design.endpoints).toBe(c.design.endpoints);
      expect(c.design.nodes.length).toBeGreaterThan(0);
      c.alternatives.forEach((a, i) => {
        if (a.design) expect(resolveDesignRequest(new URLSearchParams({ case: c.id, alt: String(i) }))?.design).toBe(a.design);
      });
    }
  });

  it("rejects unknown IDs, scenarios, empty IDs and ambiguous requests", () => {
    for (const query of ["ref=missing", "ref=", "case=", "case=missing", "ref=youtube&scenario=missing", "case=url-shortener&scenario=missing", "case=url-shortener&alt=-1", "case=url-shortener&alt=0oops", "case=url-shortener&alt=999", "case=url-shortener&alt=0&practice=1", "ref=youtube&case=url-shortener"]) {
      expect(() => resolveDesignRequest(new URLSearchParams(query))).toThrow();
    }
    expect(resolveDesignRequest(new URLSearchParams("template=cache-aside"))).toBeNull();
  });
});
