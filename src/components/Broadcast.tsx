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
    // ?shift=NN overrides shift length (useful for quick test games)
    let shiftLength: number | undefined;
    try {
      const p = new URLSearchParams(window.location.search).get('shift');
      if (p && Number(p) > 0) shiftLength = Number(p);
    } catch {}
    simRef.current = new KitchenSim(makeBrainFactory(null), { shiftLength });
  }
  const sim = simRef.current;

  const [snap, setSnap] = useState<SimState>(() => snapshotState(sim.state));
  const [brainName, setBrainName] = useState('jev-local (emulated)');
  const [started, setStarted] = useState(false);
  const startedRef = useRef(false);
  const [recordArmed, setRecordArmed] = useState(true);
  const [recording, setRecording] = useState(false);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recStreamRef = useRef<MediaStream | null>(null);

  const stopRecording = useCallback(() => {
    const rec = recorderRef.current;
    if (rec && rec.state !== 'inactive') rec.stop();
    recStreamRef.current?.getTracks().forEach((t) => t.stop());
    recorderRef.current = null;
    recStreamRef.current = null;
    setRecording(false);
  }, []);

  // Record the shift: prefer full-tab capture (game + telemetry panels, one
  // browser share prompt); fall back to the 3D canvas stream (no prompts).
  const startRecording = useCallback(async () => {
    let stream: MediaStream | null = null;
    const forceCanvas =
      typeof window !== 'undefined' &&
      new URLSearchParams(window.location.search).get('rec') === 'canvas';
    if (!forceCanvas && navigator.mediaDevices?.getDisplayMedia) {
      try {
        stream = await navigator.mediaDevices.getDisplayMedia({
          // @ts-expect-error chrome-only hints
          preferCurrentTab: true,
          video: { frameRate: 30 },
          audio: false,
        });
      } catch {
        stream = null; // denied → canvas fallback
      }
    }
    if (!stream) {
      const canvas = document.querySelector('.stage canvas') as HTMLCanvasElement | null;
      if (!canvas || typeof canvas.captureStream !== 'function') return;
      stream = canvas.captureStream(30);
    }
    const mime = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find(
      (m) => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(m),
    );
    if (!mime) return;
    const chunks: Blob[] = [];
    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 6_000_000 });
    rec.ondataavailable = (e) => e.data.size > 0 && chunks.push(e.data);
    rec.onstop = () => {
      const blob = new Blob(chunks, { type: 'video/webm' });
      if (blob.size > 0) {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `jev-shift-recording-${Date.now()}.webm`;
        a.click();
        URL.revokeObjectURL(a.href);
      }
    };
    // stop if the user ends tab sharing manually
    stream.getVideoTracks()[0]?.addEventListener('ended', () => stopRecording());
    rec.start(1000);
    recorderRef.current = rec;
    recStreamRef.current = stream;
    setRecording(true);
  }, [stopRecording]);

  const startShift = useCallback(() => {
    startedRef.current = true;
    setStarted(true);
    if (recordArmed) void startRecording();
  }, [recordArmed, startRecording]);

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

  const shiftOver = started && !snap.running && snap.t >= snap.shiftEndsAt;

  const downloadLog = useCallback(() => {
    const log = sim.getShiftLog();
    const blob = new Blob([JSON.stringify(log, null, 1)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `jev-shift-log-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  }, [sim]);


  // Expose the full log for analysis + download once the shift ends, and
  // finalize the shift recording (auto-downloads the .webm).
  useEffect(() => {
    if (!shiftOver) return;
    try {
      (window as unknown as Record<string, unknown>).__jevShiftLog = sim.getShiftLog();
      // ?autolog=1 → save the analysis log with no interaction needed
      if (new URLSearchParams(window.location.search).get('autolog') === '1') {
        downloadLog();
      }
    } catch {}
    stopRecording();
  }, [shiftOver, sim, stopRecording, downloadLog]);

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
          {recording && !shiftOver && (
            <div className="rec-chip">
              <span className="rec-chip__dot" /> REC
            </div>
          )}
          {shiftOver && (
            <div className="end-overlay">
              <div className="end-overlay__label">Shift Over</div>
              <div className="end-overlay__score">{snap.score.toLocaleString()} PTS</div>
              <div className="end-overlay__strip">
                {snap.served} served · {snap.failed} failed · {snap.fires} fires ·{' '}
                {snap.telemetry.reduce((a, t) => a + t.decisions, 0)} decisions · $
                {snap.telemetry.reduce((a, t) => a + t.totalCostUsd, 0).toFixed(4)}
              </div>
              <table className="end-overlay__table">
                <thead>
                  <tr>
                    <th>Chef</th><th>Served</th><th>Decisions</th><th>Avg ms</th><th>Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {snap.chefs.map((c, i) => {
                    const t = snap.telemetry[i];
                    const avg = t.latencyHistory.length
                      ? Math.round(t.latencyHistory.reduce((a, b) => a + b, 0) / t.latencyHistory.length)
                      : 0;
                    return (
                      <tr key={c.id}>
                        <td style={{ color: c.accent }}>P{c.id + 1} {c.name}</td>
                        <td>{c.dishesServed}</td>
                        <td>{t.decisions}</td>
                        <td>{avg}</td>
                        <td>${t.totalCostUsd.toFixed(4)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <div className="end-overlay__btns">
                <button className="end-overlay__btn end-overlay__btn--primary" onClick={downloadLog}>
                  Download Full Log
                </button>
                <button
                  className="end-overlay__btn end-overlay__btn--ghost"
                  onClick={() => window.location.reload()}
                >
                  Run It Back
                </button>
              </div>
            </div>
          )}
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
              <label className="start-overlay__rec">
                <input
                  type="checkbox"
                  checked={recordArmed}
                  onChange={(e) => setRecordArmed(e.target.checked)}
                />
                <span className="start-overlay__recdot" /> Record shift video (.webm)
              </label>
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
