// The same deterministic simulation can run on the server and in a browser.
export const ARENA = Object.freeze({ width: 12000, height: 8000 });
export const ROUND_DURATION = 180;
export const COLORS = ['#5eefa8', '#d4b5ff', '#ffbd68', '#83d9ff', '#ff8eaf', '#9da8ff', '#ffe787', '#70f0e4'];
export const BLAST_COST = 30;
export const MOTION = Object.freeze({ response: 6, drag: 2, stopSpeed: 0.5, restitution: 0.2,
  restingThreshold: 60, contactSlop: 0.01, physicsStep: 1 / 120 });
export const WAVE = Object.freeze({ speed: 600, distance: 420, width: 160, thickness: 20, curvature: 30, segments: 8 });
export const UPGRADE_THRESHOLDS = [60, 100, 160, 240, 360, 520];
export const UPGRADE_POOL = [
  { id: 'speed', title: '光速引擎', description: '移动速度提升 10%', icon: '⚡' },
  { id: 'growth', title: '星尘滋养', description: '吞食星尘获得的质量增加 20%', icon: '✦' },
  { id: 'range', title: '超新星回响', description: '引力波射程增加 18%', icon: '◎' },
  { id: 'efficiency', title: '能量核心', description: '释放星爆的能量消耗降低 15%', icon: '◈' },
  { id: 'magnet', title: '引力透镜', description: '引力吸引范围增加 25', icon: '🧲' },
  { id: 'shield', title: '行星护盾', description: '生命上限增加 25，并恢复 25 生命', icon: '◇' },
  { id: 'recovery', title: '恒星充能', description: '能量自然恢复速度提升 30%', icon: '☀' },
  { id: 'cooldown', title: '脉冲加速', description: '星爆冷却时间缩短 15%', icon: '⟳' },
];
const START_MASS = 36;
export const DUST_COUNT = 6000;
const GRID_SIZE = 256;
const GRID_COLUMNS = Math.ceil(ARENA.width / GRID_SIZE);

const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
const finite = value => typeof value === 'number' && Number.isFinite(value) ? value : 0;
const round = value => Math.round(value * 100) / 100;

function resetProgress(player) {
  player.level = 1;
  player.peakMass = START_MASS;
  player.upgradeMilestones = 0;
  player.upgradePending = 0;
  player.upgradeChoices = [];
  player.upgrades = {};
  player.stats = { speed: 1, growth: 1, blastRange: 1, blastCost: BLAST_COST,
    magnet: 0, maxHp: 100, energyRegen: 3, blastCooldown: 0.85 };
}

