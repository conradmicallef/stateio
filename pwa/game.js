(() => {
'use strict';

// ---------- constants ----------
const W = 360, H = 640;                 // logical world size (portrait)
const PLAYER = 1;
const SPEED = 58;                       // unit speed, world px/s
const UNIT_R = 2.6;                     // unit radius
const HIT_D2 = (UNIT_R * 2.1) ** 2;     // collision distance squared
const EMIT = 0.13;                      // seconds between unit waves leaving a building
const BR = 13;                          // building footprint radius (unit spawn/arrive edge)
const TAU = Math.PI * 2;

// faction palette: building colour, dark shade (cliffs, outlines), territory fill
const FACT = [
  { main: '#aab2bf', dark: '#7d8696', land: '#e3e7ee' }, // neutral
  { main: '#2f80ff', dark: '#1d5fd0', land: '#9cc4ff' }, // player
  { main: '#ff4757', dark: '#c92f3e', land: '#ffadb4' },
  { main: '#ffae1a', dark: '#c9820a', land: '#ffd98c' },
  { main: '#20c07a', dark: '#12915a', land: '#93e4bf' },
  { main: '#a25ff0', dark: '#763cc2', land: '#d5b5fb' },
];
const NAMES = ['Neutral', 'You', 'Red', 'Yellow', 'Green', 'Purple'];

// building types: production per second, capacity, (towers) range & fire interval, per level 1..3
const TYPES = {
  city:     { prod: [0.9, 1.3, 1.8], cap: [40, 60, 90] },
  barracks: { prod: [1.6, 2.2, 3.0], cap: [25, 40, 60] },
  tower:    { prod: [0.45, 0.6, 0.8], cap: [25, 40, 60], range: [62, 74, 88], rate: [1.1, 0.8, 0.55] },
};
const UPG_COST = [0, 10, 20];           // troops to feed into a FULL building to go lvl 1->2, 2->3
const MAX_LVL = 3;

// ---------- DOM ----------
const cv = document.getElementById('c');
const ctx = cv.getContext('2d');
const terr = document.createElement('canvas');   // cached territory layer
const tctx = terr.getContext('2d');
const overlay = document.getElementById('overlay');
const titleEl = document.getElementById('title');
const msgEl = document.getElementById('msg');
const starsEl = document.getElementById('stars');
const playBtn = document.getElementById('play');
const lvlEl = document.getElementById('lvl');
const barEl = document.getElementById('bar');
const installBtn = document.getElementById('install');

// localStorage can throw (private mode, blocked storage)
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : v; } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } },
};

// ---------- state ----------
let level = Math.max(1, parseInt(store.get('kingdoms.level', '1'), 10) || 1);
let map = null;                 // { pts, path }
let bld = [];                   // buildings
let units = [], fx = [], shots = [], ai = [];
let running = false, ended = false, last = 0, elapsed = 0, time = 0;
let stats = { captured: 0, lost: 0 };
let diff = null;
let dpr = 1, vw = 0, vh = 0, scale = 1, offX = 0, offY = 0;
let terrDirty = true, barT = 0;
// input
let activeId = null, selected = [], pointer = null, downPos = null, moved = false, tapSel = null, hover = null;

// seeded RNG so a level is the same every time
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const cap = b => TYPES[b.type].cap[b.lvl - 1];
const prod = b => TYPES[b.type].prod[b.lvl - 1];
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
function rgba(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
}

// ---------- geometry ----------
function inPoly(x, y, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function edgeDist(x, y, pts) {
  let m = Infinity;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [ax, ay] = pts[j], [bx, by] = pts[i];
    const dx = bx - ax, dy = by - ay;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
    m = Math.min(m, Math.hypot(x - ax - dx * t, y - ay - dy * t));
  }
  return m;
}
function polyArea(pts) {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += pts[j][0] * pts[i][1] - pts[i][0] * pts[j][1];
  return Math.abs(a / 2);
}
// keep the half of `poly` closer to a than to b (Voronoi half-plane clip)
function clipHalf(poly, a, b) {
  const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2, nx = b.x - a.x, ny = b.y - a.y;
  const f = p => (p[0] - mx) * nx + (p[1] - my) * ny;
  const out = [];
  for (let k = 0; k < poly.length; k++) {
    const P = poly[k], Q = poly[(k + 1) % poly.length];
    const fp = f(P), fq = f(Q);
    if (fp <= 0) out.push(P);
    if ((fp < 0 && fq > 0) || (fp > 0 && fq < 0)) {
      const t = fp / (fp - fq);
      out.push([P[0] + (Q[0] - P[0]) * t, P[1] + (Q[1] - P[1]) * t]);
    }
  }
  return out;
}
function smoothPath(pts) {
  const p = new Path2D(), n = pts.length;
  const mid = i => [(pts[i % n][0] + pts[(i + 1) % n][0]) / 2, (pts[i % n][1] + pts[(i + 1) % n][1]) / 2];
  const s = mid(0);
  p.moveTo(s[0], s[1]);
  for (let i = 1; i <= n; i++) { const c = pts[i % n], e = mid(i); p.quadraticCurveTo(c[0], c[1], e[0], e[1]); }
  p.closePath();
  return p;
}
function polyPath(pts) {
  const p = new Path2D();
  pts.forEach((q, i) => (i ? p.lineTo(q[0], q[1]) : p.moveTo(q[0], q[1])));
  p.closePath();
  return p;
}

