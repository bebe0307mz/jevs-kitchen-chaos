import { GameEngine } from './engine';
import {
  Agent, AgentState, Station, TileType, FoodItem, ItemState, Spill, Particle,
  GRID_W, GRID_H, TILE_SIZE,
} from './types';

const C = {
  FLOOR_A: '#F0DCC0',
  FLOOR_B: '#E3CBAB',
  WALL: '#6B4226',
  WALL_TOP: '#8B5E3C',
  WALL_DARK: '#4A2D15',
  STOVE: '#4A4A4A',
  STOVE_TOP: '#5A5A5A',
  BURNER_OFF: '#333',
  BURNER_ON: '#FF4500',
  CUTTING: '#D4A574',
  CUTTING_MARKS: '#C09560',
  SINK_BASE: '#7EC8E3',
  SINK_BOWL: '#5BAFD4',
  PLATE_BASE: '#E8E8E8',
  PLATE_RIM: '#CCC',
  DELIVERY: '#7BCF72',
  DELIVERY_DARK: '#5AA854',
  INGREDIENT: '#FFD166',
  INGREDIENT_DARK: '#E6B84D',
  TRASH: '#888',
  TRASH_DARK: '#666',
  FIRE_A: '#FF6B35',
  FIRE_B: '#FFD166',
  FIRE_C: '#EF476F',
  GREASE: 'rgba(80, 50, 20, 0.3)',
  SPILL: 'rgba(100, 180, 220, 0.4)',
  PROGRESS_BG: 'rgba(0,0,0,0.3)',
  PROGRESS_FG: '#06D6A0',
};

export class Renderer {
  ctx: CanvasRenderingContext2D;
  engine: GameEngine;
  t = 0;

  constructor(ctx: CanvasRenderingContext2D, engine: GameEngine) {
    this.ctx = ctx;
    this.engine = engine;
  }

  render(dt: number) {
    this.t += dt;
    const ctx = this.ctx;
    ctx.clearRect(0, 0, GRID_W * TILE_SIZE, GRID_H * TILE_SIZE);

    this.drawFloor();
    this.drawSpills();
    this.drawWallsAndStations();
    this.drawStationItems();
    this.drawAgents();
    this.drawParticles();
  }

  private drawFloor() {
    const ctx = this.ctx;
    for (let y = 0; y < GRID_H; y++) {
      for (let x = 0; x < GRID_W; x++) {
        if (this.engine.grid[y][x] === TileType.FLOOR) {
          ctx.fillStyle = (x + y) % 2 === 0 ? C.FLOOR_A : C.FLOOR_B;
          ctx.fillRect(x * TILE_SIZE, y * TILE_SIZE, TILE_SIZE, TILE_SIZE);
          // Subtle tile line
          ctx.strokeStyle = 'rgba(0,0,0,0.05)';
          ctx.lineWidth = 1;
          ctx.strokeRect(x * TILE_SIZE + 0.5, y * TILE_SIZE + 0.5, TILE_SIZE - 1, TILE_SIZE - 1);
        }
      }
    }
  }

