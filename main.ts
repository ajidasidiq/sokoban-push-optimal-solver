// Push-optimal Sokoban solver.
// Strategy: the level is a 1-wide hallway with 1-4 rooms off it, each room
// entered through a single door. A box pushed out of a room can never come
// back, so rooms are independent: solve each room push-optimally from its
// door with push-based A* (state = box positions + the player's reachable
// region), then stitch the room solutions together with hallway walks.
// The search is budgeted by a fixed expansion count per room, never by the
// clock, so two runs produce identical bytes.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// Fixed work budgets (expansions). Deterministic: no clock is ever read.
const ROOM_BUDGET = 800000;
const WHOLE_BUDGET = 1500000;

const DX = [0, 0, -1, 1];
const DY = [-1, 1, 0, 0];
const CH = ['u', 'd', 'l', 'r'];

interface Level {
  w: number;
  h: number;
  wall: Uint8Array; // 1 = wall
  goal: Uint8Array; // 1 = goal
  boxes: number[];
  player: number;
}

function parseLevel(text: string): Level {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goal = new Uint8Array(w * h);
  const boxes: number[] = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const i = y * w + x;
      const c = row[x];
      if (c === '#') continue;
      wall[i] = 0;
      if (c === '.' || c === '*' || c === '+') goal[i] = 1;
      if (c === '$' || c === '*') boxes.push(i);
      if (c === '@' || c === '+') player = i;
    }
  });
  boxes.sort((a, b) => a - b);
  return { w, h, wall, goal, boxes, player };
}

// Breadth-first flood from `start` over floor cells that are not in `blocked`.
// Returns the reachable set and the smallest reachable cell (canonical rep).
function flood(lv: Level, start: number, blocked: Uint8Array): { reach: Uint8Array; canon: number } {
  const reach = new Uint8Array(lv.w * lv.h);
  const q: number[] = [start];
  reach[start] = 1;
  let canon = start;
  let head = 0;
  while (head < q.length) {
    const c = q[head++];
    if (c < canon) canon = c;
    const x = c % lv.w;
    const y = (c / lv.w) | 0;
    for (let d = 0; d < 4; d++) {
      const nx = x + DX[d];
      const ny = y + DY[d];
      if (nx < 0 || ny < 0 || nx >= lv.w || ny >= lv.h) continue;
      const n = ny * lv.w + nx;
      if (reach[n] || lv.wall[n] || blocked[n]) continue;
      reach[n] = 1;
      q.push(n);
    }
  }
  return { reach, canon };
}

// Shortest player walk from `from` to `to` avoiding walls and `blocked` cells.
// Returns the move string, or null when unreachable.
function walkPath(lv: Level, from: number, to: number, blocked: Uint8Array): string | null {
  if (from === to) return '';
  const prev = new Int32Array(lv.w * lv.h).fill(-2);
  const prevCh = new Array<string>(lv.w * lv.h);
  const q: number[] = [from];
  prev[from] = -1;
  let head = 0;
  while (head < q.length) {
    const c = q[head++];
    const x = c % lv.w;
    const y = (c / lv.w) | 0;
    for (let d = 0; d < 4; d++) {
      const nx = x + DX[d];
      const ny = y + DY[d];
      if (nx < 0 || ny < 0 || nx >= lv.w || ny >= lv.h) continue;
      const n = ny * lv.w + nx;
      if (prev[n] !== -2 || lv.wall[n] || blocked[n]) continue;
      prev[n] = c;
      prevCh[n] = CH[d];
      if (n === to) {
        let s = '';
        let cur = n;
        while (cur !== from) {
          s = prevCh[cur] + s;
          cur = prev[cur];
        }
        return s;
      }
      q.push(n);
    }
  }
  return null;
}

function blockedOf(lv: Level, boxes: number[]): Uint8Array {
  const b = new Uint8Array(lv.w * lv.h);
  for (const cell of boxes) b[cell] = 1;
  return b;
}

