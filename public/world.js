// The world map: team buildings on a grid, a pannable/zoomable camera, empty lots and a minimap.

export const ROOM_W = 1400;
export const ROOM_H = 880;
const GAP_X = 260;
const GAP_Y = 220;
const CELL_W = ROOM_W + GAP_X;
const CELL_H = ROOM_H + GAP_Y;
const MIN_Z = 0.15;
const MAX_Z = 1.4;

const WALLS = ['#B9D7E8', '#C9E4C5', '#E3D3F2', '#FAD9C1', '#F6E7A8', '#C7E6E3', '#F2C6D3'];
const TRIMS = ['#7FA7C0', '#8DBF87', '#AE97CF', '#E2A47C', '#D8BF5C', '#83BDB7', '#D58FA5'];

const $ = (id) => document.getElementById(id);
const viewport = $('viewport');
const world = $('world');
const minimap = $('minimap');

const cam = { x: ROOM_W / 2, y: ROOM_H / 2, z: 0.6 };
let teams = [];
let handlers = { onLot: () => {}, onSign: () => {}, onBoard: () => {}, onPreview: () => {}, onCamera: () => {} };
let alertTeams = new Set();

export const cellToWorld = (col, row) => ({ x: col * CELL_W, y: row * CELL_H });
export const zoom = () => cam.z;

function hashIndex(s, n) {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h % n;
}

export function teamColors(team) {
  const i = hashIndex(team.id, WALLS.length);
  return { wall: WALLS[i], trim: TRIMS[i] };
}

// ---------- camera ----------

function applyCamera() {
  const vw = viewport.clientWidth;
  const vh = viewport.clientHeight;
  world.style.transform = `translate(${vw / 2 - cam.x * cam.z}px, ${vh / 2 - cam.y * cam.z}px) scale(${cam.z})`;
  drawMinimap();
  handlers.onCamera();
  try {
    localStorage.setItem('agent-office-camera', JSON.stringify(cam));
  } catch {
    // Storage blocked; the camera just won't be remembered.
  }
}

function clampZ(z) {
  return Math.min(MAX_Z, Math.max(MIN_Z, z));
}

// Zoom while keeping the world point under (sx, sy) in place.
function zoomAt(factor, sx, sy) {
  const r = viewport.getBoundingClientRect();
  const px = sx - r.left - r.width / 2;
  const py = sy - r.top - r.height / 2;
  const wx = cam.x + px / cam.z;
  const wy = cam.y + py / cam.z;
  cam.z = clampZ(cam.z * factor);
  cam.x = wx - px / cam.z;
  cam.y = wy - py / cam.z;
  applyCamera();
}

let flight = null;
export function flyTo(x, y, z = cam.z) {
  cancelAnimationFrame(flight);
  const from = { ...cam };
  const to = { x, y, z: clampZ(z) };
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
    Object.assign(cam, to);
    return applyCamera();
  }
  const t0 = performance.now();
  const step = (now) => {
    const t = Math.min(1, (now - t0) / 550);
    const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    cam.x = from.x + (to.x - from.x) * e;
    cam.y = from.y + (to.y - from.y) * e;
    cam.z = from.z + (to.z - from.z) * e;
    applyCamera();
    if (t < 1) flight = requestAnimationFrame(step);
  };
  flight = requestAnimationFrame(step);
}

export function fitZoom() {
  return clampZ(Math.min(viewport.clientWidth / (ROOM_W + 80), viewport.clientHeight / (ROOM_H + 80)));
}

export function focusTeam(teamId, animate = true) {
  const t = teams.find((x) => x.id === teamId);
  if (!t) return;
  const p = cellToWorld(t.col, t.row);
  const z = fitZoom();
  if (animate) flyTo(p.x + ROOM_W / 2, p.y + ROOM_H / 2, z);
  else Object.assign(cam, { x: p.x + ROOM_W / 2, y: p.y + ROOM_H / 2, z }), applyCamera();
}

