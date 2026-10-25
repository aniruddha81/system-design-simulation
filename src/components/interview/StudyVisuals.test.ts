import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { caseStudies } from "@/content/case-studies";
import { DesignFlow, EstimateTiles, RubricMeter } from "./StudyVisuals";

describe("study visuals", () => {
  it("renders every reference topology with finite coordinates and full labels", () => {
    for (const study of caseStudies) {
      const html = renderToStaticMarkup(createElement(DesignFlow, { design: study.design }));
      expect(html).not.toMatch(/NaN|Infinity/);
      expect(html).toContain("Component labels and connections");
      expect(html.match(/<rect width="136"/g)).toHaveLength(study.design.nodes.length);
    }
  });

  it("keeps single-coordinate diagrams finite", () => {
    const design = { ...caseStudies[0].design, nodes: caseStudies[0].design.nodes.map((n) => ({ ...n, position: { x: 0, y: 0 } })) };
    expect(renderToStaticMarkup(createElement(DesignFlow, { design }))).not.toMatch(/NaN|Infinity/);
  });

  it("distinguishes unrated from rated and retains estimate formulas", () => {
    expect(renderToStaticMarkup(createElement(RubricMeter, { stage: "estimates" }))).toContain("estimates: not rated");
    expect(renderToStaticMarkup(createElement(RubricMeter, { stage: "estimates", value: 3 }))).toContain("estimates: 3 of 4");
    const html = renderToStaticMarkup(createElement(EstimateTiles, { estimates: [{ label: "Traffic", formula: "100 / 10", result: "10 rps", note: "Assumed" }] }));
    expect(html).toContain("100 / 10");
    expect(html).toContain("10 rps");
    expect(html).toContain("Assumed");
  });
});
