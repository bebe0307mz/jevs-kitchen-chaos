export const GRID_W = 20;
export const GRID_H = 14;
export const TILE_SIZE = 48;

export enum TileType {
  FLOOR = 0,
  WALL = 1,
  STOVE = 2,
  CUTTING_BOARD = 3,
  SINK = 4,
  PLATING = 5,
  DELIVERY = 6,
  INGREDIENT = 7,
  TRASH = 8,
}

export enum AgentState {
  IDLE,
  WALKING,
  WORKING,
  PANICKING,
  RAGE_QUITTING,
  POSSESSED,
  SLIPPING,
}

export enum DishType {
  BURGER,
  SOUP,
  SALAD,
  STEAK,
  PASTA,
}

export enum ItemState {
  RAW,
  CHOPPED,
  COOKED,
  PLATED,
  BURNT,
}

export interface Point { x: number; y: number; }

export interface FoodItem {
  type: 'meat' | 'veggies' | 'grain';
  state: ItemState;
  dishTarget?: DishType;
}

export interface Station {
  type: TileType;
  pos: Point;
  item: FoodItem | null;
  progress: number;
  grease: number;
  onFire: boolean;
  fireTimer: number;
  inUse: boolean;
  usedBy: number | null;
}

export interface Order {
  id: number;
  dish: DishType;
  timeLeft: number;
  maxTime: number;
  claimed: boolean;
  claimedBy: number | null;
  completed: boolean;
  failed: boolean;
}

export interface Recipe {
  name: string;
  ingredient: 'meat' | 'veggies' | 'grain';
  needsCut: boolean;
  needsCook: boolean;
  cookTime: number;
  cutTime: number;
  points: number;
  orderTime: number;
}

export interface TaskStep {
  action: 'walk_to' | 'place_item' | 'work' | 'pickup' | 'deliver';
  stationType?: TileType;
  duration?: number;
}

export interface AgentTask {
  orderId: number;
  dish: DishType;
  steps: TaskStep[];
  currentStep: number;
}

export interface Agent {
  id: number;
  x: number;
  y: number;
  state: AgentState;
  prevState: AgentState;
  path: Point[];
  pathIndex: number;
  carrying: FoodItem | null;
  task: AgentTask | null;
  stateTimer: number;
  workTimer: number;
  workDuration: number;
  color: string;
  name: string;
  expression: 'normal' | 'happy' | 'stressed' | 'panicking' | 'angry';
  speed: number;
  facingDir: Point;
  targetStation: Station | null;
  idleTimer: number;
  bobOffset: number;
}

export interface Spill {
  x: number;
  y: number;
  timer: number;
  maxTimer: number;
}

export interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  color: string;
  size: number;
}

export interface GameStats {
  dishesServed: number;
  dishesFailed: number;
  firesCaused: number;
  jevsFired: number;
  jevsHired: number;
  totalScore: number;
}

export const RECIPES: Record<number, Recipe> = {
  [DishType.BURGER]: { name: 'Burger', ingredient: 'meat', needsCut: true, needsCook: true, cookTime: 5, cutTime: 3, points: 30, orderTime: 60 },
  [DishType.SOUP]: { name: 'Soup', ingredient: 'veggies', needsCut: true, needsCook: true, cookTime: 6, cutTime: 3, points: 25, orderTime: 55 },
  [DishType.SALAD]: { name: 'Salad', ingredient: 'veggies', needsCut: true, needsCook: false, cookTime: 0, cutTime: 4, points: 15, orderTime: 35 },
  [DishType.STEAK]: { name: 'Steak', ingredient: 'meat', needsCut: false, needsCook: true, cookTime: 7, cutTime: 0, points: 35, orderTime: 50 },
  [DishType.PASTA]: { name: 'Pasta', ingredient: 'grain', needsCut: true, needsCook: true, cookTime: 5, cutTime: 2, points: 40, orderTime: 65 },
};

export const DISH_EMOJIS: Record<number, string> = {
  [DishType.BURGER]: '\u{1F354}',
  [DishType.SOUP]: '\u{1F372}',
  [DishType.SALAD]: '\u{1F957}',
  [DishType.STEAK]: '\u{1F969}',
  [DishType.PASTA]: '\u{1F35D}',
};

export const AGENT_COLORS = ['#E74C3C', '#3498DB', '#2ECC71', '#F39C12', '#9B59B6', '#1ABC9C', '#E67E22', '#34495E'];
export const AGENT_NAMES = ['Chef Jev', 'Sous Jev', 'Line Jev', 'Prep Jev', 'Fry Jev', 'Grill Jev', 'Saucy Jev', 'Dish Jev'];

export const KITCHEN_LAYOUT: number[][] = [
  [1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1],
  [1,7,0,7,0,7,0,0,0,0,0,0,0,0,0,0,6,0,6,1],
  [1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1],
  [1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1],
  [1,4,0,0,2,0,2,0,2,0,0,3,0,3,0,5,0,0,6,1],
  [1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1],
  [1,0,0,0,0,0,0,1,1,0,0,1,1,0,0,0,0,0,0,1],
  [1,0,0,0,0,0,0,1,1,0,0,1,1,0,0,0,0,0,0,1],
  [1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1],
  [1,0,0,0,2,0,2,0,2,0,0,3,0,3,0,5,0,0,6,1],
  [1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1],
  [1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,8,1],
  [1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1],
  [1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1],
];