// ---------- level generation ----------
function genLevel(n) {
  const r = rng(n * 7919 + 13);

  // landmass: a wobbly ellipse
  const cx = W / 2, cy = 360, rx = 140, ry = 226;
  const ph = [r() * TAU, r() * TAU, r() * TAU], am = [0.06 + r() * 0.05, 0.03 + r() * 0.04, 0.02 + r() * 0.02];
  const pts = [];
  for (let i = 0; i < 72; i++) {
    const th = i / 72 * TAU;
    const k = 1 + am[0] * Math.sin(2 * th + ph[0]) + am[1] * Math.sin(3 * th + ph[1]) + am[2] * Math.sin(5 * th + ph[2]);
    pts.push([cx + Math.cos(th) * rx * k, cy + Math.sin(th) * ry * k]);
  }
  map = { pts, path: smoothPath(pts) };

  // building seeds (Poisson-ish rejection sampling inside the landmass)
  const count = Math.min(8 + n, 20);
  let minD = Math.sqrt(polyArea(pts) / count) * 0.82;
  const seeds = [];
  let tries = 0;
  while (seeds.length < count) {
    if (++tries > 3000) { minD *= 0.92; tries = 0; }
    const x = cx + (r() * 2 - 1) * rx * 1.2, y = cy + (r() * 2 - 1) * ry * 1.2;
    if (!inPoly(x, y, pts) || edgeDist(x, y, pts) < 24) continue;
    if (seeds.some(s => Math.hypot(s.x - x, s.y - y) < minD)) continue;
    seeds.push({ x, y });
  }

  bld = seeds.map((s, i) => {
    let cell = [[-40, -40], [W + 40, -40], [W + 40, H + 40], [-40, H + 40]];
    for (const o of seeds) if (o !== s) cell = clipHalf(cell, s, o);
    const rr = r();
    const type = n >= 2 && rr < 0.2 ? 'tower' : rr < 0.45 ? 'barracks' : 'city';
    const base = type === 'tower' ? 8 : type === 'barracks' ? 4 : 6;
    return {
      id: i, x: s.x, y: s.y, type, owner: 0,
      lvl: n >= 6 && r() < 0.25 ? 2 : 1,
      troops: Math.round((base + r() * 9) * (1 + n * 0.06)),
      upg: 0, out: null, emitT: 0, cool: 0, flash: 0, bump: 0, hit: 0,
      path: polyPath(cell),
    };
  });

  // owners: player at the bottom, enemies spread far apart (farthest-point sampling)
  const enemies = n < 3 ? 1 : n < 7 ? 2 : n < 12 ? 3 : 4;
  const home = (b, owner, troops, lvl) => {
    b.owner = owner; b.type = 'city'; b.troops = troops; b.lvl = lvl;
  };
  const p = bld.reduce((a, b) => (b.y > a.y ? b : a));
  home(p, PLAYER, 20, 1);
  const chosen = [p];
  ai = [];
  diff = {
    think: Math.max(0.8, 3.8 - n * 0.22),       // seconds between AI decisions
    mistake: Math.max(0, 0.4 - n * 0.04),       // chance to skip a decision
    safety: n < 4 ? 1.0 : n < 10 ? 1.1 : 1.2,   // margin before attacking
    minSend: n < 3 ? 15 : n < 6 ? 11 : 8,
    hate: 1 + Math.min(0.6, n * 0.05),          // preference for attacking the player
  };
  for (let e = 0; e < enemies; e++) {
    let best = null, bd = -1;
    for (const b of bld) {
      if (chosen.includes(b)) continue;
      const d = Math.min(...chosen.map(c => dist(b, c)));
      if (d > bd) { bd = d; best = b; }
    }
    home(best, 2 + e, 18 + Math.min(n, 20), n >= 9 ? 2 : 1);
    chosen.push(best);
    ai.push({ owner: 2 + e, timer: 1.5 + e * 0.6 + r() * 1.5 });
  }

  units = []; fx = []; shots = [];
  terrDirty = true;
}

