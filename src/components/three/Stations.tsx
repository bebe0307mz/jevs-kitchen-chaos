'use client';
// ─────────────────────────────────────────────────────────────
// All kitchen stations. Static bodies (counters, crates, plates,
// trash, walls, splashback) are built ONCE from KITCHEN_LAYOUT into
// a non-reactive group. Dynamic stations (stoves, boards, serve
// window) are per-instance components that read their live Station
// from getState() inside useFrame — never via React state.
// ─────────────────────────────────────────────────────────────
import { useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { Billboard, RoundedBox, Text } from '@react-three/drei';
import {
  GRID_W, GRID_H, KITCHEN_LAYOUT, T,
  type SimState, type Station,
} from '@/game/types';
import { COL, TILE, tileToWorld, GEO, mat, hash2 } from './palette';
import { ItemMesh, Tomato, MeatSlab, PastaBundle, Knife } from './FoodBits';
import { ParticlePool, type PoolHandle } from './Particles';

const COUNTER_H = 0.55;

// ── static counter body (used for counters, crates, boards, etc) ─
function CounterBody({ x, z, hueShift = 0 }: { x: number; z: number; hueShift?: number }) {
  const top = useMemo(() => {
    const c = new THREE.Color(COL.counterTop);
    c.offsetHSL(0, 0, hueShift);
    return c;
  }, [hueShift]);
  const body = useMemo(() => {
    const c = new THREE.Color(COL.counterBody);
    c.offsetHSL(0, 0, hueShift);
    return c;
  }, [hueShift]);
  return (
    <group position={[x, 0, z]}>
      <RoundedBox args={[TILE * 0.96, COUNTER_H, TILE * 0.96]} radius={0.09} smoothness={3} position={[0, COUNTER_H / 2, 0]} castShadow receiveShadow>
        <meshStandardMaterial color={body} roughness={0.8} metalness={0.03} />
      </RoundedBox>
      <RoundedBox args={[TILE * 0.99, 0.1, TILE * 0.99]} radius={0.05} smoothness={3} position={[0, COUNTER_H + 0.02, 0]} castShadow receiveShadow>
        <meshStandardMaterial color={top} roughness={0.7} metalness={0.03} />
      </RoundedBox>
    </group>
  );
}

// ── floating icon chip above crates ──────────────────────────
function CrateChip({ label, color }: { label: string; color: string }) {
  const ref = useRef<THREE.Group>(null);
  useFrame(({ clock }) => {
    if (ref.current) ref.current.position.y = COUNTER_H + 0.62 + Math.sin(clock.elapsedTime * 2) * 0.03;
  });
  return (
    <group ref={ref} position={[0, COUNTER_H + 0.62, 0]}>
      <Billboard>
        <mesh geometry={GEO.cyl} material={mat({ color: '#15151c', rough: 0.6, transparent: true, opacity: 0.85 })} rotation={[Math.PI / 2, 0, 0]} scale={[0.17, 0.05, 0.17]} />
        <mesh geometry={GEO.cyl} material={mat({ color, emissive: color, emissiveIntensity: 0.35 })} rotation={[Math.PI / 2, 0, 0]} scale={[0.19, 0.02, 0.19]} position={[0, 0, -0.02]} />
        <Text position={[0, 0, 0.04]} fontSize={0.17} color={color} anchorX="center" anchorY="middle" outlineWidth={0.006} outlineColor="#000">
          {label}
        </Text>
      </Billboard>
    </group>
  );
}

// ── crate: slatted wood box with visible contents + chip ─────
function Crate({ x, z, kind }: { x: number; z: number; kind: number }) {
  const contents = useMemo(() => {
    const els: JSX.Element[] = [];
    const spots: [number, number][] = [[-0.16, -0.14], [0.16, -0.12], [0, 0.16], [-0.1, 0.12]];
    for (let i = 0; i < spots.length; i++) {
      const [dx, dz] = spots[i];
      const pos: [number, number, number] = [dx, COUNTER_H + 0.14, dz];
      if (kind === T.CRATE_TOMATO) els.push(<group key={i} position={pos}><Tomato scale={1.15} /></group>);
      else if (kind === T.CRATE_MEAT) els.push(<group key={i} position={pos}><MeatSlab scale={1.1} /></group>);
      else els.push(<group key={i} position={pos}><PastaBundle scale={1.0} /></group>);
    }
    return els;
  }, [kind]);

  const chip =
    kind === T.CRATE_TOMATO ? { label: 'T', color: COL.tomato }
    : kind === T.CRATE_MEAT ? { label: 'M', color: COL.meat }
    : { label: 'P', color: COL.pasta };

  return (
    <group position={[x, 0, z]}>
      {/* crate walls */}
      <mesh geometry={GEO.box} material={mat({ color: COL.crate, rough: 0.85 })} position={[0, COUNTER_H * 0.5, 0]} scale={[0.9, COUNTER_H, 0.9]} castShadow receiveShadow />
      {/* slats */}
      {[-0.3, 0, 0.3].map((yy, i) => (
        <mesh key={i} geometry={GEO.box} material={mat({ color: COL.crateSlat, rough: 0.9 })} position={[0, COUNTER_H * 0.5 + yy * COUNTER_H, 0.46]} scale={[0.92, 0.09, 0.04]} />
      ))}
      {contents}
      <CrateChip label={chip.label} color={chip.color} />
    </group>
  );
}

// ── plate stack ──────────────────────────────────────────────
function PlateStack({ x, z }: { x: number; z: number }) {
  return (
    <group position={[x, 0, z]}>
      <CounterBodyStatic x={0} z={0} />
      {[0, 1, 2, 3, 4].map((i) => (
        <mesh key={i} geometry={GEO.cyl} material={mat({ color: i % 2 ? COL.plateEdge : COL.plate, rough: 0.4 })} position={[0, COUNTER_H + 0.1 + i * 0.035, 0]} scale={[0.42, 0.03, 0.42]} castShadow />
      ))}
    </group>
  );
}
// counter body without its own position group (already positioned by parent)
function CounterBodyStatic({ x, z }: { x: number; z: number }) {
  return (
    <group position={[x, 0, z]}>
      <RoundedBox args={[TILE * 0.96, COUNTER_H, TILE * 0.96]} radius={0.09} smoothness={3} position={[0, COUNTER_H / 2, 0]} castShadow receiveShadow>
        <meshStandardMaterial color={COL.counterBody} roughness={0.8} metalness={0.03} />
      </RoundedBox>
      <RoundedBox args={[TILE * 0.99, 0.1, TILE * 0.99]} radius={0.05} smoothness={3} position={[0, COUNTER_H + 0.02, 0]} castShadow receiveShadow>
        <meshStandardMaterial color={COL.counterTop} roughness={0.7} metalness={0.03} />
      </RoundedBox>
    </group>
  );
}

// ── trash bin ────────────────────────────────────────────────
function Trash({ x, z }: { x: number; z: number }) {
  return (
    <group position={[x, 0, z]}>
      <mesh geometry={GEO.cyl} material={mat({ color: COL.trash, rough: 0.4, metal: 0.5 })} position={[0, 0.28, 0]} scale={[0.62, 0.56, 0.62]} castShadow receiveShadow />
      <mesh geometry={GEO.cyl} material={mat({ color: COL.trashDark, rough: 0.5, metal: 0.4 })} position={[0, 0.06, 0]} scale={[0.7, 0.12, 0.7]} />
      <mesh geometry={GEO.cyl} material={mat({ color: COL.trashLid, rough: 0.35, metal: 0.5 })} position={[0, 0.58, 0]} scale={[0.7, 0.08, 0.7]} castShadow />
      <mesh geometry={GEO.cyl} material={mat({ color: COL.trashDark, rough: 0.4, metal: 0.5 })} position={[0, 0.64, 0]} scale={[0.18, 0.06, 0.18]} />
    </group>
  );
}

// ── STOVE (dynamic) ──────────────────────────────────────────
function Stove({ x, z, stationId, getState }: { x: number; z: number; stationId: number; getState: () => SimState }) {
  const potContentRef = useRef<THREE.Mesh>(null);
  const ringRef = useRef<THREE.Mesh>(null);
  const ringGroupRef = useRef<THREE.Group>(null);
  const flameRef = useRef<THREE.Group>(null);
  const fireLightRef = useRef<THREE.PointLight>(null);
  const steamPool = useRef<PoolHandle>(null);
  const smokePool = useRef<PoolHandle>(null);
  const steamTimer = useRef(0);
  const smokeTimer = useRef(0);
  const cookedContent = useRef(new THREE.Color(COL.soup));

  useFrame(({ clock }, dt) => {
    const st = getState().stations.find((s) => s.id === stationId);
    if (!st) return;
    const time = clock.elapsedTime;

    // progress bar: visible only while cooking (has item + progress in-flight)
    const showRing = !!st.item && st.progress > 0 && st.progress < 1 && !st.onFire;
    if (ringGroupRef.current) ringGroupRef.current.visible = showRing;
    if (ringRef.current && showRing) {
      const p = st.progress;
      const BAR_W = 0.6;
      ringRef.current.scale.x = Math.max(0.001, p * BAR_W);
      ringRef.current.position.x = -((1 - p) * BAR_W) / 2;
      const m = ringRef.current.material as THREE.MeshStandardMaterial;
      m.color.set(p > 0.8 ? '#ffb74d' : '#7ed957');
      m.emissive.set(p > 0.8 ? '#ffb74d' : '#7ed957');
      m.emissiveIntensity = 0.75 + Math.sin(time * 6) * 0.15;
    }

    // pot contents visibility + color
    if (potContentRef.current) {
      const hasContent = !!st.item;
      potContentRef.current.visible = hasContent;
      if (hasContent && st.item) {
        const m = potContentRef.current.material as THREE.MeshStandardMaterial;
        if (st.item.stage === 'burnt') m.color.set(COL.burnt);
        else if (st.item.dish === 'soup' || st.item.ingredient === 'tomato') m.color.set(COL.soup);
        else if (st.item.ingredient === 'meat') m.color.set(COL.meatCooked);
        else m.color.set(COL.pasta);
        // gentle bubbling bob while cooking
        potContentRef.current.position.y = 0.62 + (st.progress > 0 && st.progress < 1 ? Math.sin(time * 8) * 0.01 : 0);
      }
    }

    // steam when cooked & waiting (progress complete, not burnt, not on fire)
    const cookedWaiting = !!st.item && st.progress >= 1 && st.item.stage === 'cooked' && !st.onFire;
    if (cookedWaiting && steamPool.current) {
      steamTimer.current -= dt;
      if (steamTimer.current <= 0) {
        steamTimer.current = 0.22;
        steamPool.current.emit({
          x: x + (Math.random() - 0.5) * 0.14,
          y: 0.85,
          z: z + (Math.random() - 0.5) * 0.14,
          vy: 0.55 + Math.random() * 0.2,
          vx: (Math.random() - 0.5) * 0.1,
          vz: (Math.random() - 0.5) * 0.1,
          life: 1.3,
          size: 0.14 + Math.random() * 0.06,
          color: '#f2f2f7',
        });
      }
    }

    // fire
    const onFire = st.onFire;
    if (flameRef.current) {
      flameRef.current.visible = onFire;
      if (onFire) {
        for (let i = 0; i < flameRef.current.children.length; i++) {
          const c = flameRef.current.children[i] as THREE.Mesh;
          const p = 0.8 + Math.sin(time * 14 + i * 2.1) * 0.35;
          c.scale.set(0.18 + i * 0.02, (0.4 + i * 0.05) * p, 0.18 + i * 0.02);
          c.position.y = 0.72 + (0.2 + i * 0.05) * p * 0.5;
        }
      }
    }
    if (fireLightRef.current) {
      fireLightRef.current.visible = onFire;
      if (onFire) fireLightRef.current.intensity = 2.4 + Math.sin(time * 18) * 1.1;
    }
    if (onFire && smokePool.current) {
      smokeTimer.current -= dt;
      if (smokeTimer.current <= 0) {
        smokeTimer.current = 0.12;
        smokePool.current.emit({
          x: x + (Math.random() - 0.5) * 0.2,
          y: 1.0,
          z: z + (Math.random() - 0.5) * 0.2,
          vy: 0.7 + Math.random() * 0.3,
          vx: (Math.random() - 0.5) * 0.25,
          vz: (Math.random() - 0.5) * 0.25,
          life: 1.6,
          size: 0.2 + Math.random() * 0.12,
          color: '#3a3a40',
        });
      }
    }
  });

  return (
    <group position={[x, 0, z]}>
      {/* enamel body */}
      <RoundedBox args={[TILE * 0.94, COUNTER_H, TILE * 0.94]} radius={0.1} smoothness={3} position={[0, COUNTER_H / 2, 0]} castShadow receiveShadow>
        <meshStandardMaterial color={COL.stoveBody} roughness={0.4} metalness={0.1} />
      </RoundedBox>
      {/* dark cooktop */}
      <RoundedBox args={[TILE * 0.8, 0.08, TILE * 0.8]} radius={0.04} smoothness={2} position={[0, COUNTER_H + 0.04, 0]} castShadow>
        <meshStandardMaterial color={COL.cooktop} roughness={0.3} metalness={0.5} />
      </RoundedBox>
      {/* burner ring */}
      <mesh geometry={GEO.torus} material={mat({ color: COL.stoveDark, rough: 0.5, metal: 0.4 })} rotation={[Math.PI / 2, 0, 0]} position={[0, COUNTER_H + 0.09, 0]} scale={[0.5, 0.5, 0.5]} />
      {/* dials on the front face */}
      {[-0.22, 0.22].map((dx, i) => (
        <mesh key={i} geometry={GEO.cylLow} material={mat({ color: COL.dial, rough: 0.4 })} position={[dx, COUNTER_H * 0.55, 0.47]} rotation={[Math.PI / 2, 0, 0]} scale={[0.09, 0.06, 0.09]} />
      ))}

      {/* steel pot */}
      <mesh geometry={GEO.cyl} material={mat({ color: COL.steel, rough: 0.3, metal: 0.6 })} position={[0, 0.5, 0]} scale={[0.5, 0.36, 0.5]} castShadow />
      {/* pot rim */}
      <mesh geometry={GEO.torus} material={mat({ color: COL.steelDark, rough: 0.3, metal: 0.7 })} rotation={[Math.PI / 2, 0, 0]} position={[0, 0.66, 0]} scale={[0.5, 0.5, 0.5]} />
      {/* stick handles */}
      {[-1, 1].map((s) => (
        <mesh key={s} geometry={GEO.cylLow} material={mat({ color: COL.steelDark, rough: 0.3, metal: 0.7 })} position={[s * 0.3, 0.58, 0]} rotation={[0, 0, Math.PI / 2]} scale={[0.05, 0.24, 0.05]} castShadow />
      ))}
      {/* pot contents (liquid disc) */}
      <mesh ref={potContentRef} geometry={GEO.cyl} position={[0, 0.62, 0]} scale={[0.44, 0.05, 0.44]} visible={false}>
        <meshStandardMaterial color={cookedContent.current} roughness={0.35} metalness={0.05} />
      </mesh>

      {/* progress bar floating above (billboard, Overcooked-style) */}
      <group ref={ringGroupRef} position={[0, 1.15, 0]} visible={false}>
        <Billboard>
          <mesh geometry={GEO.box} material={mat({ color: '#15151c', rough: 0.6, transparent: true, opacity: 0.85 })} scale={[0.68, 0.13, 0.04]} />
          <mesh ref={ringRef} geometry={GEO.box} position={[0, 0, 0.03]} scale={[0.001, 0.08, 0.04]}>
            <meshStandardMaterial color="#7ed957" emissive="#7ed957" emissiveIntensity={0.8} />
          </mesh>
        </Billboard>
      </group>

      {/* flames (hidden unless onFire) */}
      <group ref={flameRef} visible={false}>
        {[0, 1, 2, 3].map((i) => (
          <mesh key={i} geometry={GEO.cone} position={[(i - 1.5) * 0.12, 0.8, 0]} material={mat({ color: i % 2 ? COL.flameHot : COL.flame, emissive: COL.flame, emissiveIntensity: 1.4, transparent: true, opacity: 0.92 })} />
        ))}
      </group>
      <pointLight ref={fireLightRef} color={COL.flame} distance={4} intensity={0} position={[0, 1.0, 0]} visible={false} />

      {/* particle pools local to this stove */}
      <ParticlePool ref={steamPool} count={14} gravity={-0.2} drag={0.4} baseColor="#f2f2f7" />
      <ParticlePool ref={smokePool} count={18} gravity={-0.25} drag={0.35} baseColor="#3a3a40" />
    </group>
  );
}

// ── BOARD (dynamic) ──────────────────────────────────────────
function Board({ x, z, stationId, getState }: { x: number; z: number; stationId: number; getState: () => SimState }) {
  const knifeRef = useRef<THREE.Group>(null);
  const itemGroupRef = useRef<THREE.Group>(null);
  const rawRef = useRef<THREE.Group>(null);
  const choppedRef = useRef<THREE.Group>(null);

  useFrame(({ clock }) => {
    const st = getState().stations.find((s) => s.id === stationId);
    if (!st) return;
    const chopping = st.inUseBy != null && !!st.item && st.item.stage === 'raw';
    // knife chop animation
    if (knifeRef.current) {
      if (chopping) {
        knifeRef.current.visible = true;
        const chop = Math.abs(Math.sin(clock.elapsedTime * 10));
        knifeRef.current.position.y = COUNTER_H + 0.2 + chop * 0.14;
        knifeRef.current.rotation.z = 0.15 + chop * 0.5;
      } else {
        knifeRef.current.visible = false;
      }
    }
    // show item raw vs chopped
    if (itemGroupRef.current) itemGroupRef.current.visible = !!st.item;
    if (st.item) {
      const isChopped = st.item.stage === 'chopped';
      if (rawRef.current) rawRef.current.visible = !isChopped;
      if (choppedRef.current) choppedRef.current.visible = isChopped;
      // tint raw piece by ingredient
      if (rawRef.current && !isChopped) {
        const m = (rawRef.current.children[0] as THREE.Mesh)?.material as THREE.MeshStandardMaterial | undefined;
        if (m) m.color.set(st.item.ingredient === 'tomato' ? COL.tomato : st.item.ingredient === 'meat' ? COL.meat : COL.pasta);
      }
      if (choppedRef.current && isChopped) {
        choppedRef.current.children.forEach((c) => {
          const m = (c as THREE.Mesh).material as THREE.MeshStandardMaterial;
          m.color.set(st.item!.ingredient === 'tomato' ? COL.tomato : st.item!.ingredient === 'meat' ? COL.meat : COL.pasta);
        });
      }
    }
  });

  return (
    <group position={[x, 0, z]}>
      <CounterBodyStatic x={0} z={0} />
      {/* cutting board */}
      <RoundedBox args={[0.66, 0.06, 0.5]} radius={0.03} smoothness={2} position={[0, COUNTER_H + 0.13, 0]} castShadow>
        <meshStandardMaterial color={COL.board} roughness={0.75} />
      </RoundedBox>
      <mesh geometry={GEO.box} material={mat({ color: COL.boardEdge, rough: 0.8 })} position={[0, COUNTER_H + 0.1, 0]} scale={[0.7, 0.03, 0.54]} />

      {/* item on board */}
      <group ref={itemGroupRef} position={[-0.02, COUNTER_H + 0.19, 0]} visible={false}>
        <group ref={rawRef}>
          <mesh geometry={GEO.sphere} material={mat({ color: COL.tomato, rough: 0.55 })} scale={0.16} castShadow />
        </group>
        <group ref={choppedRef} visible={false}>
          {[[-0.09, 0, -0.04], [0.08, 0, 0.05], [0, 0, -0.07]].map((p, i) => (
            <mesh key={i} geometry={GEO.box} material={mat({ color: COL.tomato, rough: 0.55 })} position={p as [number, number, number]} rotation={[0, i, 0]} scale={[0.09, 0.05, 0.09]} castShadow />
          ))}
        </group>
      </group>

      {/* knife */}
      <group ref={knifeRef} position={[0.12, COUNTER_H + 0.22, 0.02]} visible={false}>
        <Knife scale={1} />
      </group>
    </group>
  );
}

// ── SERVE window (dynamic glow + delivery burst) ─────────────
function ServeWindow({ x, z, getState, isLeft }: { x: number; z: number; getState: () => SimState; isLeft: boolean }) {
  const glowRingRef = useRef<THREE.Mesh>(null);
  const burstPool = useRef<PoolHandle>(null);
  const conveyorDishRef = useRef<THREE.Group>(null);
  const lastServed = useRef(-1); // -1 = uninitialised; sync on first frame so we only burst on NEW serves
  const slideT = useRef(1); // 1 = parked (offscreen), animates 0→1 on serve

  useFrame(({ clock }, dt) => {
    const s = getState();
    const time = clock.elapsedTime;
    if (lastServed.current < 0) lastServed.current = s.served;
    if (glowRingRef.current) {
      // pulse the warm light spill instead of a floating hoop
      const m = glowRingRef.current.material as THREE.MeshStandardMaterial;
      m.emissiveIntensity = 1.0 + Math.sin(time * 2.5) * 0.25;
    }
    // detect a new serve (served count increment) — fire burst + conveyor slide
    if (s.served > lastServed.current) {
      lastServed.current = s.served;
      slideT.current = 0;
      if (burstPool.current) {
        for (let i = 0; i < 14; i++) {
          const ang = (i / 14) * Math.PI * 2;
          burstPool.current.emit({
            x, y: 1.1, z: z + 0.2,
            vx: Math.cos(ang) * 1.4,
            vy: 0.6 + Math.random() * 0.8,
            vz: Math.sin(ang) * 1.4,
            life: 0.9,
            size: 0.1,
            color: i % 2 ? COL.serveGlow : '#fff2cc',
            spin: 3,
          });
        }
      }
    }
    // conveyor dish slide-away
    if (conveyorDishRef.current) {
      if (slideT.current < 1) {
        slideT.current = Math.min(1, slideT.current + dt * 1.4);
        conveyorDishRef.current.visible = true;
        conveyorDishRef.current.position.z = z - 0.1 - slideT.current * 1.2;
        conveyorDishRef.current.position.y = COUNTER_H + 0.25;
        const sc = 1 - slideT.current * 0.6;
        conveyorDishRef.current.scale.setScalar(Math.max(0.001, sc));
      } else {
        conveyorDishRef.current.visible = false;
      }
    }
  });

  return (
    <group position={[x, 0, z]}>
      {/* hatch frame in the back wall */}
      <mesh geometry={GEO.box} material={mat({ color: COL.serveFrame, rough: 0.5, metal: 0.2 })} position={[0, 1.0, -0.42]} scale={[0.98, 1.4, 0.14]} castShadow />
      {/* dark opening */}
      <mesh geometry={GEO.box} material={mat({ color: '#120e08', rough: 1 })} position={[0, 1.0, -0.36]} scale={[0.74, 1.0, 0.06]} />
      {/* warm light spill (pulses via glowRingRef) */}
      <mesh ref={glowRingRef} geometry={GEO.plane} position={[0, 1.0, -0.32]} scale={[0.74, 1.0, 1]}>
        <meshStandardMaterial color={COL.serveGlow} emissive={COL.serveGlow} emissiveIntensity={1.1} transparent opacity={0.55} />
      </mesh>
      <pointLight color={COL.serveGlow} distance={5} intensity={2.2} position={[0, 1.0, 0.2]} />
      {/* serving sill counter */}
      <mesh geometry={GEO.box} material={mat({ color: COL.serveFrame, rough: 0.5 })} position={[0, COUNTER_H * 0.5, 0.1]} scale={[0.9, COUNTER_H, 0.7]} castShadow receiveShadow />
      {/* tiny conveyor stub */}
      <mesh geometry={GEO.box} material={mat({ color: COL.trashDark, rough: 0.5, metal: 0.4 })} position={[0, COUNTER_H + 0.12, -0.4]} scale={[0.5, 0.05, 0.9]} />
      {/* plated dish that slides away on serve */}
      <group ref={conveyorDishRef} visible={false}>
        <mesh geometry={GEO.cyl} material={mat({ color: COL.plate, rough: 0.4 })} scale={[0.34, 0.03, 0.34]} />
        <mesh geometry={GEO.sphere} material={mat({ color: COL.soup, rough: 0.5 })} position={[0, 0.07, 0]} scale={[0.2, 0.13, 0.2]} />
      </group>
      <ParticlePool ref={burstPool} count={16} gravity={1.6} drag={0.2} baseColor={COL.serveGlow} additive />
    </group>
  );
}

// ── back wall + splashback (static) ──────────────────────────
function BackWall() {
  const [, backZ] = tileToWorld(0, 0);
  const wallZ = backZ - 0.5; // behind row 0
  const tiles = useMemo(() => {
    const out: JSX.Element[] = [];
    for (let gx = 0; gx < GRID_W; gx++) {
      const [wx] = tileToWorld(gx, 0);
      const c = new THREE.Color(gx % 2 ? COL.wallTile : COL.wall);
      out.push(
        <mesh key={gx} geometry={GEO.box} position={[wx, 1.3, wallZ + 0.06]} scale={[0.94, 1.7, 0.05]}>
          <meshStandardMaterial color={c} roughness={0.7} />
        </mesh>,
      );
    }
    return out;
  }, [wallZ]);
  return (
    <group>
      {/* wall base slab */}
      <mesh geometry={GEO.box} material={mat({ color: COL.wallTrim, rough: 0.7 })} position={[0, 1.25, wallZ]} scale={[GRID_W * TILE + 0.4, 2.5, 0.18]} receiveShadow castShadow />
      {tiles}
      {/* top trim */}
      <mesh geometry={GEO.box} material={mat({ color: COL.wallTrim, rough: 0.6 })} position={[0, 2.45, wallZ + 0.04]} scale={[GRID_W * TILE + 0.5, 0.16, 0.2]} />
    </group>
  );
}

// ── The whole station system ─────────────────────────────────
export function Stations({ getState }: { getState: () => SimState }) {
  // Split layout into static tiles (built once) and dynamic station
  // ids. We match a grid tile to its Station by (x,y) from the initial
  // state so dynamic components can look themselves up each frame.
  const initial = useMemo(() => getState(), []); // snapshot for id mapping
  const stationAt = useMemo(() => {
    const map = new Map<string, Station>();
    for (const s of initial.stations) map.set(`${s.x},${s.y}`, s);
    return map;
  }, [initial]);

  const staticEls: JSX.Element[] = [];
  const dynamicEls: JSX.Element[] = [];

  for (let gy = 0; gy < GRID_H; gy++) {
    for (let gx = 0; gx < GRID_W; gx++) {
      const kind = KITCHEN_LAYOUT[gy][gx];
      const [x, z] = tileToWorld(gx, gy);
      const key = `${gx},${gy}`;
      const st = stationAt.get(key);
      switch (kind) {
        case T.COUNTER: {
          const hue = (hash2(gx, gy) - 0.5) * 0.06;
          staticEls.push(<CounterBody key={key} x={x} z={z} hueShift={hue} />);
          break;
        }
        case T.CRATE_TOMATO:
        case T.CRATE_MEAT:
        case T.CRATE_PASTA:
          staticEls.push(<Crate key={key} x={x} z={z} kind={kind} />);
          break;
        case T.PLATES:
          staticEls.push(<PlateStack key={key} x={x} z={z} />);
          break;
        case T.TRASH:
          staticEls.push(<Trash key={key} x={x} z={z} />);
          break;
        case T.STOVE:
          if (st) dynamicEls.push(<Stove key={key} x={x} z={z} stationId={st.id} getState={getState} />);
          else staticEls.push(<CounterBodyStatic key={key} x={x} z={z} />);
          break;
        case T.BOARD:
          if (st) dynamicEls.push(<Board key={key} x={x} z={z} stationId={st.id} getState={getState} />);
          else staticEls.push(<CounterBodyStatic key={key} x={x} z={z} />);
          break;
        case T.SERVE:
          dynamicEls.push(<ServeWindow key={key} x={x} z={z} getState={getState} isLeft={gx < GRID_W / 2} />);
          break;
        default:
          break; // floor
      }
    }
  }

  return (
    <group>
      <BackWall />
      <group>{staticEls}</group>
      <group>{dynamicEls}</group>
    </group>
  );
}
