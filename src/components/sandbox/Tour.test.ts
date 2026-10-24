import { expect, it } from "vitest";
import { nextTourStep } from "./Tour";

it("advances the tour only when the current step's action occurs", () => {
  expect(nextTourStep({ step: 0, nodes: 2, edges: 1 }, 2, 2, "running")).toBe(0);
  expect(nextTourStep({ step: 0, nodes: 2, edges: 1 }, 3, 1, "idle")).toBe(1);
  expect(nextTourStep({ step: 1, nodes: 3, edges: 1 }, 4, 1, "idle")).toBe(1);
  expect(nextTourStep({ step: 1, nodes: 3, edges: 1 }, 3, 2, "idle")).toBe(2);
  expect(nextTourStep({ step: 2, nodes: 3, edges: 2 }, 3, 2, "paused")).toBe(2);
  expect(nextTourStep({ step: 2, nodes: 3, edges: 2 }, 3, 2, "running")).toBe(3);
  expect(nextTourStep({ step: 3, nodes: 3, edges: 2 }, 4, 3, "running")).toBe(3);
});