// ---------- gameplay ----------
function start(n) {
  level = n;
  store.set('kingdoms.level', level);
  lvlEl.textContent = 'Level ' + level;
  genLevel(level);
  resetInput();
  elapsed = 0; stats = { captured: 0, lost: 0 };
  ended = false; running = true;
  overlay.classList.remove('show');
  last = performance.now();
  updateBar();
}

// send every troop from `from` to `to`; they leave as a stream. A new order redirects the stream.
function order(from, to) {
  if (!from || !to || from === to || from.owner === 0) return;
  const n = Math.floor(from.troops);
  if (n < 1) return;
  from.out = { to, n };
}

function spawnUnit(from, to, off) {
  const dx = to.x - from.x, dy = to.y - from.y, len = Math.hypot(dx, dy) || 1;
  const ux = dx / len, uy = dy / len;
  const sx = from.x + ux * BR - uy * off, sy = from.y + uy * BR + ux * off;
  const ex = to.x - ux * BR - uy * off, ey = to.y - uy * BR + ux * off;
  units.push({
    x: sx, y: sy, sx, sy, ux, uy, d: 0, len: Math.max(0, Math.hypot(ex - sx, ey - sy)),
    owner: from.owner, to, dead: false, ph: Math.random() * TAU,
  });
}

const LANES = [[0], [-3, 3], [-5.5, 0, 5.5]];
function emit(b, dt) {
  if (!b.out) { b.emitT = 0; return; }
  b.emitT -= dt;
  while (b.out && b.emitT <= 0) {
    b.emitT += EMIT;
    const k = Math.min(3, b.out.n, Math.floor(b.troops));
    if (k < 1) { b.out = null; break; }
    for (const off of LANES[k - 1]) spawnUnit(b, b.out.to, off);
    b.troops -= k; b.out.n -= k;
    if (b.out.n <= 0) b.out = null;
  }
}

function capture(t, owner) {
  if (t.owner === PLAYER) stats.lost++;
  if (owner === PLAYER) stats.captured++;
  if (owner === PLAYER || t.owner === PLAYER) {
    window.dispatchEvent(new CustomEvent('kingdoms:capture', { detail: { lost: owner !== PLAYER } }));
  }
  t.owner = owner; t.troops = 1; t.upg = 0; t.out = null; t.emitT = 0;
  t.flash = 1; t.bump = 1;
  if (tapSel === t) tapSel = null;
  selected = selected.filter(s => s !== t);
  burst(t.x, t.y - 8, FACT[owner].main, 14, 60);
  terrDirty = true;
}

function arrive(u) {
  const t = u.to;
  if (t.owner === u.owner) {
    if (t.lvl < MAX_LVL && t.troops >= cap(t) - 0.001) {
      // feeding a full building upgrades it
      if (++t.upg >= UPG_COST[t.lvl]) {
        t.lvl++; t.upg = 0; t.bump = 1;
        burst(t.x, t.y - 10, '#ffd23f', 18, 70);
      }
    } else t.troops += 1;
  } else if (t.troops >= 1) {
    t.troops -= 1; t.hit = 0.12;
  } else capture(t, u.owner);
}