  private drawSpills() {
    const ctx = this.ctx;
    for (const s of this.engine.spills) {
      const px = s.x * TILE_SIZE + TILE_SIZE / 2;
      const py = s.y * TILE_SIZE + TILE_SIZE / 2;
      const alpha = Math.min(1, s.timer / 3) * 0.4;
      ctx.fillStyle = `rgba(100, 180, 220, ${alpha})`;
      ctx.beginPath();
      ctx.ellipse(px, py, TILE_SIZE * 0.35, TILE_SIZE * 0.25, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = `rgba(120, 200, 240, ${alpha * 0.5})`;
      ctx.beginPath();
      ctx.ellipse(px - 4, py - 2, TILE_SIZE * 0.15, TILE_SIZE * 0.1, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  private drawWallsAndStations() {
    const ctx = this.ctx;
    for (let y = 0; y < GRID_H; y++) {
      for (let x = 0; x < GRID_W; x++) {
        const tile = this.engine.grid[y][x];
        const px = x * TILE_SIZE;
        const py = y * TILE_SIZE;
        const T = TILE_SIZE;

        if (tile === TileType.WALL) {
          // 3D block effect
          ctx.fillStyle = C.WALL_TOP;
          ctx.fillRect(px, py, T, T);
          ctx.fillStyle = C.WALL;
          ctx.fillRect(px, py + 4, T, T - 4);
          ctx.fillStyle = C.WALL_DARK;
          ctx.fillRect(px, py + T - 3, T, 3);
          // Wood grain
          ctx.strokeStyle = 'rgba(0,0,0,0.08)';
          ctx.lineWidth = 1;
          for (let i = 0; i < 3; i++) {
            const ly = py + 8 + i * 12;
            ctx.beginPath(); ctx.moveTo(px + 4, ly); ctx.lineTo(px + T - 4, ly); ctx.stroke();
          }
        } else if (tile >= 2) {
          const station = this.engine.getStationAt({ x, y });
          this.drawStation(tile as TileType, px, py, station);
        }
      }
    }
  }

  private drawStation(type: TileType, px: number, py: number, station: Station | null) {
    const ctx = this.ctx;
    const T = TILE_SIZE;

    switch (type) {
      case TileType.STOVE: {
        // Counter base
        ctx.fillStyle = C.WALL_TOP;
        ctx.fillRect(px, py, T, T);
        ctx.fillStyle = C.STOVE_TOP;
        ctx.fillRect(px + 2, py + 2, T - 4, T - 6);
        // Burner rings
        const hot = station?.item != null;
        ctx.strokeStyle = hot ? C.BURNER_ON : C.BURNER_OFF;
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(px + T * 0.35, py + T * 0.4, 8, 0, Math.PI * 2); ctx.stroke();
        ctx.beginPath(); ctx.arc(px + T * 0.65, py + T * 0.4, 8, 0, Math.PI * 2); ctx.stroke();
        // Grease overlay
        if (station && station.grease > 0.1) {
          ctx.fillStyle = `rgba(80, 50, 20, ${station.grease * 0.4})`;
          ctx.fillRect(px + 2, py + 2, T - 4, T - 6);
        }
        // Fire!
        if (station?.onFire) {
          this.drawFire(px + T / 2, py + T * 0.3);
        }
        // Progress bar
        if (station && station.progress > 0 && station.inUse) {
          this.drawProgressBar(px + 4, py + T - 8, T - 8, 5, station.progress);
        }
        break;
      }
      case TileType.CUTTING_BOARD: {
        ctx.fillStyle = C.WALL_TOP;
        ctx.fillRect(px, py, T, T);
        ctx.fillStyle = C.CUTTING;
        ctx.fillRect(px + 4, py + 4, T - 8, T - 10);
        // Knife marks
        ctx.strokeStyle = C.CUTTING_MARKS;
        ctx.lineWidth = 1;
        for (let i = 0; i < 4; i++) {
          const lx = px + 10 + i * 8;
          ctx.beginPath(); ctx.moveTo(lx, py + 8); ctx.lineTo(lx, py + T - 10); ctx.stroke();
        }
        if (station && station.progress > 0 && station.inUse) {
          this.drawProgressBar(px + 4, py + T - 8, T - 8, 5, station.progress);
        }
        break;
      }
      case TileType.SINK: {
        ctx.fillStyle = C.WALL_TOP;
        ctx.fillRect(px, py, T, T);
        ctx.fillStyle = C.SINK_BASE;
        ctx.fillRect(px + 6, py + 6, T - 12, T - 14);
        ctx.fillStyle = C.SINK_BOWL;
        ctx.fillRect(px + 10, py + 10, T - 20, T - 22);
        // Faucet
        ctx.fillStyle = '#AAA';
        ctx.fillRect(px + T / 2 - 3, py + 2, 6, 10);
        ctx.fillRect(px + T / 2 - 6, py + 2, 12, 4);
        break;
      }
      case TileType.PLATING: {
        ctx.fillStyle = C.WALL_TOP;
        ctx.fillRect(px, py, T, T);
        ctx.fillStyle = C.PLATE_BASE;
        ctx.fillRect(px + 4, py + 4, T - 8, T - 10);
        // Plate circle
        ctx.strokeStyle = C.PLATE_RIM;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(px + T / 2, py + T / 2 - 1, T * 0.28, 0, Math.PI * 2);
        ctx.stroke();
        if (station && station.progress > 0 && station.inUse) {
          this.drawProgressBar(px + 4, py + T - 8, T - 8, 5, station.progress);
        }
        break;
      }
      case TileType.DELIVERY: {
        ctx.fillStyle = C.DELIVERY_DARK;
        ctx.fillRect(px, py, T, T);
        ctx.fillStyle = C.DELIVERY;
        ctx.fillRect(px + 2, py + 2, T - 4, T - 6);
        // Arrow
        ctx.fillStyle = '#FFF';
        ctx.font = 'bold 18px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('\u2191', px + T / 2, py + T / 2 - 1);
        // Pulsing border
        const pulse = Math.sin(this.t * 3) * 0.3 + 0.7;
        ctx.strokeStyle = `rgba(255,255,255,${pulse * 0.5})`;
        ctx.lineWidth = 2;
        ctx.strokeRect(px + 1, py + 1, T - 2, T - 2);
        break;
      }
      case TileType.INGREDIENT: {
        ctx.fillStyle = C.INGREDIENT_DARK;
        ctx.fillRect(px, py, T, T);
        ctx.fillStyle = C.INGREDIENT;
        ctx.fillRect(px + 2, py + 2, T - 4, T - 6);
        // Food icons
        ctx.font = '16px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('\u{1F356}', px + T / 2, py + T / 2 - 1);
        break;
      }
      case TileType.TRASH: {
        ctx.fillStyle = C.TRASH_DARK;
        ctx.fillRect(px, py, T, T);
        ctx.fillStyle = C.TRASH;
        ctx.fillRect(px + 4, py + 4, T - 8, T - 10);
        ctx.font = 'bold 16px sans-serif';
        ctx.fillStyle = '#555';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('\u{1F5D1}', px + T / 2, py + T / 2);
        break;
      }
    }
  }

  private drawStationItems() {
    const ctx = this.ctx;
    for (const s of this.engine.stations) {
      if (!s.item) continue;
      const px = s.pos.x * TILE_SIZE + TILE_SIZE / 2;
      const py = s.pos.y * TILE_SIZE + TILE_SIZE / 2 - 4;
      this.drawFoodItem(px, py, s.item, 10);
    }
  }

  private drawFoodItem(x: number, y: number, item: FoodItem, size: number) {
    const ctx = this.ctx;
    let color = '#888';
    switch (item.state) {
      case ItemState.RAW:
        color = item.type === 'meat' ? '#E74C3C' : item.type === 'veggies' ? '#2ECC71' : '#F4D03F';
        break;
      case ItemState.CHOPPED:
        color = item.type === 'meat' ? '#C0392B' : item.type === 'veggies' ? '#27AE60' : '#D4AC0D';
        break;
      case ItemState.COOKED:
        color = item.type === 'meat' ? '#8B4513' : item.type === 'veggies' ? '#1E8449' : '#B7950B';
        break;
      case ItemState.PLATED:
        color = '#F5F5DC';
        break;
      case ItemState.BURNT:
        color = '#2C2C2C';
        break;
    }
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, size, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.3)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    // Plate ring for plated items
    if (item.state === ItemState.PLATED) {
      ctx.strokeStyle = '#CCC';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(x, y, size + 3, 0, Math.PI * 2);
      ctx.stroke();
    }
    // Smoke for burnt
    if (item.state === ItemState.BURNT) {
      ctx.fillStyle = 'rgba(100,100,100,0.5)';
      for (let i = 0; i < 3; i++) {
        const ox = Math.sin(this.t * 2 + i * 2) * 4;
        const oy = -8 - i * 5 - Math.sin(this.t * 3 + i) * 3;
        ctx.beginPath();
        ctx.arc(x + ox, y + oy, 3, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  private drawAgents() {
    const sorted = [...this.engine.agents].sort((a, b) => a.y - b.y);
    for (const agent of sorted) {
      if (agent.y > GRID_H) continue;
      this.drawAgent(agent);
    }
  }

  private drawAgent(agent: Agent) {
    const ctx = this.ctx;
    const T = TILE_SIZE;
    const px = agent.x * T + T / 2;
    const py = agent.y * T + T / 2;
    const r = T * 0.32;
    const bob = Math.sin(agent.bobOffset) * 2;
    const isSelected = this.engine.possessedId === agent.id;

    // Selection ring
    if (isSelected) {
      const pulse = Math.sin(this.t * 4) * 0.3 + 0.7;
      ctx.strokeStyle = `rgba(255, 255, 100, ${pulse})`;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(px, py + 2, r + 6, 0, Math.PI * 2);
      ctx.stroke();
      // Arrow indicator
      ctx.fillStyle = '#FFD166';
      ctx.beginPath();
      ctx.moveTo(px, py - r - 16 + Math.sin(this.t * 5) * 3);
      ctx.lineTo(px - 6, py - r - 22 + Math.sin(this.t * 5) * 3);
      ctx.lineTo(px + 6, py - r - 22 + Math.sin(this.t * 5) * 3);
      ctx.closePath();
      ctx.fill();
    }

    // Shadow
    ctx.fillStyle = 'rgba(0,0,0,0.15)';
    ctx.beginPath();
    ctx.ellipse(px, py + r + 4, r * 0.8, r * 0.3, 0, 0, Math.PI * 2);
    ctx.fill();

    // Body
    ctx.fillStyle = agent.color;
    ctx.beginPath();
    ctx.arc(px, py + bob, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.25)';
    ctx.lineWidth = 2;
    ctx.stroke();

    // Chef hat
    ctx.fillStyle = '#FFFFFF';
    ctx.strokeStyle = 'rgba(0,0,0,0.1)';
    ctx.lineWidth = 1;
    // Hat brim
    ctx.beginPath();
    ctx.ellipse(px, py - r + bob + 2, r * 0.7, r * 0.25, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    // Hat puff
    ctx.beginPath();
    ctx.arc(px, py - r - 4 + bob, r * 0.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    // Face
    this.drawFace(px, py + bob, r, agent.expression, agent);

    // Carried item
    if (agent.carrying) {
      this.drawFoodItem(px + r * 0.7, py - r - 6 + bob, agent.carrying, 6);
    }

    // Name tag
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.font = 'bold 9px Fredoka, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const nameY = py + r + 6;
    const nameW = ctx.measureText(agent.name).width + 6;
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.beginPath();
    ctx.roundRect(px - nameW / 2, nameY - 1, nameW, 12, 3);
    ctx.fill();
    ctx.fillStyle = '#FFF';
    ctx.fillText(agent.name, px, nameY);
  }

  private drawFace(x: number, y: number, r: number, expr: string, agent: Agent) {
    const ctx = this.ctx;
    const eyeY = y - r * 0.15;
    const eyeSpacing = r * 0.35;
    const eyeR = 2.5;
    const mouthY = y + r * 0.3;

    // Eyes
    ctx.fillStyle = '#FFF';
    ctx.beginPath(); ctx.arc(x - eyeSpacing, eyeY, eyeR + 1, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(x + eyeSpacing, eyeY, eyeR + 1, 0, Math.PI * 2); ctx.fill();

    ctx.fillStyle = '#333';
    const lookX = agent.facingDir.x * 1;
    const lookY = agent.facingDir.y * 0.5;
    ctx.beginPath(); ctx.arc(x - eyeSpacing + lookX, eyeY + lookY, eyeR, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(x + eyeSpacing + lookX, eyeY + lookY, eyeR, 0, Math.PI * 2); ctx.fill();

    // Mouth based on expression
    ctx.strokeStyle = '#333';
    ctx.lineWidth = 1.5;
    ctx.lineCap = 'round';
    switch (expr) {
      case 'happy':
        ctx.beginPath();
        ctx.arc(x, mouthY - 2, r * 0.2, 0.1, Math.PI - 0.1);
        ctx.stroke();
        break;
      case 'stressed':
        ctx.beginPath();
        ctx.moveTo(x - r * 0.2, mouthY);
        ctx.lineTo(x - r * 0.1, mouthY + 2);
        ctx.lineTo(x + r * 0.1, mouthY - 1);
        ctx.lineTo(x + r * 0.2, mouthY + 1);
        ctx.stroke();
        // Sweat drop
        ctx.fillStyle = '#7EC8E3';
        ctx.beginPath();
        ctx.arc(x + r * 0.6, eyeY + 2, 2, 0, Math.PI * 2);
        ctx.fill();
        break;
      case 'panicking':
        // Wide open mouth
        ctx.fillStyle = '#333';
        ctx.beginPath();
        ctx.ellipse(x, mouthY, r * 0.2, r * 0.15, 0, 0, Math.PI * 2);
        ctx.fill();
        // Sweat drops
        ctx.fillStyle = '#7EC8E3';
        ctx.beginPath(); ctx.arc(x - r * 0.5, eyeY + 4, 2, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.arc(x + r * 0.6, eyeY + 2, 2, 0, Math.PI * 2); ctx.fill();
        break;
      case 'angry':
        // Frown
        ctx.beginPath();
        ctx.arc(x, mouthY + 4, r * 0.2, Math.PI + 0.2, -0.2);
        ctx.stroke();
        // Angry eyebrows
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(x - eyeSpacing - 3, eyeY - 5);
        ctx.lineTo(x - eyeSpacing + 3, eyeY - 3);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(x + eyeSpacing + 3, eyeY - 5);
        ctx.lineTo(x + eyeSpacing - 3, eyeY - 3);
        ctx.stroke();
        break;
      default: // normal
        ctx.beginPath();
        ctx.moveTo(x - r * 0.15, mouthY);
        ctx.lineTo(x + r * 0.15, mouthY);
        ctx.stroke();
    }
  }

  private drawFire(x: number, y: number) {
    const ctx = this.ctx;
    const flicker = Math.sin(this.t * 15) * 0.3;
    for (let i = 0; i < 5; i++) {
      const ox = Math.sin(this.t * 8 + i * 1.5) * 8;
      const oy = -i * 6 - Math.abs(Math.sin(this.t * 10 + i)) * 8;
      const s = 6 - i * 0.8 + flicker * 2;
      const colors = [C.FIRE_A, C.FIRE_B, C.FIRE_C];
      ctx.fillStyle = colors[i % 3];
      ctx.globalAlpha = 0.8 - i * 0.12;
      ctx.beginPath();
      ctx.arc(x + ox, y + oy, s, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  private drawProgressBar(x: number, y: number, w: number, h: number, progress: number) {
    const ctx = this.ctx;
    ctx.fillStyle = C.PROGRESS_BG;
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, 2);
    ctx.fill();
    ctx.fillStyle = C.PROGRESS_FG;
    ctx.beginPath();
    ctx.roundRect(x + 1, y + 1, (w - 2) * Math.min(1, progress), h - 2, 1);
    ctx.fill();
  }

  private drawParticles() {
    const ctx = this.ctx;
    for (const p of this.engine.particles) {
      const alpha = Math.min(1, p.life / (p.maxLife * 0.3));
      ctx.globalAlpha = alpha;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size * alpha, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }
}
