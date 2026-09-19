'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Canvas } from '@react-three/fiber';
import { KitchenSim } from '@/game/sim';
import { makeBrainFactory } from '@/game/brain';
import { KitchenAudio } from '@/game/audio';
import type { SimState } from '@/game/types';
import { KitchenScene } from '@/components/three/KitchenScene';
import { TelemetryPanel, TopBar, BottomBar } from '@/components/hud';

// Same-origin proxy → Vercel AI Gateway → typesafe-ai/jev.
const DEFAULT_ENDPOINT = process.env.NEXT_PUBLIC_JEV_API_URL ?? '/api/jev-decide';

const KEY_STORAGE = 'jev-gateway-key';
const LEGACY_KEY_STORAGE = 'jev-api-key';
const LIVE_BRAIN_NAME = 'typesafe-ai/jev (live via AI Gateway)';
const LIVE_BRAIN_NAME_OR = 'typesafe/jev-1.13 (live via OpenRouter)';
const LOCAL_BRAIN_NAME = 'jev-local (emulated)';

// Benchmark roster — same slugs on both providers.
const BRAIN_MODELS = [
  { id: 'jev', label: 'Jev (TypeSafe) · decisions API' },
  { id: 'anthropic/claude-opus-4.8', label: 'Claude Opus 4.8' },
  { id: 'openai/gpt-5.6-sol', label: 'GPT-5.6 Sol · fast' },
  { id: 'deepseek/deepseek-v4-flash', label: 'DeepSeek V4 Flash · fast' },
];

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
  const [keyTail, setKeyTail] = useState('');
  const [balance, setBalance] = useState<number | null>(null);
  const [brainModel, setBrainModel] = useState('jev');
  const providerRef = useRef<string>('gateway');
  const keyRef = useRef<string>('');
  // ?pure=1 → benchmark mode: no fallback brain, no breaker; failed calls
  // just idle the chef until the next attempt.
  const pureRef = useRef<boolean>(
    (() => {
      try {
        return new URLSearchParams(window.location.search).get('pure') === '1';
      } catch {
        return false;
      }
    })(),
  );
  const [started, setStarted] = useState(false);
  const startedRef = useRef(false);
  const [recordArmed, setRecordArmed] = useState(true);
  const [recording, setRecording] = useState(false);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recStreamRef = useRef<MediaStream | null>(null);
  const audioRef = useRef<KitchenAudio | null>(null);
  const [muted, setMuted] = useState(() => {
    try {
      return localStorage.getItem('jev-muted') === '1';
    } catch {
      return false;
    }
  });

  const toggleMute = useCallback(() => {
    setMuted((m) => {
      const next = !m;
      try {
        localStorage.setItem('jev-muted', next ? '1' : '0');
      } catch {}
      audioRef.current?.setMuted(next);
      return next;
    });
  }, []);

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
    // Audio must be created inside a user gesture (autoplay policy).
    try {
      if (!audioRef.current) audioRef.current = new KitchenAudio();
      audioRef.current.setMuted(muted);
      audioRef.current.start();
    } catch {}
    if (recordArmed) void startRecording();
  }, [recordArmed, startRecording, muted]);

  useEffect(() => () => audioRef.current?.dispose(), []);

  // Fixed-step sim loop. Driven by setInterval — NOT requestAnimationFrame —
  // so the kitchen keeps simulating when the window is occluded or the tab
  // loses focus (rAF starves there and froze the game). Rendering still runs
  // on R3F's own rAF and simply catches up. Holds until the shift is started.
  useEffect(() => {
    let last = performance.now();
    const id = setInterval(() => {
      const now = performance.now();
      const dt = Math.min((now - last) / 1000, 0.25);
      last = now;
      if (startedRef.current) sim.tick(dt);
    }, 33);
    return () => clearInterval(id);
  }, [sim]);

  // HUD snapshot at 10Hz (also feeds the audio engine).
  useEffect(() => {
    const id = setInterval(() => {
      setSnap(snapshotState(sim.state));
      audioRef.current?.observe(sim.state);
    }, 100);
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
        const health = (await res.json()) as {
          valid?: boolean;
          balance?: number;
          provider?: string;
        };
        if (!res.ok || !health.valid) {
          setKeyStatus('invalid');
          return;
        }
        try {
          localStorage.setItem(KEY_STORAGE, trimmed);
        } catch {}
        keyRef.current = trimmed;
        providerRef.current = health.provider ?? 'gateway';
        sim.setBrains(
          makeBrainFactory({
            endpoint: DEFAULT_ENDPOINT,
            apiKey: trimmed,
            brainModel,
            pure: pureRef.current,
          }),
        );
        setBrainName(
          brainModel !== 'jev'
            ? `${brainModel} (live via ${health.provider === 'openrouter' ? 'OpenRouter' : 'AI Gateway'})`
            : health.provider === 'openrouter'
              ? LIVE_BRAIN_NAME_OR
              : LIVE_BRAIN_NAME,
        );
        setBalance(typeof health.balance === 'number' ? health.balance : null);
        setKeyTail(trimmed.slice(-4));
        setKeyInput('');
        setKeyStatus('valid');
      } catch {
        setKeyStatus('invalid');
      }
    },
    [sim],
  );

  const selectBrainModel = useCallback(
    (id: string) => {
      setBrainModel(id);
      if (keyRef.current) {
        sim.setBrains(
          makeBrainFactory({
            endpoint: DEFAULT_ENDPOINT,
            apiKey: keyRef.current,
            brainModel: id,
            pure: pureRef.current,
          }),
        );
        setBrainName(
          id !== 'jev'
            ? `${id} (live via ${providerRef.current === 'openrouter' ? 'OpenRouter' : 'AI Gateway'})`
            : providerRef.current === 'openrouter'
              ? LIVE_BRAIN_NAME_OR
              : LIVE_BRAIN_NAME,
        );
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

  // Drop the saved key and fall back to the demo brain.
  const forgetKey = useCallback(() => {
    try {
      localStorage.removeItem(KEY_STORAGE);
      localStorage.removeItem(LEGACY_KEY_STORAGE);
    } catch {}
    sim.setBrains(makeBrainFactory(null));
    setBrainName(LOCAL_BRAIN_NAME);
    setKeyStatus('none');
    setKeyTail('');
    setBalance(null);
    setKeyInput('');
  }, [sim]);

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
          {started && (
            <button
              className="mute-chip"
              onClick={toggleMute}
              title={muted ? 'Unmute kitchen audio' : 'Mute kitchen audio'}
            >
              {muted ? '🔇' : '🔊'}
            </button>
          )}
          {shiftOver && (
            <div className="end-overlay">
              <div className="end-overlay__label">Shift Over</div>
              <div className="end-overlay__score">{snap.score.toLocaleString()} PTS</div>
              <div className="end-overlay__strip">
                {(() => {
                  const m = sim.getShiftLog().metrics;
                  return `${snap.served} served · ${snap.failed} failed · ${snap.fires} fires · ${m.decisions} decisions · p50 ${m.latencyMs.p50}ms · $${m.totalCostUsd.toFixed(4)}${m.costPerServe != null ? ` · $${m.costPerServe.toFixed(4)}/serve` : ''}`;
                })()}
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
                Jev is TypeSafe&apos;s decision model: game state in, a chosen move out —
                no text, just probabilities.
                <br />
                Here it plays all four chefs at once. Each panel shows that chef&apos;s
                current plan, Jev&apos;s confidence, and the real API latency.
              </p>
              <div className="start-overlay__byok">
                <div className="hud-microlabel">Play with the real Jev — use your own key</div>
                {keyStatus === 'valid' ? (
                  <div className="start-overlay__byokrow">
                    <div className="start-overlay__savedkey hud-mono">
                      🔑 vck_…{keyTail || '····'} saved in this browser
                    </div>
                    <button className="start-overlay__connect" onClick={forgetKey}>
                      Forget key
                    </button>
                  </div>
                ) : (
                  <div className="start-overlay__byokrow">
                    <input
                      className="start-overlay__key hud-mono"
                      type="password"
                      placeholder="Vercel AI Gateway (vck_…) or OpenRouter (sk-or-…) key"
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
                )}
                <div
                  className={`start-overlay__keystatus hud-mono start-overlay__keystatus--${keyStatus}`}
                >
                  {keyStatus === 'valid' && balance != null
                    ? `✓ Connected — $${balance.toFixed(2)} gateway credit. A full game costs about $0.01. Refreshing keeps you connected.`
                    : keyStatus === 'valid'
                      ? '✓ Connected — every decision now comes from the real Jev API.'
                      : keyStatus === 'invalid'
                        ? '✗ The gateway rejected this key. It should start with vck_ — check and retry.'
                        : keyStatus === 'checking'
                          ? 'Checking your key with the gateway…'
                          : 'Works with Vercel AI Gateway or OpenRouter credits (~$0.01 per game). The key stays in this browser — our server never stores it.'}
                </div>
              </div>
              {keyStatus === 'valid' && (
                <div className="start-overlay__brains">
                  <div className="hud-microlabel">Chef brain — benchmark them</div>
                  <div className="start-overlay__brainrow">
                    {BRAIN_MODELS.map((m) => (
                      <button
                        key={m.id}
                        className={`start-overlay__brain${brainModel === m.id ? ' start-overlay__brain--on' : ''}`}
                        onClick={() => selectBrainModel(m.id)}
                      >
                        {m.label}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              <button className="start-overlay__btn" onClick={startShift}>
                {keyStatus === 'valid'
                  ? brainModel === 'jev'
                    ? 'Start Shift · Live Jev'
                    : `Start Shift · ${BRAIN_MODELS.find((m) => m.id === brainModel)?.label ?? brainModel}`
                  : 'Start Demo Shift'}
              </button>
              <label className="start-overlay__rec">
                <input
                  type="checkbox"
                  checked={recordArmed}
                  onChange={(e) => setRecordArmed(e.target.checked)}
                />
                <span className="start-overlay__recdot" /> Record a video of the shift (.webm)
              </label>
              <div className="start-overlay__model hud-mono">
                {keyStatus === 'valid'
                  ? `model: ${brainName}${pureRef.current ? ' · PURE BENCHMARK (no fallback)' : ''}`
                  : 'No key? The demo runs a built-in imitation of Jev — free. Get a key at vercel.com → AI Gateway or openrouter.ai → Keys.'}
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
