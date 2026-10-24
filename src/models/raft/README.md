# Raft

`createRaftModel(options?)` returns `Model<RaftState, RaftAction>`. Defaults:
three nodes A/B/C, election timeout 8..15 ticks, heartbeat every two ticks.
Membership is fixed. A tick is a logical time unit, not a wall-clock read.

`timeout` forces a follower/candidate election; `tick` uses seed-derived deadlines.
Every RequestVote, vote reply, AppendEntries and replication reply is an explicit
message. `deliver`, `drop` and `delay` operate on message IDs. A partition contains
groups covering each node once; `heal` restores connectivity. Messages remain in
flight while partitioned or offline. Delayed messages require time advancement.
`crash`/`recover` preserve terms, votes, logs and applied state. `propose` requires
a live leader, including an isolated stale leader that cannot obtain a majority.

Logs use one-based indexes; `commitIndex` is also the number of committed entries.
Leaders append a `null` no-op on election to establish a current-term majority.
Followers never campaign while fresh heartbeats reset their election deadlines.
`drainRaft(model, state)` delivers reachable messages without advancing time and
returns both the new state and all delivery actions, for exact replay.

`raftInvariants` checks `electionSafety`, `logMatching`, `leaderCompleteness` and
`stateMachineSafety`. Election snapshots and committed-entry witnesses retain
evidence across crashes and role changes. Scripts cover election, crash, split
vote, minority partition and suffix repair. Scripts contain explicit message IDs
and can replay at any seed (they use forced elections, not timer assumptions).

`variants.ts` exports `generateRaftVariant(seed)` and `solveRaftVariant(variant)`;
the boolean answer replays the supplied message schedule.

Limits: no membership changes, snapshots/log compaction, pre-vote, check-quorum,
disk faults or Byzantine nodes. This is the focused mechanism, separate from the
operational engine's election-delay abstraction. An isolated leader remains a
leader in its older term until it receives evidence of a newer term.
