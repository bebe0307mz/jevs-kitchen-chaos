'use client';
// ─────────────────────────────────────────────────────────────
// Pooled particle systems. Each pool pre-allocates a fixed set of
// meshes; emit() recycles the oldest. Nothing is allocated inside
// useFrame — only positions/scales/opacity are mutated in place.
// ─────────────────────────────────────────────────────────────
import { useMemo, useRef, forwardRef, useImperativeHandle } from 'react';
import * as THREE from 'three';
import { GEO } from './palette';

export interface Particle {
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  life: number;     // remaining, seconds
  maxLife: number;
  size: number;
  spin: number;
  hue: THREE.Color;
  active: boolean;
}

export interface PoolHandle {
  /** spawn one particle at world pos with velocity + look */
  emit(o: {
    x: number; y: number; z: number;
    vx?: number; vy?: number; vz?: number;
    life?: number; size?: number; color?: THREE.Color | string; spin?: number;
  }): void;
}

interface PoolProps {
  count: number;
  geo?: THREE.BufferGeometry;
  /** base material; opacity animated per particle via color/scale only */
  baseColor?: string;
  gravity?: number;      // + falls, − rises
  drag?: number;         // velocity damping /s
  transparent?: boolean;
  additive?: boolean;
  fade?: 'in-out' | 'out'; // opacity curve
  emissive?: string;
  emissiveIntensity?: number;
}

/**
 * A reusable particle pool. The parent calls handle.emit() (e.g. from
 * a station's steam tick) and the pool integrates + renders every frame.
 * Uses InstancedMesh for zero draw-call overhead per particle.
 */
export const ParticlePool = forwardRef<PoolHandle, PoolProps>(function ParticlePool(
  {
    count,
    geo = GEO.sphereLow,
    baseColor = '#ffffff',
    gravity = 0,
    drag = 0.6,
    transparent = true,
    additive = false,
    fade = 'out',
    emissive,
    emissiveIntensity = 1,
  },
  ref,
) {
  const meshRef = useRef<THREE.InstancedMesh>(null);
  const dummy = useMemo(() => new THREE.Object3D(), []);
  const parts = useMemo<Particle[]>(
    () =>
      Array.from({ length: count }, () => ({
        x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0,
        life: 0, maxLife: 1, size: 0.1, spin: 0,
        hue: new THREE.Color(baseColor), active: false,
      })),
    [count, baseColor],
  );
  const cursor = useRef(0);
  const material = useMemo(() => {
    const m = new THREE.MeshStandardMaterial({
      color: baseColor,
      transparent,
      opacity: 1,
      roughness: 0.9,
      metalness: 0,
      depthWrite: false,
      emissive: emissive ?? '#000000',
      emissiveIntensity,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    return m;
  }, [baseColor, transparent, additive, emissive, emissiveIntensity]);

  useImperativeHandle(ref, () => ({
    emit(o) {
      const p = parts[cursor.current];
      cursor.current = (cursor.current + 1) % parts.length;
      p.x = o.x; p.y = o.y; p.z = o.z;
      p.vx = o.vx ?? 0; p.vy = o.vy ?? 0; p.vz = o.vz ?? 0;
      p.maxLife = o.life ?? 1;
      p.life = p.maxLife;
      p.size = o.size ?? 0.12;
      p.spin = o.spin ?? 0;
      if (o.color) p.hue.set(o.color as THREE.Color);
      p.active = true;
    },
  }));

  // Driven by parent's useFrame through the exposed step() — but to keep
  // the pool self-contained we integrate inside our own frame via a ref
  // the parent invokes. We expose stepping through useFrame here instead:
  // (kept internal so pools "just work" when mounted.)
  useFrameStep(meshRef, parts, dummy, material, gravity, drag, fade);

  return (
    <instancedMesh
      ref={meshRef}
      args={[geo, material, count]}
      frustumCulled={false}
    />
  );
});

// ── internal integration hook ────────────────────────────────
import { useFrame } from '@react-three/fiber';

function useFrameStep(
  meshRef: React.RefObject<THREE.InstancedMesh>,
  parts: Particle[],
  dummy: THREE.Object3D,
  material: THREE.MeshStandardMaterial,
  gravity: number,
  drag: number,
  fade: 'in-out' | 'out',
) {
  const tmpColor = useMemo(() => new THREE.Color(), []);
  useFrame((_, dtRaw) => {
    const mesh = meshRef.current;
    if (!mesh) return;
    const dt = Math.min(dtRaw, 0.05);
    let anyActive = false;
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      if (!p.active) {
        // park offscreen at zero scale
        dummy.position.set(0, -999, 0);
        dummy.scale.setScalar(0.0001);
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
        continue;
      }
      anyActive = true;
      p.life -= dt;
      if (p.life <= 0) {
        p.active = false;
        dummy.position.set(0, -999, 0);
        dummy.scale.setScalar(0.0001);
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
        continue;
      }
      const damp = Math.max(0, 1 - drag * dt);
      p.vx *= damp; p.vz *= damp;
      p.vy = p.vy * damp - gravity * dt;
      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;

      const t = p.life / p.maxLife; // 1→0
      let a: number;
      if (fade === 'in-out') {
        // ramp up quickly then out
        a = t > 0.7 ? (1 - t) / 0.3 : t / 0.7;
      } else {
        a = t;
      }
      const s = p.size * (fade === 'in-out' ? 0.5 + (1 - t) * 0.9 : 0.6 + t * 0.5);

      dummy.position.set(p.x, p.y, p.z);
      dummy.rotation.set(p.spin * (1 - t) * 4, p.spin * (1 - t) * 3, 0);
      dummy.scale.setScalar(Math.max(0.0001, s));
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);

      // per-instance color with alpha baked via brightness is not ideal;
      // instead scale the color toward black as it dies for smoke,
      // and rely on material opacity peak. We tint per-instance:
      tmpColor.copy(p.hue).multiplyScalar(0.55 + a * 0.75);
      mesh.setColorAt(i, tmpColor);
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    // global opacity follows whether anything is alive (cheap shimmer)
    material.opacity = anyActive ? 0.85 : 0;
  });
}
