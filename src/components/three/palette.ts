'use client';
// ─────────────────────────────────────────────────────────────
// Shared colors, world math, and module-scope geometry/material
// pools. Everything static is created ONCE here so the scene never
// allocates per-frame. Import from KitchenScene and friends only.
// ─────────────────────────────────────────────────────────────
import * as THREE from 'three';
import { GRID_W, GRID_H } from '@/game/types';

// ── World mapping ────────────────────────────────────────────
// Grid tile = 1 world unit. Kitchen centered at origin, floor y=0.
// Grid (col x, row y) → world (X, Z). Row 0 is the back wall (−Z).
export const TILE = 1;
export const HALF_W = (GRID_W * TILE) / 2;
export const HALF_H = (GRID_H * TILE) / 2;

/** grid tile centre → world XZ (returns [x, z]) */
export function tileToWorld(gx: number, gy: number): [number, number] {
  const x = (gx + 0.5) * TILE - HALF_W;
  const z = (gy + 0.5) * TILE - HALF_H;
  return [x, z];
}

// ── Palette ──────────────────────────────────────────────────
// Warm, toy-like, high-saturation. Reads bright against near-black.
export const COL = {
  floorA: '#f2e2c4',      // warm cream
  floorB: '#e4cba0',      // tan
  plinth: '#8a5a34',      // rich wood
  plinthTop: '#a9713f',
  plinthDark: '#3a2414',
  counterBody: '#b9793f', // warm wood
  counterTop: '#e9c88f',  // lighter slab
  wall: '#f4d9b0',        // splashback base
  wallTile: '#e7c9a0',
  wallTrim: '#c98f52',
  stoveBody: '#e8462f',   // red-orange enamel
  stoveDark: '#c1341f',
  cooktop: '#26262e',
  steel: '#c9ced6',
  steelDark: '#8b929c',
  dial: '#2a2a30',
  board: '#d9a566',       // cutting board
  boardEdge: '#b3823f',
  knife: '#d5dae2',
  knifeHandle: '#3a2b1e',
  crate: '#b07a44',
  crateSlat: '#94622f',
  tomato: '#e23b34',
  tomatoStem: '#4c9a3a',
  meat: '#e59aa4',
  meatCooked: '#a5502f',
  patty: '#5f3a24',       // grilled burger patty (dark)
  pattySear: '#3f2517',   // seared crust
  pasta: '#e9cf8e',
  pastaCooked: '#f0e4c0',  // pale boiled pasta
  bun: '#e8a94f',         // golden-brown bun
  bunBase: '#d9963c',     // bun underside
  bunSheen: '#f6cd82',    // lighter sheen highlight
  plate: '#f4f6fb',
  plateEdge: '#d8dce6',
  serveGlow: '#ffd27a',
  serveFrame: '#caa35c',
  trash: '#9aa1ab',
  trashDark: '#6b727c',
  trashLid: '#7c828c',
  burnt: '#2c2622',
  soup: '#e5622f',
  flame: '#ff7a1a',
  flameHot: '#ffd23d',
  glow: '#ffb347',
  eyeWhite: '#ffffff',
  pupil: '#20202a',
  hat: '#fbfcff',
  hatBand: '#e7ebf3',
} as const;

// ── Shared geometry pool (unit-ish; scaled per instance) ─────
// Reused by reference across the whole scene.
export const GEO = {
  box: new THREE.BoxGeometry(1, 1, 1),
  plane: new THREE.PlaneGeometry(1, 1),
  sphere: new THREE.SphereGeometry(0.5, 20, 16),
  sphereLow: new THREE.SphereGeometry(0.5, 12, 10),
  halfSphere: new THREE.SphereGeometry(0.5, 20, 12, 0, Math.PI * 2, 0, Math.PI / 2),
  cyl: new THREE.CylinderGeometry(0.5, 0.5, 1, 24),
  cylLow: new THREE.CylinderGeometry(0.5, 0.5, 1, 16),
  cone: new THREE.ConeGeometry(0.5, 1, 16),
  torus: new THREE.TorusGeometry(0.5, 0.12, 10, 32),
  ringThin: new THREE.TorusGeometry(0.5, 0.045, 8, 40),
  capsule: new THREE.CapsuleGeometry(0.5, 0.6, 6, 12),
  disc: new THREE.CircleGeometry(0.5, 28),
} as const;

// ── Material factory ─────────────────────────────────────────
// Standard toy material: matte-ish, slight roughness, no metal
// unless asked. Cached by a key so identical looks share one mat.
const matCache = new Map<string, THREE.Material>();

interface MatOpts {
  color?: string | number;
  rough?: number;
  metal?: number;
  emissive?: string | number;
  emissiveIntensity?: number;
  transparent?: boolean;
  opacity?: number;
  flat?: boolean;
  side?: THREE.Side;
  depthWrite?: boolean;
}

export function mat(opts: MatOpts): THREE.MeshStandardMaterial {
  const key = JSON.stringify(opts);
  const cached = matCache.get(key);
  if (cached) return cached as THREE.MeshStandardMaterial;
  const m = new THREE.MeshStandardMaterial({
    color: opts.color ?? '#ffffff',
    roughness: opts.rough ?? 0.72,
    metalness: opts.metal ?? 0.04,
    emissive: opts.emissive ?? '#000000',
    emissiveIntensity: opts.emissiveIntensity ?? 1,
    transparent: opts.transparent ?? false,
    opacity: opts.opacity ?? 1,
    flatShading: opts.flat ?? false,
    side: opts.side ?? THREE.FrontSide,
    depthWrite: opts.depthWrite ?? true,
  });
  matCache.set(key, m);
  return m;
}

// Small deterministic hash → stable per-tile hue jitter.
export function hash2(x: number, y: number): number {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
}