// All-pairs shortest path (in steps, ignoring boxes) over `cells`.
function distMatrix(lv: Level, cells: number[]): Map<number, Map<number, number>> {
  const out = new Map<number, Map<number, number>>();
  const cellSet = new Set(cells);
  for (const s of cells) {
    const dist = new Map<number, number>();
    dist.set(s, 0);
    const q: number[] = [s];
    let head = 0;
    while (head < q.length) {
      const c = q[head++];
      const x = c % lv.w;
      const y = (c / lv.w) | 0;
      for (let d = 0; d < 4; d++) {
        const nx = x + DX[d];
        const ny = y + DY[d];
        if (nx < 0 || ny < 0 || nx >= lv.w || ny >= lv.h) continue;
        const n = ny * lv.w + nx;
        if (dist.has(n) || lv.wall[n] || !cellSet.has(n)) continue;
        dist.set(n, dist.get(c)! + 1);
        q.push(n);
      }
    }
    out.set(s, dist);
  }
  return out;
}

// Cells from which some goal is reachable by pushes of a single box,
// ignoring other boxes (an optimistic, hence sound, liveness test).
function liveCells(lv: Level, walk: Set<number>, goals: number[]): Set<number> {
  const live = new Set<number>(goals);
  const q: number[] = [...goals];
  let head = 0;
  while (head < q.length) {
    const x = q[head++];
    const cx = x % lv.w;
    const cy = (x / lv.w) | 0;
    for (let d = 0; d < 4; d++) {
      // Box at x was pushed from prev = x - dir(d) with the player at prev - dir(d).
      const px = cx - DX[d];
      const py = cy - DY[d];
      const sx = cx - 2 * DX[d];
      const sy = cy - 2 * DY[d];
      if (px < 0 || py < 0 || px >= lv.w || py >= lv.h) continue;
      if (sx < 0 || sy < 0 || sx >= lv.w || sy >= lv.h) continue;
      const prev = py * lv.w + px;
      const stand = sy * lv.w + sx;
      if (!walk.has(prev) || !walk.has(stand) || live.has(prev)) continue;
      live.add(prev);
      q.push(prev);
    }
  }
  return live;
}

// Minimum-cost matching of boxes to goals over precomputed distances.
// Returns Infinity when no assignment exists.
function matchingHeuristic(
  boxes: number[],
  goals: number[],
  dist: Map<number, Map<number, number>>,
): number {
  const n = boxes.length;
  let best = Infinity;
  const used = new Array<boolean>(n).fill(false);
  const order = [...boxes];
  const dfs = (i: number, cost: number): void => {
    if (cost >= best) return;
    if (i === n) {
      best = cost;
      return;
    }
    for (let g = 0; g < n; g++) {
      if (used[g]) continue;
      const d = dist.get(order[i])?.get(goals[g]);
      if (d === undefined) continue;
      used[g] = true;
      dfs(i + 1, cost + d);
      used[g] = false;
    }
  };
  dfs(0, 0);
  return best;
}

interface PushProblem {
  walk: Set<number>; // cells the player may stand on
  boxCells: Set<number>; // cells a box may occupy
  boxes: number[];
  goals: number[];
  startPlayer: number;
  mustReach: number | null; // after solving, player must be able to reach this cell
  budget: number;
}

interface SearchNode {
  boxes: number[];
  player: number; // actual cell the player stands on
  canon: number; // smallest reachable cell: the state's canonical player rep
  g: number;
  parent: number;
  via: string; // moves from parent state to this state (walk + push step)
}

