'use client';

import React from 'react';
import type { Chef, ChefTelemetry, PolicyEntry, Point } from '@/game/types';
import './hud.css';

// Role tags keyed by chef id → P1..P4. Purely cosmetic broadcast flavor.
const ROLE_TAGS = ['EXPEDITER', 'SOUS', 'LINE COOK', 'PREP'];

// ── Sparkline ──────────────────────────────────────────────────
// Pure SVG polyline built from latency history. Memoized on the
// array reference so it only recomputes when the sim pushes a new
// sample (the sim reuses/replaces the array each decision).
function Sparkline({ history, accent }: { history: number[]; accent: string }) {
  const W = 120;
  const H = 30;
  const path = React.useMemo(() => {
    const pts = history.slice(-48);
    if (pts.length < 2) {
      return { line: '', area: '' };
    }
    let lo = Infinity;
    let hi = -Infinity;
    for (const v of pts) {
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    // Pad the range so a flat baseline still shows a gentle wiggle band.
    const pad = Math.max(8, (hi - lo) * 0.15);
    lo -= pad;
    hi += pad;
    const span = hi - lo || 1;
    const n = pts.length;
    const coords = pts.map((v, i) => {
      const x = (i / (n - 1)) * W;
      const y = H - ((v - lo) / span) * H;
      return [x, y] as const;
    });
    const line = coords.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
    const area = `${line} L${W} ${H} L0 ${H} Z`;
    return { line, area };
  }, [history]);

  const gid = React.useId();
  return (
    <svg className="tpanel__spark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden>
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={accent} stopOpacity="0.24" />
          <stop offset="100%" stopColor={accent} stopOpacity="0" />
        </linearGradient>
      </defs>
      {path.area && <path d={path.area} fill={`url(#${gid})`} />}
      {path.line && <path d={path.line} fill="none" stroke={accent} strokeWidth={1.25} strokeLinejoin="round" strokeLinecap="round" />}
    </svg>
  );
}

// ── Gamepad input viz ──────────────────────────────────────────
// Signature element: a stylized controller. D-pad segments and A/B
// buttons light up from the chef's live controller state.
function Gamepad({ dir, btn }: { dir: Point; btn: 'A' | 'B' | null }) {
  const up = dir.y < -0.35;
  const down = dir.y > 0.35;
  const left = dir.x < -0.35;
  const right = dir.x > 0.35;
  // D-pad geometry centered around (28,27); arms 12px, hub 10px.
  const cx = 28;
  const cy = 27;
  const arm = 11;
  const w = 9; // arm width
  return (
    <svg className="gamepad" viewBox="0 0 120 54" aria-hidden>
      <rect className="pad-base" x="0.5" y="6.5" width="119" height="41" rx="10" />
      {/* D-pad */}
      <rect className={`seg${up ? ' on' : ''}`} x={cx - w / 2} y={cy - arm - w / 2} width={w} height={arm} rx="1.5" />
      <rect className={`seg${down ? ' on' : ''}`} x={cx - w / 2} y={cy + w / 2} width={w} height={arm} rx="1.5" />
      <rect className={`seg${left ? ' on' : ''}`} x={cx - arm - w / 2} y={cy - w / 2} width={arm} height={w} rx="1.5" />
      <rect className={`seg${right ? ' on' : ''}`} x={cx + w / 2} y={cy - w / 2} width={arm} height={w} rx="1.5" />
      <rect className="pad-base" x={cx - w / 2} y={cy - w / 2} width={w} height={w} rx="1.5" />
      {/* A / B buttons */}
      <circle className={`btn${btn === 'A' ? ' on' : ''}`} cx="86" cy="34" r="9" />
      <text className={`btn-lbl${btn === 'A' ? ' on' : ''}`} x="86" y="34">A</text>
      <circle className={`btn${btn === 'B' ? ' on' : ''}`} cx="104" cy="20" r="9" />
      <text className={`btn-lbl${btn === 'B' ? ' on' : ''}`} x="104" y="20">B</text>
    </svg>
  );
}

// ── Policy confidence bars ─────────────────────────────────────
function PolicyBars({ policy, chosenId, accent }: { policy: PolicyEntry[] | undefined; chosenId: string | undefined; accent: string }) {
  const top = (policy ?? []).slice(0, 3);
  if (top.length === 0) {
    return <div className="tpanel__policy--empty">awaiting first decision…</div>;
  }
  return (
    <div className="tpanel__policy">
      {top.map((e) => {
        const pct = Math.round(e.prob * 100);
        const chosen = e.id === chosenId;
        return (
          <div className={`pbar${chosen ? ' pbar--chosen' : ''}`} key={e.id}>
            <div className="pbar__top">
              <span className="pbar__pct">{pct}%</span>
            </div>
            <div className="pbar__track">
              <div className="pbar__fill" style={{ width: `${Math.max(2, e.prob * 100)}%` }} />
            </div>
            <div className="pbar__label">{e.label}</div>
          </div>
        );
      })}
    </div>
  );
}

function formatCost(usd: number): string {
  if (usd <= 0) return '$0.00000';
  // enough decimals to render a non-zero micro-cost
  if (usd < 0.001) return `$${usd.toFixed(5)}`;
  if (usd < 1) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

function TelemetryPanelBase({ chef, telemetry, side }: { chef: Chef; telemetry: ChefTelemetry; side: 'left' | 'right' }) {
  const pnum = chef.id + 1;
  const last = telemetry.lastDecision;
  const latency = last?.latencyMs ?? 0;
  const style = { ['--accent' as string]: chef.accent } as React.CSSProperties;

  return (
    <section className="tpanel" style={style} data-side={side} data-player={`p${pnum}`}>
      {/* 1. Header */}
      <div className="tpanel__head">
        <div className="tpanel__pid">P{pnum} <b>/ JEV</b></div>
        <div className="tpanel__live">
          <span className="tpanel__livedot" />
          LIVE
        </div>
      </div>

      {/* 2. Sub row */}
      <div className="tpanel__sub">
        <div className="tpanel__name">
          {chef.name.toUpperCase()} <span className="tpanel__role">· {ROLE_TAGS[chef.id] ?? 'CHEF'}</span>
        </div>
        <div className="tpanel__count hud-mono">
          <b>{telemetry.decisions.toLocaleString()}</b> RESPONSES
        </div>
      </div>

      {/* 3. Current plan */}
      <div className="tpanel__section">
        <div className="hud-microlabel">Current Plan</div>
        <div className="tpanel__plan">{chef.planLabel || 'standing by'}</div>
      </div>

      {/* 4. Response latency + sparkline */}
      <div className="tpanel__section tpanel__section--tight">
        <div className="hud-microlabel">Response Latency</div>
        <div className="tpanel__latrow">
          <div className="tpanel__latnum hud-mono">
            {Math.round(latency)}<span>ms</span>
          </div>
          <Sparkline history={telemetry.latencyHistory} accent={chef.accent} />
        </div>
      </div>

      {/* 5. Policy confidence */}
      <div className="tpanel__section tpanel__section--tight">
        <div className="hud-microlabel">Policy Confidence</div>
        <PolicyBars policy={last?.policy} chosenId={last?.chosenId} accent={chef.accent} />
      </div>

      {/* 6. Move */}
      <div className="tpanel__section tpanel__section--tight">
        <div className="hud-microlabel">Move</div>
        <div className="tpanel__move hud-mono">{chef.moveLabel || '—'}</div>
      </div>

      {/* 7. Input viz + token/cost */}
      <div className="tpanel__section tpanel__section--tight">
        <div className="hud-microlabel">Input</div>
        <div className="tpanel__inputrow">
          <Gamepad dir={chef.inputDir} btn={chef.inputBtn} />
          <div className="tpanel__cost hud-mono">
            <b>{telemetry.totalTokens.toLocaleString()}</b> tok
            <br />
            <b>{formatCost(telemetry.totalCostUsd)}</b>
          </div>
        </div>
      </div>

      {/* 8. In-flight shimmer */}
      <div className={`tpanel__flight${telemetry.inFlight ? ' on' : ''}`}>
        {telemetry.inFlight ? 'POST /v1/decision · waiting…' : ''}
      </div>
    </section>
  );
}

// Re-render at ~10Hz from a state snapshot — memoize so panels whose
// chef/telemetry references are unchanged skip re-rendering entirely.
export const TelemetryPanel = React.memo(TelemetryPanelBase);
export default TelemetryPanel;
