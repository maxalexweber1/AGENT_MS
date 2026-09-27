/**
 * Announcements for M₳X's own crystal movements.
 *
 * The notary's balance fallback reads "the crystal balance went up and nothing
 * of ours moved it" as a customer payment. The problem: the journal event for a
 * coin sale is written 20-35 s AFTER the trade lands (price wait, idle wait,
 * anchor enqueue), while the money is on the account immediately - so a check
 * that only looks backwards sees the money long before it sees the reason.
 *
 * On 2026-09-21 07:30 UTC that booked all 7 open quotes as paid from a single
 * 400 crystal coin sale 35 s later, sent 7 "payment landed" receipts to agents
 * who had explicitly declined, and anchored 7 notary-paid attestations on
 * Midnight. A check over the whole history found the same pattern behind 19 of
 * the 20 payments ever recorded (batch event 18-35 s after the booking).
 *
 * So every action that moves M₳X's own crystal says so BEFORE it acts. The
 * marker outlives the action long enough for the journal event to catch up, and
 * notary.mjs treats a rise inside that window as our own money, never a payment.
 */

import { log } from "./mc.mjs";

/** How long an announced move keeps explaining balance changes. */
export const DEFAULT_MS = Number(process.env.MCITY_OWN_MOVE_MS || 180_000);

let until = 0;
let last = { reason: "", at: 0 };

/**
 * "I am about to move my own crystal." Call it immediately before the action,
 * not after - the point is to be earlier than the money.
 */
export function expectOwnMove(reason, ms = DEFAULT_MS) {
  const now = Date.now();
  last = { reason: String(reason || "own move"), at: now };
  until = Math.max(until, now + Math.max(0, ms));
  return until;
}

/** Is an announced move still covering us right now? */
export function ownMoveActive(at = Date.now()) { return at < until; }

/** Was a move announced at or after `ts`? (catches announcements made after a rise was seen) */
export function announcedSince(ts) { return last.at >= ts; }

export function lastOwnMove() { return { ...last, until }; }

/** Tests and `life.mjs once` runs that want a clean slate. */
export function reset() { until = 0; last = { reason: "", at: 0 }; }

/** Wrap an own-money action: announce, then run it. */
export async function withOwnMove(reason, fn, ms = DEFAULT_MS) {
  expectOwnMove(reason, ms);
  try {
    return await fn();
  } finally {
    // the money may land slightly after the call returns - keep the window open
    expectOwnMove(reason, ms);
    log(`purse: own move "${reason}" - balance changes are ours for the next ${Math.round(ms / 1000)}s`);
  }
}