// Drag to pan. Clicks on buttons and desks still work because we only pan after a few pixels of movement.
let drag = null;
viewport.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  drag = { id: e.pointerId, x: e.clientX, y: e.clientY, cx: cam.x, cy: cam.y, moved: false };
});
addEventListener('pointermove', (e) => {
  if (!drag || e.pointerId !== drag.id) return;
  const dx = e.clientX - drag.x;
  const dy = e.clientY - drag.y;
  if (!drag.moved && Math.hypot(dx, dy) < 5) return;
  if (!drag.moved) {
    drag.moved = true;
    viewport.classList.add('dragging');
    cancelAnimationFrame(flight);
  }
  cam.x = drag.cx - dx / cam.z;
  cam.y = drag.cy - dy / cam.z;
  applyCamera();
});
// The click that ends a drag shouldn't open a chat or build a team.
let swallowClicksUntil = 0;
addEventListener(
  'click',
  (ev) => {
    if (performance.now() < swallowClicksUntil) {
      ev.stopPropagation();
      ev.preventDefault();
    }
  },
  { capture: true },
);
addEventListener('pointerup', () => {
  if (drag?.moved) swallowClicksUntil = performance.now() + 80;
  drag = null;
  viewport.classList.remove('dragging');
});

viewport.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    cancelAnimationFrame(flight);
    if (e.ctrlKey || e.metaKey) {
      zoomAt(Math.exp(-e.deltaY * 0.01), e.clientX, e.clientY);
    } else {
      cam.x += e.deltaX / cam.z;
      cam.y += e.deltaY / cam.z;
      applyCamera();
    }
  },
  { passive: false },
);

addEventListener('keydown', (e) => {
  if (e.target.closest('input, textarea, select, dialog')) return;
  const step = 120 / cam.z;
  const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
  if (moves[e.key]) {
    cam.x += moves[e.key][0];
    cam.y += moves[e.key][1];
    applyCamera();
    e.preventDefault();
  } else if (e.key === '+' || e.key === '=') {
    zoomAt(1.2, innerWidth / 2, innerHeight / 2);
  } else if (e.key === '-') {
    zoomAt(1 / 1.2, innerWidth / 2, innerHeight / 2);
  }
});

$('zoom-in').addEventListener('click', () => {
  const r = viewport.getBoundingClientRect();
  zoomAt(1.25, r.left + r.width / 2, r.top + r.height / 2);
});
$('zoom-out').addEventListener('click', () => {
  const r = viewport.getBoundingClientRect();
  zoomAt(1 / 1.25, r.left + r.width / 2, r.top + r.height / 2);
});
addEventListener('resize', applyCamera);

// ---------- rooms and lots ----------

const PLANT = `<svg viewBox="0 0 60 90"><path d="M30 60 C10 50 6 26 14 14 C22 30 28 40 30 60 Z" fill="#2BB673" stroke="#1E2A3A" stroke-width="3" stroke-linejoin="round"/><path d="M30 60 C50 50 54 22 46 8 C38 26 32 40 30 60 Z" fill="#3FCB86" stroke="#1E2A3A" stroke-width="3" stroke-linejoin="round"/><path d="M16 60 L44 60 L40 86 L20 86 Z" fill="#F7A072" stroke="#1E2A3A" stroke-width="3" stroke-linejoin="round"/></svg>`;

export function roomFor(teamId) {
  return world.querySelector(`.room[data-team="${teamId}"]`);
}