function update(dt) {
  elapsed += dt;

  for (const b of bld) {
    if (b.owner) {
      const c = cap(b);
      if (b.troops < c) b.troops = Math.min(c, b.troops + prod(b) * dt);
      else if (b.troops > c + 0.5) b.troops = Math.max(c, b.troops - dt * 0.8); // overflow bleeds back to cap
    }
    emit(b, dt);
    b.flash = Math.max(0, b.flash - dt * 1.6);
    b.bump = Math.max(0, b.bump - dt * 4);
    b.hit = Math.max(0, b.hit - dt);
  }

  // move units
  for (const u of units) {
    if (u.dead) continue;
    u.d += SPEED * dt;
    if (u.d >= u.len) { u.dead = true; arrive(u); continue; }
    u.x = u.sx + u.ux * u.d; u.y = u.sy + u.uy * u.d;
  }

  // opposing units that touch cancel each other (spatial grid, each pair checked once)
  const G = 8, grid = new Map();
  for (const u of units) {
    if (u.dead) continue;
    const gx = Math.floor(u.x / G), gy = Math.floor(u.y / G);
    let hitV = null;
    for (let ix = gx - 1; ix <= gx + 1 && !hitV; ix++) {
      for (let iy = gy - 1; iy <= gy + 1 && !hitV; iy++) {
        const cell = grid.get(ix * 4096 + iy);
        if (!cell) continue;
        for (const v of cell) {
          if (v.dead || v.owner === u.owner) continue;
          const dx = v.x - u.x, dy = v.y - u.y;
          if (dx * dx + dy * dy < HIT_D2) { hitV = v; break; }
        }
      }
    }
    if (hitV) {
      u.dead = hitV.dead = true;
      pop((u.x + hitV.x) / 2, (u.y + hitV.y) / 2, FACT[u.owner].main, FACT[hitV.owner].main);
      continue;
    }
    const key = gx * 4096 + gy;
    const cell = grid.get(key);
    if (cell) cell.push(u); else grid.set(key, [u]);
  }

  // defence towers shoot hostile units in range (neutral towers only shoot their attackers)
  for (const b of bld) {
    if (b.type !== 'tower') continue;
    b.cool -= dt;
    if (b.cool > 0) continue;
    const T = TYPES.tower, range = T.range[b.lvl - 1];
    let best = null, bd = range * range;
    for (const u of units) {
      if (u.dead || u.owner === b.owner || (b.owner === 0 && u.to !== b)) continue;
      const dx = u.x - b.x, dy = u.y - b.y, d2 = dx * dx + dy * dy;
      if (d2 < bd) { bd = d2; best = u; }
    }
    if (best) {
      best.dead = true;
      shots.push({ x1: b.x, y1: b.y - 26, x2: best.x, y2: best.y, t: 0.16, c: FACT[b.owner].dark });
      pop(best.x, best.y, FACT[best.owner].main, '#ffffff');
      b.cool = T.rate[b.lvl - 1];
    } else b.cool = 0.1;
  }

  units = units.filter(u => !u.dead);

  for (const a of ai) {
    a.timer -= dt;
    if (a.timer > 0) continue;
    a.timer = diff.think * (0.75 + Math.random() * 0.5);
    if (Math.random() >= diff.mistake) aiThink(a.owner);
  }

  if (tapSel && tapSel.owner !== PLAYER) tapSel = null;

  const alive = new Set();
  for (const b of bld) if (b.owner) alive.add(b.owner);
  for (const u of units) alive.add(u.owner);
  if (!alive.has(PLAYER)) return end(false);
  if ([...alive].every(o => o === PLAYER)) return end(true);
}

// ---------- AI ----------
function incomingMap() {
  const m = new Map();
  const add = (t, o, k) => {
    let e = m.get(t);
    if (!e) m.set(t, (e = {}));
    e[o] = (e[o] || 0) + k;
  };
  for (const u of units) add(u.to, u.owner, 1);
  for (const b of bld) if (b.out && b.owner) add(b.out.to, b.owner, b.out.n);
  return m;
}

// estimated defenders when an attack from `me` lands after `travel` seconds
function estDefence(t, travel, me, inc) {
  let def = t.troops;
  if (t.owner) def = Math.min(Math.max(t.troops, cap(t)), def + prod(t) * travel);
  const ic = inc.get(t);
  if (ic) {
    for (const k in ic) {
      const o = +k;
      if (o === t.owner) def += ic[k];
      else if (o === me) def -= ic[k];
      else def -= ic[k] * 0.5;
    }
  }
  if (t.type === 'tower') def += (TYPES.tower.range[t.lvl - 1] / SPEED) / TYPES.tower.rate[t.lvl - 1];
  return def;
}

function targetValue(t) {
  let v = t.type === 'barracks' ? 1.3 : t.type === 'tower' ? 1.1 : 1;
  v *= 1 + 0.3 * (t.lvl - 1);
  if (t.owner === PLAYER) v *= diff.hate;
  else if (t.owner) v *= 0.85;
  return v;
}

