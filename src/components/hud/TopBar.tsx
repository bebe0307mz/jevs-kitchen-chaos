'use client';

import React from 'react';
import type { SimState } from '@/game/types';
import './hud.css';

function mean(nums: number[]): number {
  if (nums.length === 0) return 0;
  let s = 0;
  for (const n of nums) s += n;
  return s / nums.length;
}

function formatCost(usd: number): string {
  if (usd <= 0) return '$0.0000';
  if (usd < 1) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

function TopBarBase({ state }: { state: SimState }) {
  const tel = state.telemetry;

  // AVG LATENCY: mean of each chef's most recent latency sample.
  const recentLatencies = tel
    .map((t) => t.latencyHistory[t.latencyHistory.length - 1] ?? t.lastDecision?.latencyMs ?? 0)
    .filter((v) => v > 0);
  const avgLatency = Math.round(mean(recentLatencies));

  const decisions = tel.reduce((a, t) => a + t.decisions, 0);
  const cost = tel.reduce((a, t) => a + t.totalCostUsd, 0);
  const totalOrders = state.served + state.failed;

  return (
    <header className="topbar">
      <div className="topbar__brand">
        <span className="topbar__wordmark">JEV</span>
        <span className="topbar__divider" />
        <span className="topbar__title">Kitchen Chaos — Four-Jev Kitchen</span>
      </div>

      <div className="topbar__stats">
        <div className="statblock">
          <span className="hud-microlabel">Avg Latency</span>
          <span className="statblock__val hud-mono">{avgLatency}<span>ms</span></span>
        </div>
        <div className="statblock">
          <span className="hud-microlabel">Decisions</span>
          <span className="statblock__val hud-mono">{decisions.toLocaleString()}</span>
        </div>
        <div className="statblock">
          <span className="hud-microlabel">Cost</span>
          <span className="statblock__val statblock__val--good hud-mono">{formatCost(cost)}</span>
        </div>
        <div className="statblock">
          <span className="hud-microlabel">Orders</span>
          <span className="statblock__val hud-mono">{state.served}<span>/{totalOrders}</span></span>
        </div>
      </div>
    </header>
  );
}

export const TopBar = React.memo(TopBarBase);
export default TopBar;
