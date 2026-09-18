'use client';

import React from 'react';
import type { SimState, Order, Chef } from '@/game/types';
import { RECIPES, DISH_EMOJI } from '@/game/types';
import './hud.css';

// Condense a chef's plan label for the status chip (chips are narrow).
function chipPlan(chef: Chef): string {
  const p = chef.planLabel?.trim();
  if (!p || chef.action === 'idle') return 'IDLE';
  return p.toUpperCase();
}

// % time remaining on the order this chef has claimed, at sim time t.
function chefRemainingPct(chef: Chef, state: SimState): number | null {
  const order = state.orders.find((o) => o.claimedBy === chef.id && o.status === 'open');
  if (!order) return null;
  const life = order.expiresAt - order.createdAt;
  if (life <= 0) return 0;
  const pct = ((order.expiresAt - state.t) / life) * 100;
  return Math.max(0, Math.min(100, Math.round(pct)));
}

function PlayerChip({ chef, state }: { chef: Chef; state: SimState }) {
  const pnum = chef.id + 1;
  const pct = chefRemainingPct(chef, state);
  const idle = pct === null;
  const style = { ['--accent' as string]: chef.accent } as React.CSSProperties;
  return (
    <span className="pchip" style={style}>
      <span className="pchip__p">P{pnum}</span>
      <span className="pchip__plan">{chipPlan(chef)}</span>
      {!idle && <span className="pchip__pct">{pct}%</span>}
    </span>
  );
}

function Ticket({ order, t }: { order: Order; t: number }) {
  const recipe = RECIPES[order.dish];
  const life = order.expiresAt - order.createdAt;
  const frac = life > 0 ? Math.max(0, Math.min(1, (order.expiresAt - t) / life)) : 0;
  const urgent = frac < 0.25;
  return (
    <div className="ticket">
      <div className="ticket__top">
        <span className="ticket__emoji">{DISH_EMOJI[order.dish]}</span>
        <span className="ticket__name">{recipe.name}</span>
      </div>
      <div className="ticket__track">
        <div className={`ticket__fill${urgent ? ' urgent' : ''}`} style={{ width: `${frac * 100}%` }} />
      </div>
    </div>
  );
}

function EventTicker({ state }: { state: SimState }) {
  const recent = state.events.slice(-6).reverse();
  return (
    <div className="ticker">
      <span className="hud-microlabel">Feed</span>
      <div className="ticker__items">
        {recent.length === 0 ? (
          <span className="ticker__empty">kitchen warming up…</span>
        ) : (
          recent.map((e, i) => (
            <span className={`ticker__item ticker__item--${e.kind}`} key={`${e.t}-${i}`}>
              {e.text}
            </span>
          ))
        )}
      </div>
    </div>
  );
}

function BottomBarBase({
  state,
  onRush,
  onFire,
  onApiKey,
  brainName = 'jev-local (emulated)',
}: {
  state: SimState;
  onRush(): void;
  onFire(): void;
  onApiKey(key: string): void;
  brainName?: string;
}) {
  const [apiOpen, setApiOpen] = React.useState(false);
  const [apiKey, setApiKey] = React.useState('');
  const [rushFlash, setRushFlash] = React.useState(false);
  const [fireFlash, setFireFlash] = React.useState(false);
  const popRef = React.useRef<HTMLDivElement | null>(null);

  const flash = (setter: (v: boolean) => void) => {
    setter(true);
    window.setTimeout(() => setter(false), 180);
  };

  const handleRush = () => { flash(setRushFlash); onRush(); };
  const handleFire = () => { flash(setFireFlash); onFire(); };
  const handleConnect = () => {
    const k = apiKey.trim();
    if (!k) return;
    onApiKey(k);
    setApiKey('');
    setApiOpen(false);
  };

  // Close the popover on outside click.
  React.useEffect(() => {
    if (!apiOpen) return;
    const onDoc = (ev: MouseEvent) => {
      if (popRef.current && !popRef.current.contains(ev.target as Node)) {
        setApiOpen(false);
      }
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [apiOpen]);

  const openOrders = state.orders.filter((o) => o.status === 'open');

  return (
    <footer className="bottombar">
      <div className="bottombar__main">
        {/* Left: player status chips */}
        <div className="bottombar__chips">
          {state.chefs.map((chef) => (
            <PlayerChip chef={chef} state={state} key={chef.id} />
          ))}
        </div>

        {/* Center: open order tickets */}
        <div className="tickets">
          <span className="hud-microlabel tickets__label">Orders</span>
          <div className="tickets__row">
            {openOrders.length === 0 ? (
              <span className="tickets__empty">no open tickets</span>
            ) : (
              openOrders.slice(0, 8).map((o) => <Ticket order={o} t={state.t} key={o.id} />)
            )}
          </div>
        </div>

        {/* Right: actions + API popover */}
        <div className="bottombar__actions" ref={popRef}>
          <button className={`actbtn actbtn--rush${rushFlash ? ' flash' : ''}`} onClick={handleRush}>
            <span>Rush Hour</span>
          </button>
          <button className={`actbtn actbtn--fire${fireFlash ? ' flash' : ''}`} onClick={handleFire}>
            <span>Start Fire</span>
          </button>
          <button
            className={`actbtn actbtn--api${apiOpen ? ' open' : ''}`}
            onClick={() => setApiOpen((v) => !v)}
            aria-expanded={apiOpen}
          >
            <span>API</span>
          </button>

          {apiOpen && (
            <div className="apipop">
              <div className="apipop__model">
                <span className="hud-microlabel">Model</span>
                <span className="apipop__modelval hud-mono">{brainName}</span>
              </div>
              <div className="apipop__desc">Plug a live Jev API key to drive all four chefs.</div>
              <div className="apipop__form">
                <input
                  className="apipop__input"
                  type="password"
                  placeholder="jev-sk-…"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') handleConnect(); }}
                />
                <button className="apipop__connect" onClick={handleConnect}>Connect</button>
              </div>
              <div className="apipop__note">Runs local heuristic emulation until connected.</div>
            </div>
          )}
        </div>
      </div>

      {/* Events ticker */}
      <EventTicker state={state} />
    </footer>
  );
}

export const BottomBar = React.memo(BottomBarBase);
export default BottomBar;
