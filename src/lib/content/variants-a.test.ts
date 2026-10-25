import { describe, expect, it } from "vitest";
import { generate, isCorrect, templates } from "./variants";
import { templatesA } from "./variants-a";

describe("new building-block variant templates", () => {
  for (const [id, template] of Object.entries(templatesA)) {
    it(`${id} generates valid answers and distinct mistakes for 50 seeds`, () => {
      expect(template.id).toBe(id);
      expect(templates[id]).toBe(template);
      for (let seed = 0; seed < 50; seed++) {
        const variant = generate(template, seed);
        expect(template.valid?.(variant.params)).toBe(true);
        expect(Number.isFinite(variant.answer)).toBe(true);
        expect(isCorrect(template, variant, variant.answer)).toBe(true);
        for (const mistake of template.mistakes?.(variant.params) ?? []) {
          expect(Number.isFinite(mistake.value)).toBe(true);
          expect(mistake.value).not.toBe(variant.answer);
          expect(isCorrect(template, variant, mistake.value)).toBe(false);
        }
      }
    });
  }
});
