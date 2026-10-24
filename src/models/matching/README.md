# Sequenced limit order book

`createMatchingModel()` returns `Model<MatchingState, MatchingAction>`.
`limit`, `market` and `cancel` actions receive monotonically increasing sequence
numbers in step order, including missing/late cancellations. IDs cannot be
reused. Prices are positive integer ticks and quantities positive safe integers.
Market orders consume available liquidity and cancel their unfilled remainder.
Unknown/already-filled cancels are recorded no-ops.

`orderBook(state)` returns sorted `bids` and `asks`. Matching chooses best price,
then earliest sequence, executes at the resting maker's price, and supports
partial fills across orders and levels. `orders` retains original, remaining,
filled and cancelled quantities. `tape` records maker/taker IDs, price, quantity
and the taker's sequence. `history` records every sequenced command and its
consumed maker IDs.

`matchingInvariants` checks that the book is uncrossed and every order's submitted
quantity equals its fills, cancellations and resting remainder. It replays the
sequenced commands to check the recorded price-time executions. Tests also use
an independent prior-book fill oracle. `matchingScenarios` includes a cross,
multi-level fills, and both orderings of a cancel/fill race.

`generateMatchingVariant(seed)` includes all commands; `solveMatchingVariant`
replays them to return total traded units. Types and all functions above are
exported from this folder. This is a single-venue continuous book, without fees,
auctions, stops, amendments, account balances or self-trade prevention.
