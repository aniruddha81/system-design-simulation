export interface Violation {
  code: string;
  message: string;
  transactions?: string[];
  keys?: string[];
}

/** Replay actions.slice(0, cursor) from init(seed) to scrub without mutable history. */
export interface Script<A> {
  name: string;
  description: string;
  actions: A[];
}

export interface Model<S, A> {
  init(seed: number): S;
  actions(state: S): A[];
  step(state: S, action: A): S;
  invariants(state: S): Violation[];
  scenarios: Script<A>[];
}
