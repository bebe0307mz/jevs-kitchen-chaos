'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Canvas } from '@react-three/fiber';
import { KitchenSim } from '@/game/sim';
import { makeBrainFactory } from '@/game/brain';
import type { SimState } from '@/game/types';
import { KitchenScene } from '@/components/three/KitchenScene';
import { TelemetryPanel, TopBar, BottomBar } from '@/components/hud';

const DEFAULT_ENDPOINT = process.env.NEXT_PUBLIC_JEV_API_URL ?? '';

const KEY_STORAGE = 'jev-api-key';

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

  // Fixed-step sim loop driven by rAF.
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    const loop = (now: number) => {
      const dt = Math.min((now - last) / 1000, 0.1);
      last = now;
      sim.tick(dt);
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
      setBrainName('jev-1.13 (live API)');
    },
    [sim],
  );

  // Restore saved key.
  useEffect(() => {
    try {
      const saved = localStorage.getItem(KEY_STORAGE);
      if (saved) connectRemote(saved);
    } catch {}
  }, [connectRemote]);

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