function aiThink(me) {
  const mine = bld.filter(b => b.owner === me);
  if (!mine.length) return;
  const inc = incomingMap();
  const idle = mine.filter(b => !b.out);

  // 1) defend a building about to fall
  for (const b of mine) {
    const ic = inc.get(b);
    if (!ic) continue;
    let hostile = 0;
    for (const k in ic) if (+k !== me) hostile += ic[k];
    if (hostile > b.troops + (ic[me] || 0) + 1) {
      const helper = idle.filter(h => h !== b && h.troops >= 8).sort((x, y) => dist(x, b) - dist(y, b))[0];
      if (helper && Math.random() < 0.4 + level * 0.04) { order(helper, b); return; }
    }
  }

  // 2) single-source attack
  let best = null, bestScore = -Infinity;
  for (const src of idle) {
    const avail = Math.floor(src.troops);
    if (avail < diff.minSend && avail < cap(src) - 1) continue;
    for (const t of bld) {
      if (t.owner === me) continue;
      const d = dist(src, t);
      const need = estDefence(t, d / SPEED, me, inc) + 2;
      if (need <= 0 || avail < need * diff.safety) continue;
      const score = targetValue(t) * 80 / (d + 60) - need / avail * 0.6;
      if (score > bestScore) { bestScore = score; best = [src, t]; }
    }
  }
  if (best) { order(best[0], best[1]); return; }

  // 3) combined attack from up to three nearby buildings
  let group = null, gScore = -Infinity;
  for (const t of bld) {
    if (t.owner === me) continue;
    const srcs = idle.filter(s => s.troops >= 5 && dist(s, t) < 260).sort((x, y) => dist(x, t) - dist(y, t)).slice(0, 3);
    if (srcs.length < 2) continue;
    const sum = srcs.reduce((s, b) => s + Math.floor(b.troops), 0);
    const avgD = srcs.reduce((s, b) => s + dist(b, t), 0) / srcs.length;
    const need = estDefence(t, avgD / SPEED, me, inc) + 3;
    if (sum < need * diff.safety * 1.1) continue;
    const score = targetValue(t) * 80 / (avgD + 60);
    if (score > gScore) { gScore = score; group = [srcs, t]; }
  }
  if (group) { group[0].forEach(s => order(s, group[1])); return; }

  // 4) upgrade: feed one full building into another
  const full = idle.filter(b => b.troops >= cap(b) - 0.5);
  const upg = full.filter(b => b.lvl < MAX_LVL).sort((x, y) => targetValue(y) - targetValue(x))[0];
  if (upg && full.length >= 2 && Math.random() < 0.3 + level * 0.03) {
    const src = full.filter(b => b !== upg).sort((x, y) => dist(x, upg) - dist(y, upg))[0];
    if (src) order(src, upg);
  }
}

function end(win) {
  if (ended) return;
  ended = true; running = false;
  resetInput();
  updateBar();
  starsEl.textContent = '';
  const mm = Math.floor(elapsed / 60), ss = String(Math.floor(elapsed % 60)).padStart(2, '0');
  if (win) {
    const par = 35 + bld.length * 5;
    const stars = elapsed < par ? 3 : elapsed < par * 1.8 ? 2 : 1;
    titleEl.textContent = 'Level ' + level + ' complete!';
    starsEl.innerHTML = [1, 2, 3].map(i => `<span class="${i <= stars ? 'on' : ''}">&#9733;</span>`).join('');
    msgEl.textContent = `Time ${mm}:${ss} · Captured ${stats.captured} · Lost ${stats.lost}`;
    level++;
    store.set('kingdoms.level', level);
    playBtn.textContent = 'Next level';
    confetti();
  } else {
    titleEl.textContent = 'Defeated';
    msgEl.textContent = `You held out for ${mm}:${ss}. Try again!`;
    playBtn.textContent = 'Retry';
  }
  setTimeout(() => overlay.classList.add('show'), win ? 1100 : 700);
}

// ---------- effects ----------
function pop(x, y, c1, c2) {
  for (let i = 0; i < 4; i++) {
    const a = Math.random() * TAU, s = 20 + Math.random() * 30;
    fx.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, t: 0.35, max: 0.35, c: i & 1 ? c1 : c2, r: 1.6, g: 0 });
  }
}
function burst(x, y, c, n, sp) {
  for (let i = 0; i < n; i++) {
    const a = Math.random() * TAU, s = sp * (0.4 + Math.random() * 0.6);
    fx.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 20, t: 0.6, max: 0.6, c, r: 2.4, g: 80 });
  }
}
function confetti() {
  const cols = ['#2f80ff', '#ff4757', '#ffae1a', '#20c07a', '#a25ff0', '#ffffff'];
  for (let i = 0; i < 90; i++) {
    fx.push({ x: Math.random() * W, y: -10 - Math.random() * 120, vx: (Math.random() - 0.5) * 40, vy: 60 + Math.random() * 80,
      t: 3, max: 3, c: cols[i % cols.length], r: 2.5 + Math.random() * 1.5, g: 30, sq: true, rot: Math.random() * TAU });
  }
}
function updateFx(dt) {
  for (const p of fx) { p.t -= dt; p.vy += p.g * dt; p.x += p.vx * dt; p.y += p.vy * dt; if (p.rot != null) p.rot += dt * 6; }
  fx = fx.filter(p => p.t > 0);
  for (const s of shots) s.t -= dt;
  shots = shots.filter(s => s.t > 0);
}

// ---------- HUD power bar ----------
const barSegs = FACT.map((f, i) => {
  const d = document.createElement('div');
  d.style.background = f.main; d.title = NAMES[i];
  barEl.appendChild(d);
  return d;
});
function updateBar() {
  const tot = FACT.map(() => 0);
  for (const b of bld) if (b.owner) tot[b.owner] += b.troops;
  for (const u of units) tot[u.owner] += 1;
  barSegs.forEach((d, i) => {
    d.style.display = i && tot[i] > 0 ? '' : 'none';
    d.style.flexGrow = String(tot[i]);
    d.textContent = i && tot[i] > 0 ? Math.floor(tot[i]) : '';
  });
}

