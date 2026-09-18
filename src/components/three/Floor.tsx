'use client';
// ─────────────────────────────────────────────────────────────
// The diorama base: a thick rounded wooden plinth, a per-tile
// beveled checker floor, and a soft radial glow disc beneath so the
// whole kitchen appears to float in the dark broadcast frame.
// Built once, never re-renders (pure static group).
// ─────────────────────────────────────────────────────────────
import { useMemo } from 'react';
import * as THREE from 'three';
import { RoundedBox } from '@react-three/drei';
import { GRID_W, GRID_H, KITCHEN_LAYOUT, T } from '@/game/types';
import { COL, TILE, HALF_W, HALF_H, tileToWorld, GEO, mat, hash2 } from './palette';

const PLINTH_PAD = 0.6;   // wood lip beyond the grid
const PLINTH_H = 0.55;    // plinth thickness
const FLOOR_Y = 0.02;     // beveled tile top sits just above plinth top

function GlowDisc() {
  // Radial gradient sprite-like disc via a shader-free vertex-color mesh.
  const geo = useMemo(() => {
    const g = new THREE.CircleGeometry(HALF_W + 4.5, 48);
    const colors: number[] = [];
    const c0 = new THREE.Color(COL.glow);
    const c1 = new THREE.Color('#000000');
    const pos = g.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const y = pos.getY(i);
      const r = Math.sqrt(x * x + y * y) / (HALF_W + 4.5);
      const c = c0.clone().lerp(c1, Math.min(1, r * 1.15));
      colors.push(c.r, c.g, c.b);
    }
    g.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    return g;
  }, []);
  const material = useMemo(
    () =>
      new THREE.MeshBasicMaterial({
        vertexColors: true,
        transparent: true,
        opacity: 0.5,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    [],
  );
  return (
    <mesh
      geometry={geo}
      material={material}
      rotation={[-Math.PI / 2, 0, 0]}
      position={[0, -PLINTH_H - 0.34, 0]}
      renderOrder={-2}
    />
  );
}

export function Floor() {
  // Precompute floor tiles that are actually walkable/visible floor.
  const tiles = useMemo(() => {
    const out: { x: number; z: number; color: THREE.Color }[] = [];
    const a = new THREE.Color(COL.floorA);
    const b = new THREE.Color(COL.floorB);
    for (let gy = 0; gy < GRID_H; gy++) {
      for (let gx = 0; gx < GRID_W; gx++) {
        const [x, z] = tileToWorld(gx, gy);
        const checker = (gx + gy) % 2 === 0;
        const base = (checker ? a : b).clone();
        // subtle per-tile warmth jitter
        const j = (hash2(gx, gy) - 0.5) * 0.05;
        base.offsetHSL(0.0, 0.0, j);
        out.push({ x, z, color: base });
      }
    }
    return out;
  }, []);

  return (
    <group>
      <GlowDisc />

      {/* Plinth: rounded wood slab under everything */}
      <RoundedBox
        args={[GRID_W * TILE + PLINTH_PAD * 2, PLINTH_H, GRID_H * TILE + PLINTH_PAD * 2]}
        radius={0.28}
        smoothness={4}
        position={[0, -PLINTH_H / 2, 0]}
        castShadow
        receiveShadow
        material={mat({ color: COL.plinth, rough: 0.85 })}
      />
      {/* Lighter top rim of plinth peeking around the floor */}
      <mesh
        geometry={GEO.box}
        material={mat({ color: COL.plinthTop, rough: 0.8 })}
        position={[0, -0.02, 0]}
        scale={[GRID_W * TILE + PLINTH_PAD * 1.2, 0.06, GRID_H * TILE + PLINTH_PAD * 1.2]}
        receiveShadow
      />
      {/* Dark underside shadow slab for depth */}
      <mesh
        geometry={GEO.box}
        material={mat({ color: COL.plinthDark, rough: 1 })}
        position={[0, -PLINTH_H - 0.12, 0]}
        scale={[GRID_W * TILE + PLINTH_PAD * 1.6, 0.24, GRID_H * TILE + PLINTH_PAD * 1.6]}
      />

      {/* Beveled checker tiles */}
      {tiles.map((t, i) => (
        <RoundedBox
          key={i}
          args={[TILE * 0.98, 0.08, TILE * 0.98]}
          radius={0.05}
          smoothness={2}
          position={[t.x, FLOOR_Y, t.z]}
          receiveShadow
        >
          <meshStandardMaterial color={t.color} roughness={0.85} metalness={0.02} />
        </RoundedBox>
      ))}
    </group>
  );
}

export { PLINTH_H, PLINTH_PAD };
