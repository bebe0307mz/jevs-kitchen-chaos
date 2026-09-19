// Headless harness for KitchenSim (task-market, multi-component recipes).
// Runs 300 game-seconds with a zero-latency local brain and asserts the game
// stays alive, serves dishes (incl. a multi-component one), makes decisions,
// never deadlocks on committed work, can catch + extinguish fires, and leaves
// no prepping component with a dead chain.
//
//   bun scripts/simtest.ts
//
// Exits non-zero with a clear message on any assertion failure.

import { KitchenSim } from '../src/game/sim';
import { LocalJevBrain } from '../src/game/brain';
import { SimState, DishId, RECIPES } from '../src/game/types';

const DT = 0.05;
const DURATION = 300; // game seconds
const STEPS = Math.round(DURATION / DT);

function anyNaN(s: SimState): boolean {
  return s.chefs.some(
    (c) =>
      !Number.isFinite(c.x) ||
      !Number.isFinite(c.y) ||
      !Number.isFinite(c.actionProgress),
  );
}

function assert(cond: boolean, msg: string): void {
  if (!cond) fail(msg);
}
function fail(msg: string): never {
  console.error(`\n❌ ASSERTION FAILED: ${msg}`);
  process.exit(1);
}

async function main(): Promise<void> {
  // zero-latency brains so decisions resolve as fast as the event loop allows
  const sim = new KitchenSim(() => new LocalJevBrain(0), { shiftLength: 100000 });

  // Longest streak (seconds) a chef sat on COMMITTED work — carrying an item OR
  // holding a workingOrderId — while idle and with no decision in flight AND no
  // steps queued. Waiting next to a cooking stove keeps steps queued (awaitCook)
  // so it counts as progress, not deadlock. Pure waiting for orders (no work) is
  // legitimate and not counted.
  const idleStreak = [0, 0, 0, 0];
  const longestIdle = [0, 0, 0, 0];
  let sawFire = false;
  let fireExtinguishedAfterTrigger = false;
  let firePeakCount = 0;
  let firedAt = -1;

  // per-dish served tally (from serve events)
  const servedByDish: Record<DishId, number> = { salad: 0, soup: 0, burger: 0, steak: 0, pasta: 0 };
  const seenServeEvents = new Set<string>();

  for (let i = 0; i < STEPS; i++) {
    sim.tick(DT);
    const s = sim.state;
    const now = s.t;

    if (anyNaN(s)) fail(`NaN position/progress detected at t=${now.toFixed(2)}`);

    // force a rush and a fire at fixed points to exercise both flood + fire paths
    if (i === Math.round(STEPS * 0.25)) sim.triggerRush();
    if (i === Math.round(STEPS * 0.4)) {
      sim.triggerFire();
      firedAt = now;
    }

    const activeFires = s.stations.filter((st) => st.onFire).length;
    if (activeFires > 0) sawFire = true;
    firePeakCount = Math.max(firePeakCount, activeFires);
    if (firedAt >= 0 && now > firedAt + 1 && activeFires === 0) {
      fireExtinguishedAfterTrigger = true;
    }

    // tally serve events by dish name (events are capped in state; snapshot as
    // we go, dedup by t+text so the rolling window doesn't double-count).
    for (const ev of s.events) {
      if (ev.kind !== 'serve') continue;
      const key = `${ev.t}|${ev.text}`;
      if (seenServeEvents.has(key)) continue;
      seenServeEvents.add(key);
      for (const dish of Object.keys(RECIPES) as DishId[]) {
        if (ev.text.includes(RECIPES[dish].name)) { servedByDish[dish]++; break; }
      }
    }

    for (const c of s.chefs) {
      const rtIdle =
        c.action === 'idle' &&
        !s.telemetry[c.id].inFlight;
      // "committed work with no queued step": carrying OR working an order, and
      // the sim thinks the chef is idle (no active step). awaitCook keeps action
      // != 'idle' briefly but sets action to 'idle' while waiting — however it
      // keeps a step queued, so we approximate "no progress" as idle-action with
      // committed state. To avoid flagging legit awaitCook waits, we only count
      // when there is NO working order tied to a live stove item; simplest: count
      // idle-action while carrying, or idle-action holding an order but the order
      // has no component 'prepping'/'ready' progress attributable to a queued
      // step. We use the robust proxy: idle-action + committed + stagnant.
      const hasWork = !!c.carrying || c.workingOrderId !== null;
      const stuck = hasWork && rtIdle;
      if (stuck) {
        idleStreak[c.id] += DT;
        longestIdle[c.id] = Math.max(longestIdle[c.id], idleStreak[c.id]);
      } else {
        idleStreak[c.id] = 0;
      }
    }

    // yield so brain promises (setTimeout 0) resolve between ticks
    await Promise.resolve();
    if (i % 4 === 0) await new Promise((r) => setTimeout(r, 0));
  }

  const s = sim.state;
  const decisions = s.telemetry.map((t) => t.decisions);
  const tokens = s.telemetry.reduce((a, t) => a + t.totalTokens, 0);
  const cost = s.telemetry.reduce((a, t) => a + t.totalCostUsd, 0);
  const allLat = s.telemetry.flatMap((t) => t.latencyHistory);
  const avgLat = allLat.length ? allLat.reduce((a, b) => a + b, 0) / allLat.length : 0;

  const multiServed = servedByDish.soup + servedByDish.burger;

  // Validate: no OPEN order has a 'prepping' component whose owner chef isn't
  // actually working that order (dead chain / abandoned component).
  let deadChains = 0;
  for (const o of s.orders) {
    if (o.status !== 'open') continue;
    for (const comp of o.components) {
      if (comp.status !== 'prepping') continue;
      const owner = comp.by !== null ? s.chefs[comp.by] : null;
      if (!owner || owner.workingOrderId !== o.id) deadChains++;
    }
  }

  console.log('─'.repeat(48));
  console.log('JEV KITCHEN SIM — headless test report');
  console.log('─'.repeat(48));
  console.log(`game time        : ${s.t.toFixed(1)}s`);
  console.log(`served           : ${s.served}`);
  console.log(`failed           : ${s.failed}`);
  console.log(`score            : ${s.score}`);
  console.log(`fires (lifetime) : ${s.fires}  (peak concurrent ${firePeakCount})`);
  console.log(`open orders left : ${s.orders.filter((o) => o.status === 'open').length}`);
  console.log(`decisions/chef   : ${decisions.join(', ')}`);
  console.log(`longest work-idle: ${longestIdle.map((x) => x.toFixed(1) + 's').join(', ')}`);
  console.log(`per-dish served  : ${(Object.keys(servedByDish) as DishId[]).map((d) => `${RECIPES[d].name} ${servedByDish[d]}`).join(' · ')}`);
  console.log(`multi-comp served: ${multiServed} (soup ${servedByDish.soup} + burger ${servedByDish.burger})`);
  console.log(`prepping w/o chef: ${deadChains}`);
  console.log(`total tokens     : ${tokens}`);
  console.log(`total cost (usd) : $${cost.toFixed(6)}`);
  console.log(`avg latency (ms) : ${avgLat.toFixed(1)}`);
  console.log(`events logged    : ${s.events.length} (cap 30)`);
  console.log('─'.repeat(48));

  assert(s.served >= 5, `expected served >= 5, got ${s.served}`);
  assert(multiServed >= 1, `expected at least one multi-component dish (soup/burger) served, got ${multiServed}`);
  assert(s.failed < s.served, `failed not below served: ${s.failed} vs served ${s.served}`);
  assert(!anyNaN(s), 'NaN positions at end');
  for (const c of s.chefs) {
    assert(
      s.telemetry[c.id].decisions > 15,
      `chef ${c.id} made only ${s.telemetry[c.id].decisions} decisions (need >15)`,
    );
  }
  for (let i = 0; i < 4; i++) {
    assert(longestIdle[i] < 10, `chef ${i} deadlocked on committed work for ${longestIdle[i].toFixed(1)}s (need <10s)`);
  }
  assert(sawFire, 'no fire ever occurred (triggerFire should have ignited one)');
  assert(fireExtinguishedAfterTrigger, 'fire was never extinguished after being triggered');
  assert(deadChains === 0, `${deadChains} open-order component(s) stuck 'prepping' with a dead chain`);
  assert(s.events.length <= 30, `events not capped: ${s.events.length}`);
  assert(tokens > 0, 'no tokens accumulated');
  assert(cost > 0, 'no cost accumulated');

  console.log('\n✅ ALL ASSERTIONS PASSED');
  process.exit(0);
}

main().catch((e) => {
  console.error('\n❌ HARNESS CRASHED:', e);
  process.exit(1);
});
