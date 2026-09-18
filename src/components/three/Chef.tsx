'use client';
// ─────────────────────────────────────────────────────────────
// A Chef Jev blob — the star of the show. Round two-tone body, chef
// hat, expressive eyes/mouth, stubby arms, blob shadow, floating
// name chip. All motion driven from getState() in useFrame; the
// visual position lerps toward the sim position to kill jitter.
// ─────────────────────────────────────────────────────────────
import { useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { Text, Billboard } from '@react-three/drei';
import type { SimState, Chef as ChefT, ChefAction } from '@/game/types';
import { COL, GEO, mat, tileToWorld } from './palette';
import { ParticlePool, type PoolHandle } from './Particles';
import type { Item } from '@/game/types';

const BODY_Y = 0.34;      // body centre height above floor
const HAT_Y = 0.66;

// Mouth shapes are three tiny meshes we toggle: neutral, open (O), happy arc.
export function Chef({ chefId, getState }: { chefId: number; getState: () => SimState }) {
  const root = useRef<THREE.Group>(null);
  const bodyTilt = useRef<THREE.Group>(null);      // lean/waddle
  const bodyScale = useRef<THREE.Group>(null);      // squash/stretch
  const leftArm = useRef<THREE.Mesh>(null);
  const rightArm = useRef<THREE.Mesh>(null);
  const eyesGroup = useRef<THREE.Group>(null);
  const eyeL = useRef<THREE.Mesh>(null);
  const eyeR = useRef<THREE.Mesh>(null);
  const happyL = useRef<THREE.Mesh>(null);
  const happyR = useRef<THREE.Mesh>(null);
  const mouthNeutral = useRef<THREE.Mesh>(null);
  const mouthOpen = useRef<THREE.Mesh>(null);
  const mouthHappy = useRef<THREE.Mesh>(null);
  const carryGroup = useRef<THREE.Group>(null);
  const shadowRef = useRef<THREE.Mesh>(null);
  const bangRef = useRef<THREE.Group>(null); // "!" chip
  const confetti = useRef<PoolHandle>(null);
  const spray = useRef<PoolHandle>(null);

  // interpolated visual state
  const vis = useRef({ x: 0, z: 0, rot: 0, init: false });
  const confettiTimer = useRef(0);
  const sprayTimer = useRef(0);

  const chef0 = useMemo(() => getState().chefs.find((c) => c.id === chefId), [chefId]);
  const accent = chef0?.accent ?? '#ff4d5e';
  const accentColor = useMemo(() => new THREE.Color(accent), [accent]);
  const bellyColor = useMemo(() => new THREE.Color(accent).offsetHSL(0, -0.15, 0.22), [accent]);

  useFrame(({ clock }, dtRaw) => {
    const dt = Math.min(dtRaw, 0.05);
    const chef = getState().chefs.find((c) => c.id === chefId);
    if (!chef || !root.current) return;
    const time = clock.elapsedTime;
    const [tx, tz] = tileToWorld(chef.x, chef.y);

    // ── smooth position ──
    if (!vis.current.init) {
      vis.current.x = tx; vis.current.z = tz; vis.current.init = true;
    }
    const k = 1 - Math.pow(0.001, dt); // ~frame-rate independent lerp
    vis.current.x += (tx - vis.current.x) * k;
    vis.current.z += (tz - vis.current.z) * k;
    root.current.position.x = vis.current.x;
    root.current.position.z = vis.current.z;

    // ── facing ──
    const fx = chef.facing?.x ?? 0;
    const fz = chef.facing?.y ?? 1;
    if (Math.abs(fx) > 0.01 || Math.abs(fz) > 0.01) {
      const targetRot = Math.atan2(fx, fz);
      let d = targetRot - vis.current.rot;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      vis.current.rot += d * Math.min(1, dt * 10);
    }
    root.current.rotation.y = vis.current.rot;

    const a = chef.action as ChefAction;
    const moving = a === 'walking' || a === 'delivering';
    const inputMag = Math.hypot(chef.inputDir?.x ?? 0, chef.inputDir?.y ?? 0);

    // ── defaults each frame (reset transforms) ──
    let bobY = 0;
    let squashY = 1;
    let squashXZ = 1;
    let tilt = 0;
    let roll = 0;
    let leanZ = 0;
    let armSwing = 0;

    // ── per-action animation ──
    switch (a) {
      case 'walking': {
        const stride = time * 11;
        bobY = Math.abs(Math.sin(stride)) * 0.06;
        roll = Math.sin(stride) * 0.12;        // waddle
        leanZ = 0.14 * Math.min(1, inputMag + 0.4);
        armSwing = Math.sin(stride) * 0.5;
        break;
      }
      case 'delivering': {
        const stride = time * 8;
        bobY = Math.abs(Math.sin(stride)) * 0.04;
        leanZ = -0.06; // proud upright
        armSwing = Math.sin(stride) * 0.3;
        break;
      }
      case 'chopping': {
        const chop = Math.abs(Math.sin(time * 12));
        bobY = -chop * 0.08;
        squashY = 1 - chop * 0.1;
        squashXZ = 1 + chop * 0.06;
        armSwing = chop * 1.2;
        leanZ = 0.18;
        break;
      }
      case 'stirring': {
        tilt = Math.sin(time * 6) * 0.12;
        roll = Math.cos(time * 6) * 0.12;
        leanZ = 0.12;
        armSwing = Math.sin(time * 6) * 0.6;
        break;
      }
      case 'grabbing':
      case 'plating': {
        const dip = Math.abs(Math.sin(time * 5));
        leanZ = 0.24 + dip * 0.06;
        bobY = -dip * 0.05;
        armSwing = dip * 0.8;
        break;
      }
      case 'extinguishing': {
        leanZ = 0.3;
        tilt = Math.sin(time * 20) * 0.03;
        armSwing = 0.6 + Math.sin(time * 14) * 0.4;
        break;
      }
      case 'celebrating': {
        const jump = Math.abs(Math.sin(time * 4.5));
        bobY = jump * 0.28;
        squashY = 1 + jump * 0.12;
        squashXZ = 1 - jump * 0.06;
        armSwing = -1.0 - jump * 0.4; // arms up
        break;
      }
      case 'panicking': {
        const shiver = Math.sin(time * 40);
        root.current.position.x += shiver * 0.015;
        root.current.position.z += Math.cos(time * 37) * 0.015;
        bobY = Math.abs(Math.sin(time * 20)) * 0.05;
        squashY = 1 + Math.sin(time * 20) * 0.05;
        armSwing = Math.sin(time * 30) * 0.8;
        break;
      }
      default: {
        // idle breathing
        bobY = Math.sin(time * 2) * 0.02;
        squashY = 1 + Math.sin(time * 2) * 0.02;
      }
    }

    // ── apply body transforms ──
    root.current.position.y = bobY;
    if (bodyScale.current) bodyScale.current.scale.set(squashXZ, 0.92 * squashY, squashXZ);
    if (bodyTilt.current) {
      bodyTilt.current.rotation.x = leanZ + tilt;
      bodyTilt.current.rotation.z = roll;
    }
    if (leftArm.current) leftArm.current.rotation.x = armSwing;
    if (rightArm.current) rightArm.current.rotation.x = -armSwing;

    // ── face expressions ──
    const panic = a === 'panicking';
    const celebrate = a === 'celebrating';
    // eyes: happy closed arcs when celebrating, wide when panicking, normal otherwise
    if (eyeL.current && eyeR.current && happyL.current && happyR.current) {
      const showHappy = celebrate;
      eyeL.current.visible = !showHappy;
      eyeR.current.visible = !showHappy;
      happyL.current.visible = showHappy;
      happyR.current.visible = showHappy;
      const wide = panic ? 1.35 : 1;
      eyeL.current.scale.setScalar(0.05 * wide);
      eyeR.current.scale.setScalar(0.05 * wide);
    }
    if (mouthNeutral.current && mouthOpen.current && mouthHappy.current) {
      mouthNeutral.current.visible = !panic && !celebrate;
      mouthOpen.current.visible = panic;
      mouthHappy.current.visible = celebrate;
    }

    // ── "!" chip when panicking ──
    if (bangRef.current) {
      bangRef.current.visible = panic;
      if (panic) bangRef.current.position.y = 1.05 + Math.abs(Math.sin(time * 12)) * 0.06;
    }

    // ── blob shadow (stays flat on floor, scales with jump) ──
    if (shadowRef.current) {
      const shrink = 1 - Math.min(0.4, bobY * 1.2);
      shadowRef.current.scale.set(0.42 * shrink, 0.42 * shrink, 1);
    }

    // ── carried item floats at chest, in front ──
    if (carryGroup.current) {
      carryGroup.current.visible = !!chef.carrying;
      if (chef.carrying) {
        carryGroup.current.position.y = 0.5 + Math.sin(time * 3) * 0.02;
      }
    }

    // ── confetti on celebrate ──
    if (celebrate && confetti.current) {
      confettiTimer.current -= dt;
      if (confettiTimer.current <= 0) {
        confettiTimer.current = 0.08;
        for (let i = 0; i < 2; i++) {
          confetti.current.emit({
            x: vis.current.x + (Math.random() - 0.5) * 0.4,
            y: 1.0,
            z: vis.current.z + (Math.random() - 0.5) * 0.4,
            vx: (Math.random() - 0.5) * 1.6,
            vy: 0.9 + Math.random() * 0.5,
            vz: (Math.random() - 0.5) * 1.6,
            life: 0.85,
            size: 0.07,
            color: accentColor,
            spin: 5,
          });
        }
      }
    }
    // ── white spray on extinguish ──
    if (a === 'extinguishing' && spray.current) {
      sprayTimer.current -= dt;
      if (sprayTimer.current <= 0) {
        sprayTimer.current = 0.05;
        const dirx = Math.sin(vis.current.rot);
        const dirz = Math.cos(vis.current.rot);
        for (let i = 0; i < 2; i++) {
          spray.current.emit({
            x: vis.current.x + dirx * 0.3,
            y: 0.5,
            z: vis.current.z + dirz * 0.3,
            vx: dirx * 1.8 + (Math.random() - 0.5) * 0.5,
            vy: 0.3 + Math.random() * 0.3,
            vz: dirz * 1.8 + (Math.random() - 0.5) * 0.5,
            life: 0.5,
            size: 0.08,
            color: '#eef4ff',
          });
        }
      }
    }
  });

  const startPos = useMemo<[number, number, number]>(() => {
    const c = getState().chefs.find((ch) => ch.id === chefId);
    if (!c) return [0, 0, 0];
    const [x, z] = tileToWorld(c.x, c.y);
    return [x, 0, z];
  }, [chefId]);

  return (
    <group ref={root} position={startPos}>
      {/* blob shadow */}
      <mesh ref={shadowRef} geometry={GEO.disc} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.11, 0]} renderOrder={1}>
        <meshBasicMaterial color="#000000" transparent opacity={0.28} depthWrite={false} />
      </mesh>

      {/* tilt/lean wrapper */}
      <group ref={bodyTilt} position={[0, BODY_Y, 0]}>
        {/* squash/stretch wrapper */}
        <group ref={bodyScale}>
          {/* body */}
          <mesh geometry={GEO.sphere} scale={[0.62, 0.62, 0.62]} castShadow receiveShadow>
            <meshStandardMaterial color={accentColor} roughness={0.55} metalness={0.02} />
          </mesh>
          {/* lighter belly (front half-sphere) */}
          <mesh geometry={GEO.halfSphere} rotation={[Math.PI / 2, 0, 0]} position={[0, -0.02, 0.02]} scale={[0.5, 0.42, 0.5]}>
            <meshStandardMaterial color={bellyColor} roughness={0.6} />
          </mesh>

          {/* eyes (normal) */}
          <group ref={eyesGroup} position={[0, 0.08, 0.28]}>
            <mesh position={[-0.13, 0, 0]} scale={0.09}>
              <sphereGeometry args={[0.5, 12, 10]} />
              <meshStandardMaterial color={COL.eyeWhite} roughness={0.3} />
            </mesh>
            <mesh position={[0.13, 0, 0]} scale={0.09}>
              <sphereGeometry args={[0.5, 12, 10]} />
              <meshStandardMaterial color={COL.eyeWhite} roughness={0.3} />
            </mesh>
            {/* pupils */}
            <mesh ref={eyeL} position={[-0.13, 0, 0.06]} scale={0.05}>
              <sphereGeometry args={[0.5, 8, 8]} />
              <meshStandardMaterial color={COL.pupil} />
            </mesh>
            <mesh ref={eyeR} position={[0.13, 0, 0.06]} scale={0.05}>
              <sphereGeometry args={[0.5, 8, 8]} />
              <meshStandardMaterial color={COL.pupil} />
            </mesh>
            {/* happy closed-arc eyes (torus arcs) */}
            <mesh ref={happyL} position={[-0.13, 0.01, 0.05]} rotation={[0, 0, 0]} scale={0.07} visible={false}>
              <torusGeometry args={[0.5, 0.12, 8, 16, Math.PI]} />
              <meshStandardMaterial color={COL.pupil} />
            </mesh>
            <mesh ref={happyR} position={[0.13, 0.01, 0.05]} rotation={[0, 0, 0]} scale={0.07} visible={false}>
              <torusGeometry args={[0.5, 0.12, 8, 16, Math.PI]} />
              <meshStandardMaterial color={COL.pupil} />
            </mesh>
          </group>

          {/* mouths */}
          <mesh ref={mouthNeutral} position={[0, -0.06, 0.34]} scale={[0.08, 0.02, 0.02]}>
            <boxGeometry args={[1, 1, 1]} />
            <meshStandardMaterial color={COL.pupil} />
          </mesh>
          <mesh ref={mouthOpen} position={[0, -0.08, 0.33]} scale={0.06} visible={false}>
            <sphereGeometry args={[0.5, 10, 10]} />
            <meshStandardMaterial color="#5a1e22" />
          </mesh>
          <mesh ref={mouthHappy} position={[0, -0.05, 0.33]} rotation={[0, 0, Math.PI]} scale={0.08} visible={false}>
            <torusGeometry args={[0.5, 0.18, 8, 16, Math.PI]} />
            <meshStandardMaterial color={COL.pupil} />
          </mesh>

          {/* chef hat */}
          <group position={[0, HAT_Y - BODY_Y, 0]}>
            <mesh geometry={GEO.cyl} position={[0, -0.02, 0]} scale={[0.34, 0.18, 0.34]} castShadow>
              <meshStandardMaterial color={COL.hatBand} roughness={0.6} />
            </mesh>
            <mesh geometry={GEO.sphere} position={[0, 0.14, 0]} scale={[0.4, 0.36, 0.4]} castShadow>
              <meshStandardMaterial color={COL.hat} roughness={0.65} />
            </mesh>
            <mesh geometry={GEO.sphere} position={[-0.18, 0.1, 0.06]} scale={0.16}>
              <meshStandardMaterial color={COL.hat} roughness={0.65} />
            </mesh>
            <mesh geometry={GEO.sphere} position={[0.18, 0.1, -0.04]} scale={0.16}>
              <meshStandardMaterial color={COL.hat} roughness={0.65} />
            </mesh>
          </group>

          {/* stubby arms */}
          <mesh ref={leftArm} geometry={GEO.sphere} position={[-0.5, -0.06, 0]} scale={0.17} castShadow>
            <meshStandardMaterial color={accentColor} roughness={0.55} />
          </mesh>
          <mesh ref={rightArm} geometry={GEO.sphere} position={[0.5, -0.06, 0]} scale={0.17} castShadow>
            <meshStandardMaterial color={accentColor} roughness={0.55} />
          </mesh>
        </group>
      </group>

      {/* carried item, in front at chest height */}
      <group ref={carryGroup} position={[0, 0.5, 0.5]} visible={false}>
        <CarriedItemInner chefId={chefId} getState={getState} />
      </group>

      {/* "!" panic chip */}
      <Billboard>
        <group ref={bangRef} position={[0, 1.05, 0]} visible={false}>
          <mesh geometry={GEO.cyl} material={mat({ color: '#ffd23d', emissive: '#ffb300', emissiveIntensity: 0.6 })} rotation={[Math.PI / 2, 0, 0]} scale={[0.16, 0.05, 0.16]} />
          <Text position={[0, 0, 0.06]} fontSize={0.22} color="#7a1010" anchorX="center" anchorY="middle" fontWeight="bold">
            !
          </Text>
        </group>
      </Billboard>

      {/* name chip above head, always facing camera */}
      <Billboard position={[0, 1.28, 0]}>
        <mesh geometry={GEO.plane} scale={[1.0, 0.28, 1]} position={[0, 0, -0.01]}>
          <meshBasicMaterial color="#0d0d12" transparent opacity={0.72} depthWrite={false} />
        </mesh>
        <mesh geometry={GEO.plane} scale={[1.04, 0.05, 1]} position={[0, -0.15, 0]}>
          <meshBasicMaterial color={accentColor} transparent opacity={0.9} depthWrite={false} />
        </mesh>
        <Text fontSize={0.15} color="#ffffff" anchorX="center" anchorY="middle" outlineWidth={0.006} outlineColor="#000" maxWidth={1.2}>
          {`P${chefId + 1} ${chef0?.name ?? ''}`}
        </Text>
      </Billboard>

      {/* per-chef particle pools */}
      <ParticlePool ref={confetti} count={24} gravity={2.4} drag={0.15} baseColor={accent} />
      <ParticlePool ref={spray} count={16} gravity={0.4} drag={0.5} baseColor="#eef4ff" />
    </group>
  );
}