function makeRoom(team) {
  const el = document.createElement('section');
  el.className = 'room';
  el.dataset.team = team.id;
  el.innerHTML = `
    <div class="wall">
      <button class="sign" title="Rename team"></button>
      <p class="project-tag"></p>
      <div class="window" aria-hidden="true"><span></span><span></span><span></span><span></span></div>
      <button class="tv" title="Preview the team's site"><span class="tv-screen"><span>Preview</span></span></button>
      <div class="plant" aria-hidden="true">${PLANT}</div>
      <button class="whiteboard" title="Open the task board">
        <span class="wb-col" data-col="todo"><b>To do</b><i></i></span>
        <span class="wb-col" data-col="doing"><b>Doing</b><i></i></span>
        <span class="wb-col" data-col="review"><b>Review</b><i></i></span>
        <span class="wb-col" data-col="done"><b>Done</b><i></i></span>
      </button>
    </div>
    <div class="floor">
      <div class="stage">
        <div class="team"></div>
        <div class="front"></div>
      </div>
    </div>`;
  el.querySelector('.sign').addEventListener('click', () => handlers.onSign(team.id));
  el.querySelector('.whiteboard').addEventListener('click', () => handlers.onBoard(team.id));
  el.querySelector('.tv').addEventListener('click', () => handlers.onPreview(team.id));
  world.appendChild(el);
  return el;
}

export function renderRooms(list) {
  teams = list;
  const ids = new Set(list.map((t) => t.id));
  for (const el of world.querySelectorAll('.room')) if (!ids.has(el.dataset.team)) el.remove();
  for (const t of list) {
    const el = roomFor(t.id) ?? makeRoom(t);
    const p = cellToWorld(t.col, t.row);
    el.style.left = `${p.x}px`;
    el.style.top = `${p.y}px`;
    el.setAttribute('aria-label', `${t.name}, project ${t.project}`);
    const { wall, trim } = teamColors(t);
    el.style.setProperty('--wall', wall);
    el.style.setProperty('--wall-trim', trim);
    el.querySelector('.sign').textContent = t.name;
    el.querySelector('.project-tag').textContent = `Project: ${t.project}`;
  }
  renderLots();
  drawMinimap();
}

// Empty plots next to existing teams, where a new team can be built.
function lotCells() {
  const taken = new Set(teams.map((t) => `${t.col},${t.row}`));
  const cells = new Map();
  for (const t of teams) {
    for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const key = `${t.col + dc},${t.row + dr}`;
      if (!taken.has(key)) cells.set(key, { col: t.col + dc, row: t.row + dr });
    }
  }
  if (!teams.length) cells.set('0,0', { col: 0, row: 0 });
  return [...cells.values()];
}

function renderLots() {
  for (const el of world.querySelectorAll('.lot')) el.remove();
  for (const c of lotCells()) {
    const el = document.createElement('button');
    el.className = 'lot';
    const p = cellToWorld(c.col, c.row);
    el.style.left = `${p.x}px`;
    el.style.top = `${p.y}px`;
    el.innerHTML = '<span class="lot-plus" aria-hidden="true">+</span><span class="lot-label">Build a team here</span>';
    el.addEventListener('click', () => handlers.onLot(c.col, c.row));
    world.appendChild(el);
  }
}

// ---------- minimap ----------

function bounds() {
  const cells = [...teams, ...lotCells()];
  const xs = cells.map((c) => c.col);
  const ys = cells.map((c) => c.row);
  const minC = Math.min(...xs, 0);
  const maxC = Math.max(...xs, 0);
  const minR = Math.min(...ys, 0);
  const maxR = Math.max(...ys, 0);
  return { x0: minC * CELL_W - GAP_X, y0: minR * CELL_H - GAP_Y, x1: (maxC + 1) * CELL_W, y1: (maxR + 1) * CELL_H };
}

function minimapTransform() {
  const b = bounds();
  const w = minimap.width;
  const h = minimap.height;
  const s = Math.min((w - 16) / (b.x1 - b.x0), (h - 16) / (b.y1 - b.y0));
  const ox = (w - (b.x1 - b.x0) * s) / 2 - b.x0 * s;
  const oy = (h - (b.y1 - b.y0) * s) / 2 - b.y0 * s;
  return { s, ox, oy };
}

