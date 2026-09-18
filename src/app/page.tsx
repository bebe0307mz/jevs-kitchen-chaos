'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { GameEngine } from '@/game/engine';
import { Renderer } from '@/game/renderer';
import { GRID_W, GRID_H, TILE_SIZE, RECIPES, DISH_EMOJIS, GameStats } from '@/game/types';

const CANVAS_W = GRID_W * TILE_SIZE;
const CANVAS_H = GRID_H * TILE_SIZE;

export default function Home() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<GameEngine | null>(null);
  const rendererRef = useRef<Renderer | null>(null);
  const rafRef = useRef<number>(0);
  const lastTimeRef = useRef<number>(0);

  const [started, setStarted] = useState(false);
  const [score, setScore] = useState(0);
  const [timeLeft, setTimeLeft] = useState(180);
  const [rushHour, setRushHour] = useState(false);
  const [orders, setOrders] = useState<Array<{ id: number; dish: number; pct: number; urgent: boolean; completed: boolean; failed: boolean; name: string }>>([]);
  const [shiftEnded, setShiftEnded] = useState(false);
  const [finalStats, setFinalStats] = useState<GameStats | null>(null);
  const [agentCount, setAgentCount] = useState(5);
  const [possessedName, setPossessedName] = useState<string | null>(null);

  const startGame = useCallback(() => {
    if (started) return;
    setStarted(true);
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const engine = new GameEngine();
    const renderer = new Renderer(ctx, engine);
    engineRef.current = engine;
    rendererRef.current = renderer;

    engine.onUpdate = () => {
      setScore(engine.stats.totalScore);
      setTimeLeft(Math.max(0, Math.ceil(engine.shiftDuration - engine.gameTime)));
      setRushHour(engine.rushHour);
      setAgentCount(engine.agents.length);
      const possessed = engine.possessedId !== null ? engine.agents.find(a => a.id === engine.possessedId) : null;
      setPossessedName(possessed?.name || null);

      const orderData = engine.orders
        .filter(o => !o.completed || o.timeLeft > -1)
        .slice(-8)
        .map(o => ({
          id: o.id,
          dish: o.dish,
          pct: Math.max(0, o.timeLeft / o.maxTime),
          urgent: o.timeLeft < 10 && !o.completed && !o.failed,
          completed: o.completed,
          failed: o.failed,
          name: RECIPES[o.dish].name,
        }));
      setOrders(orderData);
    };

    engine.onShiftEnd = () => {
      setShiftEnded(true);
      setFinalStats({ ...engine.stats });
    };

    lastTimeRef.current = performance.now();
    const loop = (time: number) => {
      const dt = Math.min((time - lastTimeRef.current) / 1000, 0.1);
      lastTimeRef.current = time;
      engine.update(dt);
      renderer.render(dt);
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
  }, [started]);

  // Canvas click handler
  const handleCanvasClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const engine = engineRef.current;
    const canvas = canvasRef.current;
    if (!engine || !canvas) return;
    const rect = canvas.getBoundingClientRect();
    const scaleX = CANVAS_W / rect.width;
    const scaleY = CANVAS_H / rect.height;
    const cx = (e.clientX - rect.left) * scaleX;
    const cy = (e.clientY - rect.top) * scaleY;
    engine.handleClick(cx, cy);
  }, []);

  // Keyboard handlers
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!engineRef.current) return;
      if (['w', 'a', 's', 'd', ' ', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'escape'].includes(e.key.toLowerCase())) {
        e.preventDefault();
      }
      engineRef.current.handleKeyDown(e.key);
    };
    const onKeyUp = (e: KeyboardEvent) => {
      engineRef.current?.handleKeyUp(e.key);
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, []);

  // Cleanup
  useEffect(() => {
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
  }, []);

  const formatTime = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

  const handleHire = () => engineRef.current?.hireJev();
  const handleFire = () => engineRef.current?.fireJev();
  const handleRush = () => engineRef.current?.triggerRushHour();

  const handleContinue = () => {
    setShiftEnded(false);
    engineRef.current?.continueShift();
  };

  const handleTweet = () => {
    const s = finalStats;
    if (!s) return;
    const text = `Just ran Jev's Kitchen Chaos! ${s.totalScore} pts, ${s.dishesServed} dishes served, ${s.firesCaused} fires started, ${s.jevsFired} Jevs fired. Can you beat that?\n\nhttps://jevs-kitchen-chaos.vercel.app`;
    window.open(`https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}`, '_blank');
  };

  return (
    <div className="game-container">
      {/* Intro overlay */}
      {!started && (
        <div className="intro-overlay" onClick={startGame}>
          <div className="intro-content">
            <h1>Jev&apos;s Kitchen Chaos</h1>
            <p>
              5 autonomous Jev agents are running a restaurant kitchen.
              They cook, collide, panic, and set things on fire.
              You can hire more, fire them, trigger rush hour, or take control yourself.
            </p>
            <div className="start-hint">Click anywhere to start the shift</div>
            <div className="controls-hint">
              <span className="control-key"><kbd>Click</kbd> Jev to possess</span>
              <span className="control-key"><kbd>WASD</kbd> move</span>
              <span className="control-key"><kbd>Space</kbd> interact</span>
              <span className="control-key"><kbd>Esc</kbd> release</span>
            </div>
          </div>
        </div>
      )}

      {/* Canvas */}
      <div className="canvas-wrapper">
        <canvas
          ref={canvasRef}
          width={CANVAS_W}
          height={CANVAS_H}
          onClick={handleCanvasClick}
        />
      </div>

      {/* HUD - only visible when game started */}
      {started && (
        <>
          <div className="hud-top">
            <div className="orders-bar">
              {orders.map(o => (
                <div
                  key={o.id}
                  className={`order-ticket ${o.urgent ? 'urgent' : ''} ${o.completed ? 'completed' : ''} ${o.failed ? 'failed' : ''}`}
                >
                  <div className="order-emoji">{DISH_EMOJIS[o.dish]}</div>
                  <div className="order-name">{o.name}</div>
                  <div
                    className={`order-timer ${o.pct < 0.3 ? 'critical' : o.pct < 0.5 ? 'low' : ''}`}
                    style={{ width: `${o.pct * 100}%` }}
                  />
                </div>
              ))}
            </div>
            <div className="score-panel">
              <div className="score-label">Score</div>
              <div className="score-value">{score}</div>
              <div className={`timer-display ${rushHour ? 'rush' : ''}`}>
                {rushHour ? 'RUSH HOUR ' : ''}{formatTime(timeLeft)}
              </div>
            </div>
          </div>

          <div className="hud-bottom">
            <button className="action-btn btn-hire" onClick={handleHire} title="Spawn a new Jev (starts panicked)">
              + Hire Jev ({agentCount}/8)
            </button>
            <button className="action-btn btn-fire" onClick={handleFire} title="Fire a Jev (rage-quits)">
              Fire Jev
            </button>
            <button className={`action-btn btn-rush ${rushHour ? 'active' : ''}`} onClick={handleRush} title="3x orders for 30s">
              {rushHour ? 'RUSHING!' : 'Rush Hour'}
            </button>
            {possessedName && (
              <span className="hint-text">
                Controlling {possessedName} &middot; WASD move &middot; Space interact &middot; Esc release
              </span>
            )}
          </div>
        </>
      )}

      {/* Scoreboard */}
      {shiftEnded && finalStats && (
        <div className="scoreboard-overlay">
          <div className="scoreboard">
            <h2>Shift Over!</h2>
            <p className="subtitle">Here&apos;s how the kitchen fared</p>
            <div className="stat-grid">
              <div className="stat-item">
                <div className="stat-num score">{finalStats.totalScore}</div>
                <div className="stat-desc">Total Score</div>
              </div>
              <div className="stat-item">
                <div className="stat-num dishes">{finalStats.dishesServed}</div>
                <div className="stat-desc">Dishes Served</div>
              </div>
              <div className="stat-item">
                <div className="stat-num fires">{finalStats.firesCaused}</div>
                <div className="stat-desc">Fires Caused</div>
              </div>
              <div className="stat-item">
                <div className="stat-num fired">{finalStats.jevsFired}</div>
                <div className="stat-desc">Jevs Fired</div>
              </div>
            </div>
            <div className="scoreboard-actions">
              <button className="btn-tweet" onClick={handleTweet}>
                Share on X
              </button>
              <button className="btn-continue" onClick={handleContinue}>
                Continue Shift
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
