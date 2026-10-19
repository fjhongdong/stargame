// The same deterministic simulation can run on the server and in a browser.
export const ARENA = Object.freeze({ width: 12000, height: 8000 });
export const ROUND_DURATION = 180;
export const COLORS = ['#5eefa8', '#d4b5ff', '#ffbd68', '#83d9ff', '#ff8eaf', '#9da8ff', '#ffe787', '#70f0e4'];
export const BLAST_COST = 30;
export const MOTION = Object.freeze({ response: 6, drag: 2, stopSpeed: 0.5, restitution: 0.2,
  restingThreshold: 60, contactSlop: 0.01, physicsStep: 1 / 120,
  baseSpeed: 210, referenceMass: 36, speedExponent: 0.22 });
export const SIBLING = Object.freeze({ launchGrace: 0.9, rangeBase: 600, rangeScale: 2,
  attraction: 900, radialDamping: 12, maxAcceleration: 4000, fusionDuration: 1.2 });
export const WAVE = Object.freeze({ speed: 600, distance: 420, width: 160, thickness: 20, curvature: 30, segments: 8, knockback: 240, minKnockback: 80, maxKnockback: 320, chipFraction: 0.12, fragmentCount: 3, fragmentSpeed: 55, clashRetention: 1.5, clashLimit: 64 });
export const METEOR = Object.freeze({ count: 72, minSpeed: 450, maxSpeed: 750, minRadius: 3, maxRadius: 5,
  mass: 4, interaction: 'impact', nearPlayerCount: 3, nearRadius: 1200, nearSpawnMinDistance: 450,
  nearSpawnMaxDistance: 900, spawnClearance: 80, tailScale: 0.14, minTail: 60, maxTail: 120,
  viewportLead: 0.25, knockback: 160, minKnockback: 60, maxKnockback: 240, restitution: 0.2,
  chipFraction: 0.12, fragmentCount: 3, fragmentSpeed: 55, pickupGrace: 0.3 });
export const UPGRADE_THRESHOLDS = [60, 100, 160, 240, 360, 520];
export const UPGRADE_POOL = [
  { id: 'speed', title: '光速引擎', description: '移动速度提升 10%', icon: '⚡' },
  { id: 'growth', title: '星尘滋养', description: '吞食星尘获得的质量增加 20%', icon: '✦' },
  { id: 'range', title: '超新星回响', description: '引力波射程增加 18%', icon: '◎' },
  { id: 'efficiency', title: '能量核心', description: '释放星爆的能量消耗降低 15%', icon: '◈' },
  { id: 'magnet', title: '引力透镜', description: '引力吸引范围增加 25', icon: '🧲' },
  { id: 'recovery', title: '恒星充能', description: '能量自然恢复速度提升 30%', icon: '☀' },
  { id: 'cooldown', title: '星波调谐', description: '星爆冷却时间缩短 15%', icon: '⟳' },
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
    magnet: 0, energyRegen: 3, blastCooldown: 0.85 };
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
  if (arena.status !== 'playing' || !player || !UPGRADE_POOL.some(option => option.id === upgradeId) ||
      !player.upgradeChoices.some(option => option.id === upgradeId)) {
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
  return { x, y, fire: input.fire === true, rearFire: input.rearFire === true,
    split: input.split === true };
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

export function createArena({ random = Math.random, endless = false } = {}) {
  return { endless: endless === true, status: 'lobby', time: 0, remaining: endless === true ? null : ROUND_DURATION, round: 0, winnerId: null,
    players: new Map(), dust: [], blasts: [], meteors: [], meteorsInitialized: false, waveClashes: [], clashSerial: 0, serial: 0, random,
    dustGrid: null, activeDust: new Set(), naturalDustCount: 0, bodyContacts: new Set(), fractureContacts: new Map(), impactSerial: 0 };
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
    connected: true, ...position, vx: 0, vy: 0, radius: 24, mass: START_MASS, cells: [], energy: 60,
    score: 0, kills: 0, respawnIn: 0, invulnerable: 1.5, cooldown: 0,
    input: normalizeInput(), fireQueued: false, rearFireQueued: false, splitQueued: false, shatteredAt: -10,
    pendingInputSeq: 0, lastInputSeq: 0, inputAge: 0, collisionRevision: 0, lastImpact: null, lastWaveHit: null, lastMeteorHit: null, botState: null, direction: { x: 1, y: 0 } };
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
  if (next.rearFire && !player.input.rearFire) player.rearFireQueued = true;
  if (next.split && !player.input.split) player.splitQueued = true;
  player.input = next;
  if (Number.isSafeInteger(input?.seq) && input.seq >= 0) player.pendingInputSeq = Math.max(player.pendingInputSeq, input.seq);
}

function newCell(arena, x, y, mass, extra = {}) {
  return { id: `c${++arena.serial}`, x, y, mass, radius: 4 * Math.sqrt(mass),
    vx: 0, vy: 0, mergeIn: 0, impulseX: 0, impulseY: 0, protectedFor: 0, shatterCooldown: 0, lastWaveHitId: null, lastMeteorHitId: null,
    fusionId: null, fusionRole: null, fusionPartnerId: null, fusionTargetId: null, fusionDonorId: null,
    fusionProgress: 0, fusionTime: 0, ...extra };
}

export function movementSpeed(mass, multiplier = 1) {
  return MOTION.baseSpeed * multiplier * Math.pow(MOTION.referenceMass / Math.max(0.000001, mass), MOTION.speedExponent);
}

export function siblingGravityRange(a, b) {
  return SIBLING.rangeBase + SIBLING.rangeScale * (a.radius + b.radius);
}

function clearFusion(cell) {
  cell.fusionId = cell.fusionRole = cell.fusionPartnerId = cell.fusionTargetId = cell.fusionDonorId = null;
  cell.fusionProgress = cell.fusionTime = 0;
}

function fusionPairs(cells) {
  const lookup = new Map(cells.map(cell => [cell.id, cell]));
  const pairs = [];
  for (const donor of cells) if (donor.fusionRole === 'donor') {
    const receiver = lookup.get(donor.fusionTargetId);
    if (receiver && receiver.fusionDonorId === donor.id && receiver.fusionId === donor.fusionId) pairs.push({ donor, receiver });
    else clearFusion(donor);
  }
  for (const cell of cells) if (cell.fusionRole === 'receiver' && !lookup.has(cell.fusionDonorId)) clearFusion(cell);
  return pairs;
}

/** Internal sibling forces are equal and opposite; opponents never enter here. */
export function applySiblingGravity(cells, dt) {
  const ordered = [...cells].sort((a, b) => a.id.localeCompare(b.id));
  for (const cell of cells) cell._siblingAwake = Boolean(cell.fusionId);
  for (let i = 0; i < ordered.length; i++) for (let j = i + 1; j < ordered.length; j++) {
    const a = ordered[i], b = ordered[j];
    if (a.mergeIn > 0 || b.mergeIn > 0 || (a.fusionId && a.fusionId === b.fusionId)) continue;
    const dx = b.x - a.x, dy = b.y - a.y;
    const distance = Math.hypot(dx, dy), range = siblingGravityRange(a, b);
    if (distance > range || distance < 1e-9) continue;
    const nx = dx / distance, ny = dy / distance;
    const mass = a.mass + b.mass, reducedMass = a.mass * b.mass / mass;
    const separating = Math.max(0, (b.vx - a.vx) * nx + (b.vy - a.vy) * ny);
    const acceleration = Math.min(SIBLING.maxAcceleration,
      SIBLING.attraction * Math.pow(mass / 72, 0.15) * (1 - 0.5 * distance / range) + SIBLING.radialDamping * separating);
    const impulse = reducedMass * acceleration * dt;
    a.vx += nx * impulse / a.mass; a.vy += ny * impulse / a.mass;
    b.vx -= nx * impulse / b.mass; b.vy -= ny * impulse / b.mass;
    a._siblingAwake = b._siblingAwake = true;
  }
}