// ---------- rendering ----------
function worldTransform(g) { g.setTransform(dpr * scale, 0, 0, dpr * scale, dpr * offX, dpr * offY); }

function renderTerrain() {
  terrDirty = false;
  const g = tctx;
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.clearRect(0, 0, terr.width, terr.height);
  if (!map) return;
  worldTransform(g);
  // soft drop shadow in the sea
  g.save(); g.translate(0, 16); g.fillStyle = 'rgba(30,80,140,.18)'; g.fill(map.path); g.restore();
  // coloured cliff edge (cells shifted down)
  g.save(); g.translate(0, 8); g.clip(map.path);
  for (const b of bld) { g.fillStyle = FACT[b.owner].dark; g.fill(b.path); }
  g.restore();
  // territory tops + white borders
  g.save(); g.clip(map.path);
  for (const b of bld) { g.fillStyle = FACT[b.owner].land; g.fill(b.path); }
  g.lineJoin = 'round'; g.lineWidth = 2; g.strokeStyle = 'rgba(255,255,255,.85)';
  for (const b of bld) g.stroke(b.path);
  g.restore();
  g.lineWidth = 2.5; g.strokeStyle = 'rgba(255,255,255,.95)'; g.stroke(map.path);
}

function rr(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
}

// returns label y (relative) above the drawn building
function drawBuildingShape(b) {
  const f = FACT[b.owner];
  ctx.lineWidth = 1.5; ctx.strokeStyle = 'rgba(0,0,0,.28)';
  if (b.type === 'city') {
    ctx.fillStyle = f.main;
    rr(ctx, -11, -15, 22, 16, 3); ctx.fill(); ctx.stroke();
    for (const x of [-11, -2.5, 6]) { ctx.fillRect(x, -19, 5, 5); ctx.strokeRect(x, -19, 5, 5); }
    ctx.fillStyle = f.dark; ctx.fillRect(-11, -3, 22, 4);
    ctx.beginPath(); ctx.arc(0, -3, 4, Math.PI, 0); ctx.lineTo(4, 1); ctx.lineTo(-4, 1); ctx.fill();
    return -25;
  }
  if (b.type === 'barracks') {
    ctx.fillStyle = f.main;
    rr(ctx, -13, -11, 26, 12, 2); ctx.fill(); ctx.stroke();
    ctx.fillStyle = f.dark;
    ctx.beginPath(); ctx.moveTo(-15, -10); ctx.lineTo(0, -21); ctx.lineTo(15, -10); ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.fillRect(-3, -6, 6, 7);
    ctx.fillStyle = '#fff'; ctx.fillRect(-10, -7, 4, 3); ctx.fillRect(6, -7, 4, 3);
    return -27;
  }
  // tower
  ctx.fillStyle = f.main;
  rr(ctx, -6, -24, 12, 25, 2); ctx.fill(); ctx.stroke();
  ctx.fillStyle = f.dark;
  rr(ctx, -9, -30, 18, 7, 2); ctx.fill(); ctx.stroke();
  ctx.fillRect(-9, -34, 4, 4); ctx.fillRect(-2, -34, 4, 4); ctx.fillRect(5, -34, 4, 4);
  ctx.fillRect(-1.5, -18, 3, 6);
  return -40;
}

function drawBuilding(b) {
  const f = FACT[b.owner];
  const s = 1 + Math.sin(b.bump * Math.PI) * 0.3;
  const sh = b.hit > 0 ? Math.sin(time * 90) * 1.4 : 0;
  ctx.save();
  ctx.translate(b.x + sh, b.y);
  ctx.fillStyle = 'rgba(0,0,0,.18)';
  ctx.beginPath(); ctx.ellipse(0, 2, 15, 5.5, 0, 0, TAU); ctx.fill();
  ctx.scale(s, s);
  const ly = drawBuildingShape(b);
  ctx.restore();

  // level pips + upgrade progress
  ctx.fillStyle = '#ffd23f'; ctx.strokeStyle = 'rgba(0,0,0,.35)'; ctx.lineWidth = 1;
  for (let i = 0; i < b.lvl; i++) {
    ctx.beginPath(); ctx.arc(b.x + (i - (b.lvl - 1) / 2) * 6, b.y + 7, 2.1, 0, TAU); ctx.fill(); ctx.stroke();
  }
  if (b.upg > 0 && b.lvl < MAX_LVL) {
    const w = 24, p = b.upg / UPG_COST[b.lvl];
    ctx.fillStyle = 'rgba(0,0,0,.3)'; ctx.fillRect(b.x - w / 2, b.y + 11, w, 3);
    ctx.fillStyle = '#ffd23f'; ctx.fillRect(b.x - w / 2, b.y + 11, w * p, 3);
  }

  // troop count
  const txt = String(Math.floor(b.troops));
  ctx.font = '800 13px system-ui,-apple-system,Segoe UI,Roboto,sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.lineWidth = 3.5; ctx.lineJoin = 'round'; ctx.strokeStyle = f.dark;
  ctx.strokeText(txt, b.x, b.y + ly * s);
  ctx.fillStyle = '#fff'; ctx.fillText(txt, b.x, b.y + ly * s);
}

