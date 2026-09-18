'use client';
// ─────────────────────────────────────────────────────────────
// JEV'S KITCHEN CHAOS 3D — scene entry point.
//
//   export function KitchenScene({ getState }: { getState: () => SimState })
//
// Mounted INSIDE a <Canvas> by page.tsx (do not render Canvas here).
// Owns the camera, lights, idle sway, and composes the floor, the
// station system, and the chefs. All animation reads getState() inside
// useFrame — this component never calls setState per frame.
// ─────────────────────────────────────────────────────────────
import { useRef } from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';
import { PerspectiveCamera } from '@react-three/drei';
import type { SimState } from '@/game/types';
import { COL } from './palette';
import { Floor } from './Floor';
import { Stations } from './Stations';
import { Chef } from './Chef';

const CAM_BASE = new THREE.Vector3(0, 13.2, 7.4);
const LOOK_AT = new THREE.Vector3(0, 0, -0.7);

function Rig() {
  const camRef = useRef<THREE.PerspectiveCamera>(null);
  const { set } = useThree();
  useFrame(({ clock }) => {
    const cam = camRef.current;
    if (!cam) return;
    const t = clock.elapsedTime;
    // extremely subtle idle sway (±0.15 drift, slow)
    cam.position.x = CAM_BASE.x + Math.sin(t * 0.22) * 0.15;
    cam.position.y = CAM_BASE.y + Math.sin(t * 0.17 + 1.3) * 0.08;
    cam.position.z = CAM_BASE.z + Math.cos(t * 0.19) * 0.1;
    cam.lookAt(LOOK_AT);
  });
  return (
    <PerspectiveCamera
      ref={camRef}
      makeDefault
      fov={38}
      near={0.5}
      far={100}
      position={[CAM_BASE.x, CAM_BASE.y, CAM_BASE.z]}
      onUpdate={(c) => {
        c.lookAt(LOOK_AT);
        set({ camera: c });
      }}
    />
  );
}

function Lights() {
  const keyRef = useRef<THREE.DirectionalLight>(null);
  return (
    <group>
      {/* warm ambient base */}
      <ambientLight color="#fff2dd" intensity={0.7} />
      <hemisphereLight color="#fff3e0" groundColor="#3a2a1a" intensity={0.55} />

      {/* main warm key with soft shadows */}
      <directionalLight
        ref={keyRef}
        color="#fff0d0"
        intensity={1.55}
        position={[7, 12, 6]}
        castShadow
        shadow-mapSize-width={2048}
        shadow-mapSize-height={2048}
        shadow-camera-near={1}
        shadow-camera-far={40}
        shadow-camera-left={-11}
        shadow-camera-right={11}
        shadow-camera-top={9}
        shadow-camera-bottom={-9}
        shadow-bias={-0.0004}
        shadow-normalBias={0.02}
      />

      {/* cool blue-ish fill from opposite side (no shadow) */}
      <directionalLight color="#8fb8ff" intensity={0.55} position={[-8, 6, -5]} />

      {/* soft top-down bounce to keep faces readable */}
      <directionalLight color="#ffffff" intensity={0.25} position={[0, 14, 2]} />
    </group>
  );
}

export function KitchenScene({ getState }: { getState: () => SimState }) {
  // Snapshot chef ids once; the number of chefs is fixed (0..3 → P1..P4).
  const chefIds = getState().chefs.map((c) => c.id);

  return (
    <>
      <Rig />
      <Lights />

      {/* static diorama */}
      <Floor />

      {/* stations (static bodies + dynamic stoves/boards/serve) */}
      <Stations getState={getState} />

      {/* the stars */}
      {chefIds.map((id) => (
        <Chef key={id} chefId={id} getState={getState} />
      ))}
    </>
  );
}

export default KitchenScene;
