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

const KEY_STORAGE = 'jev-gateway-key';
const LEGACY_KEY_STORAGE = 'jev-api-key';
const LIVE_BRAIN_NAME = 'typesafe-ai/jev (live via AI Gateway)';
const LOCAL_BRAIN_NAME = 'jev-local (emulated)';

type KeyStatus = 'none' | 'checking' | 'valid' | 'invalid';

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
  const [brainName, setBrainName] = useState(LOCAL_BRAIN_NAME);
  const [keyStatus, setKeyStatus] = useState<KeyStatus>('none');
  const [keyInput, setKeyInput] = useState('');
  const [balance, setBalance] = useState<number | null>(null);
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

  // BYOK: validate the visitor's gateway key server-side (returns credit
  // balance), then hot-swap all four brains to the live proxy.
  const connectRemote = useCallback(
    async (raw: string) => {
      // Accept legacy "endpoint|key" pastes by keeping only the key part.
      const trimmed = raw.trim().split('|').pop()?.trim() ?? '';
      if (!trimmed) return;
      setKeyStatus('checking');
      try {
        const res = await fetch(DEFAULT_ENDPOINT, {
          method: 'GET',
          headers: { 'x-gateway-key': trimmed },
        });
        const health = (await res.json()) as { valid?: boolean; balance?: number };
        if (!res.ok || !health.valid) {
          setKeyStatus('invalid');
          return;
        }
        try {
          localStorage.setItem(KEY_STORAGE, trimmed);
        } catch {}
        sim.setBrains(makeBrainFactory({ endpoint: DEFAULT_ENDPOINT, apiKey: trimmed }));
        setBrainName(LIVE_BRAIN_NAME);
        setBalance(typeof health.balance === 'number' ? health.balance : null);
        setKeyStatus('valid');
      } catch {
        setKeyStatus('invalid');
      }
    },
    [sim],
  );

  // Restore a previously saved key (also migrate the legacy storage format).
  useEffect(() => {
    try {
      const saved =
        localStorage.getItem(KEY_STORAGE) ?? localStorage.getItem(LEGACY_KEY_STORAGE);
      if (saved) void connectRemote(saved);
    } catch {}
  }, [connectRemote]);

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
              <div className="start-overlay__byok">
                <div className="start-overlay__byokrow">
                  <input
                    className="start-overlay__key hud-mono"
                    type="password"
                    placeholder="vck_… your Vercel AI Gateway key"
                    value={keyInput}
                    autoComplete="off"
                    onChange={(e) => setKeyInput(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && void connectRemote(keyInput)}
                  />
                  <button
                    className="start-overlay__connect"
                    disabled={keyStatus === 'checking' || !keyInput.trim()}
                    onClick={() => void connectRemote(keyInput)}
                  >
                    {keyStatus === 'checking' ? 'Checking…' : 'Connect'}
                  </button>
                </div>
                <div
                  className={`start-overlay__keystatus hud-mono start-overlay__keystatus--${keyStatus}`}
                >
                  {keyStatus === 'valid' && balance != null
                    ? `✓ key connected · $${balance.toFixed(2)} gateway credit · ~$0.00002 per decision`
                    : keyStatus === 'valid'
                      ? '✓ key connected — all four chefs go live on Jev'
                      : keyStatus === 'invalid'
                        ? '✗ key rejected by the gateway — check it and try again'
                        : keyStatus === 'checking'
                          ? 'validating key with the gateway…'
                          : 'bring your own key (BYOK) — it stays in your browser, proxied per-request, never stored'}
                </div>
              </div>
              <button className="start-overlay__btn" onClick={startShift}>
                {keyStatus === 'valid' ? 'Start Shift — Live Jev' : 'Start Shift — Emulated'}
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
                model: {brainName} · no key? get one at vercel.com → AI Gateway, or run the
                free emulated brain
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
