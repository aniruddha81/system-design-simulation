# Gossip and phi-accrual failure detection

`createGossipModel(options?)` returns `Model<GossipState, GossipAction>`.
Defaults: 32 nodes, one initial rumor holder N0, fanout one, `pushPull`.
Each `round` samples distinct peers from a seeded hash stream. Rounds use a
synchronous infection snapshot: a node newly infected this round only sends the
rumor in a later round. `push`, `pull` and `pushPull` share this schedule model.
`curve` contains infected count from round zero; `contacts` exposes the last
round's directed contacts. Offline peers cannot send or receive.

The detector observes N0's heartbeat stream independently of gossip rounds.
`advance` moves milliseconds; `heartbeat` records a positive inter-arrival time.
`threshold` changes suspicion sensitivity; `crash`/`recover` on N0 supplies the
ground truth used to count false positives and record the first detection time.
The detector cannot infer that ground truth from the heartbeats themselves.

`phiAccrual(elapsed, intervals, initialInterval?, minStdDev?)` estimates
-log10(normal survival probability), using a sliding inter-arrival history,
configurable variance floor and a finite tail floor. Defaults: initial mean
100ms, minimum standard deviation 25ms, window 100 samples, threshold three.
This Gaussian model is illustrative; the distribution assumption is exposed,
not a guarantee for production heartbeat traffic. False positives are counted on
transitions into suspicion while the target is live. Detection time is sampled
when the learner advances time, not an interpolated threshold-crossing instant.

`gossipInvariants` checks infection monotonicity, detector consistency and reports
current `falsePositive` notices. Scripts cover each spread mode and both detector
outcomes. `generateGossipVariant` / `solveGossipVariant` in `variants.ts` ask for
the seeded infection count and obtain the answer by replaying the rounds.
Logarithmic convergence is statistical for connected, live nodes with uniform
contacts, never a bound on every individual seed or a promise during outages.