// Push-based A* over one (sub)problem. Returns the move string, or null.
function solvePush(lv: Level, p: PushProblem): string | null {
  const goalsSorted = [...p.goals].sort((a, b) => a - b);
  const goalSet = new Set(p.goals);
  const walkArr = [...p.walk];
  const dist = distMatrix(lv, walkArr);
  const live = liveCells(lv, p.walk, p.goals);

  const startBlocked = blockedOf(lv, p.boxes);
  const startCanon = flood(lv, p.startPlayer, startBlocked).canon;

  const keyOf = (boxes: number[], player: number): string =>
    boxes.join(',') + '|' + player;

  // Binary heap of node indices ordered by (f, h, seq).
  const heap: number[] = [];
  const heapKey = (i: number): [number, number, number] => {
    const n = nodes[i];
    return [n.g + heur[i], heur[i], i];
  };
  const nodes: SearchNode[] = [];
  const heur: number[] = [];
  const best = new Map<string, number>();

  const h0 = matchingHeuristic(p.boxes, goalsSorted, dist);
  if (!Number.isFinite(h0)) return null;
  nodes.push({ boxes: [...p.boxes], player: p.startPlayer, canon: startCanon, g: 0, parent: -1, via: '' });
  heur.push(h0);
  best.set(keyOf(p.boxes, startCanon), 0);
  heap.push(0);
  let expansions = 0;

  const heapLess = (a: number, b: number): boolean => {
    const ka = heapKey(a);
    const kb = heapKey(b);
    return ka[0] < kb[0] || (ka[0] === kb[0] && (ka[1] < kb[1] || (ka[1] === kb[1] && ka[2] < kb[2])));
  };
  const heapPush = (idx: number): void => {
    heap.push(idx);
    let i = heap.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!heapLess(heap[i], heap[parent])) break;
      [heap[i], heap[parent]] = [heap[parent], heap[i]];
      i = parent;
    }
  };
  const heapPop = (): number => {
    const top = heap[0];
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < heap.length && heapLess(heap[l], heap[m])) m = l;
        if (r < heap.length && heapLess(heap[r], heap[m])) m = r;
        if (m === i) break;
        [heap[i], heap[m]] = [heap[m], heap[i]];
        i = m;
      }
    }
    return top;
  };

  const isSolved = (boxes: number[]): boolean => boxes.every((b) => goalSet.has(b));

  while (heap.length > 0) {
    const ni = heapPop();
    const node = nodes[ni];
    if (best.get(keyOf(node.boxes, node.canon)) !== node.g) continue;
    if (isSolved(node.boxes)) {
      if (p.mustReach !== null) {
        const blocked = blockedOf(lv, node.boxes);
        const path = walkPath(lv, node.player, p.mustReach, blocked);
        if (path === null) continue;
      }
      // Reconstruct.
      const parts: string[] = [];
      let cur = ni;
      while (cur !== 0) {
        parts.push(nodes[cur].via);
        cur = nodes[cur].parent;
      }
      parts.reverse();
      return parts.join('');
    }
    if (++expansions > p.budget) return null;
    const blocked = blockedOf(lv, node.boxes);
    const boxSet = new Set(node.boxes);
    for (let bi = 0; bi < node.boxes.length; bi++) {
      const b = node.boxes[bi];
      const bx = b % lv.w;
      const by = (b / lv.w) | 0;
      for (let d = 0; d < 4; d++) {
        const tx = bx + DX[d];
        const ty = by + DY[d];
        if (tx < 0 || ty < 0 || tx >= lv.w || ty >= lv.h) continue;
        const dest = ty * lv.w + tx;
        if (!p.boxCells.has(dest) || boxSet.has(dest)) continue;
        if (!live.has(dest) && !goalSet.has(dest)) continue;
        const sx = bx - DX[d];
        const sy = by - DY[d];
        if (sx < 0 || sy < 0 || sx >= lv.w || sy >= lv.h) continue;
        const stand = sy * lv.w + sx;
        if (!p.walk.has(stand) || boxSet.has(stand)) continue;
        const toStand = walkPath(lv, node.player, stand, blocked);
        if (toStand === null) continue;
        const nextBoxes = [...node.boxes];
        nextBoxes[bi] = dest;
        nextBoxes.sort((a, b2) => a - b2);
        // 2x2 freeze: a 2x2 block of walls/boxes holding an off-goal box is dead.
        let frozen = false;
        const nbx = dest % lv.w;
        const nby = (dest / lv.w) | 0;
        const nextSet = new Set(nextBoxes);
        for (let oy = -1; oy <= 0 && !frozen; oy++) {
          for (let ox = -1; ox <= 0 && !frozen; ox++) {
            const cx0 = nbx + ox;
            const cy0 = nby + oy;
            if (cx0 < 0 || cy0 < 0 || cx0 + 1 >= lv.w || cy0 + 1 >= lv.h) continue;
            let allSolid = true;
            let hasOffGoalBox = false;
            for (let yy = 0; yy < 2; yy++) {
              for (let xx = 0; xx < 2; xx++) {
                const c = (cy0 + yy) * lv.w + (cx0 + xx);
                if (lv.wall[c]) continue;
                if (nextSet.has(c)) {
                  if (!goalSet.has(c)) hasOffGoalBox = true;
                  continue;
                }
                allSolid = false;
              }
            }
            if (allSolid && hasOffGoalBox) frozen = true;
          }
        }
        if (frozen) continue;
        const h = matchingHeuristic(nextBoxes, goalsSorted, dist);
        if (!Number.isFinite(h)) continue;
        const nextBlocked = blockedOf(lv, nextBoxes);
        const canon = flood(lv, b, nextBlocked).canon;
        const key = keyOf(nextBoxes, canon);
        const g2 = node.g + 1;
        if ((best.get(key) ?? Infinity) <= g2) continue;
        best.set(key, g2);
        nodes.push({
          boxes: nextBoxes,
          player: b,
          canon,
          g: g2,
          parent: ni,
          via: toStand + CH[d],
        });
        heur.push(h);
        heapPush(nodes.length - 1);
      }
    }
  }
  return null;
}