// Renders whatever the chef currently carries. To avoid per-frame React
// churn we imperatively rebuild the item group only when the carried
// item's identity actually changes.
function CarriedItemInner({ chefId, getState }: { chefId: number; getState: () => SimState }) {
  const ref = useRef<THREE.Group>(null);
  const current = useRef<string>('');
  useFrame(() => {
    const chef = getState().chefs.find((c) => c.id === chefId);
    const carrying = chef?.carrying ?? null;
    const key = carrying ? `${carrying.ingredient}:${carrying.stage}:${carrying.dish ?? ''}` : '';
    if (key === current.current || !ref.current) return;
    current.current = key;
    ref.current.clear();
    if (carrying) {
      ref.current.add(buildItemObject(carrying));
    }
  });
  return <group ref={ref} />;
}

// Build a plain THREE.Group for an item (imperative, no React) so we can
// swap carried items without per-frame re-renders.
function buildItemObject(item: Item): THREE.Group {
  const g = new THREE.Group();
  const add = (geo: THREE.BufferGeometry, color: string, pos: [number, number, number], scale: [number, number, number] | number, rough = 0.6) => {
    const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color, roughness: rough }));
    m.position.set(...pos);
    if (typeof scale === 'number') m.scale.setScalar(scale);
    else m.scale.set(...scale);
    m.castShadow = true;
    g.add(m);
  };
  if (item.stage === 'plated') {
    add(GEO.cyl, COL.plate, [0, 0, 0], [0.32, 0.04, 0.32], 0.4);
    const food = item.stage === 'plated' && item.dish === 'soup' ? COL.soup
      : item.ingredient === 'tomato' ? COL.tomato
      : item.ingredient === 'meat' ? COL.meatCooked : COL.pasta;
    add(GEO.sphere, food, [0, 0.08, 0], [0.2, 0.13, 0.2], 0.5);
  } else if (item.stage === 'burnt') {
    add(GEO.sphere, COL.burnt, [0, 0, 0], 0.16, 0.98);
  } else if (item.stage === 'chopped') {
    const c = item.ingredient === 'tomato' ? COL.tomato : item.ingredient === 'meat' ? COL.meat : COL.pasta;
    add(GEO.box, c, [-0.06, 0, -0.03], [0.09, 0.05, 0.09]);
    add(GEO.box, c, [0.06, 0, 0.03], [0.09, 0.05, 0.09]);
    add(GEO.box, c, [0, 0.02, 0.05], [0.08, 0.05, 0.08]);
  } else if (item.ingredient === 'tomato') {
    add(GEO.sphere, COL.tomato, [0, 0, 0], 0.16, 0.5);
    add(GEO.sphere, COL.tomatoStem, [0, 0.09, 0], 0.04);
  } else if (item.ingredient === 'meat') {
    add(GEO.box, item.stage === 'cooked' ? COL.meatCooked : COL.meat, [0, 0, 0], [0.24, 0.09, 0.2]);
  } else {
    // pasta bundle
    for (let i = -1; i <= 1; i++) {
      const m = new THREE.Mesh(GEO.cylLow, new THREE.MeshStandardMaterial({ color: COL.pasta, roughness: 0.7 }));
      m.position.set(i * 0.05, 0, 0);
      m.rotation.z = Math.PI / 2;
      m.scale.set(0.03, 0.26, 0.03);
      m.castShadow = true;
      g.add(m);
    }
  }
  return g;
}
