'use client';
// ─────────────────────────────────────────────────────────────
// Small reusable food/prop geometry: raw & chopped ingredients,
// plated dishes, knives. Used by crates, boards, stoves, and chefs'
// carried items so a tomato always looks like the same tomato.
// ─────────────────────────────────────────────────────────────
import * as THREE from 'three';
import { GEO, COL, mat } from './palette';
import type { Item, Ingredient, ItemStage, DishId } from '@/game/types';

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

/** Burger bun: flat cylinder base + squashed dome top with a lighter sheen. */
export function Bun({ scale = 1 }: { scale?: number }) {
  return (
    <group scale={scale}>
      {/* flat base */}
      <mesh geometry={GEO.cyl} material={mat({ color: COL.bunBase, rough: 0.7 })} position={[0, 0, 0]} scale={[0.2, 0.05, 0.2]} castShadow />
      {/* domed top */}
      <mesh geometry={GEO.halfSphere} material={mat({ color: COL.bun, rough: 0.6 })} rotation={[Math.PI / 2, 0, 0]} position={[0, 0.05, 0]} scale={[0.21, 0.16, 0.21]} castShadow />
      {/* sheen highlight */}
      <mesh geometry={GEO.sphere} material={mat({ color: COL.bunSheen, rough: 0.4 })} position={[-0.05, 0.13, 0.04]} scale={0.05} />
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

/**
 * A compact "ready component" — one prepared part of a dish sitting on a
 * plate/assembly (chopped tomato, grilled patty, boiled pasta, bun, seared
 * steak, tomato base). Small footprint so several can stack appealingly.
 * Rendered by both the JSX path (below) and the imperative assembly builder.
 */
export function ReadyComponent({
  ingredient,
  stage,
  scale = 1,
}: {
  ingredient: Ingredient;
  stage: ItemStage;
  scale?: number;
}) {
  return <group scale={scale}>{readyComponentMeshes(ingredient, stage)}</group>;
}

// Shared shape spec for a ready component. Returns JSX; the imperative
// builder (buildReadyComponent) mirrors these exact shapes.
function readyComponentMeshes(ingredient: Ingredient, stage: ItemStage): JSX.Element[] {
  // Bun — golden dome + base.
  if (ingredient === 'bun') {
    return [
      <mesh key="b" geometry={GEO.cyl} material={mat({ color: COL.bunBase, rough: 0.7 })} scale={[0.18, 0.045, 0.18]} castShadow />,
      <mesh key="t" geometry={GEO.halfSphere} material={mat({ color: COL.bun, rough: 0.6 })} rotation={[Math.PI / 2, 0, 0]} position={[0, 0.045, 0]} scale={[0.19, 0.14, 0.19]} castShadow />,
    ];
  }
  // Meat cooked = dark seared slab; meat chopped = grilled patty (dark disc).
  if (ingredient === 'meat') {
    if (stage === 'chopped') {
      // grilled patty: thick dark seared disc
      return [
        <mesh key="p" geometry={GEO.cyl} material={mat({ color: COL.patty, rough: 0.65 })} scale={[0.17, 0.06, 0.17]} castShadow />,
        <mesh key="s" geometry={GEO.cyl} material={mat({ color: COL.pattySear, rough: 0.5 })} position={[0, 0.035, 0]} scale={[0.15, 0.02, 0.15]} />,
      ];
    }
    // seared steak slab
    return [
      <mesh key="m" geometry={GEO.box} material={mat({ color: COL.meatCooked, rough: 0.6 })} scale={[0.26, 0.07, 0.2]} castShadow />,
      <mesh key="c" geometry={GEO.box} material={mat({ color: COL.pattySear, rough: 0.5 })} position={[0, 0.04, 0]} scale={[0.22, 0.02, 0.16]} />,
    ];
  }
  // Pasta cooked = pale boiled nest.
  if (ingredient === 'pasta') {
    const strands: JSX.Element[] = [];
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2;
      strands.push(
        <mesh
          key={i}
          geometry={GEO.torus}
          material={mat({ color: COL.pastaCooked, rough: 0.55 })}
          rotation={[Math.PI / 2, 0, a]}
          position={[Math.cos(a) * 0.03, 0.02 + (i % 2) * 0.02, Math.sin(a) * 0.03]}
          scale={[0.14, 0.14, 0.05]}
          castShadow
        />,
      );
    }
    return strands;
  }
  // Tomato — chopped diced pieces, or a whole tomato base.
  if (stage === 'chopped') {
    const offs: [number, number, number][] = [
      [-0.06, 0, -0.03],
      [0.05, 0, 0.04],
      [0.0, 0.01, -0.05],
      [-0.02, 0.02, 0.03],
    ];
    return offs.map((p, i) => (
      <mesh key={i} geometry={GEO.box} material={mat({ color: COL.tomato, rough: 0.55 })} position={p} rotation={[0, i * 1.1, 0]} scale={[0.07, 0.045, 0.07]} castShadow />
    ));
  }
  // whole tomato (raw base / garnish)
  return [
    <mesh key="t" geometry={GEO.sphere} material={mat({ color: COL.tomato, rough: 0.5 })} scale={0.14} castShadow />,
    <mesh key="s" geometry={GEO.sphere} material={mat({ color: COL.tomatoStem })} position={[0, 0.08, 0]} scale={0.035} />,
  ];
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

// ─────────────────────────────────────────────────────────────
// Imperative builders (plain THREE, no React). Used by the assembly
// station system and the chef's carried plated dish so we can swap
// contents without per-frame re-renders. Shapes mirror the JSX above.
// ─────────────────────────────────────────────────────────────

function meshOf(
  geo: THREE.BufferGeometry,
  color: string,
  pos: [number, number, number],
  scale: [number, number, number] | number,
  rough = 0.6,
  rot?: [number, number, number],
): THREE.Mesh {
  const m = new THREE.Mesh(geo, mat({ color, rough }));
  m.position.set(...pos);
  if (typeof scale === 'number') m.scale.setScalar(scale);
  else m.scale.set(...scale);
  if (rot) m.rotation.set(...rot);
  m.castShadow = true;
  return m;
}

/** A ready component as a plain THREE.Group centred at origin (y-up on a plate). */
export function buildReadyComponent(ingredient: Ingredient, stage: ItemStage): THREE.Group {
  const g = new THREE.Group();
  if (ingredient === 'bun') {
    g.add(meshOf(GEO.cyl, COL.bunBase, [0, 0, 0], [0.18, 0.045, 0.18], 0.7));
    const top = meshOf(GEO.halfSphere, COL.bun, [0, 0.045, 0], [0.19, 0.14, 0.19], 0.6, [Math.PI / 2, 0, 0]);
    g.add(top);
  } else if (ingredient === 'meat' && stage === 'chopped') {
    g.add(meshOf(GEO.cyl, COL.patty, [0, 0, 0], [0.17, 0.06, 0.17], 0.65));
    g.add(meshOf(GEO.cyl, COL.pattySear, [0, 0.035, 0], [0.15, 0.02, 0.15], 0.5));
  } else if (ingredient === 'meat') {
    g.add(meshOf(GEO.box, COL.meatCooked, [0, 0, 0], [0.26, 0.07, 0.2], 0.6));
    g.add(meshOf(GEO.box, COL.pattySear, [0, 0.04, 0], [0.22, 0.02, 0.16], 0.5));
  } else if (ingredient === 'pasta') {
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2;
      g.add(meshOf(GEO.torus, COL.pastaCooked, [Math.cos(a) * 0.03, 0.02 + (i % 2) * 0.02, Math.sin(a) * 0.03], [0.14, 0.14, 0.05], 0.55, [Math.PI / 2, 0, a]));
    }
  } else if (stage === 'chopped') {
    const offs: [number, number, number][] = [[-0.06, 0, -0.03], [0.05, 0, 0.04], [0, 0.01, -0.05], [-0.02, 0.02, 0.03]];
    offs.forEach((p, i) => g.add(meshOf(GEO.box, COL.tomato, p, [0.07, 0.045, 0.07], 0.55, [0, i * 1.1, 0])));
  } else {
    g.add(meshOf(GEO.sphere, COL.tomato, [0, 0, 0], 0.14, 0.5));
    g.add(meshOf(GEO.sphere, COL.tomatoStem, [0, 0.08, 0], 0.035));
  }
  return g;
}

/** A small white plate as a plain THREE.Group (top surface at y≈0.05). */
export function buildPlate(): THREE.Group {
  const g = new THREE.Group();
  g.add(meshOf(GEO.cyl, COL.plate, [0, 0, 0], [0.34, 0.03, 0.34], 0.4));
  g.add(meshOf(GEO.cyl, COL.plateEdge, [0, 0.02, 0], [0.4, 0.02, 0.4], 0.4));
  return g;
}

/** A shallow bowl as a plain THREE.Group (for soup). */
function buildBowl(color: string): THREE.Group {
  const g = new THREE.Group();
  g.add(meshOf(GEO.cyl, COL.plate, [0, 0, 0], [0.3, 0.04, 0.3], 0.4));
  // liquid surface
  g.add(meshOf(GEO.cyl, color, [0, 0.04, 0], [0.26, 0.03, 0.26], 0.4));
  return g;
}

/**
 * A fully composed plated dish as a plain THREE.Group, sitting on a plate/bowl.
 * burger = bun/patty/tomato stack; soup = bowl + garnish; steak/pasta/salad too.
 * Origin at plate base; food stacks upward.
 */
export function buildComposedDish(dish: DishId): THREE.Group {
  const g = new THREE.Group();
  if (dish === 'soup') {
    g.add(buildBowl(COL.soup));
    // floating garnish bits
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2;
      g.add(meshOf(GEO.box, COL.tomato, [Math.cos(a) * 0.1, 0.06, Math.sin(a) * 0.1], [0.05, 0.03, 0.05], 0.55, [0, a, 0]));
    }
    return g;
  }
  g.add(buildPlate());
  const base = 0.05;
  if (dish === 'burger') {
    const bun = buildReadyComponent('bun', 'raw'); bun.position.y = base; bun.scale.setScalar(1.05); g.add(bun);
    const patty = buildReadyComponent('meat', 'chopped'); patty.position.y = base + 0.07; g.add(patty);
    const tom = buildReadyComponent('tomato', 'chopped'); tom.position.y = base + 0.12; tom.scale.setScalar(0.85); g.add(tom);
    // bun crown
    const crown = meshOf(GEO.halfSphere, COL.bun, [0, base + 0.19, 0], [0.19, 0.13, 0.19], 0.6, [Math.PI / 2, 0, 0]);
    g.add(crown);
  } else if (dish === 'steak') {
    const steak = buildReadyComponent('meat', 'cooked'); steak.position.y = base + 0.03; g.add(steak);
  } else if (dish === 'pasta') {
    const nest = buildReadyComponent('pasta', 'cooked'); nest.position.y = base + 0.02; nest.scale.setScalar(1.1); g.add(nest);
  } else {
    // salad — mound of chopped tomato
    const s = buildReadyComponent('tomato', 'chopped'); s.position.y = base + 0.02; s.scale.setScalar(1.15); g.add(s);
  }
  return g;
}

export type { DishId };