function offerUpgrade(arena, player) {
  if (player.upgradePending <= 0 || player.upgradeChoices.length) return;
  const pool = UPGRADE_POOL.filter(option => (player.upgrades[option.id] ?? 0) < 4);
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(arena.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  player.upgradeChoices = pool.slice(0, 3).map(option => ({ ...option }));
}

function updateProgress(arena, player) {
  player.peakMass = Math.max(player.peakMass, player.mass);
  while (player.upgradeMilestones < UPGRADE_THRESHOLDS.length && player.peakMass >= UPGRADE_THRESHOLDS[player.upgradeMilestones]) {
    player.upgradeMilestones++;
    player.upgradePending++;
    player.level++;
  }
  offerUpgrade(arena, player);
}

export function chooseUpgrade(arena, id, upgradeId) {
  const player = arena.players.get(id);
  if (arena.status !== 'playing' || !player || !player.upgradeChoices.some(option => option.id === upgradeId)) {
    throw new Error('这个强化选项已经失效，请从当前三个选项中选择');
  }
  const count = (player.upgrades[upgradeId] ?? 0) + 1;
  player.upgrades[upgradeId] = count;
  switch (upgradeId) {
    case 'speed': player.stats.speed = 1 + count * 0.1; break;
    case 'growth': player.stats.growth = 1 + count * 0.2; break;
    case 'range': player.stats.blastRange = 1 + count * 0.18; break;
    case 'efficiency': player.stats.blastCost = BLAST_COST * Math.pow(0.85, count); break;
    case 'magnet': player.stats.magnet = count * 25; break;
    case 'shield': player.stats.maxHp = 100 + count * 25; player.hp = Math.min(player.stats.maxHp, player.hp + 25); break;
    case 'recovery': player.stats.energyRegen = 3 * (1 + count * 0.3); break;
    case 'cooldown': player.stats.blastCooldown = 0.85 * Math.pow(0.85, count); break;
  }
  player.upgradePending--;
  player.upgradeChoices = [];
  offerUpgrade(arena, player);
}

export function normalizeInput(input = {}) {
  if (!input || typeof input !== 'object') input = {};
  let x = clamp(finite(input.x), -1, 1);
  let y = clamp(finite(input.y), -1, 1);
  const length = Math.hypot(x, y);
  if (length > 1) { x /= length; y /= length; }
  return { x, y, boost: input.boost === true, fire: input.fire === true,
    split: input.split === true, eject: input.eject === true };
}

export function cleanName(value) {
  if (typeof value !== 'string') return '流浪星球';
  const cleaned = value.normalize('NFKC').replace(/[\p{Cc}\p{Cf}<>]/gu, '').trim();
  return [...cleaned].slice(0, 14).join('') || '流浪星球';
}

export function skinColor(skin, fallback = 0) {
  const names = { lime: 0, violet: 1, coral: 2, cyan: 3 };
  const index = typeof skin === 'string' && Object.hasOwn(names, skin) ? names[skin] : skin;
  return Number.isInteger(index) && index >= 0 && index < COLORS.length ? COLORS[index] : COLORS[fallback % COLORS.length];
}

export function createArena({ random = Math.random } = {}) {
  return { status: 'lobby', time: 0, remaining: ROUND_DURATION, round: 0, winnerId: null,
    players: new Map(), dust: [], blasts: [], serial: 0, random,
    dustGrid: null, activeDust: new Set(), naturalDustCount: 0, bodyContacts: new Set(), impactSerial: 0 };
}

function spawnPosition(arena) {
  let point;
  for (let attempt = 0; attempt < 20; attempt++) {
    point = { x: ARENA.width / 2 - 1000 + arena.random() * 2000,
      y: ARENA.height / 2 - 700 + arena.random() * 1400 };
    if ([...arena.players.values()].every(p => p.respawnIn > 0 || Math.hypot(p.x - point.x, p.y - point.y) > 140)) break;
  }
  return point;
}

export function addPlayer(arena, { id, name, skin, bot = false, ready = false }) {
  if (arena.players.has(id)) return arena.players.get(id);
  if (arena.players.size >= 8) throw new Error('房间已满，最多容纳 8 人');
  const position = spawnPosition(arena);
  const player = { id, name: cleanName(name), color: skinColor(skin, arena.players.size), bot, ready,
    connected: true, ...position, vx: 0, vy: 0, radius: 24, mass: START_MASS, cells: [], hp: 100, energy: 60,
    score: 0, kills: 0, boosting: false, respawnIn: 0, invulnerable: 1.5, cooldown: 0,
    input: normalizeInput(), fireQueued: false, splitQueued: false, ejectQueued: false, shatteredAt: -10,
    pendingInputSeq: 0, lastInputSeq: 0, inputAge: 0, collisionRevision: 0, lastImpact: null, direction: { x: 1, y: 0 } };
  player.cells.push(newCell(arena, position.x, position.y, START_MASS));
  resetProgress(player);
  arena.players.set(id, player);
  return player;
}

export function setPlayerInput(arena, id, input) {
  const player = arena.players.get(id);
  if (!player) return;
  if (Number.isSafeInteger(input?.seq) && input.seq <= player.pendingInputSeq) return;
  const next = normalizeInput(input);
  if (next.fire && !player.input.fire) player.fireQueued = true;
  if (next.split && !player.input.split) player.splitQueued = true;
  if (next.eject && !player.input.eject) player.ejectQueued = true;
  player.input = next;
  if (Number.isSafeInteger(input?.seq) && input.seq >= 0) player.pendingInputSeq = Math.max(player.pendingInputSeq, input.seq);
}

function newCell(arena, x, y, mass, extra = {}) {
  return { id: `c${++arena.serial}`, x, y, mass, radius: 4 * Math.sqrt(mass),
    vx: 0, vy: 0, mergeIn: 0, impulseX: 0, impulseY: 0, protectedFor: 0, shatterCooldown: 0, ...extra };
}

function syncPlayer(player) {
  player.mass = player.cells.reduce((sum, cell) => sum + cell.mass, 0);
  if (player.mass > 0) {
    player.x = player.cells.reduce((sum, cell) => sum + cell.x * cell.mass, 0) / player.mass;
    player.y = player.cells.reduce((sum, cell) => sum + cell.y * cell.mass, 0) / player.mass;
    player.radius = Math.max(...player.cells.map(cell => cell.radius));
    player.vx = player.cells.reduce((sum, cell) => sum + finite(cell.vx) * cell.mass, 0) / player.mass;
    player.vy = player.cells.reduce((sum, cell) => sum + finite(cell.vy) * cell.mass, 0) / player.mass;
  }
}

function addDust(arena, x, y, value = 1, extra = {}) {
  const dust = { id: `d${++arena.serial}`, x: x ?? (35 + arena.random() * (ARENA.width - 70)),
    y: y ?? (35 + arena.random() * (ARENA.height - 70)), value, vx: 0, vy: 0, ...extra };
  arena.dust.push(dust);
  if (!dust.fragment && !dust.ejected) arena.naturalDustCount++;
  if (arena.dustGrid) insertDust(arena, dust);
  if (dust.vx || dust.vy) arena.activeDust.add(dust);
  arena._indexedCount = arena.dust.length;
  return dust;
}

function gridKey(x, y) {
  return Math.floor(y / GRID_SIZE) * GRID_COLUMNS + Math.floor(x / GRID_SIZE);
}

function insertDust(arena, dust) {
  const key = gridKey(dust.x, dust.y);
  let bucket = arena.dustGrid.get(key);
  if (!bucket) arena.dustGrid.set(key, bucket = []);
  bucket.push(dust);
  dust._gridKey = key;
}

function removeDustFromGrid(arena, dust) {
  const bucket = arena.dustGrid.get(dust._gridKey);
  if (!bucket) return;
  const index = bucket.indexOf(dust);
  if (index >= 0) { bucket[index] = bucket[bucket.length - 1]; bucket.pop(); }
  if (!bucket.length) arena.dustGrid.delete(dust._gridKey);
}

function rebuildDustGrid(arena) {
  arena.dustGrid = new Map();
  arena.activeDust = new Set();
  arena.naturalDustCount = 0;
  for (const dust of arena.dust) {
    insertDust(arena, dust);
    if (Math.abs(finite(dust.vx)) + Math.abs(finite(dust.vy)) > 0.05) arena.activeDust.add(dust);
    if (!dust.ejected && !dust.fragment) arena.naturalDustCount++;
  }
  arena._indexedDust = arena.dust;
  arena._indexedCount = arena.dust.length;
}

function ensureDustGrid(arena) {
  if (!arena.dustGrid || arena._indexedDust !== arena.dust || arena._indexedCount !== arena.dust.length) rebuildDustGrid(arena);
}

function visitDustRect(arena, left, top, right, bottom, visit) {
  const minX = Math.max(0, Math.floor(left / GRID_SIZE));
  const maxX = Math.min(GRID_COLUMNS - 1, Math.floor(right / GRID_SIZE));
  const minY = Math.max(0, Math.floor(top / GRID_SIZE));
  const maxY = Math.min(Math.ceil(ARENA.height / GRID_SIZE) - 1, Math.floor(bottom / GRID_SIZE));
  for (let gy = minY; gy <= maxY; gy++) {
    for (let gx = minX; gx <= maxX; gx++) {
      const bucket = arena.dustGrid.get(gy * GRID_COLUMNS + gx);
      if (bucket) for (const dust of bucket) {
        if (!dust._consumed && dust.x >= left && dust.x <= right && dust.y >= top && dust.y <= bottom) visit(dust);
      }
    }
  }
}

function viewportBounds(view) {
  if (!view || !Number.isFinite(view.x) || !Number.isFinite(view.y) ||
      !Number.isFinite(view.width) || !Number.isFinite(view.height) || view.width <= 0 || view.height <= 0) return null;
  const margin = Number.isFinite(view.margin) ? Math.max(0, view.margin) : 180;
  return { left: view.x - view.width / 2 - margin, right: view.x + view.width / 2 + margin,
    top: view.y - view.height / 2 - margin, bottom: view.y + view.height / 2 + margin };
}

/** Query raw particles within a viewport centered on world x/y, using the grid. */
export function queryDust(arena, view) {
  const bounds = viewportBounds(view);
  if (!bounds) return arena.dust;
  ensureDustGrid(arena);
  const found = [];
  visitDustRect(arena, bounds.left, bounds.top, bounds.right, bounds.bottom, dust => found.push(dust));
  return found;
}

function seedNearbyDust(arena, player, count) {
  for (let i = 0; i < count; i++) {
    const angle = arena.random() * Math.PI * 2;
    const distance = 80 + arena.random() * 420;
    addDust(arena, clamp(player.x + Math.cos(angle) * distance, 35, ARENA.width - 35),
      clamp(player.y + Math.sin(angle) * distance, 35, ARENA.height - 35));
  }
}

function refillDust(arena) {
  const players = arena.round > 0 ? [...arena.players.values()].filter(p => p.respawnIn <= 0) : [];
  while (arena.naturalDustCount < DUST_COUNT) {
    if (players.length && arena.random() < 0.3) {
      const player = players[Math.min(players.length - 1, Math.floor(arena.random() * players.length))];
      const angle = arena.random() * Math.PI * 2;
      const distance = 850 + arena.random() * 650;
      addDust(arena, clamp(player.x + Math.cos(angle) * distance, 35, ARENA.width - 35),
        clamp(player.y + Math.sin(angle) * distance, 35, ARENA.height - 35));
    } else addDust(arena);
  }
}

export function startRound(arena) {
  arena.status = 'playing';
  arena.time = 0;
  arena.remaining = ROUND_DURATION;
  arena.round++;
  arena.winnerId = null;
  arena.dust = [];
  arena.dustGrid = null;
  arena.naturalDustCount = 0;
  arena.activeDust = new Set();
  arena.blasts = [];
  arena.bodyContacts = new Set();
  arena.impactSerial = 0;
  for (const player of arena.players.values()) {
    Object.assign(player, spawnPosition(arena), { vx: 0, vy: 0, hp: 100, energy: 60, score: 0, kills: 0,
      boosting: false, respawnIn: 0, invulnerable: 1.5, cooldown: 0, fireQueued: false, splitQueued: false,
      ejectQueued: false, shatteredAt: -10, collisionRevision: 0, lastImpact: null,
      pendingInputSeq: 0, lastInputSeq: 0, inputAge: 0, input: normalizeInput() });
    player.cells = [newCell(arena, player.x, player.y, START_MASS)];
    syncPlayer(player);
    resetProgress(player);
  }
  for (const player of arena.players.values()) seedNearbyDust(arena, player, 24);
  for (let i = arena.naturalDustCount; i < Math.min(DUST_COUNT, 650); i++) {
    addDust(arena, ARENA.width / 2 - 1300 + arena.random() * 2600,
      ARENA.height / 2 - 950 + arena.random() * 1900);
  }
  refillDust(arena);
  rebuildDustGrid(arena);
}

function botInput(arena, player) {
  let target = null;
  let distance = Infinity;
  for (const range of [300, 700, 1500]) {
    visitDustRect(arena, player.x - range, player.y - range, player.x + range, player.y + range, dust => {
      const dx = dust.x - player.x, dy = dust.y - player.y;
      const d = dx * dx + dy * dy;
      if (d < distance) { distance = d; target = dust; }
    });
    if (target) break;
  }
  const opponents = [...arena.players.values()].filter(p => p.id !== player.id && p.respawnIn <= 0);
  const enemy = opponents.sort((a, b) => Math.hypot(a.x - player.x, a.y - player.y) - Math.hypot(b.x - player.x, b.y - player.y))[0];
  const enemyDistance = enemy ? Math.hypot(enemy.x - player.x, enemy.y - player.y) : Infinity;
  if (enemyDistance < 240 && (player.mass > (enemy?.mass ?? Infinity) * 1.3 || player.energy >= player.stats.blastCost)) target = enemy;
  if (!target) target = { x: ARENA.width / 2, y: ARENA.height / 2 };
  const dx = target.x - player.x;
  const dy = target.y - player.y;
  const length = Math.hypot(dx, dy) || 1;
  const flee = enemyDistance < 200 && (enemy?.mass ?? 0) > player.mass * 1.25;
  return { x: dx / length * (flee ? -1 : 1), y: dy / length * (flee ? -1 : 1), boost: flee,
    split: enemyDistance > 140 && enemyDistance < 320 && player.cells.length === 1 && player.mass > (enemy?.mass ?? Infinity) * 3,
    fire: enemyDistance < 175 && player.cooldown <= 0 && player.energy >= player.stats.blastCost };
}

function destroyPlayer(arena, victim, ownerId, dropDust = true) {
  const owner = arena.players.get(ownerId);
  if (owner && owner.id !== victim.id) { owner.score += 25; owner.kills++; }
  victim.hp = 0;
  victim.respawnIn = 2;
  victim.boosting = false;
  victim.vx = victim.vy = 0;
  victim.cells = [];
  victim.mass = 0;
  for (let i = 0; dropDust && i < 7; i++) {
    const angle = arena.random() * Math.PI * 2;
    const distance = 12 + arena.random() * 48;
    addDust(arena, clamp(victim.x + Math.cos(angle) * distance, 24, ARENA.width - 24),
      clamp(victim.y + Math.sin(angle) * distance, 24, ARENA.height - 24));
  }
}

function splitPlayer(arena, player, direction = player.direction) {
  for (const cell of [...player.cells]) {
    if (player.cells.length >= 8) break;
    if (cell.mass < 48) continue;
    cell.mass /= 2;
    cell.radius = 4 * Math.sqrt(cell.mass);
    cell.mergeIn = 12;
    const { x, y } = direction;
    // Start the launched half beyond the parent's edge. Spawning overlapping
    // halves makes collision separation push the parent against its input.
    const separation = cell.radius * 2 + 2;
    const child = newCell(arena, cell.x + x * separation, cell.y + y * separation, cell.mass,
      { mergeIn: 12, vx: cell.vx + x * 650, vy: cell.vy + y * 650 });
    player.cells.push(child);
  }
}

function ejectMass(arena, player, direction = player.direction) {
  const { x, y } = direction;
  for (const cell of player.cells) {
    if (cell.mass < 16) continue;
    cell.mass -= 3;
    cell.radius = 4 * Math.sqrt(cell.mass);
    addDust(arena, clamp(cell.x + x * (cell.radius + 14), 8, ARENA.width - 8),
      clamp(cell.y + y * (cell.radius + 14), 8, ARENA.height - 8), 3,
      { ownerId: player.id, availableAt: arena.time + 0.9, ejected: true, color: player.color, vx: x * 270, vy: y * 270 });
  }
}

/** Exact integration of acceleration toward a target velocity, in world units. */
export function integrateMotion(cell, input, speed, dt) {
  const moving = Math.hypot(input.x, input.y) > 0;
  const rate = moving ? MOTION.response : MOTION.drag;
  const targetX = input.x * speed, targetY = input.y * speed;
  const decay = Math.exp(-rate * dt);
  const initialX = finite(cell.vx), initialY = finite(cell.vy);
  cell.x += targetX * dt + (initialX - targetX) * (1 - decay) / rate;
  cell.y += targetY * dt + (initialY - targetY) * (1 - decay) / rate;
  cell.vx = targetX + (initialX - targetX) * decay;
  cell.vy = targetY + (initialY - targetY) * decay;
  if (!moving && Math.hypot(cell.vx, cell.vy) < MOTION.stopSpeed) cell.vx = cell.vy = 0;
}

function confineCell(cell) {
  const bounce = velocity => Math.abs(velocity) > MOTION.restingThreshold ? -velocity * MOTION.restitution : 0;
  if (cell.x < cell.radius) { cell.x = cell.radius; if (cell.vx < 0) cell.vx = bounce(cell.vx); }
  if (cell.x > ARENA.width - cell.radius) { cell.x = ARENA.width - cell.radius; if (cell.vx > 0) cell.vx = bounce(cell.vx); }
  if (cell.y < cell.radius) { cell.y = cell.radius; if (cell.vy < 0) cell.vy = bounce(cell.vy); }
  if (cell.y > ARENA.height - cell.radius) { cell.y = ARENA.height - cell.radius; if (cell.vy > 0) cell.vy = bounce(cell.vy); }
}

function moveCells(player, input, dt) {
  for (const cell of player.cells) {
    cell._stepX = cell.x;
    cell._stepY = cell.y;
    cell.mergeIn = Math.max(0, cell.mergeIn - dt);
    cell.protectedFor = Math.max(0, cell.protectedFor - dt);
    cell.shatterCooldown = Math.max(0, cell.shatterCooldown - dt);
    const speed = (player.boosting ? 360 : 210) * player.stats.speed * Math.pow(START_MASS / cell.mass, 0.18);
    cell.vx = finite(cell.vx) + finite(cell.impulseX);
    cell.vy = finite(cell.vy) + finite(cell.impulseY);
    cell.impulseX = cell.impulseY = 0;
    integrateMotion(cell, input, speed, dt);
    confineCell(cell);
  }
  for (let i = 0; i < player.cells.length; i++) {
    for (let j = i + 1; j < player.cells.length; j++) {
      const a = player.cells[i], b = player.cells[j];
      const dx = b.x - a.x, dy = b.y - a.y;
      const distance = Math.hypot(dx, dy);
      if (a.mergeIn <= 0 && b.mergeIn <= 0 && distance < (a.radius + b.radius) * 0.9) {
        const mass = a.mass + b.mass;
        a.x = (a.x * a.mass + b.x * b.mass) / mass;
        a.y = (a.y * a.mass + b.y * b.mass) / mass;
        a.vx = (a.vx * a.mass + b.vx * b.mass) / mass;
        a.vy = (a.vy * a.mass + b.vy * b.mass) / mass;
        a.mass = mass;
        a.radius = 4 * Math.sqrt(mass);
        player.cells.splice(j--, 1);
      } else if ((a.mergeIn > 0 || b.mergeIn > 0) && distance < a.radius + b.radius) {
        const ux = distance > 0 ? dx / distance : 1, uy = distance > 0 ? dy / distance : 0;
        resolveBodyPair({ player, cell: a }, { player, cell: b }, ux, uy);
      }
    }
  }
  for (const cell of player.cells) {
    confineCell(cell);
  }
  syncPlayer(player);
}

function shatterCell(arena, player, cell, collider, closingSpeed = 0) {
  if (cell.mass < 16 || cell.protectedFor > 0 || cell.shatterCooldown > 0) return false;
  const count = cell.mass >= 64 ? 3 : 2;
  const mass = cell.mass / (count + 1);
  const angle = Math.atan2(cell.y - collider.y, cell.x - collider.x);
  const inheritedX = cell.vx, inheritedY = cell.vy;
  const scatterSpeed = Math.min(300, 20 + closingSpeed * 0.35);
  cell.mass = mass;
  cell.radius = 4 * Math.sqrt(cell.mass);
  cell.protectedFor = 1;
  cell.shatterCooldown = 3;
  cell.vx = inheritedX + Math.cos(angle) * scatterSpeed;
  cell.vy = inheritedY + Math.sin(angle) * scatterSpeed;
  for (let i = 0; i < count; i++) {
    const direction = angle + (i + 1) * Math.PI * 2 / (count + 1);
    const ux = Math.cos(direction), uy = Math.sin(direction);
    const distance = cell.radius + 14;
    addDust(arena, clamp(cell.x + ux * distance, 8, ARENA.width - 8),
      clamp(cell.y + uy * distance, 8, ARENA.height - 8), mass,
      { fragment: true, color: player.color, ownerId: player.id, collectAfter: arena.time + 0.3,
        availableAt: arena.time + 0.9, vx: inheritedX + ux * scatterSpeed, vy: inheritedY + uy * scatterSpeed });
  }
  player.shatteredAt = arena.time;
  syncPlayer(player);
  return true;
}

function chipCollider(arena, body, other, closingSpeed = 0) {
  const cell = body.cell;
  const lost = Math.min(cell.mass * 0.05, Math.max(0, cell.mass - 8));
  if (lost <= 0) return;
  const count = cell.mass >= 64 ? 3 : 2;
  const inheritedX = cell.vx, inheritedY = cell.vy;
  const scatterSpeed = Math.min(240, 12 + closingSpeed * 0.25);
  cell.mass -= lost;
  cell.radius = 4 * Math.sqrt(cell.mass);
  const angle = Math.atan2(other.y - cell.y, other.x - cell.x);
  for (let i = 0; i < count; i++) {
    const direction = angle + (i - (count - 1) / 2) * 0.7;
    const ux = Math.cos(direction), uy = Math.sin(direction);
    const scatterX = ux * scatterSpeed, scatterY = uy * scatterSpeed;
    addDust(arena, clamp(cell.x + ux * (cell.radius + 14), 8, ARENA.width - 8),
      clamp(cell.y + uy * (cell.radius + 14), 8, ARENA.height - 8), lost / count,
      { fragment: true, color: body.player.color, ownerId: body.player.id,
        collectAfter: arena.time + 0.3, availableAt: arena.time + 0.9,
        vx: inheritedX + scatterX, vy: inheritedY + scatterY });
    cell.vx -= lost / count / cell.mass * scatterX;
    cell.vy -= lost / count / cell.mass * scatterY;
  }
}

function bodyContact(a, b) {
  const ac = a.cell, bc = b.cell;
  const ax = ac._stepX ?? ac.x, ay = ac._stepY ?? ac.y;
  const bx = bc._stepX ?? bc.x, by = bc._stepY ?? bc.y;
  const dx = bx - ax, dy = by - ay;
  const vx = (bc.x - bx) - (ac.x - ax), vy = (bc.y - by) - (ac.y - ay);
  const radius = ac.radius + bc.radius;
  const c = dx * dx + dy * dy - radius * radius;
  let time = 0;
  if (c > 0.000001) {
    const quadratic = vx * vx + vy * vy;
    if (quadratic < 1e-12) return null;
    const linear = 2 * (dx * vx + dy * vy);
    const discriminant = linear * linear - 4 * quadratic * c;
    if (discriminant < 0) return null;
    time = (-linear - Math.sqrt(discriminant)) / (2 * quadratic);
    if (time < 0 || time > 1) return null;
  }
  let nx = dx + vx * time, ny = dy + vy * time;
  const length = Math.hypot(nx, ny);
  if (length > 1e-9) { nx /= length; ny /= length; }
  else { nx = 1; ny = 0; }
  return { a, b, time, nx, ny, key: `${a.key}|${b.key}` };
}

function travelRoom(cell, nx, ny) {
  let room = Infinity;
  if (nx > 1e-9) room = Math.min(room, (ARENA.width - cell.radius - cell.x) / nx);
  else if (nx < -1e-9) room = Math.min(room, (cell.radius - cell.x) / nx);
  if (ny > 1e-9) room = Math.min(room, (ARENA.height - cell.radius - cell.y) / ny);
  else if (ny < -1e-9) room = Math.min(room, (cell.radius - cell.y) / ny);
  return Math.max(0, room);
}

function resolveBodyPair(a, b, nx, ny) {
  const ac = a.cell, bc = b.cell;
  const inverseA = 1 / ac.mass, inverseB = 1 / bc.mass;
  const inverseSum = inverseA + inverseB;
  const penetration = ac.radius + bc.radius - ((bc.x - ac.x) * nx + (bc.y - ac.y) * ny);
  let changed = false;
  if (penetration > 1e-7) {
    const capacityA = travelRoom(ac, -nx, -ny), capacityB = travelRoom(bc, nx, ny);
    const beforeAX = ac.x, beforeAY = ac.y, beforeBX = bc.x, beforeBY = bc.y;
    let moveA = Math.min(capacityA, penetration * inverseA / inverseSum);
    let moveB = Math.min(capacityB, penetration - moveA);
    moveA = Math.min(capacityA, penetration - moveB);
    ac.x -= nx * moveA; ac.y -= ny * moveA;
    bc.x += nx * moveB; bc.y += ny * moveB;
    if (moveA + moveB < penetration - 1e-7) {
      // At a corner, each circle can have its normal blocked by a different
      // wall. Project the remaining correction onto legal wall tangents.
      const remaining = penetration - moveA - moveB;
      const slideA = remaining * inverseA / inverseSum, slideB = remaining * inverseB / inverseSum;
      ac.x = clamp(ac.x - nx * slideA, ac.radius, ARENA.width - ac.radius);
      ac.y = clamp(ac.y - ny * slideA, ac.radius, ARENA.height - ac.radius);
      bc.x = clamp(bc.x + nx * slideB, bc.radius, ARENA.width - bc.radius);
      bc.y = clamp(bc.y + ny * slideB, bc.radius, ARENA.height - bc.radius);
    }
    changed = Math.abs(ac.x - beforeAX) + Math.abs(ac.y - beforeAY) + Math.abs(bc.x - beforeBX) + Math.abs(bc.y - beforeBY) > 1e-7;
  }
  const approaching = (bc.vx - ac.vx) * nx + (bc.vy - ac.vy) * ny;
  if (approaching < -1e-7) {
    const restitution = -approaching > MOTION.restingThreshold ? MOTION.restitution : 0;
    const impulse = -(1 + restitution) * approaching / inverseSum;
    ac.vx -= impulse * inverseA * nx; ac.vy -= impulse * inverseA * ny;
    bc.vx += impulse * inverseB * nx; bc.vy += impulse * inverseB * ny;
    changed = true;
  }
  // Revisions identify a significant discontinuity, not every substep of a
  // resting contact. Low-speed support forces must not look like teleports.
  if (changed && (penetration > 0.5 || -approaching > MOTION.restingThreshold)) {
    a.player.collisionRevision++;
    if (b.player !== a.player) b.player.collisionRevision++;
  }
}

function constrainWallVelocity(cell) {
  const slop = MOTION.contactSlop;
  const response = (velocity, gap) => {
    if (Math.abs(velocity) <= MOTION.restingThreshold) return 0;
    // Slop supports resting bodies; a fast body across a positive gap must
    // reach the wall before receiving its real impact and restitution.
    return gap <= 1e-7 ? -velocity * MOTION.restitution : velocity;
  };
  if (cell.x <= cell.radius + slop && cell.vx < 0) cell.vx = response(cell.vx, cell.x - cell.radius);
  if (cell.x >= ARENA.width - cell.radius - slop && cell.vx > 0) cell.vx = response(cell.vx, ARENA.width - cell.radius - cell.x);
  if (cell.y <= cell.radius + slop && cell.vy < 0) cell.vy = response(cell.vy, cell.y - cell.radius);
  if (cell.y >= ARENA.height - cell.radius - slop && cell.vy > 0) cell.vy = response(cell.vy, ARENA.height - cell.radius - cell.y);
}

function constrainContactVelocities(bodies) {
  const touching = [];
  for (let i = 0; i < bodies.length; i++) for (let j = i + 1; j < bodies.length; j++) {
    const a = bodies[i], b = bodies[j];
    if (a.player === b.player && a.cell.mergeIn <= 0 && b.cell.mergeIn <= 0) continue;
    const dx = b.cell.x - a.cell.x, dy = b.cell.y - a.cell.y;
    const limit = a.cell.radius + b.cell.radius + MOTION.contactSlop;
    const coarseLimit = limit + 1e-9;
    if (Math.abs(dx) > coarseLimit || Math.abs(dy) > coarseLimit) continue;
    const squaredDistance = dx * dx + dy * dy;
    if (squaredDistance > coarseLimit * coarseLimit) continue;
    const distance = Math.hypot(dx, dy);
    if (distance > limit) continue;
    touching.push({ a: a.cell, b: b.cell, nx: distance > 1e-9 ? dx / distance : 1,
      ny: distance > 1e-9 ? dy / distance : 0, gap: distance - a.cell.radius - b.cell.radius });
  }
  // Solve velocity and wall constraints together. Otherwise a wall-pinned
  // chain can publish forward velocity while all of its positions stand still.
  for (let iteration = 0; iteration < 512; iteration++) {
    for (const body of bodies) constrainWallVelocity(body.cell);
    let closing = 0;
    for (const pair of touching) {
      const { a, b, nx, ny } = pair;
      const relative = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
      if (relative >= -1e-6) continue;
      if (pair.gap > 1e-7 && -relative > MOTION.restingThreshold) continue;
      closing = Math.max(closing, -relative);
      const inverseA = 1 / a.mass, inverseB = 1 / b.mass;
      const impulse = -relative / (inverseA + inverseB);
      a.vx -= impulse * inverseA * nx; a.vy -= impulse * inverseA * ny;
      b.vx += impulse * inverseB * nx; b.vy += impulse * inverseB * ny;
    }
    if (closing < 1e-5) break;
  }
  for (const body of bodies) constrainWallVelocity(body.cell);
}

function resolvePlayerBodies(arena) {
  const bodies = [];
  for (const player of arena.players.values()) if (player.respawnIn <= 0) {
    for (const cell of player.cells) bodies.push({ player, cell, key: `${player.id}:${cell.id}` });
  }
  bodies.sort((a, b) => a.key.localeCompare(b.key));
  const contacts = [];
  for (let i = 0; i < bodies.length; i++) for (let j = i + 1; j < bodies.length; j++) {
    if (bodies[i].player === bodies[j].player) continue;
    const contact = bodyContact(bodies[i], bodies[j]);
    if (contact) contacts.push(contact);
  }
  contacts.sort((a, b) => a.time - b.time || a.key.localeCompare(b.key));
  for (const contact of contacts) {
    const { a, b, nx, ny, key } = contact;
    const closingSpeed = Math.max(0, -((b.cell.vx - a.cell.vx) * nx + (b.cell.vy - a.cell.vy) * ny));
    resolveBodyPair(a, b, nx, ny);
    if (arena.bodyContacts.has(key)) continue;
    const impactPoint = { x: a.cell.x + nx * a.cell.radius, y: a.cell.y + ny * a.cell.radius,
      radius: Math.min(32, Math.min(a.cell.radius, b.cell.radius) * 0.65) };
    let fractured = false;
    if (a.cell.mass !== b.cell.mass) {
      const big = a.cell.mass > b.cell.mass ? a : b;
      const small = big === a ? b : a;
      if (small.player.invulnerable <= 0 && shatterCell(arena, small.player, small.cell, big.cell, closingSpeed)) {
        chipCollider(arena, big, small.cell, closingSpeed);
        big.player.collisionRevision++; small.player.collisionRevision++;
        fractured = true;
      }
    }
    if (closingSpeed > 12 || fractured) {
      const impact = { id: `impact-${arena.round}-${++arena.impactSerial}`, at: arena.time,
        x: impactPoint.x, y: impactPoint.y, normalX: nx, normalY: ny, speed: closingSpeed,
        radius: impactPoint.radius, fractured };
      a.player.lastImpact = b.player.lastImpact = impact;
    }
  }
  // Resolve secondary overlaps in piles, including particles pinned to a wall.
  for (let iteration = 0; iteration < 512; iteration++) {
    let overlap = false;
    for (let i = 0; i < bodies.length; i++) for (let j = i + 1; j < bodies.length; j++) {
      const a = bodies[i], b = bodies[j];
      if (a.player === b.player) continue;
      const dx = b.cell.x - a.cell.x, dy = b.cell.y - a.cell.y;
      const radius = a.cell.radius + b.cell.radius;
      const coarseRadius = radius - 1e-6 + 1e-9;
      if (Math.abs(dx) > coarseRadius || Math.abs(dy) > coarseRadius) continue;
      const squaredDistance = dx * dx + dy * dy;
      if (squaredDistance > coarseRadius * coarseRadius) continue;
      const distance = Math.hypot(dx, dy);
      if (distance >= radius - 1e-6) continue;
      overlap = true;
      resolveBodyPair(a, b, distance > 1e-9 ? dx / distance : 1, distance > 1e-9 ? dy / distance : 0);
    }
    if (!overlap) break;
  }
  const current = new Set();
  for (let i = 0; i < bodies.length; i++) for (let j = i + 1; j < bodies.length; j++) {
    const a = bodies[i], b = bodies[j];
    if (a.player === b.player) continue;
    const radius = a.cell.radius + b.cell.radius;
    const dx = a.cell.x - b.cell.x, dy = a.cell.y - b.cell.y;
    const limit = radius + 0.5 + 1e-9;
    if (Math.abs(dx) > limit || Math.abs(dy) > limit) continue;
    const squaredDistance = dx * dx + dy * dy;
    if (squaredDistance > limit * limit) continue;
    const key = `${a.key}|${b.key}`;
    const gap = Math.hypot(dx, dy) - radius;
    if (gap <= 1e-6 || (arena.bodyContacts.has(key) && gap <= 0.5)) {
      current.add(key);
    }
  }
  arena.bodyContacts = current;
  constrainContactVelocities(bodies);
  for (const player of arena.players.values()) syncPlayer(player);
}

export function gravityRadius(cell, player) {
  return cell.radius + 70 + Math.sqrt(cell.mass) * 3 + player.stats.magnet;
}

function gravityStrength(cell) {
  // Smoothly bounded, strictly increasing mass scaling. Base-mass planets
  // retain their original pull; large planets have stronger, faster inflow.
  const scale = Math.pow(Math.max(1, finite(cell.mass)) / START_MASS, 0.35);
  return 6 * scale / (5 + scale);
}

function attractDust(arena, dt) {
  if (dt <= 0) return;
  const targets = new Map();
  for (const player of arena.players.values()) {
    if (player.respawnIn > 0) continue;
    for (const cell of player.cells) {
      const range = gravityRadius(cell, player);
      const strength = gravityStrength(cell);
      visitDustRect(arena, cell.x - range, cell.y - range, cell.x + range, cell.y + range, dust => {
        if (arena.time < (dust.collectAfter ?? 0) || (dust.ownerId === player.id && arena.time < dust.availableAt)) return;
        const dx = cell.x - dust.x, dy = cell.y - dust.y;
        const distanceSquared = dx * dx + dy * dy;
        if (distanceSquared > range * range) return;
        const force = cell.mass / Math.max(1, distanceSquared);
        const previous = targets.get(dust);
        if (!previous || force > previous.force) targets.set(dust, { force, cell, distanceSquared, range, strength });
        arena.activeDust.add(dust);
      });
    }
  }
  const damping = Math.exp(-2.3 * dt);
  for (const dust of arena.activeDust) {
    const target = targets.get(dust);
    let vx = finite(dust.vx), vy = finite(dust.vy);
    if (target && target.distanceSquared > 0.000001) {
      const distance = Math.sqrt(target.distanceSquared);
      const acceleration = (280 + 600 * (1 - distance / target.range)) * target.strength;
      vx += (target.cell.x - dust.x) / distance * acceleration * dt;
      vy += (target.cell.y - dust.y) / distance * acceleration * dt;
    }
    const speed = Math.hypot(vx, vy);
    const maxSpeed = target ? 420 * Math.sqrt(target.strength) : 420;
    if (speed > maxSpeed) { vx *= maxSpeed / speed; vy *= maxSpeed / speed; }
    dust.x = clamp(dust.x + vx * dt, 8, ARENA.width - 8);
    dust.y = clamp(dust.y + vy * dt, 8, ARENA.height - 8);
    dust.vx = vx * damping;
    dust.vy = vy * damping;
    if (gridKey(dust.x, dust.y) !== dust._gridKey) { removeDustFromGrid(arena, dust); insertDust(arena, dust); }
    if (!target && Math.abs(dust.vx) + Math.abs(dust.vy) < 0.05) {
      dust.vx = dust.vy = 0;
      arena.activeDust.delete(dust);
    }
  }
}

function collectDust(arena) {
  const consumed = [];
  for (const player of arena.players.values()) {
    if (player.respawnIn > 0) continue;
    for (const cell of player.cells) {
      const range = cell.radius + 5;
      visitDustRect(arena, cell.x - range, cell.y - range, cell.x + range, cell.y + range, dust => {
        if (dust._consumed || arena.time < (dust.collectAfter ?? 0) ||
          (dust.ownerId === player.id && arena.time < dust.availableAt)) return;
        const dx = dust.x - cell.x, dy = dust.y - cell.y;
        if (dx * dx + dy * dy > (cell.radius + 5) ** 2) return;
        cell.mass += dust.value * (dust.ejected || dust.fragment ? 1 : player.stats.growth);
        cell.radius = 4 * Math.sqrt(cell.mass);
        if (!dust.ejected && !dust.fragment) {
          player.score += 2 * dust.value;
          player.energy = Math.min(100, player.energy + 4 * dust.value);
          arena.naturalDustCount--;
        }
        dust._consumed = true;
        consumed.push(dust);
      });
    }
    syncPlayer(player);
  }
  if (consumed.length) {
    for (const dust of consumed) { removeDustFromGrid(arena, dust); arena.activeDust.delete(dust); }
    arena.dust = arena.dust.filter(dust => !dust._consumed);
    arena._indexedDust = arena.dust;
    arena._indexedCount = arena.dust.length;
  }
  return consumed.length;
}

function mainCell(player) {
  return player.cells.reduce((largest, cell) => !largest || cell.mass > largest.mass ? cell : largest, null);
}

function updateFacing(player, input) {
  const source = mainCell(player);
  const speed = source ? Math.hypot(source.vx, source.vy) : 0;
  if (speed >= 5) player.direction = { x: source.vx / speed, y: source.vy / speed };
  else {
    const length = Math.hypot(input.x, input.y);
    if (length > 0) player.direction = { x: input.x / length, y: input.y / length };
  }
}

function launchWave(arena, player) {
  const source = mainCell(player);
  if (!source || player.respawnIn > 0 || player.energy < player.stats.blastCost || player.cooldown > 0) return;
  const speed = Math.hypot(source.vx, source.vy);
  const direction = speed >= 5 ? { x: source.vx / speed, y: source.vy / speed } : player.direction;
  const originOffset = source.radius + WAVE.curvature + WAVE.thickness / 2 + 4;
  const x = source.x + direction.x * originOffset, y = source.y + direction.y * originOffset;
  player.energy -= player.stats.blastCost;
  player.cooldown = player.stats.blastCooldown;
  arena.blasts.push({ id: `b${++arena.serial}`, ownerId: player.id, kind: 'wave', sourceCellId: source.id,
    x, y, originX: x, originY: y, originOffset, directionX: direction.x, directionY: direction.y,
    width: WAVE.width, thickness: WAVE.thickness, curvature: WAVE.curvature,
    speed: WAVE.speed, distance: WAVE.distance * player.stats.blastRange, travel: 0,
    color: player.color, radius: WAVE.width / 2 + WAVE.curvature + WAVE.thickness / 2, hit: new Set() });
}

/** A forward arc; its tips trail its center by curvature world units. */
export function waveArcPoint(wave, u) {
  const sideways = u * wave.width / 2;
  const backwards = wave.curvature * u * u;
  return { x: wave.x - wave.directionY * sideways - wave.directionX * backwards,
    y: wave.y + wave.directionX * sideways - wave.directionY * backwards };
}

function pointSegmentDistanceSquared(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const length = dx * dx + dy * dy;
  const t = length > 0 ? clamp(((px - ax) * dx + (py - ay) * dy) / length, 0, 1) : 0;
  return (px - ax - t * dx) ** 2 + (py - ay - t * dy) ** 2;
}

function segmentDistanceSquared(ax, ay, bx, by, cx, cy, dx, dy) {
  const rx = bx - ax, ry = by - ay, sx = dx - cx, sy = dy - cy;
  const denominator = rx * sy - ry * sx;
  if (Math.abs(denominator) > 1e-10) {
    const qx = cx - ax, qy = cy - ay;
    const t = (qx * sy - qy * sx) / denominator;
    const u = (qx * ry - qy * rx) / denominator;
    if (t >= 0 && t <= 1 && u >= 0 && u <= 1) return 0;
  }
  return Math.min(pointSegmentDistanceSquared(ax, ay, cx, cy, dx, dy),
    pointSegmentDistanceSquared(bx, by, cx, cy, dx, dy),
    pointSegmentDistanceSquared(cx, cy, ax, ay, bx, by),
    pointSegmentDistanceSquared(dx, dy, ax, ay, bx, by));
}

function advanceWaves(arena, dt) {
  for (const wave of arena.blasts) {
    const previousX = wave.x, previousY = wave.y;
    const remaining = wave.distance - wave.travel;
    const activeFraction = dt > 0 ? Math.min(1, remaining / (wave.speed * dt)) : 1;
    wave.travel = Math.min(wave.distance, wave.travel + wave.speed * dt);
    wave.x = wave.originX + wave.directionX * wave.travel;
    wave.y = wave.originY + wave.directionY * wave.travel;
    const deltaX = wave.x - previousX, deltaY = wave.y - previousY;
    const arc = [];
    for (let i = 0; i <= WAVE.segments; i++) {
      const point = waveArcPoint(wave, -1 + 2 * i / WAVE.segments);
      arc.push({ x: point.x - deltaX, y: point.y - deltaY });
    }
    for (const player of arena.players.values()) {
      if (player.id === wave.ownerId || player.respawnIn > 0 || player.invulnerable > 0 || wave.hit.has(player.id)) continue;
      const hit = player.cells.some(cell => {
        const radiusSquared = (cell.radius + wave.thickness / 2) ** 2;
        const startX = cell._frameX ?? cell._stepX ?? cell.x, startY = cell._frameY ?? cell._stepY ?? cell.y;
        const endX = startX + (cell.x - startX) * activeFraction - deltaX;
        const endY = startY + (cell.y - startY) * activeFraction - deltaY;
        for (let i = 1; i < arc.length; i++) {
          if (segmentDistanceSquared(startX, startY, endX, endY,
            arc[i - 1].x, arc[i - 1].y, arc[i].x, arc[i].y) <= radiusSquared) return true;
        }
        return false;
      });
      if (hit) {
        wave.hit.add(player.id);
        player.hp = Math.max(0, player.hp - 40);
        if (player.hp === 0) destroyPlayer(arena, player, wave.ownerId);
      }
    }
  }
  arena.blasts = arena.blasts.filter(wave => wave.travel < wave.distance);
}

export function stepArena(arena, elapsed) {
  if (arena.status !== 'playing') return;
  const dt = clamp(finite(elapsed), 0, 0.1);
  arena.time += dt;
  arena.remaining = Math.max(0, ROUND_DURATION - arena.time);
  // One linear grid rebuild replaces repeated all-particle scans for bots,
  // gravity and pickups. Moving particles update only their changed buckets.
  rebuildDustGrid(arena);
  const movers = [];
  for (const player of arena.players.values()) {
    if (player.bot) setPlayerInput(arena, player.id, botInput(arena, player));
    if (player.bot && player.upgradeChoices.length) chooseUpgrade(arena, player.id, player.upgradeChoices[0].id);
    player.cooldown = Math.max(0, player.cooldown - dt);
    player.invulnerable = Math.max(0, player.invulnerable - dt);
    if (player.respawnIn > 0) {
      player.respawnIn = Math.max(0, player.respawnIn - dt);
      player.fireQueued = player.splitQueued = player.ejectQueued = false;
      if (player.respawnIn === 0) {
        Object.assign(player, spawnPosition(arena), { hp: player.stats.maxHp, energy: 45, invulnerable: 2 });
        player.cells = [newCell(arena, player.x, player.y, START_MASS)];
        syncPlayer(player);
      }
      continue;
    }
    const input = player.connected ? player.input : normalizeInput();
    const moving = Math.hypot(input.x, input.y) > 0;
    const actionDirection = moving ? { x: input.x / Math.hypot(input.x, input.y), y: input.y / Math.hypot(input.x, input.y) } : player.direction;
    player.boosting = input.boost && moving && player.energy > 1;
    player.energy = clamp(player.energy + dt * (player.boosting ? -13 : player.stats.energyRegen), 0, 100);
    if (player.splitQueued) splitPlayer(arena, player, actionDirection);
    if (player.ejectQueued) ejectMass(arena, player, actionDirection);
    player.splitQueued = player.ejectQueued = false;
    if (player.pendingInputSeq !== player.lastInputSeq) player.inputAge = 0;
    for (const cell of player.cells) { cell._frameX = cell.x; cell._frameY = cell.y; }
    movers.push({ player, input });
  }

  // Keep the expensive dust grid at the network simulation rate, while solid
  // contacts advance in short steps so glancing bodies follow changing normals.
  const steps = Math.max(1, Math.ceil(dt / MOTION.physicsStep - 1e-9));
  const substep = dt / steps;
  for (let i = 0; i < steps; i++) {
    for (const { player, input } of movers) moveCells(player, input, substep);
    resolvePlayerBodies(arena);
  }
  for (const { player, input } of movers) {
    player.inputAge += dt;
    player.lastInputSeq = player.pendingInputSeq;
    updateFacing(player, input);
  }

  attractDust(arena, dt);
  if (collectDust(arena)) {
    // Collection can enlarge a body after its movement has finished.
    for (const player of arena.players.values()) for (const cell of player.cells) {
      cell._stepX = cell.x; cell._stepY = cell.y; confineCell(cell);
    }
    resolvePlayerBodies(arena);
  }
  for (const player of arena.players.values()) {
    updateFacing(player, player.connected ? player.input : normalizeInput());
    if (player.fireQueued) launchWave(arena, player);
    player.fireQueued = false;
  }
  advanceWaves(arena, dt);
  refillDust(arena);
  for (const player of arena.players.values()) updateProgress(arena, player);

  if (arena.remaining <= 0) {
    arena.status = 'finished';
    const ranked = [...arena.players.values()].sort((a, b) => b.mass - a.mass || b.score - a.score || b.kills - a.kills || a.id.localeCompare(b.id));
    arena.winnerId = ranked[0]?.id ?? null;
  }
}

export function snapshotArena(arena, view) {
  const bounds = viewportBounds(view);
  const visibleDust = bounds ? queryDust(arena, view) : arena.dust;
  const visibleBlasts = bounds ? arena.blasts.filter(blast => blast.x + blast.radius >= bounds.left &&
    blast.x - blast.radius <= bounds.right && blast.y + blast.radius >= bounds.top && blast.y - blast.radius <= bounds.bottom) : arena.blasts;
  return {
    arena: ARENA, motion: MOTION, simulationTime: arena.time * 1000, dustTotal: arena.dust.length,
    status: arena.status, time: round(arena.time), remaining: round(arena.remaining),
    round: arena.round, winnerId: arena.winnerId,
    players: [...arena.players.values()].map(p => ({ id: p.id, name: p.name, color: p.color,
      x: round(p.x), y: round(p.y), vx: round(p.vx), vy: round(p.vy), radius: round(p.radius), mass: round(p.mass),
      lastInputSeq: p.lastInputSeq, inputAge: p.inputAge, collisionRevision: p.collisionRevision,
      lastImpact: p.lastImpact ? { ...p.lastImpact } : null,
      direction: { ...p.direction },
      steering: { x: p.connected ? p.input.x : 0, y: p.connected ? p.input.y : 0,
        boost: p.connected && p.input.boost },
      gravityRadius: p.cells.length ? round(Math.max(...p.cells.map(c => gravityRadius(c, p)))) : 0,
      cells: p.cells.map(c => ({ id: c.id, x: round(c.x), y: round(c.y), vx: round(c.vx), vy: round(c.vy),
        impulseX: round(c.impulseX), impulseY: round(c.impulseY), radius: round(c.radius), mass: round(c.mass),
        mergeIn: round(c.mergeIn), gravityRadius: round(gravityRadius(c, p)), protected: c.protectedFor > 0, protectedFor: round(c.protectedFor) })),
      hp: p.hp, energy: round(p.energy), score: p.score, kills: p.kills, ready: p.ready,
      bot: p.bot, connected: p.connected, boosting: p.boosting, respawnIn: round(p.respawnIn),
      level: p.level, peakMass: round(p.peakMass), nextUpgradeMass: UPGRADE_THRESHOLDS[p.upgradeMilestones] ?? null,
      upgradePending: p.upgradePending, upgradeChoices: p.upgradeChoices.map(option => ({ ...option })),
      shatteredAt: round(p.shatteredAt),
      upgrades: Object.entries(p.upgrades).map(([id, count]) => ({ id, count })), stats: { ...p.stats },
      invulnerable: round(p.invulnerable), cooldown: round(p.cooldown) })),
    dust: visibleDust.map(d => ({ id: d.id, x: round(d.x), y: round(d.y), vx: round(finite(d.vx)), vy: round(finite(d.vy)), value: d.value,
      ...(d.ejected ? { ejected: true, color: d.color } : {}),
      ...(d.fragment ? { fragment: true, color: d.color, ownerId: d.ownerId } : {}) })),
    blasts: visibleBlasts.map(b => ({ id: b.id, ownerId: b.ownerId, kind: b.kind, sourceCellId: b.sourceCellId,
      x: round(b.x), y: round(b.y), originX: round(b.originX), originY: round(b.originY), originOffset: round(b.originOffset),
      directionX: b.directionX, directionY: b.directionY, width: b.width, thickness: b.thickness, curvature: b.curvature,
      speed: b.speed, distance: round(b.distance), travel: round(b.travel),
      color: b.color, radius: round(b.radius), progress: round(b.travel / b.distance) })),
  };
}
