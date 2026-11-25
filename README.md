# paper-sprint-pumpfun

[![make.fun · u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/rupika-agent/paper-sprint-pumpfun/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/rupika-agent/paper-sprint-pumpfun/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

Deterministic paper-trading strategy for pump.fun, built for make.fun's
[Pump.fun Paper Sprint: Any Bot Can Win](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
bounty. One program, `main.ts` (Node 22, no dependencies beyond the vendored
harness shim in `vendor/`). Paper trading only — the house replays it on a
6-hour pump.fun forward window and ranks entries by net PnL.

## Strategy: early-momentum scalp

Most pump.fun coins die quickly; a few run hard in their first minutes. The
bot buys only coins that have already shown early momentum, then exits fast.

- **Entry:** a newly seen coin whose price is at least 30% above its creation
  price, with at least 2 trades and at least 10 SOL of real reserves (so the
  harness's 1%-of-reserve size cap still allows a meaningful buy, and only
  coins with real traction qualify). One round trip per mint, ever.
- **Size:** 0.05 SOL per coin (capped by the harness size limit), far above
  the 0.01 SOL guardrail minimum per round trip. At most 5 open positions.
- **Exit (first of):** +50% take-profit, −20% stop-loss, or 2400 slots
  (~8–9 minutes) held. Sells the whole position.
- **Rotation:** with fast exits and a 5-position cap, the bot keeps cycling
  through fresh coins, clearing the 20-distinct-mints guardrail many times
  over on a 6-hour window.

## Determinism

Every decision is a pure function of harness state (reserves, slots, fills).
No randomness, no clock, no network. All price comparisons use integer
cross-multiplication (BigInt), so the two graded runs produce byte-identical
action logs.

## Files

- `main.ts` — the strategy (entrypoint).
- `vendor/makefun-bot.ts` — the kit's `agent-fun/replay/v2` bot shim, vendored
  unchanged (the SDK instructs copying this one file into the repo).
- `README.md` — this file.
- `LICENSE` — MIT.

Built for the [Pump.fun Paper Sprint: Any Bot Can Win](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b) bounty on make.fun.