export function drawMinimap() {
  const ctx = minimap.getContext('2d');
  const { s, ox, oy } = minimapTransform();
  ctx.clearRect(0, 0, minimap.width, minimap.height);
  ctx.lineJoin = 'round';

  ctx.setLineDash([3, 3]);
  ctx.strokeStyle = 'rgba(30,42,58,.45)';
  ctx.lineWidth = 1;
  for (const c of lotCells()) {
    const p = cellToWorld(c.col, c.row);
    ctx.strokeRect(ox + p.x * s, oy + p.y * s, ROOM_W * s, ROOM_H * s);
  }
  ctx.setLineDash([]);

  for (const t of teams) {
    const p = cellToWorld(t.col, t.row);
    ctx.fillStyle = teamColors(t).wall;
    ctx.strokeStyle = '#1E2A3A';
    ctx.lineWidth = 2;
    ctx.fillRect(ox + p.x * s, oy + p.y * s, ROOM_W * s, ROOM_H * s);
    ctx.strokeRect(ox + p.x * s, oy + p.y * s, ROOM_W * s, ROOM_H * s);
    ctx.fillStyle = '#1E2A3A';
    ctx.font = '600 10px Fredoka, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const label = t.name.length > 14 ? t.name.slice(0, 13) + '…' : t.name;
    ctx.fillText(label, ox + (p.x + ROOM_W / 2) * s, oy + (p.y + ROOM_H / 2) * s);
  }

  // Teams with someone waiting for the owner pulse red.
  const pulse = 5 + 2.5 * Math.sin(performance.now() / 220);
  for (const t of teams) {
    if (!alertTeams.has(t.id)) continue;
    const p = cellToWorld(t.col, t.row);
    ctx.beginPath();
    ctx.arc(ox + (p.x + ROOM_W) * s - 2, oy + p.y * s + 2, pulse, 0, Math.PI * 2);
    ctx.fillStyle = '#E5484D';
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#fff';
    ctx.stroke();
  }

  // What's on screen right now.
  const vw = viewport.clientWidth / cam.z;
  const vh = viewport.clientHeight / cam.z;
  ctx.strokeStyle = '#E5484D';
  ctx.lineWidth = 2;
  ctx.strokeRect(ox + (cam.x - vw / 2) * s, oy + (cam.y - vh / 2) * s, vw * s, vh * s);
}

function minimapJump(e) {
  const r = minimap.getBoundingClientRect();
  const { s, ox, oy } = minimapTransform();
  const mx = ((e.clientX - r.left) / r.width) * minimap.width;
  const my = ((e.clientY - r.top) / r.height) * minimap.height;
  cam.x = (mx - ox) / s;
  cam.y = (my - oy) / s;
  applyCamera();
}

let mmDrag = false;
minimap.addEventListener('pointerdown', (e) => {
  mmDrag = true;
  minimap.setPointerCapture(e.pointerId);
  cancelAnimationFrame(flight);
  minimapJump(e);
  e.stopPropagation();
});
minimap.addEventListener('pointermove', (e) => mmDrag && minimapJump(e));
minimap.addEventListener('pointerup', () => (mmDrag = false));

let pulseLoop = null;
export function setAlerts(teamIds) {
  alertTeams = new Set(teamIds);
  cancelAnimationFrame(pulseLoop);
  const tick = () => {
    drawMinimap();
    if (alertTeams.size) pulseLoop = requestAnimationFrame(tick);
  };
  tick();
}

// ---------- setup ----------

export function initWorld(h) {
  handlers = { ...handlers, ...h };
  try {
    const saved = JSON.parse(localStorage.getItem('agent-office-camera') ?? 'null');
    if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y) && Number.isFinite(saved.z)) {
      Object.assign(cam, saved, { z: clampZ(saved.z) });
      return true;
    }
  } catch {
    // No saved camera.
  }
  return false;
}

export function refreshCamera() {
  applyCamera();
}
