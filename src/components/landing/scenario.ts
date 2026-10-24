import { cachingScenario } from "@/engine/fixtures";
import type { ChaosEvent, Scenario } from "@/engine/types";

/** The caching challenge's workload (1,500 req/s, 90% reads, Zipf keys), measured from t = 0. */
export function landingScenario(measureUs: number, chaos: ChaosEvent[]): Scenario {
  return { ...structuredClone(cachingScenario), id: "landing-cache-outage", warmupUs: 0, measureUs, chaos };
}

/** A three-second cache outage: the node is killed, then restarts empty. */
export const outage = (id: string, atUs: number): ChaosEvent => ({ id, kind: "kill", target: "cache", atUs, endUs: atUs + 3_000_000 });
