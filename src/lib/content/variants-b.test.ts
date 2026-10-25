import { describe, expect, it } from "vitest";
import { diagnose, generate, isCorrect } from "./variants";
import { templatesB } from "./variants-b";

describe("lesson variants B", () => {
  for (const [id, template] of Object.entries(templatesB)) {
    it(`${id}: generates valid answers and distinct mistakes for 50 seeds`, () => {
      expect(template.id).toBe(id);
      for (let seed = 0; seed < 50; seed++) {
        const variant = generate(template, seed);
        expect(Number.isFinite(variant.answer)).toBe(true);
        expect(template.valid?.(variant.params)).toBe(true);
        expect(isCorrect(template, variant, variant.answer)).toBe(true);
        for (const mistake of template.mistakes?.(variant.params) ?? []) {
          expect(mistake.value).not.toBe(variant.answer);
          expect(isCorrect(template, variant, mistake.value)).toBe(false);
          expect(diagnose(template, variant, mistake.value)).toBe(mistake.feedback);
        }
      }
    });
  }
});