/** Contact starts a stable one-to-one absorption; every intermediate step conserves mass, COM and momentum. */
export function advanceSiblingFusion(cells, dt) {
  const existing = fusionPairs(cells);
  const ordered = [...cells].sort((a, b) => a.id.localeCompare(b.id));
  const contacts = [];
  for (let i = 0; i < ordered.length; i++) for (let j = i + 1; j < ordered.length; j++) {
    const a = ordered[i], b = ordered[j];
    if (a.fusionId || b.fusionId || a.mergeIn > 0 || b.mergeIn > 0) continue;
    const distance = Math.hypot(b.x - a.x, b.y - a.y);
    if (distance <= a.radius + b.radius + 0.5) contacts.push({ a, b, distance });
  }
  contacts.sort((a, b) => a.distance - b.distance || a.a.id.localeCompare(b.a.id) || a.b.id.localeCompare(b.b.id));
  for (const { a, b } of contacts) {
    if (a.fusionId || b.fusionId) continue;
    const receiver = a.mass >= b.mass ? a : b, donor = receiver === a ? b : a;
    const id = `${receiver.id}:${donor.id}`;
    const mass = receiver.mass + donor.mass;
    const vx = (receiver.mass * receiver.vx + donor.mass * donor.vx) / mass;
    const vy = (receiver.mass * receiver.vy + donor.mass * donor.vy) / mass;
    for (const [cell, partner, role] of [[receiver, donor, 'receiver'], [donor, receiver, 'donor']]) {
      cell.fusionId = id; cell.fusionRole = role; cell.fusionPartnerId = partner.id;
      cell.fusionProgress = 0; cell.fusionTime = SIBLING.fusionDuration;
      cell.vx = vx; cell.vy = vy;
    }
    donor.fusionTargetId = receiver.id; receiver.fusionDonorId = donor.id;
    existing.push({ donor, receiver });
  }
  const removed = new Set();
  for (const { donor, receiver } of existing) {
    const time = donor.fusionTime;
    if (!(time > 0)) continue;
    const step = Math.min(time, Math.max(0, dt)), fraction = step / time;
    const mass = donor.mass + receiver.mass;
    const cx = (donor.mass * donor.x + receiver.mass * receiver.x) / mass;
    const cy = (donor.mass * donor.y + receiver.mass * receiver.y) / mass;
    const vx = (donor.mass * donor.vx + receiver.mass * receiver.vx) / mass;
    const vy = (donor.mass * donor.vy + receiver.mass * receiver.vy) / mass;
    const dx = (donor.x - receiver.x) * (1 - fraction), dy = (donor.y - receiver.y) * (1 - fraction);
    const transfer = donor.mass * fraction;
    donor.mass -= transfer; receiver.mass += transfer;
    donor.x = cx + dx * receiver.mass / mass; donor.y = cy + dy * receiver.mass / mass;
    receiver.x = cx - dx * donor.mass / mass; receiver.y = cy - dy * donor.mass / mass;
    donor.vx = receiver.vx = vx; donor.vy = receiver.vy = vy;
    donor.radius = 4 * Math.sqrt(donor.mass); receiver.radius = 4 * Math.sqrt(receiver.mass);
    donor.fusionTime = receiver.fusionTime = Math.max(0, time - step);
    donor.fusionProgress = receiver.fusionProgress = 1 - donor.fusionTime / SIBLING.fusionDuration;
    if (donor.fusionTime <= 1e-9) { removed.add(donor); clearFusion(receiver); }
  }
  if (removed.size) for (let i = cells.length - 1; i >= 0; i--) if (removed.has(cells[i])) cells.splice(i, 1);
  return removed.size;
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
  if (!dust.fragment) arena.naturalDustCount++;
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
    if (!dust.fragment) arena.naturalDustCount++;
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

function meteorSpawnSafe(arena, x, y, radius) {
  for (const player of arena.players.values()) for (const cell of player.cells) {
    if (Math.hypot(cell.x - x, cell.y - y) < cell.radius + radius + METEOR.spawnClearance) return false;
  }
  return true;
}

function newMeteor(arena, near, initial = false, spawnAt = arena.time) {
  const radius = METEOR.minRadius + arena.random() * (METEOR.maxRadius - METEOR.minRadius);
  const speed = METEOR.minSpeed + arena.random() * (METEOR.maxSpeed - METEOR.minSpeed);
  for (let attempt = 0; attempt < 64; attempt++) {
    let x, y, dx, dy, bornAt = spawnAt;
    if (near && attempt < 24) {
      const angle = arena.random() * Math.PI * 2;
      const distance = METEOR.nearSpawnMinDistance + arena.random() * (METEOR.nearSpawnMaxDistance - METEOR.nearSpawnMinDistance);
      x = near.x + Math.cos(angle) * distance; y = near.y + Math.sin(angle) * distance;
      if (x < radius || x > ARENA.width - radius || y < radius || y > ARENA.height - radius) continue;
      const offset = (90 + arena.random() * 210) * (arena.random() < 0.5 ? -1 : 1);
      dx = near.x - x - Math.sin(angle) * offset; dy = near.y - y + Math.cos(angle) * offset;
    } else {
      const edge = Math.min(3, Math.floor(arena.random() * 4));
      let tx, ty;
      if (edge < 2) {
        x = edge === 0 ? 0 : ARENA.width; y = arena.random() * ARENA.height;
        tx = edge === 0 ? ARENA.width : 0; ty = arena.random() * ARENA.height;
      } else {
        x = arena.random() * ARENA.width; y = edge === 2 ? 0 : ARENA.height;
        tx = arena.random() * ARENA.width; ty = edge === 2 ? ARENA.height : 0;
      }
      dx = tx - x; dy = ty - y;
      if (initial) {
        const phase = arena.random() * 0.95;
        x += dx * phase; y += dy * phase; bornAt -= Math.hypot(dx, dy) * phase / speed;
      }
    }
    if (!meteorSpawnSafe(arena, x, y, radius)) continue;
    const length = Math.hypot(dx, dy) || 1;
    return { id: `m${++arena.serial}`, x, y, vx: dx / length * speed, vy: dy / length * speed,
      radius, mass: METEOR.mass, tailLength: clamp(speed * METEOR.tailScale, METEOR.minTail, METEOR.maxTail),
      color: '#ffd6a1', bornAt };
  }
  return null;
}

function refillMeteors(arena, initial = false, spawnAt = arena.time) {
  const living = [...arena.players.values()].filter(p => p.connected && p.respawnIn <= 0 && p.cells.length);
  const humans = living.filter(p => !p.bot);
  const centers = humans.length ? humans : living;
  while (arena.meteors.length < METEOR.count) {
    const near = centers.find(player => arena.meteors.reduce((count, meteor) => count +
      (Math.hypot(meteor.x - player.x, meteor.y - player.y) < METEOR.nearRadius ? 1 : 0), 0) < METEOR.nearPlayerCount);
    const meteor = newMeteor(arena, near, initial, spawnAt);
    if (!meteor) break;
    arena.meteors.push(meteor);
  }
}

function meteorExitTime(meteor) {
  if (meteor.x < 0 || meteor.x > ARENA.width || meteor.y < 0 || meteor.y > ARENA.height) return 0;
  let time = Infinity;
  if (meteor.vx > 0) time = Math.min(time, (ARENA.width - meteor.x) / meteor.vx);
  else if (meteor.vx < 0) time = Math.min(time, -meteor.x / meteor.vx);
  if (meteor.vy > 0) time = Math.min(time, (ARENA.height - meteor.y) / meteor.vy);
  else if (meteor.vy < 0) time = Math.min(time, -meteor.y / meteor.vy);
  return Math.max(0, time);
}

function meteorShards(arena, meteor, cell, nx, ny, transferredImpulse, at) {
  const mass = meteor.mass ?? METEOR.mass;
  const meanX = meteor.vx - nx * transferredImpulse / mass;
  const meanY = meteor.vy - ny * transferredImpulse / mass;
  const angle = Math.atan2(-ny, -nx);
  for (let i = 0; i < METEOR.fragmentCount; i++) {
    const opening = angle + (i - 1) * 0.6;
    const distance = cell.radius + 14;
    let x = clamp(cell.x + Math.cos(opening) * distance, 8, ARENA.width - 8);
    let y = clamp(cell.y + Math.sin(opening) * distance, 8, ARENA.height - 8);
    for (let turn = 1; Math.hypot(x - cell.x, y - cell.y) <= cell.radius + 5 && turn <= 12; turn++) {
      const direction = opening + turn * Math.PI / 6;
      x = clamp(cell.x + Math.cos(direction) * distance, 8, ARENA.width - 8);
      y = clamp(cell.y + Math.sin(direction) * distance, 8, ARENA.height - 8);
    }
    const scatter = angle + i * Math.PI * 2 / METEOR.fragmentCount;
    addDust(arena, x, y, mass / METEOR.fragmentCount, { fragment: true, sourceKind: 'meteor',
      ownerId: null, color: meteor.color ?? '#ffd6a1', collectAfter: at + METEOR.pickupGrace,
      availableAt: at + METEOR.pickupGrace,
      vx: meanX + Math.cos(scatter) * METEOR.fragmentSpeed, vy: meanY + Math.sin(scatter) * METEOR.fragmentSpeed });
  }
}

/** Ballistic heads are immune to all gravity. Only their first body contact matters. */
export function advanceMeteors(arena, dt, { refill = arena.meteorsInitialized, frameStart = arena.time } = {}) {
  const consumed = new Set(), events = [];
  for (const meteor of arena.meteors) {
    const delay = Math.max(0, (meteor.bornAt ?? frameStart) - frameStart);
    if (delay > dt) continue;
    const duration = Math.max(0, dt - delay), exit = meteorExitTime(meteor);
    const active = Math.min(duration, exit);
    let best = null;
    for (const player of arena.players.values()) {
      if (player.respawnIn > 0) continue;
      for (const cell of player.cells) {
        const startX = cell._frameX ?? cell.x, startY = cell._frameY ?? cell.y;
        const vx = dt > 0 ? (cell.x - startX) / dt : cell.vx;
        const vy = dt > 0 ? (cell.y - startY) / dt : cell.vy;
        const center = { x: startX + vx * delay, y: startY + vy * delay };
        const time = pointCapsuleTOI(meteor.x, meteor.y, meteor.vx - vx, meteor.vy - vy,
          center, center, cell.radius + meteor.radius, active);
        if (!Number.isFinite(time)) continue;
        const key = `${player.id}:${cell.id}`;
        if (!best || time < best.time - 1e-9 || (Math.abs(time - best.time) <= 1e-9 && key < best.key)) {
          best = { meteor, player, cell, time, key, bodyVx: vx, bodyVy: vy,
            centerX: center.x + vx * time, centerY: center.y + vy * time,
            x: meteor.x + meteor.vx * time, y: meteor.y + meteor.vy * time, at: frameStart + delay + time };
        }
      }
    }
    if (best) { events.push(best); consumed.add(meteor); }
    else if (exit <= duration + 1e-10) consumed.add(meteor);
    else { meteor.x += meteor.vx * duration; meteor.y += meteor.vy * duration; }
  }
  events.sort((a, b) => a.at - b.at || a.meteor.id.localeCompare(b.meteor.id));
  for (const event of events) {
    const { meteor, player, cell, at } = event;
    let nx = event.centerX - event.x, ny = event.centerY - event.y;
    const length = Math.hypot(nx, ny);
    if (length > 1e-9) { nx /= length; ny /= length; }
    else { const speed = Math.hypot(meteor.vx, meteor.vy) || 1; nx = meteor.vx / speed; ny = meteor.vy / speed; }
    const closing = Math.max(0, (meteor.vx - event.bodyVx) * nx + (meteor.vy - event.bodyVy) * ny);
    const protectedBody = player.invulnerable > 0;
    const x = event.centerX - nx * cell.radius, y = event.centerY - ny * cell.radius;
    let transferredImpulse = 0, impulse = 0, lostMass = 0;
    if (!protectedBody && closing > 1e-6) {
      const requested = clamp(METEOR.knockback * (closing / 600) * Math.pow(36 / cell.mass, 0.35),
        METEOR.minKnockback, METEOR.maxKnockback);
      const meteorMass = meteor.mass ?? METEOR.mass;
      const physicalCap = (1 + METEOR.restitution) * cell.mass * meteorMass / (cell.mass + meteorMass) * closing;
      transferredImpulse = Math.min(cell.mass * requested, physicalCap);
      impulse = transferredImpulse / cell.mass;
      cell.vx += nx * impulse; cell.vy += ny * impulse;
      lostMass = chipWaveCell(arena, player, cell,
        { directionX: nx, directionY: ny, impactConfig: METEOR, impactAt: at });
      player.collisionRevision++;
    }
    meteorShards(arena, meteor, cell, nx, ny, transferredImpulse, at);
    const id = `${meteor.id}:${player.id}:${cell.id}`;
    cell.lastMeteorHitId = id;
    player.lastMeteorHit = { id, meteorId: meteor.id, at, cellId: cell.id, hitCellIds: [cell.id],
      x, y, directionX: nx, directionY: ny, impulse, lostMass, meteorFragmentMass: meteor.mass ?? METEOR.mass,
      protected: protectedBody };
    syncPlayer(player);
  }
  arena.meteors = arena.meteors.filter(meteor => !consumed.has(meteor));
  if (refill) refillMeteors(arena, false, frameStart + dt);
}

export function startRound(arena) {
  arena.status = 'playing';
  arena.time = 0;
  arena.remaining = arena.endless ? null : ROUND_DURATION;
  arena.round++;
  arena.winnerId = null;
  arena.dust = [];
  arena.dustGrid = null;
  arena.naturalDustCount = 0;
  arena.activeDust = new Set();
  arena.blasts = [];
  arena.meteors = [];
  arena.meteorsInitialized = true;
  arena.waveClashes = [];
  arena.clashSerial = 0;
  arena.bodyContacts = new Set();
  arena.fractureContacts = new Map();
  arena.impactSerial = 0;
  for (const player of arena.players.values()) {
    Object.assign(player, spawnPosition(arena), { vx: 0, vy: 0, energy: 60, score: 0, kills: 0,
      respawnIn: 0, invulnerable: 1.5, cooldown: 0, fireQueued: false, rearFireQueued: false, splitQueued: false,
      shatteredAt: -10, collisionRevision: 0, lastImpact: null, lastWaveHit: null, lastMeteorHit: null, botState: null,
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
  refillMeteors(arena, true);
}

function botInput(arena, player) {
  // Decisions persist across physics/network ticks. Nearby particles already
  // flow into the gravity field, so steer toward a food area rather than chase
  // a different moving particle on every frame.
  const state = player.botState ??= { mode: 'forage', target: null, nextDecisionAt: 0, threatId: null, enemyId: null };
  const source = mainCell(player);
  if (!source) return {};
  let enemy = null, enemyDistance = Infinity, threat = null, threatDistance = Infinity;
  for (const opponent of arena.players.values()) {
    if (opponent.id === player.id || opponent.respawnIn > 0) continue;
    const body = mainCell(opponent);
    if (!body) continue;
    const distance = Math.hypot(body.x - player.x, body.y - player.y);
    if (distance < enemyDistance) { enemy = { player: opponent, cell: body }; enemyDistance = distance; }
    const wasThreat = state.threatId === opponent.id;
    const enterDistance = Math.max(240, source.radius + body.radius + 120);
    const exitDistance = Math.max(330, enterDistance + 90);
    if (body.mass > source.mass * (wasThreat ? 1.15 : 1.25) && distance < (wasThreat ? exitDistance : enterDistance) &&
        (wasThreat || distance < threatDistance)) {
      threat = { player: opponent, cell: body }; threatDistance = distance;
      if (wasThreat) break;
    }
  }
  if (threat) {
    if (state.mode !== 'flee' || state.threatId !== threat.player.id) state.fleeSince = arena.time;
    state.mode = 'flee'; state.threatId = threat.player.id;
    state.target = null; state.nextDecisionAt = arena.time + 0.6;
    // Flee from the actual threat, independently of any food target.
    const dx = player.x - threat.cell.x, dy = player.y - threat.cell.y;
    const length = Math.hypot(dx, dy);
    const speed = Math.hypot(source.vx, source.vy);
    const behind = speed > 5 && length > 1e-6 && (source.vx * dx + source.vy * dy) / (speed * length) > 0.8;
    return { x: length > 1e-6 ? dx / length : player.direction.x,
      y: length > 1e-6 ? dy / length : player.direction.y, fire: false, split: false,
      rearFire: arena.time - state.fleeSince >= 0.2 && threatDistance < 260 && behind &&
        player.cooldown <= 0 && player.energy >= player.stats.blastCost };
  }
  state.threatId = null;
  if (state.mode === 'chase' && state.enemyId) {
    const previous = arena.players.get(state.enemyId), body = previous?.respawnIn <= 0 ? mainCell(previous) : null;
    const distance = body ? Math.hypot(body.x - player.x, body.y - player.y) : Infinity;
    if (body && distance < 380 && source.mass > body.mass * 1.15) {
      enemy = { player: previous, cell: body }; enemyDistance = distance;
    }
  }
  const canChase = enemy && source.mass > enemy.cell.mass * (state.mode === 'chase' && state.enemyId === enemy.player.id ? 1.15 : 1.3);
  const chaseDistance = state.mode === 'chase' ? 380 : 280;
  if (canChase && enemyDistance < chaseDistance) {
    state.mode = 'chase'; state.enemyId = enemy.player.id; state.target = { x: enemy.cell.x, y: enemy.cell.y };
  } else {
    if (state.mode !== 'forage') { state.mode = 'forage'; state.target = null; state.enemyId = null; }
    const arrived = state.target && Math.hypot(state.target.x - player.x, state.target.y - player.y) < 60;
    if (!state.target || (arena.time >= state.nextDecisionAt && (arrived || arena.time >= state.target.expiresAt))) {
      let target = null, best = Infinity;
      const gatheringRange = gravityRadius(source, player) * 0.8;
      for (const range of [400, 800, 1500]) {
        visitDustRect(arena, player.x - range, player.y - range, player.x + range, player.y + range, dust => {
          if (arena.time < (dust.collectAfter ?? 0) || (dust.ownerId === player.id && arena.time < dust.availableAt)) return;
          const dx = dust.x - player.x, dy = dust.y - player.y, distance = dx * dx + dy * dy;
          if (distance < gatheringRange * gatheringRange) return;
          // Do not route back through a stronger opponent just after fleeing.
          if (enemy && enemy.cell.mass > source.mass * 1.15 &&
              Math.hypot(dust.x - enemy.cell.x, dust.y - enemy.cell.y) < 300 + enemy.cell.radius) return;
          if (distance < best) { best = distance; target = dust; }
        });
        if (target) break;
      }
      const heading = Math.hypot(player.vx, player.vy) > 5 ? Math.atan2(player.vy, player.vx) : Math.atan2(player.direction.y, player.direction.x);
      state.target = target ? { x: target.x, y: target.y, expiresAt: arena.time + 3 } : {
        x: clamp(player.x + Math.cos(heading) * 500, 150, ARENA.width - 150),
        y: clamp(player.y + Math.sin(heading) * 500, 150, ARENA.height - 150), expiresAt: arena.time + 3 };
      state.nextDecisionAt = arena.time + 0.8;
    }
  }
  const dx = state.target.x - player.x, dy = state.target.y - player.y;
  const distance = Math.hypot(dx, dy);
  // Reduce the requested velocity on approach; this avoids overshooting a
  // fixed food waypoint and immediately reversing just to reach its center.
  const scale = state.mode === 'chase' ? 1 : Math.min(1, distance / 120);
  const split = state.mode === 'chase' && enemyDistance > 140 && enemyDistance < 320 &&
    player.cells.length === 1 && source.mass > enemy.cell.mass * 3;
  const facing = enemyDistance > 0 && enemy ? ((enemy.cell.x - source.x) * player.direction.x +
    (enemy.cell.y - source.y) * player.direction.y) / enemyDistance : -1;
  return { x: distance > 1 ? dx / distance * scale : 0, y: distance > 1 ? dy / distance * scale : 0,
    split, fire: state.mode === 'chase' && enemyDistance < 260 && facing > 0.8 &&
      player.cooldown <= 0 && player.energy >= player.stats.blastCost };
}

function splitPlayer(arena, player, direction = player.direction) {
  for (const cell of [...player.cells]) {
    if (player.cells.length >= 8) break;
    if (cell.mass < 48) continue;
    if (cell.fusionId) {
      const partner = player.cells.find(other => other.id === cell.fusionPartnerId);
      if (partner) { clearFusion(partner); partner.mergeIn = Math.max(partner.mergeIn, SIBLING.launchGrace); }
      clearFusion(cell);
    }
    cell.mass /= 2;
    cell.radius = 4 * Math.sqrt(cell.mass);
    cell.mergeIn = SIBLING.launchGrace;
    const { x, y } = direction;
    // Start the launched half beyond the parent's edge. Spawning overlapping
    // halves makes collision separation push the parent against its input.
    const separation = cell.radius * 2 + 2;
    const child = newCell(arena, cell.x + x * separation, cell.y + y * separation, cell.mass,
      { mergeIn: SIBLING.launchGrace, vx: cell.vx + x * 650, vy: cell.vy + y * 650 });
    player.cells.push(child);
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
  if (!moving && !cell._siblingAwake && Math.hypot(cell.vx, cell.vy) < MOTION.stopSpeed) cell.vx = cell.vy = 0;
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
    cell.vx = finite(cell.vx) + finite(cell.impulseX);
    cell.vy = finite(cell.vy) + finite(cell.impulseY);
    cell.impulseX = cell.impulseY = 0;
  }
  applySiblingGravity(player.cells, dt);
  const pairMasses = new Map();
  for (const { donor, receiver } of fusionPairs(player.cells)) {
    const mass = donor.mass + receiver.mass;
    const vx = (donor.vx * donor.mass + receiver.vx * receiver.mass) / mass;
    const vy = (donor.vy * donor.mass + receiver.vy * receiver.mass) / mass;
    donor.vx = receiver.vx = vx; donor.vy = receiver.vy = vy;
    pairMasses.set(donor.id, mass); pairMasses.set(receiver.id, mass);
  }
  for (const cell of player.cells) {
    const speed = movementSpeed(pairMasses.get(cell.id) ?? cell.mass, player.stats.speed);
    cell._stepVx = cell.vx; cell._stepVy = cell.vy;
    cell._targetVx = input.x * speed; cell._targetVy = input.y * speed;
    cell._motionRate = Math.hypot(input.x, input.y) > 0 ? MOTION.response : MOTION.drag;
    cell._motionDt = dt; cell._sweepTime = 0;
    cell._sweepX = cell.x; cell._sweepY = cell.y;
    cell._sweepVx = cell.vx; cell._sweepVy = cell.vy;
    integrateMotion(cell, input, speed, dt);
    cell._freeX = cell.x; cell._freeY = cell.y;
    cell._freeVx = cell.vx; cell._freeVy = cell.vy;
    confineCell(cell);
  }
  advanceSiblingFusion(player.cells, dt);
  for (let i = 0; i < player.cells.length; i++) {
    for (let j = i + 1; j < player.cells.length; j++) {
      const a = player.cells[i], b = player.cells[j];
      const dx = b.x - a.x, dy = b.y - a.y;
      const distance = Math.hypot(dx, dy);
      if (a.fusionId && a.fusionId === b.fusionId) continue;
      if (distance < a.radius + b.radius) {
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
  if (cell.mass < 3 || cell.protectedFor > 0 || cell.shatterCooldown > 0) return false;
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
  const lost = Math.min(cell.mass * 0.05, Math.max(0, cell.mass - 1));
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

function freeTrajectory(cell) {
  return Number.isFinite(cell._sweepVx) &&
    Math.abs(cell.x - cell._freeX) + Math.abs(cell.y - cell._freeY) <= 1e-7 &&
    Math.abs(cell.vx - cell._freeVx) + Math.abs(cell.vy - cell._freeVy) <= 1e-7;
}

function trajectoryAt(cell, seconds) {
  const elapsed = Math.max(0, seconds - cell._sweepTime);
  const decay = Math.exp(-cell._motionRate * elapsed), integral = (1 - decay) / cell._motionRate;
  return { x: cell._sweepX + cell._targetVx * elapsed + (cell._sweepVx - cell._targetVx) * integral,
    y: cell._sweepY + cell._targetVy * elapsed + (cell._sweepVy - cell._targetVy) * integral,
    vx: cell._targetVx + (cell._sweepVx - cell._targetVx) * decay,
    vy: cell._targetVy + (cell._sweepVy - cell._targetVy) * decay };
}

function bodyContact(a, b) {
  const ac = a.cell, bc = b.cell;
  const valid = freeTrajectory(ac) && freeTrajectory(bc);
  const duration = valid ? Math.min(ac._motionDt, bc._motionDt) : 0;
  const startTime = valid ? Math.max(ac._sweepTime, bc._sweepTime) : 0;
  const startA = valid ? trajectoryAt(ac, startTime) : ac;
  const startB = valid ? trajectoryAt(bc, startTime) : bc;
  const ax = startA.x, ay = startA.y, bx = startB.x, by = startB.y;
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
  const absoluteTime = duration > 0 ? (startTime + (duration - startTime) * time) / duration : 0;
  return { a, b, time: absoluteTime, startTime, nx, ny, key: `${a.key}|${b.key}` };
}

function resolveSweptRemainder(contact, dt, stepTime) {
  if (dt <= 0) return null;
  const { a, b, time } = contact;
  const ac = a.cell, bc = b.cell;
  // A prior wall/other-body response invalidates this pair's free trajectory.
  // Keep the conservative pile solver for those coupled contacts.
  if (!freeTrajectory(ac) || !freeTrajectory(bc)) return null;
  const startTime = contact.startTime ?? 0;
  const initialA = trajectoryAt(ac, startTime), initialB = trajectoryAt(bc, startTime);
  const initialDistance = Math.hypot(initialB.x - initialA.x, initialB.y - initialA.y);
  if (initialDistance < ac.radius + bc.radius - 1e-6) return null;
  let seconds = dt * time;
  const radius = ac.radius + bc.radius;
  // The initial sweep is a line-segment estimate. Refine its time against the
  // same analytical inertia used by movement before advancing the remainder.
  for (let i = 0; i < 5; i++) {
    const ap = trajectoryAt(ac, seconds), bp = trajectoryAt(bc, seconds);
    const dx = bp.x - ap.x, dy = bp.y - ap.y;
    const error = dx * dx + dy * dy - radius * radius;
    if (Math.abs(error) < 1e-8) break;
    const derivative = 2 * (dx * (bp.vx - ap.vx) + dy * (bp.vy - ap.vy));
    if (Math.abs(derivative) < 1e-10) return null;
    seconds = clamp(seconds - error / derivative, startTime, dt);
  }
  const av = trajectoryAt(ac, seconds), bv = trajectoryAt(bc, seconds);
  const separation = Math.hypot(bv.x - av.x, bv.y - av.y);
  if (Math.abs(separation - radius) > 1e-5) return null;
  const nx = (bv.x - av.x) / separation, ny = (bv.y - av.y) / separation;
  const closing = -((bv.vx - av.vx) * nx + (bv.vy - av.vy) * ny);
  if (closing <= 1e-7) return null;
  const point = { x: av.x + nx * ac.radius, y: av.y + ny * ac.radius };
  const restitution = closing > MOTION.restingThreshold ? MOTION.restitution : 0;
  const inverseA = 1 / ac.mass, inverseB = 1 / bc.mass;
  const impulse = (1 + restitution) * closing / (inverseA + inverseB);
  const remaining = dt - seconds;
  for (const [cell, magnitude, atContact] of [[ac, -impulse * inverseA, av], [bc, impulse * inverseB, bv]]) {
    const decay = Math.exp(-cell._motionRate * remaining);
    const displacement = (1 - decay) / cell._motionRate;
    cell.x += magnitude * nx * displacement;
    cell.y += magnitude * ny * displacement;
    cell.vx += magnitude * nx * decay;
    cell.vy += magnitude * ny * decay;
    cell._sweepTime = seconds; cell._sweepX = atContact.x; cell._sweepY = atContact.y;
    cell._sweepVx = atContact.vx + magnitude * nx;
    cell._sweepVy = atContact.vy + magnitude * ny;
    cell._freeX = cell.x; cell._freeY = cell.y; cell._freeVx = cell.vx; cell._freeVy = cell.vy;
    confineCell(cell);
  }
  if (closing > MOTION.restingThreshold) {
    a.player.collisionRevision++;
    if (b.player !== a.player) b.player.collisionRevision++;
  }
  return { closing, ...point, nx, ny, at: stepTime - dt + seconds };
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

function resolvePlayerBodies(arena, dt = 0, stepTime = arena.time) {
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
  const queued = new Set(contacts.map(contact => contact.key));
  const processed = new Set();
  while (contacts.length) {
    const previous = contacts.shift();
    if (processed.has(previous.key)) continue;
    processed.add(previous.key);
    // Earlier impacts may have changed this path. A stale broad-phase entry
    // must never apply an impulse or fracture to a body it no longer reaches.
    const contact = bodyContact(previous.a, previous.b);
    if (!contact) continue;
    let { a, b, nx, ny, key } = contact;
    const swept = resolveSweptRemainder(contact, dt, stepTime);
    if (swept) { nx = swept.nx; ny = swept.ny; }
    const closingSpeed = swept?.closing ?? Math.max(0, -((b.cell.vx - a.cell.vx) * nx + (b.cell.vy - a.cell.vy) * ny));
    resolveBodyPair(a, b, nx, ny);
    if (swept) {
      // Advancing the remaining time can reach a third body that the original
      // free path missed. Recheck only the two changed bodies' neighbors.
      for (const changed of [a, b]) for (const other of bodies) {
        if (other === changed || other.player === changed.player) continue;
        const left = changed.key < other.key ? changed : other, right = left === changed ? other : changed;
        const neighborKey = `${left.key}|${right.key}`;
        if (queued.has(neighborKey) || processed.has(neighborKey)) continue;
        const neighbor = bodyContact(left, right);
        if (neighbor) { queued.add(neighborKey); contacts.push(neighbor); }
      }
      contacts.sort((left, right) => left.time - right.time || left.key.localeCompare(right.key));
    }
    const existingContact = arena.bodyContacts.has(key);
    const impactPoint = { x: swept?.x ?? a.cell.x + nx * a.cell.radius, y: swept?.y ?? a.cell.y + ny * a.cell.radius,
      radius: Math.min(32, Math.min(a.cell.radius, b.cell.radius) * 0.65) };
    let fractured = false;
    if (!arena.fractureContacts.has(key) && a.cell.mass !== b.cell.mass) {
      const big = a.cell.mass > b.cell.mass ? a : b;
      const small = big === a ? b : a;
      if (small.player.invulnerable <= 0 && shatterCell(arena, small.player, small.cell, big.cell, closingSpeed)) {
        chipCollider(arena, big, small.cell, closingSpeed);
        big.player.collisionRevision++; small.player.collisionRevision++;
        fractured = true;
        arena.fractureContacts.set(key, { a, b, closestDistance: Math.hypot(a.cell.x - b.cell.x, a.cell.y - b.cell.y) });
      }
    }
    if ((!existingContact && closingSpeed > 12) || fractured) {
      const impact = { id: `impact-${arena.round}-${++arena.impactSerial}`, at: swept?.at ?? stepTime,
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
  // Only successful fractures lock an episode. Shrinking bodies alone does
  // not count as separating; release after their centers actually move apart
  // from the closest distance reached during this episode and a real gap opens.
  for (const [key, lock] of arena.fractureContacts) {
    const { a, b } = lock;
    const distance = Math.hypot(a.cell.x - b.cell.x, a.cell.y - b.cell.y);
    lock.closestDistance = Math.min(lock.closestDistance, distance);
    if (!a.player.cells.includes(a.cell) || !b.player.cells.includes(b.cell) ||
        (distance > a.cell.radius + b.cell.radius + 0.5 && distance > lock.closestDistance + 0.5)) {
      arena.fractureContacts.delete(key);
    }
  }
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
        cell.mass += dust.value * (dust.fragment ? 1 : player.stats.growth);
        cell.radius = 4 * Math.sqrt(cell.mass);
        if (!dust.fragment) {
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

function launchWave(arena, player, mode = 'forward') {
  const source = mainCell(player);
  if (!source || player.respawnIn > 0 || player.energy < player.stats.blastCost || player.cooldown > 0) return;
  const speed = Math.hypot(source.vx, source.vy);
  const facing = speed >= 5 ? { x: source.vx / speed, y: source.vy / speed } : player.direction;
  const sign = mode === 'rear' ? -1 : 1;
  const direction = { x: facing.x * sign, y: facing.y * sign };
  const originOffset = source.radius + WAVE.curvature + WAVE.thickness / 2 + 4;
  const x = source.x + direction.x * originOffset, y = source.y + direction.y * originOffset;
  player.energy -= player.stats.blastCost;
  player.cooldown = player.stats.blastCooldown;
  arena.blasts.push({ id: `b${++arena.serial}`, ownerId: player.id, kind: 'wave', mode, sourceCellId: source.id,
    x, y, originX: x, originY: y, originOffset, directionX: direction.x, directionY: direction.y,
    width: WAVE.width, thickness: WAVE.thickness, curvature: WAVE.curvature,
    speed: WAVE.speed, distance: WAVE.distance * player.stats.blastRange, travel: 0,
    color: player.color, radius: WAVE.width / 2 + WAVE.curvature + WAVE.thickness / 2, hit: new Set() });
}

function chipWaveCell(arena, player, cell, wave) {
  const config = wave.impactConfig ?? WAVE;
  const at = wave.impactAt ?? arena.time;
  const lost = Math.min(cell.mass * config.chipFraction, Math.max(0, cell.mass - 1));
  if (lost <= 0) return 0;
  cell.mass -= lost;
  cell.radius = 4 * Math.sqrt(cell.mass);
  // Equal triangle vectors sum to zero. All fragments inherit the post-wave
  // velocity, conserving the momentum after the external wave impulse.
  const angle = Math.atan2(wave.directionY, wave.directionX);
  for (let i = 0; i < config.fragmentCount; i++) {
    const direction = angle + i * Math.PI * 2 / config.fragmentCount;
    const ux = Math.cos(direction), uy = Math.sin(direction);
    const distance = cell.radius + 14;
    let x = clamp(cell.x + ux * distance, 8, ARENA.width - 8);
    let y = clamp(cell.y + uy * distance, 8, ARENA.height - 8);
    // A wall clamp can fold a fragment back inside its source body. Choose a
    // nearby legal opening while retaining the balanced velocity scatter.
    for (let turn = 1; Math.hypot(x - cell.x, y - cell.y) <= cell.radius + 5 && turn <= 12; turn++) {
      const opening = direction + turn * Math.PI / 6;
      x = clamp(cell.x + Math.cos(opening) * distance, 8, ARENA.width - 8);
      y = clamp(cell.y + Math.sin(opening) * distance, 8, ARENA.height - 8);
    }
    addDust(arena, x, y, lost / config.fragmentCount,
      { fragment: true, color: player.color, ownerId: player.id,
        collectAfter: at + 0.3, availableAt: at + 0.9,
        vx: cell.vx + ux * config.fragmentSpeed, vy: cell.vy + uy * config.fragmentSpeed });
  }
  return lost;
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

const WAVE_TIME_EPSILON = 1e-8;

function waveArc(wave) {
  return Array.from({ length: WAVE.segments + 1 }, (_, i) => waveArcPoint(wave, -1 + 2 * i / WAVE.segments));
}

function waveLiveTime(wave, duration) {
  if (!(wave.distance > wave.travel)) return -1;
  return Math.min(duration, (wave.distance - wave.travel) / wave.speed);
}

// Exact time of a moving point entering a finite rounded line segment.
function pointCapsuleTOI(px, py, vx, vy, a, b, radius, duration) {
  if (pointSegmentDistanceSquared(px, py, a.x, a.y, b.x, b.y) <= radius * radius + 1e-8) return 0;
  let earliest = Infinity;
  const accept = time => {
    if (time >= -WAVE_TIME_EPSILON && time <= duration + WAVE_TIME_EPSILON) earliest = Math.min(earliest, clamp(time, 0, duration));
  };
  const speedSquared = vx * vx + vy * vy;
  if (speedSquared < 1e-16) return earliest;
  for (const endpoint of [a, b]) {
    const qx = px - endpoint.x, qy = py - endpoint.y;
    const linear = 2 * (qx * vx + qy * vy);
    const constant = qx * qx + qy * qy - radius * radius;
    const discriminant = linear * linear - 4 * speedSquared * constant;
    if (discriminant >= 0) accept((-linear - Math.sqrt(discriminant)) / (2 * speedSquared));
  }
  const dx = b.x - a.x, dy = b.y - a.y, length = Math.hypot(dx, dy);
  if (length > 1e-12) {
    const tx = dx / length, ty = dy / length, nx = -ty, ny = tx;
    const qx = px - a.x, qy = py - a.y;
    const normal = qx * nx + qy * ny, normalSpeed = vx * nx + vy * ny;
    if (Math.abs(normalSpeed) > 1e-12) for (const side of [-1, 1]) {
      const time = (side * radius - normal) / normalSpeed;
      const along = (qx + vx * time) * tx + (qy + vy * time) * ty;
      if (along >= -1e-8 && along <= length + 1e-8) accept(time);
    }
  }
  return earliest;
}

function closestSegmentPoints(a, b, c, d) {
  const rx = b.x - a.x, ry = b.y - a.y, sx = d.x - c.x, sy = d.y - c.y;
  const determinant = rx * sy - ry * sx;
  if (Math.abs(determinant) > 1e-12) {
    const qx = c.x - a.x, qy = c.y - a.y;
    const t = (qx * sy - qy * sx) / determinant, u = (qx * ry - qy * rx) / determinant;
    if (t >= 0 && t <= 1 && u >= 0 && u <= 1) {
      const point = { x: a.x + t * rx, y: a.y + t * ry };
      return { a: point, b: point, squared: 0 };
    }
  }
  let result = null;
  for (const [point, from, to, reverse] of [[a, c, d, false], [b, c, d, false], [c, a, b, true], [d, a, b, true]]) {
    const dx = to.x - from.x, dy = to.y - from.y, length = dx * dx + dy * dy;
    const t = length > 0 ? clamp(((point.x - from.x) * dx + (point.y - from.y) * dy) / length, 0, 1) : 0;
    const projected = { x: from.x + t * dx, y: from.y + t * dy };
    const squared = (point.x - projected.x) ** 2 + (point.y - projected.y) ** 2;
    if (!result || squared < result.squared) result = { a: reverse ? projected : point, b: reverse ? point : projected, squared };
  }
  return result;
}

/** Same-time collision of two translating thick arcs; duration is measured in seconds. */
export function wavePairTOI(a, b, duration) {
  if (a.ownerId === b.ownerId) return null;
  const active = Math.min(waveLiveTime(a, duration), waveLiveTime(b, duration));
  if (active < 0) return null;
  const avx = a.directionX * a.speed, avy = a.directionY * a.speed;
  const bvx = b.directionX * b.speed, bvy = b.directionY * b.speed;
  const vx = avx - bvx, vy = avy - bvy;
  const bound = a.radius + b.radius;
  if (pointSegmentDistanceSquared(0, 0, a.x - b.x, a.y - b.y,
    a.x - b.x + vx * active, a.y - b.y + vy * active) > bound * bound) return null;
  const arcA = waveArc(a), arcB = waveArc(b), radius = (a.thickness + b.thickness) / 2;
  let earliest = Infinity, segmentA, segmentB;
  for (let i = 1; i < arcA.length; i++) for (let j = 1; j < arcB.length; j++) {
    const ap = arcA[i - 1], aq = arcA[i], bp = arcB[j - 1], bq = arcB[j];
    let time = segmentDistanceSquared(ap.x, ap.y, aq.x, aq.y, bp.x, bp.y, bq.x, bq.y) <= radius * radius + 1e-8 ? 0 : Infinity;
    if (time !== 0) time = Math.min(
      pointCapsuleTOI(ap.x, ap.y, vx, vy, bp, bq, radius, active),
      pointCapsuleTOI(aq.x, aq.y, vx, vy, bp, bq, radius, active),
      pointCapsuleTOI(bp.x, bp.y, -vx, -vy, ap, aq, radius, active),
      pointCapsuleTOI(bq.x, bq.y, -vx, -vy, ap, aq, radius, active));
    if (time < earliest) { earliest = time; segmentA = [ap, aq]; segmentB = [bp, bq]; }
  }
  if (!Number.isFinite(earliest)) return null;
  const moved = (point, x, y) => ({ x: point.x + x * earliest, y: point.y + y * earliest });
  const closest = closestSegmentPoints(moved(segmentA[0], avx, avy), moved(segmentA[1], avx, avy),
    moved(segmentB[0], bvx, bvy), moved(segmentB[1], bvx, bvy));
  const fraction = a.thickness / (a.thickness + b.thickness);
  return { time: earliest, x: closest.a.x + (closest.b.x - closest.a.x) * fraction,
    y: closest.a.y + (closest.b.y - closest.a.y) * fraction };
}

function waveClashTimeline(arena, waves, dt) {
  const collisions = [];
  for (let i = 0; i < waves.length; i++) for (let j = i + 1; j < waves.length; j++) {
    const hit = wavePairTOI(waves[i], waves[j], dt);
    if (hit) collisions.push({ ...hit, a: waves[i], b: waves[j] });
  }
  collisions.sort((a, b) => a.time - b.time || a.a.id.localeCompare(b.a.id) || a.b.id.localeCompare(b.b.id));
  const cancelled = new Map();
  for (let first = 0; first < collisions.length;) {
    let last = first + 1;
    while (last < collisions.length && collisions[last].time <= collisions[first].time + WAVE_TIME_EPSILON) last++;
    const simultaneous = collisions.slice(first, last).filter(hit => !cancelled.has(hit.a.id) && !cancelled.has(hit.b.id));
    const connected = new Map();
    for (const hit of simultaneous) for (const wave of [hit.a, hit.b]) connected.set(wave.id, wave);
    while (connected.size) {
      const component = new Set([connected.keys().next().value]);
      let changed = true;
      while (changed) {
        changed = false;
        for (const hit of simultaneous) if (component.has(hit.a.id) || component.has(hit.b.id)) {
          for (const wave of [hit.a, hit.b]) if (!component.has(wave.id)) { component.add(wave.id); changed = true; }
        }
      }
      const members = [...component].sort().map(id => connected.get(id));
      const edges = simultaneous.filter(hit => component.has(hit.a.id) && component.has(hit.b.id));
      const time = collisions[first].time;
      for (const wave of members) { cancelled.set(wave.id, time); connected.delete(wave.id); }
      arena.waveClashes.push({ id: `clash-${arena.round}-${++arena.clashSerial}`, at: arena.time - dt + time,
        x: edges.reduce((sum, hit) => sum + hit.x, 0) / edges.length,
        y: edges.reduce((sum, hit) => sum + hit.y, 0) / edges.length,
        waveIds: members.map(wave => wave.id), ownerIds: members.map(wave => wave.ownerId), colors: members.map(wave => wave.color),
        radius: clamp(Math.max(...members.map(wave => wave.thickness)) * 1.5, 18, 48) });
    }
    first = last;
  }
  return cancelled;
}

function waveCellTOI(wave, arc, cell, dt, duration) {
  const x = cell._frameX ?? cell._stepX ?? cell.x, y = cell._frameY ?? cell._stepY ?? cell.y;
  const vx = (dt > 0 ? (cell.x - x) / dt : 0) - wave.directionX * wave.speed;
  const vy = (dt > 0 ? (cell.y - y) / dt : 0) - wave.directionY * wave.speed;
  if (pointSegmentDistanceSquared(0, 0, x - wave.x, y - wave.y,
    x - wave.x + vx * duration, y - wave.y + vy * duration) > (wave.radius + cell.radius) ** 2) return Infinity;
  let earliest = Infinity;
  for (let i = 1; i < arc.length; i++) earliest = Math.min(earliest,
    pointCapsuleTOI(x, y, vx, vy, arc[i - 1], arc[i], cell.radius + wave.thickness / 2, duration));
  return earliest;
}

function advanceWaves(arena, dt) {
  const waves = [...arena.blasts].sort((a, b) => a.id.localeCompare(b.id));
  // Cancellation paths are independent of player hits. Resolve that timeline
  // first, then clip every player's hit sweep to the wave's cancellation time.
  const cancelled = waveClashTimeline(arena, waves, dt);
  const hits = [];
  for (const wave of waves) {
    const duration = Math.min(waveLiveTime(wave, dt), cancelled.get(wave.id) ?? Infinity);
    if (duration < 0) continue;
    const arc = waveArc(wave), cancelTime = cancelled.get(wave.id);
    for (const player of arena.players.values()) {
      if (player.id === wave.ownerId || player.respawnIn > 0 || player.invulnerable > 0 || wave.hit.has(player.id)) continue;
      const touched = player.cells.map(cell => ({ cell, time: waveCellTOI(wave, arc, cell, dt, duration) }))
        .filter(hit => Number.isFinite(hit.time) && (cancelTime === undefined || hit.time < cancelTime - WAVE_TIME_EPSILON))
        .sort((a, b) => a.time - b.time || a.cell.id.localeCompare(b.cell.id));
      if (touched.length) hits.push({ wave, player, hitCells: touched.map(hit => hit.cell), time: touched[0].time });
    }
  }
  hits.sort((a, b) => a.time - b.time || a.wave.id.localeCompare(b.wave.id) || a.player.id.localeCompare(b.player.id));
  for (const { wave, player, hitCells, time } of hits) {
    wave.hit.add(player.id);
    const eventId = `${wave.id}:${player.id}`, primary = hitCells[0];
    const impulseFor = cell => clamp(WAVE.knockback * Math.pow(START_MASS / cell.mass, 0.35), WAVE.minKnockback, WAVE.maxKnockback);
    const primaryImpulse = impulseFor(primary);
    const point = { x: primary.x - wave.directionX * primary.radius, y: primary.y - wave.directionY * primary.radius };
    let lostMass = 0;
    for (const cell of hitCells) {
      const impulse = impulseFor(cell);
      cell.lastWaveHitId = eventId; cell.vx += wave.directionX * impulse; cell.vy += wave.directionY * impulse;
      lostMass += chipWaveCell(arena, player, cell, wave);
    }
    player.collisionRevision++;
    player.lastWaveHit = { id: eventId, waveId: wave.id, at: arena.time - dt + time,
      ownerId: wave.ownerId, cellId: primary.id, ...point, directionX: wave.directionX, directionY: wave.directionY,
      mode: wave.mode, lostMass, hitCells: hitCells.length, hitCellIds: hitCells.map(cell => cell.id), impulse: primaryImpulse };
    syncPlayer(player);
  }
  for (const wave of waves) {
    const duration = Math.max(0, Math.min(waveLiveTime(wave, dt), cancelled.get(wave.id) ?? Infinity));
    wave.travel = Math.min(wave.distance, wave.travel + wave.speed * duration);
    wave.x = wave.originX + wave.directionX * wave.travel; wave.y = wave.originY + wave.directionY * wave.travel;
  }
  arena.blasts = waves.filter(wave => !cancelled.has(wave.id) && wave.travel < wave.distance);
  arena.waveClashes = arena.waveClashes.filter(event => arena.time - event.at <= WAVE.clashRetention).slice(-WAVE.clashLimit);
}

export function stepArena(arena, elapsed) {
  if (arena.status !== 'playing') return;
  const dt = clamp(finite(elapsed), 0, 0.1);
  arena.time += dt;
  arena.remaining = arena.endless ? null : Math.max(0, ROUND_DURATION - arena.time);
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
      player.fireQueued = player.rearFireQueued = player.splitQueued = false;
      if (player.respawnIn === 0) {
        Object.assign(player, spawnPosition(arena), { energy: 45, invulnerable: 2 });
        player.cells = [newCell(arena, player.x, player.y, START_MASS)];
        syncPlayer(player);
      }
      continue;
    }
    const input = player.connected ? player.input : normalizeInput();
    const moving = Math.hypot(input.x, input.y) > 0;
    const actionDirection = moving ? { x: input.x / Math.hypot(input.x, input.y), y: input.y / Math.hypot(input.x, input.y) } : player.direction;
    player.energy = clamp(player.energy + dt * player.stats.energyRegen, 0, 100);
    if (player.splitQueued) splitPlayer(arena, player, actionDirection);
    player.splitQueued = false;
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
    resolvePlayerBodies(arena, substep, arena.time - dt + (i + 1) * substep);
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
      cell._motionDt = 0; cell._sweepTime = 0;
      cell._sweepX = cell.x; cell._sweepY = cell.y;
      cell._sweepVx = cell.vx; cell._sweepVy = cell.vy;
      cell._freeX = cell.x; cell._freeY = cell.y; cell._freeVx = cell.vx; cell._freeVy = cell.vy;
    }
    resolvePlayerBodies(arena);
  }
  for (const player of arena.players.values()) {
    updateFacing(player, player.connected ? player.input : normalizeInput());
    if (player.fireQueued) launchWave(arena, player, 'forward');
    else if (player.rearFireQueued) launchWave(arena, player, 'rear');
    player.fireQueued = player.rearFireQueued = false;
  }
  advanceWaves(arena, dt);
  advanceMeteors(arena, dt, { frameStart: arena.time - dt });
  refillDust(arena);
  for (const player of arena.players.values()) updateProgress(arena, player);

  if (!arena.endless && arena.remaining <= 0) {
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
  const visibleMeteors = bounds ? arena.meteors.filter(meteor => {
    const margin = meteor.radius + meteor.tailLength + Math.hypot(meteor.vx, meteor.vy) * METEOR.viewportLead;
    return meteor.x + margin >= bounds.left && meteor.x - margin <= bounds.right &&
      meteor.y + margin >= bounds.top && meteor.y - margin <= bounds.bottom;
  }) : arena.meteors;
  return {
    arena: ARENA, motion: MOTION, sibling: SIBLING, meteor: METEOR, simulationTime: arena.time * 1000, dustTotal: arena.dust.length,
    meteorTotal: arena.meteors.length, meteors: visibleMeteors.map(meteor => ({
      id: meteor.id, x: meteor.x, y: meteor.y, vx: meteor.vx, vy: meteor.vy,
      radius: meteor.radius, mass: meteor.mass ?? METEOR.mass, tailLength: meteor.tailLength,
      color: meteor.color, bornAt: meteor.bornAt })),
    status: arena.status, endless: arena.endless, time: round(arena.time), remaining: arena.endless ? null : round(arena.remaining),
    round: arena.round, winnerId: arena.winnerId,
    waveClashes: arena.waveClashes.map(event => ({ ...event, waveIds: [...event.waveIds], ownerIds: [...event.ownerIds], colors: [...event.colors] })),
    players: [...arena.players.values()].map(p => ({ id: p.id, name: p.name, color: p.color,
      x: round(p.x), y: round(p.y), vx: round(p.vx), vy: round(p.vy), radius: round(p.radius), mass: round(p.mass),
      lastInputSeq: p.lastInputSeq, inputAge: p.inputAge, collisionRevision: p.collisionRevision,
      lastImpact: p.lastImpact ? { ...p.lastImpact } : null,
      lastWaveHit: p.lastWaveHit ? { ...p.lastWaveHit, hitCellIds: [...p.lastWaveHit.hitCellIds] } : null,
      lastMeteorHit: p.lastMeteorHit ? { ...p.lastMeteorHit, hitCellIds: [...p.lastMeteorHit.hitCellIds] } : null,
      direction: { ...p.direction },
      steering: { x: p.connected ? p.input.x : 0, y: p.connected ? p.input.y : 0 },
      gravityRadius: p.cells.length ? round(Math.max(...p.cells.map(c => gravityRadius(c, p)))) : 0,
      cells: p.cells.map(c => ({ id: c.id, x: round(c.x), y: round(c.y), vx: round(c.vx), vy: round(c.vy),
        impulseX: round(c.impulseX), impulseY: round(c.impulseY), radius: round(c.radius), mass: round(c.mass),
        lastWaveHitId: c.lastWaveHitId ?? null, lastMeteorHitId: c.lastMeteorHitId ?? null,
        mergeIn: round(c.mergeIn), gravityRadius: round(gravityRadius(c, p)), protected: Math.max(c.protectedFor, c.shatterCooldown, p.invulnerable) > 0,
        fusionId: c.fusionId ?? null, fusionRole: c.fusionRole ?? null, fusionPartnerId: c.fusionPartnerId ?? null,
        fusionTargetId: c.fusionTargetId ?? null, fusionDonorId: c.fusionDonorId ?? null,
        fusionProgress: c.fusionProgress ?? 0, fusionTime: c.fusionTime ?? 0,
        protectedFor: round(Math.max(c.protectedFor, c.shatterCooldown, p.invulnerable)) })),
      energy: round(p.energy), score: p.score, kills: p.kills, ready: p.ready,
      bot: p.bot, connected: p.connected, respawnIn: round(p.respawnIn),
      level: p.level, peakMass: round(p.peakMass), nextUpgradeMass: UPGRADE_THRESHOLDS[p.upgradeMilestones] ?? null,
      upgradePending: p.upgradePending, upgradeChoices: p.upgradeChoices.map(option => ({ ...option })),
      shatteredAt: round(p.shatteredAt),
      upgrades: Object.entries(p.upgrades).map(([id, count]) => ({ id, count })), stats: { ...p.stats },
      invulnerable: round(p.invulnerable), cooldown: round(p.cooldown) })),
    dust: visibleDust.map(d => ({ id: d.id, x: round(d.x), y: round(d.y), vx: round(finite(d.vx)), vy: round(finite(d.vy)), value: d.value,
      ...(d.fragment ? { fragment: true, color: d.color, ownerId: d.ownerId,
        ...(d.sourceKind ? { sourceKind: d.sourceKind } : {}) } : {}) })),
    blasts: visibleBlasts.map(b => ({ id: b.id, ownerId: b.ownerId, kind: b.kind, mode: b.mode, sourceCellId: b.sourceCellId,
      x: round(b.x), y: round(b.y), originX: round(b.originX), originY: round(b.originY), originOffset: round(b.originOffset),
      directionX: b.directionX, directionY: b.directionY, width: b.width, thickness: b.thickness, curvature: b.curvature,
      speed: b.speed, distance: round(b.distance), travel: round(b.travel),
      color: b.color, radius: round(b.radius), progress: round(b.travel / b.distance) })),
  };
}
