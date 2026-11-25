// paper-sprint-pumpfun: a deterministic early-momentum scalp for pump.fun.
//
// Idea (written from scratch for this competition):
//   * Most pump.fun coins die quickly. A few run hard in their first minutes.
//   * Buy a coin only once it has already shown early momentum: its price is at
//     least 30% above its creation price, it has traded at least twice, and its
//     real SOL reserve is at least 10 SOL (so the per-batch size cap still lets
//     us buy a meaningful amount, and only coins with real traction qualify).
//   * Fixed size: 0.05 SOL per coin (capped by the harness size limit), so every
//     round trip is well above the 0.01 SOL guardrail minimum.
//   * Exit each position on the first of: +50% take-profit, -20% stop-loss, or
//     2400 slots (~8-9 minutes) held. Sell the whole position.
//   * At most 5 open positions at once (the harness cap). One round trip per
//     mint, ever, so the bot keeps rotating through fresh coins and clears the
//     20-distinct-mints guardrail many times over on a 6-hour window.
//   * Fully deterministic: every decision is a pure function of the harness
//     state (reserves, slots, fills). No randomness, no clock, no network.
//
// All price comparisons are done in integer arithmetic (cross-multiplied
// BigInts) so there is no floating-point drift between the two graded runs.

import { runBot } from './vendor/makefun-bot.ts';
import type { Batch, BotState } from './vendor/makefun-bot.ts';

// ---- tuning constants (all in lamports / slots / basis points) ------------

/** SOL spent per buy. 0.05 SOL >> 0.01 SOL guardrail minimum. */
const BUY_LAMPORTS = 50_000_000n;
/** Only buy when the size cap allows at least this much (0.02 SOL). */
const MIN_BUY_LAMPORTS = 20_000_000n;
/** A coin must hold at least this much real SOL reserve to be buyable. */
const MIN_REAL_RESERVE_LAMPORTS = 10_000_000_000n;
/** Momentum trigger: price >= 130% of the creation price. */
const MOMENTUM_NUM = 130n;
const MOMENTUM_DEN = 100n;
/** Minimum trades seen on the curve before it counts as "moving". */
const MIN_TRADES = 2;
/** Only coins this young (slots since first seen) are eligible. */
const MAX_COIN_AGE_SLOTS = 3600;
/** Take-profit: sell when price >= 150% of the entry price. */
const TAKE_PROFIT_NUM = 150n;
const TAKE_PROFIT_DEN = 100n;
/** Stop-loss: sell when price <= 80% of the entry price. */
const STOP_LOSS_NUM = 80n;
const STOP_LOSS_DEN = 100n;
/** Time exit: sell after holding this many slots. */
const MAX_HOLD_SLOTS = 2400;
/** Slippage tolerance on every order (5%). */
const MAX_SLIPPAGE_BPS = 500;
/** Keep this much cash uncommitted as a buffer for tx fees. */
const CASH_BUFFER_LAMPORTS = 10_000_000n;

// ---- per-mint bookkeeping --------------------------------------------------

interface Baseline {
  /** virtual quote reserves at first sight (creation price numerator). */
  vq: bigint;
  /** virtual token reserves at first sight (creation price denominator). */
  vt: bigint;
  /** Slot the coin was first seen. */
  slot: number;
}

interface Entry {
  /** Effective entry price: quote_lamports spent / tokens received on the fill. */
  cost: bigint;
  tokens: bigint;
  /** Slot the buy was decided on. */
  buySlot: number;
}

const baselines = new Map<string, Baseline>();
const entries = new Map<string, Entry>();
/** Mints we have already bought once; never re-enter the same coin. */
const traded = new Set<string>();
/** Mints with a sell order still in flight. */
const pendingSells = new Set<string>();

/** priceA >= priceB * num / den, with prices as (vq, vt) reserve pairs. */
function priceAtLeast(vqA: bigint, vtA: bigint, vqB: bigint, vtB: bigint, num: bigint, den: bigint): boolean {
  // vqA / vtA >= (vqB / vtB) * (num / den)
  // <=> vqA * vtB * den >= vqB * vtA * num
  return vqA * vtB * den >= vqB * vtA * num;
}

function priceAtMost(vqA: bigint, vtA: bigint, vqB: bigint, vtB: bigint, num: bigint, den: bigint): boolean {
  return vqA * vtB * den <= vqB * vtA * num;
}

