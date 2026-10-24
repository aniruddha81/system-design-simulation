# 2PC, Saga and transactional outbox

`createTwoPhaseModel({ mode?, participants?, steps? })` returns
`Model<TwoPhaseState, TwoPhaseAction>`. Modes are `twoPhase` (default), `saga`
and `outbox`. Each mode supplies its own replayable `scenarios`.

2PC uses explicit prepare/vote/decision messages with `deliver` and `drop`.
Participants vote after receiving prepare. Yes votes are durable and cannot be
changed; a prepared participant's timeout records a blocking notice. An unprepared
participant can abort on timeout. The coordinator commits only after every yes
vote; a no vote or coordinator timeout aborts. Coordinator recovery resends its
durable decision or requests missing votes. Message delivery to an offline
coordinator is forbidden; decisions already in flight can still reach participants.
`blocking` is an expected liveness limitation, not an atomicity violation.

Saga `sagaStep` completes the next step or fails it (`fail: true`). `compensate`
undoes one completed step at a time, in reverse order. A non-compensatable step
stops recovery with `status: "stuck"` and `nonCompensatable`, requiring manual
intervention. Orchestrator crashes retain the workflow state.

Outbox `outboxWrite` atomically appends business data and a durable event.
`publish` queues a delivery; `consume` deduplicates effects by record ID.
`acknowledge` is the relay's durable publish acknowledgement, which may happen
before consumption. A crash before acknowledgement permits duplicate publication;
the script demonstrates exactly one consumer effect under redelivery.

`twoPhaseInvariants` checks atomic decisions, expected blocking, reverse
compensation, irreversible recovery and outbox atomicity/deduplication.
`generateTwoPhaseVariant` / `solveTwoPhaseVariant` in `variants.ts` select a mode
and schedule and solve for final invariant/limitation codes by replaying it.

Scope: one transaction/workflow per state, modeled durable memory, sequential
Saga steps, reliable compensations when available, and an idempotent consumer.
No distributed atomicity is claimed for a Saga or an outbox. There are no
automatic retries; message loss and recovery are explicit learner actions.
