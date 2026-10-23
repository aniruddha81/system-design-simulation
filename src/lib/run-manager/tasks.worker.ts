// Short-lived worker for CPU-heavy one-offs: challenge grading (K seeds) and single-request traces.
import { gradeChallenge, traceRequest } from "../../engine";
import type { TaskReply, TaskRequest } from "./index";

self.onmessage = (e: MessageEvent<TaskRequest>) => {
  const m = e.data;
  let reply: TaskReply;
  try {
    const value =
      m.type === "grade"
        ? gradeChallenge(m.design, m.challenge)
        : traceRequest(m.design, m.endpointId, m.key, m.seed, m.priorInputs);
    reply = { ok: true, value };
  } catch (err) {
    reply = { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  self.postMessage(reply);
};
