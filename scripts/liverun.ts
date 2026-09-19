// Real-time instrumented shift runner. `bun scripts/liverun.ts live` plays a
// 3:00 game against the prod Jev proxy (key from JEV_KEY env), tagging each
// decision live/fallback; `baseline` plays the local emulated brain. Writes
// the full ShiftLog to /tmp/jev-game-<mode>.json for analysis.
import { writeFileSync } from 'node:fs';
import { KitchenSim } from '../src/game/sim';
import { LocalJevBrain } from '../src/game/brain';
import type { JevBrain, DecisionRequest, JevDecision } from '../src/game/types';

const ENDPOINT = 'https://jevs-kitchen-chaos.vercel.app/api/jev-decide';
const KEY = process.env.JEV_KEY ?? '';

const BRAIN_MODEL = process.env.BRAIN_MODEL ?? 'jev';

class TaggedRemoteBrain implements JevBrain {
  readonly name = BRAIN_MODEL === 'jev' ? 'typesafe-ai/jev' : BRAIN_MODEL;
  private fallback = new LocalJevBrain();
  async decide(req: DecisionRequest): Promise<JevDecision> {
    const t0 = Date.now();
    try {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-gateway-key': KEY },
        body: JSON.stringify({ ...req, brainModel: BRAIN_MODEL }),
      });
      if (!res.ok) throw new Error(`http ${res.status}`);
      const d = (await res.json()) as JevDecision;
      if (!req.options.some((o) => o.id === d.chosenId)) throw new Error('invalid choice');
      return Object.assign({}, d, { latencyMs: Date.now() - t0, source: 'live' });
    } catch (e) {
      const d = await this.fallback.decide(req);
      return Object.assign({}, d, {
        source: 'fallback',
        fallbackReason: String(e).slice(0, 100),
      });
    }
  }
}

const mode = process.argv[2] === 'baseline' ? 'baseline' : 'live';
if (mode === 'live' && !KEY) {
  console.error('JEV_KEY env required for live mode');
  process.exit(1);
}
const sim = new KitchenSim(
  () => (mode === 'live' ? new TaggedRemoteBrain() : new LocalJevBrain()),
  { shiftLength: 180 },
);

let last = Date.now();
const iv = setInterval(() => {
  const now = Date.now();
  sim.tick(Math.min((now - last) / 1000, 0.25));
  last = now;
  if (!sim.state.running && sim.state.t >= sim.state.shiftEndsAt) {
    clearInterval(iv);
    const log = sim.getShiftLog();
    const tag = mode === 'live' && BRAIN_MODEL !== 'jev'
      ? `live-${BRAIN_MODEL.replace(/[^a-z0-9.]+/gi, '-')}`
      : mode;
    writeFileSync(`/tmp/jev-game-${tag}.json`, JSON.stringify(log, null, 1));
    console.log(
      `${mode} done: score=${log.score} served=${log.served} failed=${log.failed} fires=${log.fires} decisions=${log.decisions.length}`,
    );
    process.exit(0);
  }
}, 50);
