'use client';
// ─────────────────────────────────────────────────────────────
// Small reusable food/prop geometry: raw & chopped ingredients,
// plated dishes, knives. Used by crates, boards, stoves, and chefs'
// carried items so a tomato always looks like the same tomato.
// ─────────────────────────────────────────────────────────────
import { GEO, COL, mat } from './palette';
import type { Item, Ingredient, DishId } from '@/game/types';

// ── raw ingredient blobs ─────────────────────────────────────
export function Tomato({ scale = 1 }: { scale?: number }) {
  return (
    <group scale={scale}>
      <mesh geometry={GEO.sphere} material={mat({ color: COL.tomato, rough: 0.5 })} scale={0.16} castShadow />
      <mesh geometry={GEO.sphere} material={mat({ color: COL.tomatoStem })} position={[0, 0.09, 0]} scale={0.04} />
    </group>
  );
}

export function MeatSlab({ cooked = false, scale = 1 }: { cooked?: boolean; scale?: number }) {
  return (
    <mesh
      geometry={GEO.box}
      material={mat({ color: cooked ? COL.meatCooked : COL.meat, rough: 0.6 })}
      scale={[0.24 * scale, 0.09 * scale, 0.2 * scale]}
      castShadow
    />
  );
}

export function PastaBundle({ scale = 1 }: { scale?: number }) {
  return (
    <group scale={scale}>
      {[-0.05, 0, 0.05].map((dx, i) => (
        <mesh
          key={i}
          geometry={GEO.cylLow}
          material={mat({ color: COL.pasta, rough: 0.7 })}
          position={[dx, 0, (i - 1) * 0.02]}
          rotation={[0, 0, Math.PI / 2]}
          scale={[0.03, 0.26, 0.03]}
          castShadow
        />
      ))}
    </group>
  );
}

/** Chopped = 2–3 smaller pieces spread out. */
export function Chopped({ ingredient, scale = 1 }: { ingredient: Ingredient; scale?: number }) {
  const color =
    ingredient === 'tomato' ? COL.tomato : ingredient === 'meat' ? COL.meat : COL.pasta;
  const offs: [number, number, number][] = [
    [-0.07, 0, -0.03],
    [0.06, 0, 0.04],
    [0.0, 0, -0.06],
  ];
  return (
    <group scale={scale}>
      {offs.map((p, i) => (
        <mesh
          key={i}
          geometry={GEO.box}
          material={mat({ color, rough: 0.55 })}
          position={p}
          rotation={[0, i * 1.2, 0]}
          scale={[0.09, 0.05, 0.09]}
          castShadow
        />
      ))}
    </group>
  );
}

/** A plated dish: white plate + a food blob on top; burnt = charred. */
export function PlatedDish({ item, scale = 1 }: { item: Item; scale?: number }) {
  const burnt = item.stage === 'burnt';
  const foodColor = burnt
    ? COL.burnt
    : item.dish === 'soup'
      ? COL.soup
      : item.ingredient === 'tomato'
        ? COL.tomato
        : item.ingredient === 'meat'
          ? COL.meatCooked
          : COL.pasta;
  return (
    <group scale={scale}>
      <mesh geometry={GEO.cyl} material={mat({ color: COL.plate, rough: 0.4 })} scale={[0.34, 0.03, 0.34]} castShadow />
      <mesh geometry={GEO.cyl} material={mat({ color: COL.plateEdge, rough: 0.4 })} position={[0, 0.02, 0]} scale={[0.4, 0.02, 0.4]} />
      <mesh
        geometry={GEO.sphere}
        material={mat({ color: foodColor, rough: burnt ? 0.95 : 0.55 })}
        position={[0, 0.07, 0]}
        scale={[0.22, 0.14, 0.22]}
        castShadow
      />
    </group>
  );
}

/** Generic dispatcher: render whatever an Item currently looks like. */
export function ItemMesh({ item, scale = 1 }: { item: Item; scale?: number }) {
  if (item.stage === 'plated') return <PlatedDish item={item} scale={scale} />;
  if (item.stage === 'burnt') {
    return (
      <mesh geometry={GEO.sphere} material={mat({ color: COL.burnt, rough: 0.98 })} scale={0.16 * scale} castShadow />
    );
  }
  if (item.stage === 'chopped') return <Chopped ingredient={item.ingredient} scale={scale} />;
  // raw / cooked whole
  if (item.ingredient === 'tomato') return <Tomato scale={scale} />;
  if (item.ingredient === 'meat') return <MeatSlab cooked={item.stage === 'cooked'} scale={scale} />;
  return <PastaBundle scale={scale} />;
}

export function Knife({ scale = 1 }: { scale?: number }) {
  return (
    <group scale={scale} rotation={[0, 0, 0.15]}>
      {/* blade */}
      <mesh geometry={GEO.box} material={mat({ color: COL.knife, rough: 0.25, metal: 0.6 })} position={[0, 0.02, 0]} scale={[0.28, 0.02, 0.09]} castShadow />
      {/* handle */}
      <mesh geometry={GEO.box} material={mat({ color: COL.knifeHandle, rough: 0.6 })} position={[-0.19, 0.02, 0]} scale={[0.12, 0.05, 0.06]} castShadow />
    </group>
  );
}

export type { DishId };