interface Room {
  cells: number[];
  cellSet: Set<number>;
  door: number;
  entry: number; // hallway cell adjacent to the door
  boxes: number[];
  goals: number[];
}

function detectRooms(lv: Level): Room[] | null {
  const playerY = (lv.player / lv.w) | 0;
  const hallway = new Set<number>();
  for (let x = 0; x < lv.w; x++) {
    const c = playerY * lv.w + x;
    if (!lv.wall[c]) hallway.add(c);
  }
  if (!hallway.has(lv.player)) return null;
  const seen = new Uint8Array(lv.w * lv.h);
  const rooms: Room[] = [];
  const totalBoxes = new Set(lv.boxes);
  for (let start = 0; start < lv.w * lv.h; start++) {
    if (lv.wall[start] || seen[start]) continue;
    const y = (start / lv.w) | 0;
    if (y === playerY) continue;
    // Flood one component (all non-hallway floor).
    const cells: number[] = [];
    const q: number[] = [start];
    seen[start] = 1;
    let head = 0;
    while (head < q.length) {
      const c = q[head++];
      cells.push(c);
      const x = c % lv.w;
      const cy = (c / lv.w) | 0;
      for (let d = 0; d < 4; d++) {
        const nx = x + DX[d];
        const ny = cy + DY[d];
        if (nx < 0 || ny < 0 || nx >= lv.w || ny >= lv.h) continue;
        const n = ny * lv.w + nx;
        if (lv.wall[n] || seen[n] || ny === playerY) continue;
        seen[n] = 1;
        q.push(n);
      }
    }
    const cellSet = new Set(cells);
    let door = -1;
    let entry = -1;
    for (const c of cells) {
      const x = c % lv.w;
      const cy = (c / lv.w) | 0;
      for (let d = 0; d < 4; d++) {
        const nx = x + DX[d];
        const ny = cy + DY[d];
        if (nx < 0 || ny < 0 || nx >= lv.w || ny >= lv.h) continue;
        const n = ny * lv.w + nx;
        if (hallway.has(n)) {
          door = c;
          entry = n;
          break;
        }
      }
      if (door !== -1) break;
    }
    if (door === -1) return null;
    const boxes = lv.boxes.filter((b) => cellSet.has(b));
    const goals = cells.filter((c) => lv.goal[c]);
    if (boxes.length === 0) continue;
    if (boxes.length !== goals.length) return null;
    for (const b of boxes) totalBoxes.delete(b);
    rooms.push({ cells, cellSet, door, entry, boxes, goals });
  }
  if (totalBoxes.size !== 0) return null;
  rooms.sort((a, b) => a.entry - b.entry);
  return rooms;
}

