# Jev's Kitchen Chaos

A living Overcooked-style kitchen where autonomous Jev agents cook, collide, panic, and burn things. You can hire, fire, sabotage, or save them in real time.

## Features

- **5 autonomous Jev agents** navigate a top-down kitchen grid, picking up ingredients, cooking dishes, plating, and delivering. Emergent traffic jams and near-misses happen without you touching anything.
- **Click any Jev to possess it**: take manual control, ruin a dish mid-cook, or sacrifice yourself to save a burning station.
- **Hire a new Jev** (spawns panicked), **fire one** (it rage-quits and knocks things over), or trigger **Rush Hour** (3x orders flood in).
- **Kitchen degrades in real time**: grease builds, stations catch fire, agents slip on spills, and they adapt their pathfinding around the chaos.
- **End-of-shift scoreboard**: dishes served, fires caused, Jevs fired. Share your score on X.

## Stack

- Next.js 14 (static export)
- HTML5 Canvas rendering
- Custom A* pathfinding
- Finite state machines for agent AI
- Zero backend

## Getting Started

```bash
bun install
bun run dev
```

Open [http://localhost:3000](http://localhost:3000).