function drawArrow(x1, y1, x2, y2, col) {
  const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy);
  if (len < 16) return;
  const ux = dx / len, uy = dy / len, hx = x2 - ux * 12, hy = y2 - uy * 12;
  ctx.lineCap = 'round';
  for (const [w, c] of [[9, col], [5, '#fff']]) {
    ctx.strokeStyle = c; ctx.lineWidth = w;
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(hx, hy); ctx.stroke();
  }
  ctx.fillStyle = '#fff'; ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.lineJoin = 'round';
  ctx.beginPath(); ctx.moveTo(x2, y2); ctx.lineTo(hx - uy * 9, hy + ux * 9); ctx.lineTo(hx + uy * 9, hy - ux * 9); ctx.closePath();
  ctx.fill(); ctx.stroke();
}

function draw() {
  if (terrDirty) renderTerrain();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, cv.width, cv.height);
  ctx.drawImage(terr, 0, 0);
  worldTransform(ctx);
  if (!map) return;

  // per-frame territory overlays: capture flash, selection, drag target
  const sel = tapSel ? [tapSel, ...selected] : selected;
  ctx.save(); ctx.clip(map.path);
  for (const b of bld) {
    let a = b.flash * 0.6;
    if (sel.includes(b)) a = Math.max(a, 0.35);
    if (hover && b === hover && selected.length && !selected.includes(b)) a = Math.max(a, 0.25 + 0.15 * Math.sin(time * 10));
    if (a > 0) { ctx.fillStyle = `rgba(255,255,255,${a})`; ctx.fill(b.path); }
  }
  ctx.restore();

  // tower ranges
  for (const b of bld) {
    if (b.type !== 'tower') continue;
    const R = TYPES.tower.range[b.lvl - 1];
    ctx.beginPath(); ctx.arc(b.x, b.y, R, 0, TAU);
    ctx.fillStyle = rgba(FACT[b.owner].main, 0.08); ctx.fill();
    ctx.setLineDash([4, 5]); ctx.lineWidth = 1.2; ctx.strokeStyle = rgba(FACT[b.owner].dark, 0.45); ctx.stroke();
    ctx.setLineDash([]);
  }

  // units: marching dots, batched per faction
  for (let o = 1; o < FACT.length; o++) {
    ctx.beginPath();
    let any = false;
    for (const u of units) {
      if (u.owner !== o) continue;
      const y = u.y - Math.abs(Math.sin(u.ph + u.d * 0.35)) * 1.3;
      ctx.moveTo(u.x + UNIT_R, y); ctx.arc(u.x, y, UNIT_R, 0, TAU);
      any = true;
    }
    if (any) { ctx.fillStyle = FACT[o].main; ctx.fill(); ctx.lineWidth = 1; ctx.strokeStyle = FACT[o].dark; ctx.stroke(); }
  }

  // buildings sorted by y for overlap
  for (const b of [...bld].sort((a, c) => a.y - c.y)) drawBuilding(b);

  for (const s of shots) {
    ctx.strokeStyle = rgba('#ffffff', s.t / 0.16); ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(s.x1, s.y1); ctx.lineTo(s.x2, s.y2); ctx.stroke();
  }

  for (const p of fx) {
    ctx.globalAlpha = Math.min(1, p.t / p.max * 1.5);
    ctx.fillStyle = p.c;
    if (p.sq) { ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot); ctx.fillRect(-p.r, -p.r / 2, p.r * 2, p.r); ctx.restore(); }
    else { ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, TAU); ctx.fill(); }
  }
  ctx.globalAlpha = 1;

  // drag arrows
  if (selected.length && pointer && moved) {
    const aim = hover && !(selected.length === 1 && hover === selected[0]) ? hover : null;
    for (const s of selected) {
      if (s === aim) continue;
      const tx = aim ? aim.x : pointer.x, ty = aim ? aim.y - 6 : pointer.y;
      drawArrow(s.x, s.y - 6, tx, ty, FACT[PLAYER].dark);
    }
  }
}

function frame(now) {
  let dt = (now - last) / 1000;
  last = now;
  if (!(dt > 0)) dt = 0;
  dt = Math.min(dt, 0.05);          // also avoids a jump after the tab was hidden
  time += dt;
  if (running) {
    update(dt);
    barT -= dt;
    if (barT <= 0) { barT = 0.25; updateBar(); }
  }
  updateFx(dt);
  draw();
  requestAnimationFrame(frame);
}

