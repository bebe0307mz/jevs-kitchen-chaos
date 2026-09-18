// Headless harness for KitchenSim. Runs the sim with a zero-latency local
// brain for 240 game-seconds and asserts the game stays alive, serves dishes,
// makes decisions, never deadlocks, and can catch + extinguish fires.
//
//   bun scripts/simtest.ts
//
// Exits non-zero with a clear message on any assertion failure.

import { KitchenSim } from '../src/game/sim';
import { LocalJevBrain } from '../src/game/brain';
import { SimState } from '../src/game/types';

const DT = 0.05;
const DURATION = 240; // game seconds
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

  // Longest streak (seconds) a chef sat on COMMITTED work — a claimed order or a
  // carried item — while idle and with no decision in flight. Pure waiting for
  // orders (fewer open orders than chefs) is legitimate and not counted.
  const idleStreak = [0, 0, 0, 0];
  const longestIdle = [0, 0, 0, 0];
  let sawFire = false;
  let fireExtinguishedAfterTrigger = false;
  let firePeakCount = 0;
  let firedAt = -1;

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

    for (const c of s.chefs) {
      const tel = s.telemetry[c.id];
      const hasWork =
        !!c.carrying ||
        s.orders.some((o) => o.status === 'open' && o.claimedBy === c.id);
      const stuck = hasWork && c.action === 'idle' && !tel.inFlight;
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
  console.log(`total tokens     : ${tokens}`);
  console.log(`total cost (usd) : $${cost.toFixed(6)}`);
  console.log(`avg latency (ms) : ${avgLat.toFixed(1)}`);
  console.log(`events logged    : ${s.events.length} (cap 30)`);
  console.log('─'.repeat(48));

  assert(s.served >= 6, `expected served >= 6, got ${s.served}`);
  assert(s.failed <= s.served + 10, `failed too high: ${s.failed} vs served ${s.served}`);
  assert(!anyNaN(s), 'NaN positions at end');
  for (const c of s.chefs) {
    assert(
      s.telemetry[c.id].decisions > 20,
      `chef ${c.id} made only ${s.telemetry[c.id].decisions} decisions (need >20)`,
    );
  }
  for (let i = 0; i < 4; i++) {
    assert(longestIdle[i] < 10, `chef ${i} deadlocked on committed work for ${longestIdle[i].toFixed(1)}s (need <10s)`);
  }
  assert(sawFire, 'no fire ever occurred (triggerFire should have ignited one)');
  assert(fireExtinguishedAfterTrigger, 'fire was never extinguished after being triggered');
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