await runBot({
  onBatch(state: BotState, batch: Batch) {
    // 1. Record baselines for newly seen curves (first-seen reserves = creation
    //    price when the CreateEvent is in this batch; otherwise the earliest
    //    reserves we ever saw, which is still a fixed, deterministic anchor).
    for (const curve of state.curves.values()) {
      if (!baselines.has(curve.mint)) {
        baselines.set(curve.mint, {
          vq: curve.virtual_quote_reserves,
          vt: curve.virtual_token_reserves,
          slot: curve.created_slot ?? curve.reserves_slot,
        });
      }
    }

    // 2. Fold this batch's fills into the entry book and clear pending sells.
    for (const fill of batch.fills) {
      if (fill.side === 'buy' && fill.status === 'filled') {
        const cost = BigInt(fill.quote_lamports);
        const tokens = BigInt(fill.token_amount);
        if (cost > 0n && tokens > 0n) {
          entries.set(fill.mint, { cost, tokens, buySlot: fill.decided_slot });
        }
      } else if (fill.side === 'sell') {
        pendingSells.delete(fill.mint);
        if (fill.status === 'filled') entries.delete(fill.mint);
      }
    }

    const out: { side: 'buy' | 'sell'; mint: string; quote_lamports?: bigint; token_amount?: bigint; max_slippage_bps: number }[] = [];

    // 3. Exits first: take-profit / stop-loss / time exit on every open position.
    for (const [mint, holding] of state.positions) {
      if (pendingSells.has(mint)) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      let entry = entries.get(mint);
      if (entry === undefined) {
        // Defensive: a position with no recorded fill (should not happen).
        // Anchor on the position's own cost so TP/SL still work; the time
        // exit then counts from now.
        entry = { cost: holding.cost_lamports, tokens: holding.token_amount, buySlot: state.slot };
        entries.set(mint, entry);
      }
      const up = priceAtLeast(
        curve.virtual_quote_reserves, curve.virtual_token_reserves,
        entry.cost, entry.tokens, TAKE_PROFIT_NUM, TAKE_PROFIT_DEN,
      );
      const down = priceAtMost(
        curve.virtual_quote_reserves, curve.virtual_token_reserves,
        entry.cost, entry.tokens, STOP_LOSS_NUM, STOP_LOSS_DEN,
      );
      const stale = state.slot - entry.buySlot >= MAX_HOLD_SLOTS;
      if (up || down || stale) {
        out.push({ side: 'sell', mint, token_amount: holding.token_amount, max_slippage_bps: MAX_SLIPPAGE_BPS });
        pendingSells.add(mint);
      }
    }

    // 4. Entries: scan curves in first-seen order (deterministic) and buy the
    //    first eligible ones while a position slot is free.
    const maxPositions = state.hello.caps.max_open_positions;
    if (state.committedPositionCount() < maxPositions) {
      for (const curve of state.curves.values()) {
        if (state.committedPositionCount() + out.filter((o) => o.side === 'buy').length >= maxPositions) break;
        if (out.length >= state.hello.caps.max_orders_per_batch) break;
        if (curve.complete || traded.has(curve.mint)) continue;
        if (state.positions.has(curve.mint)) continue;
        if (pendingSells.has(curve.mint)) continue;
        if (curve.trades < MIN_TRADES) continue;
        if (curve.real_quote_reserves < MIN_REAL_RESERVE_LAMPORTS) continue;
        const baseline = baselines.get(curve.mint);
        if (baseline === undefined) continue;
        if (baseline.vq === 0n || baseline.vt === 0n) continue;
        if (state.slot - baseline.slot > MAX_COIN_AGE_SLOTS) continue;
        if (
          !priceAtLeast(
            curve.virtual_quote_reserves, curve.virtual_token_reserves,
            baseline.vq, baseline.vt, MOMENTUM_NUM, MOMENTUM_DEN,
          )
        ) continue;
        const cap = state.maxBuyLamports(curve.mint);
        if (cap < MIN_BUY_LAMPORTS) continue;
        const size = cap < BUY_LAMPORTS ? cap : BUY_LAMPORTS;
        const txFee = state.txFeeLamports();
        if (state.freeCashLamports() < size + txFee + CASH_BUFFER_LAMPORTS) continue;
        out.push({ side: 'buy', mint: curve.mint, quote_lamports: size, max_slippage_bps: MAX_SLIPPAGE_BPS });
        traded.add(curve.mint);
      }
    }

    return out;
  },
});