// ---------- sizing / DPI ----------
function resize() {
  dpr = Math.min(window.devicePixelRatio || 1, 3);
  vw = Math.max(1, window.innerWidth); vh = Math.max(1, window.innerHeight);
  cv.width = terr.width = Math.round(vw * dpr);
  cv.height = terr.height = Math.round(vh * dpr);
  scale = Math.min(vw / W, vh / H);
  offX = (vw - W * scale) / 2;
  offY = (vh - H * scale) / 2;
  terrDirty = true;
}
function watchDpr() {
  if (!window.matchMedia) return;
  const mq = matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
  const on = () => { resize(); watchDpr(); };
  if (mq.addEventListener) mq.addEventListener('change', on, { once: true });
  else if (mq.addListener) mq.addListener(function h() { mq.removeListener(h); on(); });
}
addEventListener('resize', resize);
addEventListener('orientationchange', resize);

// ---------- input ----------
function toWorld(e) {
  const r = cv.getBoundingClientRect();
  return { x: (e.clientX - r.left - offX) / scale, y: (e.clientY - r.top - offY) / scale };
}
// on land: the territory (Voronoi cell) under the point; off land: a building within reach
function pick(p) {
  if (!map) return null;
  const onLand = inPoly(p.x, p.y, map.pts);
  let best = null, bd = onLand ? Infinity : 30;
  for (const b of bld) { const d = Math.hypot(b.x - p.x, b.y - p.y); if (d < bd) { bd = d; best = b; } }
  return best;
}
function resetInput() {
  if (activeId !== null) { try { cv.releasePointerCapture(activeId); } catch (e) { /* ignore */ } }
  activeId = null; selected = []; pointer = null; downPos = null; moved = false; hover = null; tapSel = null;
}

cv.addEventListener('pointerdown', e => {
  if (!running || activeId !== null) return;      // ignore extra fingers
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  e.preventDefault();
  activeId = e.pointerId;
  try { cv.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
  pointer = downPos = toWorld(e);
  moved = false;
  const b = pick(pointer);
  hover = b;
  selected = b && b.owner === PLAYER ? [b] : [];
});
cv.addEventListener('pointermove', e => {
  if (e.pointerId !== activeId) return;
  pointer = toWorld(e);
  if (!moved && Math.hypot(pointer.x - downPos.x, pointer.y - downPos.y) > 8) moved = true;
  hover = pick(pointer);
  // swipe across several of your territories to add them as sources
  if (moved && selected.length && hover && hover.owner === PLAYER && !selected.includes(hover)) selected.push(hover);
});
cv.addEventListener('pointerup', e => {
  if (e.pointerId !== activeId) return;
  const p = toWorld(e), b = pick(p);
  if (running && b) {
    if (!moved) {
      // tap-to-select, tap-to-send
      if (tapSel && b !== tapSel) { order(tapSel, b); tapSel = null; }
      else if (b.owner === PLAYER) tapSel = tapSel === b ? null : b;
      else tapSel = null;
    } else if (selected.length) {
      for (const s of selected) if (s !== b && s.owner === PLAYER) order(s, b);
      tapSel = null;
    }
  } else if (!moved) tapSel = null;
  const keep = tapSel;
  resetInput();
  tapSel = keep;
});
const cancel = e => {
  if (e.pointerId !== activeId) return;
  const keep = tapSel; resetInput(); tapSel = keep;
};
cv.addEventListener('pointercancel', cancel);
cv.addEventListener('lostpointercapture', cancel);
cv.addEventListener('contextmenu', e => e.preventDefault());

playBtn.addEventListener('click', () => start(level));
document.getElementById('restart').addEventListener('click', () => {
  if (running && !overlay.classList.contains('show')) start(level);
});

// ---------- PWA ----------
let deferred;
addEventListener('beforeinstallprompt', e => {
  e.preventDefault(); deferred = e; installBtn.hidden = false;
});
installBtn.addEventListener('click', async () => {
  if (!deferred) return;
  deferred.prompt(); await deferred.userChoice; deferred = null; installBtn.hidden = true;
});
addEventListener('appinstalled', () => { deferred = null; installBtn.hidden = true; });
if ('serviceWorker' in navigator && !(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform())) {
  addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}

// ---------- boot ----------
lvlEl.textContent = 'Level ' + level;
if (level > 1) { titleEl.textContent = 'Welcome back'; playBtn.textContent = 'Continue – Level ' + level; }
resize();
watchDpr();
genLevel(level);          // preview map behind the menu
updateBar();
requestAnimationFrame(t => { last = t; frame(t); });
})();