function solveLevel(text: string): string {
  const lv = parseLevel(text);
  const allFloor: number[] = [];
  for (let i = 0; i < lv.w * lv.h; i++) if (!lv.wall[i]) allFloor.push(i);
  const allGoals = allFloor.filter((c) => lv.goal[c]);

  const rooms = detectRooms(lv);
  if (rooms !== null && rooms.length > 0) {
    let moves = '';
    let playerPos = lv.player;
    let boxes = [...lv.boxes];
    for (const room of rooms) {
      // Walk the hallway (boxes elsewhere are obstacles) to the door entry.
      const blocked = blockedOf(lv, boxes);
      const toEntry = walkPath(lv, playerPos, room.entry, blocked);
      if (toEntry === null) return '';
      moves += toEntry;
      const walk = new Set<number>(room.cells);
      walk.add(room.entry);
      const solved = solvePush(lv, {
        walk,
        boxCells: room.cellSet,
        boxes: room.boxes,
        goals: room.goals,
        startPlayer: room.entry,
        mustReach: room.door,
        budget: ROOM_BUDGET,
      });
      if (solved === null) return '';
      moves += solved;
      // Exit the room back to the hallway entry cell.
      // Recompute the room's final box cells by replaying `solved` from the
      // room's start state (cheap, and keeps `boxes` exact for later walks).
      const replay = replayMoves(lv, room.boxes, room.entry, solved);
      if (replay === null) return '';
      const roomBoxSet = new Set(room.boxes);
      boxes = boxes.filter((b) => !roomBoxSet.has(b)).concat(replay.boxes);
      boxes.sort((a, b) => a - b);
      const exit = walkPath(lv, replay.player, room.entry, blockedOf(lv, boxes));
      if (exit === null) return '';
      moves += exit;
      playerPos = room.entry;
    }
    return moves;
  }

  // Fallback: solve the whole level as one push problem.
  const solved = solvePush(lv, {
    walk: new Set(allFloor),
    boxCells: new Set(allFloor),
    boxes: lv.boxes,
    goals: allGoals,
    startPlayer: lv.player,
    mustReach: null,
    budget: WHOLE_BUDGET,
  });
  return solved ?? '';
}

// Replay a move string from a given box/player start; returns the end state.
function replayMoves(
  lv: Level,
  boxes0: number[],
  player0: number,
  moves: string,
): { boxes: number[]; player: number } | null {
  const boxes = new Set(boxes0);
  let player = player0;
  for (const ch of moves) {
    const d = CH.indexOf(ch);
    if (d === -1) return null;
    const x = player % lv.w;
    const y = (player / lv.w) | 0;
    const nx = x + DX[d];
    const ny = y + DY[d];
    if (nx < 0 || ny < 0 || nx >= lv.w || ny >= lv.h) return null;
    const next = ny * lv.w + nx;
    if (lv.wall[next]) return null;
    if (boxes.has(next)) {
      const bx = nx + DX[d];
      const by = ny + DY[d];
      if (bx < 0 || by < 0 || bx >= lv.w || by >= lv.h) return null;
      const beyond = by * lv.w + bx;
      if (lv.wall[beyond] || boxes.has(beyond)) return null;
      boxes.delete(next);
      boxes.add(beyond);
    }
    player = next;
  }
  return { boxes: [...boxes].sort((a, b) => a - b), player };
}

for (const id of readdirSync(INPUT).sort()) {
  const moves = solveLevel(readFileSync(join(INPUT, id, 'level.txt'), 'utf8'));
  mkdirSync(join(OUTPUT, id), { recursive: true });
  writeFileSync(join(OUTPUT, id, 'solution.txt'), `${moves}\n`);
}
