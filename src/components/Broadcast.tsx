'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Canvas } from '@react-three/fiber';
import { KitchenSim } from '@/game/sim';
import { makeBrainFactory } from '@/game/brain';
import type { SimState } from '@/game/types';
import { KitchenScene } from '@/components/three/KitchenScene';
import { TelemetryPanel, TopBar, BottomBar } from '@/components/hud';

// Same-origin proxy → Vercel AI Gateway → typesafe-ai/jev.
const DEFAULT_ENDPOINT = process.env.NEXT_PUBLIC_JEV_API_URL ?? '/api/jev-decide';

const KEY_STORAGE = 'jev-api-key';
const LIVE_BRAIN_NAME = 'typesafe-ai/jev (live via AI Gateway)';

// HUD components memoize on object identity, so every 10Hz snapshot must
// carry fresh references for anything that changes.
function snapshotState(s: SimState): SimState {
  return {
    ...s,
    chefs: s.chefs.map((c) => ({ ...c })),
    stations: s.stations.map((st) => ({ ...st })),
    orders: s.orders.map((o) => ({ ...o })),
    events: [...s.events],
    telemetry: s.telemetry.map((t) => ({
      ...t,
      latencyHistory: [...t.latencyHistory],
      lastDecision: t.lastDecision ? { ...t.lastDecision } : null,
    })),
  };
}

export default function Broadcast() {
  const simRef = useRef<KitchenSim | null>(null);
  if (!simRef.current) {
    simRef.current = new KitchenSim(makeBrainFactory(null));
  }
  const sim = simRef.current;

  const [snap, setSnap] = useState<SimState>(() => snapshotState(sim.state));
  const [brainName, setBrainName] = useState('jev-local (emulated)');
  const [started, setStarted] = useState(false);
  const startedRef = useRef(false);

  const startShift = useCallback(() => {
    startedRef.current = true;
    setStarted(true);
  }, []);

  // Fixed-step sim loop driven by rAF. The kitchen holds (attract mode)
  // until the shift is started.
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    const loop = (now: number) => {
      const dt = Math.min((now - last) / 1000, 0.1);
      last = now;
      if (startedRef.current) sim.tick(dt);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [sim]);

  // HUD snapshot at 10Hz.
  useEffect(() => {
    const id = setInterval(() => setSnap(snapshotState(sim.state)), 100);
    return () => clearInterval(id);
  }, [sim]);

  const connectRemote = useCallback(
    (raw: string) => {
      const trimmed = raw.trim();
      if (!trimmed) return;
      // Accept "key", "endpoint key" or "endpoint|key".
      let endpoint = DEFAULT_ENDPOINT;
      let apiKey = trimmed;
      const sep = trimmed.includes('|') ? '|' : trimmed.includes(' ') ? ' ' : null;
      if (sep) {
        const [a, b] = trimmed.split(sep).map((s) => s.trim());
        if (a.startsWith('http')) {
          endpoint = a;
          apiKey = b;
        }
      }
      if (!endpoint) return;
      try {
        localStorage.setItem(KEY_STORAGE, `${endpoint}|${apiKey}`);
      } catch {}
      sim.setBrains(makeBrainFactory({ endpoint, apiKey }));
      setBrainName(LIVE_BRAIN_NAME);
    },
    [sim],
  );

  // Go live automatically when the server already holds the gateway key;
  // otherwise restore a previously pasted key.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(DEFAULT_ENDPOINT, { method: 'GET' });
        if (res.ok) {
          const health = (await res.json()) as { configured?: boolean };
          if (!cancelled && health.configured) {
            sim.setBrains(makeBrainFactory({ endpoint: DEFAULT_ENDPOINT }));
            setBrainName(LIVE_BRAIN_NAME);
            return;
          }
        }
      } catch {}
      try {
        const saved = localStorage.getItem(KEY_STORAGE);
        if (saved && !cancelled) connectRemote(saved);
      } catch {}
    })();
    return () => {
      cancelled = true;
    };
  }, [sim, connectRemote]);

  const getState = useCallback((): SimState => sim.state, [sim]);

  return (
    <div className="broadcast">
      <div className="col-left">
        <TelemetryPanel chef={snap.chefs[0]} telemetry={snap.telemetry[0]} side="left" />
        <TelemetryPanel chef={snap.chefs[2]} telemetry={snap.telemetry[2]} side="left" />
      </div>
      <div className="center-stack">
        <TopBar state={snap} />
        <div className="stage">
          <Canvas
            shadows
            dpr={[1, 2]}
            gl={{ antialias: true, alpha: true }}
            camera={{ fov: 38, position: [0, 10.5, 9.5] }}
            style={{ position: 'absolute', inset: 0 }}
          >
            <KitchenScene getState={getState} />
          </Canvas>
          {!started && (
            <div className="start-overlay">
              <div className="start-overlay__label">Live AI Showcase</div>
              <h1 className="start-overlay__title">
                Jev&apos;s Kitchen Chaos
              </h1>
              <p className="start-overlay__sub">
                Four Jev decision agents run this kitchen.
                <br />
                Every move is a live API decision — plans, policies and latency
                stream into the panels around the stage.
              </p>
              <button className="start-overlay__btn" onClick={startShift}>
                Start Shift
              </button>
              <div className="start-overlay__model hud-mono">
                model: {brainName} · connect a live Jev key via the API button
              </div>
            </div>
          )}
        </div>
        <BottomBar
          state={snap}
          onRush={() => sim.triggerRush()}
          onFire={() => sim.triggerFire()}
          onApiKey={connectRemote}
          brainName={brainName}
        />
      </div>
      <div className="col-right">
        <TelemetryPanel chef={snap.chefs[1]} telemetry={snap.telemetry[1]} side="right" />
        <TelemetryPanel chef={snap.chefs[3]} telemetry={snap.telemetry[3]} side="right" />
      </div>
    </div>
  );
}
