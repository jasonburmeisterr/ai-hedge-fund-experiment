// JB Capital — pixel-art trading floor. The server sends events; each one becomes an animation.
const W = 640, H = 360, S = 2;
const cv = document.getElementById('game');
const ctx = cv.getContext('2d');
ctx.imageSmoothingEnabled = false;
const FONT = "10px VT323";
const TINY = "8px VT323";
const K = 1.5; // sprite scale: 1 sprite pixel = 3 screen pixels

// ── world layout (logical pixels) ──
const AISLE = 185, LOW_AISLE = 305;
const POI = {
  whiteboard: { x: 70, y: 70 }, scoreboard: { x: 370, y: 70 },
  exchange: { x: 612, y: 248 }, coffee: { x: 296, y: 312 }, cooler: { x: 336, y: 312 },
  bossVisit: { x: 520, y: 150 }, plant: { x: 150, y: 312 },
};
const BOSS_PATH = [{ x: 488, y: AISLE }, { x: 488, y: 150 }, { x: 520, y: 150 }];

const DEFS = [
  { id: 'mo',    name: 'Mo',    role: 'Momentum quant',      seat: [80, 112],  skin: '#f1c27d', hair: '#3b2412', shirt: '#e8573c', pants: '#2b2d42', acc: 'cap' },
  { id: 'rita',  name: 'Rita',  role: 'Mean-reversion quant', seat: [160, 112], skin: '#c68642', hair: '#111', shirt: '#9b5de5', pants: '#3a3a5a', acc: 'bun' },
  { id: 'vic',   name: 'Vic',   role: 'Volatility watcher',  seat: [240, 112], skin: '#ffdbac', hair: '#d4a017', shirt: '#00bbf9', pants: '#33415c', acc: 'none' },
  { id: 'sam',   name: 'Sam',   role: 'Scorekeeper',         seat: [370, 112], skin: '#8d5524', hair: '#222', shirt: '#f15bb5', pants: '#2b2d42', acc: 'glasses' },
  { id: 'ava',   name: 'Ava',   role: 'AI analyst (Claude)', seat: [80, 228],  skin: '#ffdbac', hair: '#b5179e', shirt: '#4cc9f0', pants: '#3a0ca3', acc: 'glasses' },
  { id: 'dot',   name: 'Dot',   role: 'Data clerk',          seat: [180, 228], skin: '#e0ac69', hair: '#6f1d1b', shirt: '#80ed99', pants: '#22577a', acc: 'bun' },
  { id: 'rex',   name: 'Rex',   role: 'Risk manager',        seat: [420, 228], skin: '#f1c27d', hair: '#555', shirt: '#4a4e69', pants: '#22223b', acc: 'helmet' },
  { id: 'eddie', name: 'Eddie', role: 'Execution trader',    seat: [540, 228], skin: '#c68642', hair: '#2d1b0e', shirt: '#fee440', pants: '#1d3557', acc: 'headset' },
  { id: 'boss',  name: 'The Boss', role: 'Portfolio manager', seat: [552, 96], skin: '#ffdbac', hair: '#9a9a9a', shirt: '#1d1d2c', pants: '#1d1d2c', acc: 'tie' },
];
const COLORS = Object.fromEntries(DEFS.map(d => [d.id, d.shirt])); COLORS.boss = '#ffcf4a';
const agents = {};
for (const d of DEFS) {
  agents[d.id] = { ...d, x: d.seat[0], y: d.seat[1], seated: true, path: [], queue: [], busy: false,
    bubble: null, carry: null, frame: 0, hidden: false, speed: 0.9, blink: 0, nextIdle: performance.now() + 15000 + Math.random() * 40000 };
}
agents.boss.speed = 0.7;

// ── state from server ──
let snap = null;
const floaters = [], stamps = [], coins = [];
let doorFlash = 0, tickerX = 0, selected = null;

// ── movement helpers ──
function seatExit(a) { return { x: a.seat[0] + 24, y: a.seat[1] }; }
function routeTo(a, dest) {
  const start = a.seated ? seatExit(a) : { x: a.x, y: a.y };
  const aisle = (dest.y > 270 || start.y > 270) ? LOW_AISLE : AISLE;
  const pts = [start, { x: start.x, y: aisle }];
  if (dest === POI.bossVisit) return pts.concat(BOSS_PATH);
  pts.push({ x: dest.x, y: aisle }, { x: dest.x, y: dest.y });
  return pts;
}
function routeHome(a) {
  const ex = seatExit(a);
  const pts = [];
  const inBossRoom = a.x > 470 && a.y < 176;
  if (inBossRoom) pts.push({ x: 488, y: 150 }, { x: 488, y: AISLE });
  const aisle = (a.y > 270 || ex.y > 270) ? LOW_AISLE : AISLE;
  pts.push({ x: inBossRoom ? 488 : a.x, y: aisle }, { x: ex.x, y: aisle }, ex, { x: a.seat[0], y: a.seat[1] });
  return pts;
}

// Actions are queued per agent and run one after another.
function act(id, ...steps) { const a = agents[id]; if (a) a.queue.push(...steps); }
const say = (text, ms = 3500) => ({ t: 'say', text, ms });
const go = (dest, run = false, carry = null) => ({ t: 'go', dest, run, carry });
const home = () => ({ t: 'home' });
const wait = ms => ({ t: 'wait', ms });
const fx = fn => ({ t: 'fx', fn });

function runQueue(a, now) {
  if (a.busy || !a.queue.length) return;
  const s = a.queue.shift();
  a.busy = true;
  if (s.t === 'say') { a.bubble = { text: s.text, until: now + s.ms }; setTimeout(() => a.busy = false, Math.min(s.ms, 1500)); }
  else if (s.t === 'wait') setTimeout(() => a.busy = false, s.ms);
  else if (s.t === 'fx') { s.fn(a); a.busy = false; }
  else if (s.t === 'go') { a.path = routeTo(a, s.dest); a.seated = false; a.run = s.run; a.carry = s.carry; a.onArrive = () => a.busy = false; }
  else if (s.t === 'home') { a.path = routeHome(a); a.run = false; a.onArrive = () => { a.seated = true; a.carry = null; a.busy = false; }; }
}

function move(a, dt) {
  if (!a.path.length) return;
  const p = a.path[0];
  const sp = a.speed * (a.run ? 2.1 : 1) * dt / 16.7;  // time-based: same speed at any frame rate
  const dx = p.x - a.x, dy = p.y - a.y, d = Math.hypot(dx, dy);
  if (d <= sp) { a.x = p.x; a.y = p.y; a.path.shift(); if (!a.path.length && a.onArrive) { const f = a.onArrive; a.onArrive = null; f(); } }
  else { a.x += dx / d * sp; a.y += dy / d * sp; a.frame += sp * 0.12; a.dir = Math.sign(dx) || a.dir; }
}

// ── server events → animations ──
function handle(e) {
  logLine(e);
  const t = e.text;
  switch (e.kind) {
    case 'data': act('dot', go(POI.whiteboard), say(t, 3000), wait(800), home()); break;
    case 'signal':
      act(e.agent, say(t, 3000), go(POI.bossVisit, false, 'paper'), say(e.dir > 0 ? 'BUY idea!' : 'SELL idea!', 1800), home());
      act('boss', wait(2500), say('Hmm...', 1500));
      break;
    case 'analysis': act('ava', say(t, 5000), go(POI.bossVisit, false, 'paper'), say('My report, boss.', 1800), home()); break;
    case 'decision': act('boss', say(t, 3200)); if (e.act === 'trade') act('rex', wait(600), say('Checking...', 1200)); break;
    case 'risk': act('rex', fx(() => stamps.push({ x: 420, y: 160, ok: e.ok, born: performance.now() })), say(t, 3500)); break;
    case 'order': act('eddie', say(t, 2000), go(POI.exchange, true, 'ticket'), fx(a => { a.hidden = true; doorFlash = performance.now(); }), wait(1100), fx(a => a.hidden = false), home()); break;
    case 'fill': floaters.push({ x: 600, y: 225, text: 'FILLED ' + (e.sym || ''), color: '#5ab8ff', born: performance.now() }); burst(600, 240, 8); break;
    case 'close': {
      const up = (e.pnl || 0) >= 0;
      floaters.push({ x: 590, y: 222, text: (up ? '+$' : '-$') + Math.abs(e.pnl || 0).toFixed(0), color: up ? '#5ee27a' : '#ff5a6a', born: performance.now() });
      if (up) burst(600, 240, 16);
      act('eddie', say(up ? 'Cha-ching!' : 'Ouch...', 2200));
      break;
    }
    case 'trail': act('eddie', say(t, 2500)); break;
    case 'score': act('sam', go(POI.scoreboard), say(t, 3500), home()); if (e.target) act(e.target, say(e.ok ? 'Yes!' : 'Ugh.', 1500)); break;
    case 'vol': act('vic', say(t, 3200)); break;
    case 'chatter': case 'system': act(e.agent, say(t, 3000)); break;
  }
}
function burst(x, y, n) { for (let i = 0; i < n; i++) coins.push({ x, y, vx: (Math.random() - .5) * 2.4, vy: -Math.random() * 2.4 - 0.6, born: performance.now() }); }

function idle(now) {
  for (const a of Object.values(agents)) {
    if (a.id === 'boss' || a.busy || a.queue.length || !a.seated || now < a.nextIdle) continue;
    a.nextIdle = now + 40000 + Math.random() * 60000;
    if (a.id === 'ava' && snap && !snap.analyst_on) { act('ava', say('Out of office (no API key).', 3000)); continue; }
    const r = Math.random();
    if (r < 0.45) act(a.id, go(POI.coffee), say(['Coffee!', 'Need caffeine.', 'Third cup...'][Math.floor(Math.random() * 3)], 2000), wait(1500), home());
    else if (r < 0.7) act(a.id, go(POI.cooler), say(['Gossip time', 'Hydrate!', 'Did you see that candle?'][Math.floor(Math.random() * 3)], 2200), wait(1200), home());
    else act(a.id, say(['*typing*', 'Backtesting...', 'Hmm, interesting chart', 'Is that a head and shoulders?'][Math.floor(Math.random() * 4)], 2000));
  }
}

// ── drawing ──
const R = (x, y, w, h, c) => { ctx.fillStyle = c; ctx.fillRect(Math.round(x), Math.round(y), w, h); };

function drawRoom(now) {
  // floor
  for (let y = 56; y < H; y += 16) for (let x = 0; x < W; x += 16) R(x, y, 16, 16, ((x + y) / 16) % 2 ? '#3d3350' : '#43385a');
  // rugs under the quant pit and the ops row
  R(48, 76, 360, 72, '#4a3b66'); R(52, 80, 352, 64, '#54447a');
  R(48, 192, 160, 70, '#3b4a66'); R(52, 196, 152, 62, '#45577a');
  R(380, 192, 200, 70, '#5a3b4a'); R(384, 196, 192, 62, '#6b4658');
  // ping pong table + sofa (for slow markets)
  R(170, 318, 52, 28, '#1e6b52'); R(195, 318, 2, 28, '#fff'); R(172, 331, 48, 1, '#e8f5e9'); R(168, 346, 4, 6, '#333'); R(218, 346, 4, 6, '#333');
  R(400, 322, 50, 14, '#8e3b46'); R(400, 316, 50, 8, '#a8505c'); R(396, 318, 6, 18, '#7a2f39'); R(448, 318, 6, 18, '#7a2f39');
  ctx.font = TINY; ctx.fillStyle = 'rgba(255,207,74,0.35)'; ctx.fillText('JB CAPITAL', 250, 170);
  // wall
  R(0, 0, W, 56, '#2a2140'); R(0, 54, W, 3, '#1a1428');
  // windows with skyline
  const hour = new Date().getHours(), night = hour < 7 || hour >= 19;
  for (const wx of [134, 214]) {
    R(wx, 8, 70, 36, night ? '#0b1030' : '#7ec8ff');
    for (let i = 0; i < 7; i++) { const bh = 8 + ((i * 37 + wx) % 20); R(wx + i * 10, 44 - bh, 9, bh, night ? '#1d2148' : '#5a6b8c');
      if (night) for (let k = 0; k < 3; k++) if ((i + k + wx) % 3) R(wx + i * 10 + 2 + (k % 2) * 4, 46 - bh + 3 + k * 4, 1, 1, '#ffd36b'); }
    R(wx - 2, 6, 74, 2, '#6b5a8c'); R(wx - 2, 44, 74, 2, '#6b5a8c'); R(wx + 34, 8, 2, 36, '#6b5a8c');
  }
  // whiteboard with prices (Dot writes here)
  R(18, 8, 104, 40, '#ece7dc'); R(18, 46, 104, 3, '#8a8a8a');
  ctx.font = TINY; ctx.fillStyle = '#1a3a8a'; ctx.fillText('PRICES (Dot)', 22, 15);
  if (snap) Object.entries(snap.markets).slice(0, 5).forEach(([s, m], i) => {
    ctx.fillStyle = m.chg >= 0 ? '#11803a' : '#c0233a';
    ctx.fillText(`${s} ${fmtPx(m.px)}`, 22 + (i > 2 ? 52 : 0), 23 + (i % 3) * 7);
  });
  // skill scoreboard screen (Sam updates)
  R(298, 6, 146, 42, '#0d0d18'); R(300, 8, 142, 38, '#10233a');
  ctx.font = TINY; ctx.fillStyle = '#ffcf4a'; ctx.fillText('SKILL BOARD', 304, 15);
  if (snap) ['mo', 'rita', 'ava'].forEach((id, i) => {
    const st = snap.agents[id] || {};
    ctx.fillStyle = '#cfe8ff';
    ctx.fillText(`${agents[id].name}`, 304, 23 + i * 7); ctx.fillText(`hit ${st.hit == null ? '--' : Math.round(st.hit * 100) + '%'}  trust ${(st.trust ?? 1).toFixed(2)}`, 340, 23 + i * 7);
  });
  // clock
  const d = new Date(); R(450, 10, 18, 18, '#6b5a8c'); R(451, 11, 16, 16, '#ece7dc'); ctx.strokeStyle = '#222'; ctx.lineWidth = 1;
  hand(459, 19, (d.getHours() % 12 + d.getMinutes() / 60) / 12, 4); hand(459, 19, d.getMinutes() / 60, 7);
  // LED ticker
  R(0, 48, W, 7, '#000'); ctx.font = TINY;
  const tick = snap ? Object.entries(snap.markets).map(([s, m]) => `${s} ${fmtPx(m.px)} ${(m.chg * 100).toFixed(2)}%`).join('   •   ') : 'CONNECTING...';
  tickerX -= 0.4; const tw = ctx.measureText(tick + '      ').width; if (tickerX < -tw) tickerX = 0;
  ctx.fillStyle = '#ffb000'; ctx.fillText(tick, tickerX, 54); ctx.fillText(tick, tickerX + tw, 54);

  // boss office (glass)
  R(470, 58, 168, 118, 'rgba(120,200,255,0.10)');
  R(470, 58, 2, 118, '#9fd8ff'); R(470, 174, 12, 2, '#9fd8ff'); R(500, 174, 138, 2, '#9fd8ff');
  R(560, 62, 70, 10, '#5b3a1e'); ctx.font = TINY; ctx.fillStyle = '#ffcf4a'; ctx.fillText('THE BOSS', 566, 69);
  R(600, 130, 20, 30, '#6b4a2b'); R(603, 126, 14, 6, '#3f8f4f'); // cabinet + plant
  // exchange door
  R(622, 214, 16, 64, '#1b1b2b'); R(624, 216, 12, 60, (performance.now() - doorFlash < 1200) ? '#5ee27a' : '#3a5a3a');
  R(588, 200, 50, 10, '#111'); ctx.font = TINY; ctx.fillStyle = '#5ee27a'; ctx.fillText('EXCHANGE', 590, 207);
  // bookshelf, server rack
  R(4, 186, 22, 64, '#6b4a2b'); for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) R(6 + j * 5, 190 + i * 15, 4, 11, ['#e85d75', '#4cc9f0', '#ffd166', '#06d6a0'][(i + j) % 4]);
  R(4, 270, 22, 70, '#202030'); for (let i = 0; i < 8; i++) R(8 + (i % 2) * 8, 276 + i * 8, 2, 2, (Math.floor(now / 300) + i) % 3 ? '#5ee27a' : '#103010');
  // coffee machine + water cooler + plants
  R(286, 290, 20, 22, '#333'); R(290, 294, 12, 6, '#a33'); R(293, 304, 6, 6, '#eee');
  R(330, 286, 12, 26, '#ddd'); R(331, 280, 10, 10, '#7ec8ff');
  for (const [px, py] of [[140, 300], [440, 300], [8, 66]]) { R(px, py, 10, 10, '#8b5a2b'); R(px - 3, py - 10, 16, 12, '#3f8f4f'); R(px + 1, py - 15, 8, 6, '#58b368'); }
}
function hand(cx, cy, frac, len) { const a = frac * Math.PI * 2 - Math.PI / 2; ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.cos(a) * len, cy + Math.sin(a) * len); ctx.stroke(); }

function desk(x, y, w = 30, top = '#8b5a2b') {
  R(x - w / 2, y, w, 6, top); R(x - w / 2, y + 6, w, 8, '#5b3a1e'); R(x - w / 2 + 2, y + 14, 2, 4, '#3a2412'); R(x + w / 2 - 4, y + 14, 2, 4, '#3a2412');
}
function monitor(x, y, now, active) {
  R(x - 7, y - 10, 14, 10, '#111'); R(x - 6, y - 9, 12, 8, active ? '#0f3d2e' : '#13243a');
  for (let i = 0; i < 5; i++) { const h = 1 + ((Math.floor(now / 250) + i * 7 + x) % 5); R(x - 5 + i * 2, y - 2 - h, 1, h, i % 2 ? '#5ee27a' : '#ff5a6a'); }
  R(x - 1, y, 2, 2, '#222');
}

function drawAgent(a, now) {
  if (a.hidden) return;
  ctx.save(); ctx.translate(Math.round(a.x), Math.round(a.y)); ctx.scale(K, K);
  const x = 0, y = 0;
  const walking = a.path.length > 0;
  const step = walking ? (Math.floor(a.frame) % 2) : 0;
  R(x - 5, y, 10, 2, 'rgba(0,0,0,0.35)');
  // legs
  if (!a.seated || walking) { R(x - 3, y - 6 + (step ? 1 : 0), 2, 6 - (step ? 1 : 0), a.pants); R(x + 1, y - 6 + (step ? 0 : 1), 2, 6 - (step ? 0 : 1), a.pants); }
  // body + arms
  R(x - 5, y - 13, 10, 8, a.shirt);
  const typing = a.seated && !walking && Math.floor(now / 180) % 2;
  R(x - 7, y - 12 + (typing ? 1 : 0), 2, 6, a.shirt); R(x + 5, y - 12 + (typing ? 0 : 1), 2, 6, a.shirt);
  R(x - 7, y - 6 + (typing ? 1 : 0), 2, 2, a.skin); R(x + 5, y - 6 + (typing ? 0 : 1), 2, 2, a.skin);
  if (a.acc === 'tie') { R(x - 1, y - 13, 2, 6, '#d62828'); R(x - 3, y - 13, 2, 2, '#fff'); R(x + 1, y - 13, 2, 2, '#fff'); }
  // head
  R(x - 4, y - 21, 8, 8, a.skin);
  R(x - 4, y - 22, 8, 3, a.hair); R(x - 5, y - 21, 1, 4, a.hair); R(x + 4, y - 21, 1, 4, a.hair);
  if (a.acc === 'bun') R(x - 2, y - 25, 4, 3, a.hair);
  if (a.acc === 'cap') { R(x - 5, y - 23, 10, 3, '#d62828'); R(x + 3, y - 21, 4, 1, '#d62828'); }
  if (a.acc === 'helmet') { R(x - 5, y - 24, 10, 4, '#ffb703'); R(x - 6, y - 21, 12, 1, '#ffb703'); }
  const blink = (now + a.seat[0] * 37) % 4000 < 120;
  const ex = (a.dir || 0) > 0 ? 1 : (a.dir || 0) < 0 ? -1 : 0;
  if (!blink) { R(x - 2 + ex, y - 18, 1, 2, '#1a1a1a'); R(x + 1 + ex, y - 18, 1, 2, '#1a1a1a'); }
  if (a.acc === 'glasses') { R(x - 3 + ex, y - 19, 3, 1, '#222'); R(x + ex, y - 19, 3, 1, '#222'); }
  if (a.acc === 'headset') { R(x - 5, y - 22, 10, 1, '#222'); R(x - 6, y - 19, 2, 3, '#222'); R(x - 5, y - 16, 3, 1, '#222'); }
  const talking = a.bubble && now < a.bubble.until && Math.floor(now / 140) % 2;
  R(x - 1, y - 15, 2, talking ? 2 : 1, '#7a2a2a');
  // carried paper / ticket
  if (a.carry) { R(x + 5, y - 11, 6, 7, a.carry === 'ticket' ? '#ffd166' : '#fff'); R(x + 6, y - 9, 4, 1, '#999'); R(x + 6, y - 7, 4, 1, '#999'); }
  ctx.restore();
  // name tag (world coords)
  if (selected === a.id || !a.seated || a.path.length) {
    const nx = Math.round(a.x), ny = Math.round(a.y);
    ctx.font = TINY; const w = ctx.measureText(a.name).width;
    R(nx - w / 2 - 2, ny - 46, w + 4, 8, selected === a.id ? '#ffcf4a' : 'rgba(0,0,0,0.6)');
    ctx.fillStyle = selected === a.id ? '#000' : '#fff'; ctx.fillText(a.name, nx - w / 2, ny - 40);
  }
}

function drawBubble(a, now) {
  if (!a.bubble || now > a.bubble.until || a.hidden) return;
  ctx.font = FONT;
  const lines = wrap(a.bubble.text, 34).slice(0, 4);
  const w = Math.max(...lines.map(l => ctx.measureText(l).width)) + 8, h = lines.length * 9 + 4;
  let bx = Math.round(a.x - w / 2), by = Math.round(a.y - 42 - h);
  bx = Math.max(2, Math.min(W - w - 2, bx)); by = Math.max(58, by);
  R(bx - 1, by - 1, w + 2, h + 2, '#111'); R(bx, by, w, h, '#fffdf3');
  R(a.x - 2, by + h, 4, 3, '#fffdf3'); R(a.x - 1, by + h + 3, 2, 2, '#fffdf3');
  ctx.fillStyle = '#1a1a1a'; lines.forEach((l, i) => ctx.fillText(l, bx + 4, by + 9 + i * 9));
}
function wrap(text, n) {
  const words = String(text).split(' '), out = []; let cur = '';
  for (const w of words) { if ((cur + ' ' + w).trim().length > n) { if (cur) out.push(cur); cur = w; } else cur = (cur + ' ' + w).trim(); }
  if (cur) out.push(cur); return out;
}

function drawFx(now) {
  for (const s of stamps) {
    const age = now - s.born; if (age > 2600 || age < 0) continue;
    const k = Math.max(0, Math.min(1, age / 180)), sc = 2 - k;
    ctx.save(); ctx.translate(s.x, s.y); ctx.rotate(-0.2); ctx.scale(sc, sc);
    ctx.font = "8px 'Press Start 2P'"; const txt = s.ok ? 'APPROVED' : 'VETO!';
    const w = ctx.measureText(txt).width + 8; ctx.globalAlpha = age > 2000 ? (2600 - age) / 600 : 1;
    ctx.strokeStyle = s.ok ? '#2ecc71' : '#e63946'; ctx.lineWidth = 2; ctx.strokeRect(-w / 2, -8, w, 14);
    ctx.fillStyle = s.ok ? '#2ecc71' : '#e63946'; ctx.fillText(txt, -w / 2 + 4, 3); ctx.restore(); ctx.globalAlpha = 1;
  }
  for (const f of floaters) {
    const age = now - f.born; if (age > 2500) continue;
    ctx.globalAlpha = 1 - age / 2500; ctx.font = "8px 'Press Start 2P'"; ctx.fillStyle = '#000';
    ctx.fillText(f.text, f.x + 1, f.y - age / 40 + 1); ctx.fillStyle = f.color; ctx.fillText(f.text, f.x, f.y - age / 40); ctx.globalAlpha = 1;
  }
  for (const c of coins) { const age = now - c.born; if (age > 1500) continue; c.x += c.vx; c.y += c.vy; c.vy += 0.08; R(c.x, c.y, 3, 3, '#ffcf4a'); R(c.x + 1, c.y + 1, 1, 1, '#b8860b'); }
  if (stamps.length > 20) stamps.splice(0, 10); if (floaters.length > 20) floaters.splice(0, 10); if (coins.length > 200) coins.splice(0, 100);
}

let lastT = performance.now();
function frame() { tick(performance.now()); requestAnimationFrame(frame); }  // one clock for everything
// backup timer: keeps animating if the browser throttles requestAnimationFrame
setInterval(() => { const n = performance.now(); if (n - lastT > 100) tick(n); }, 50);
function tick(now) {
  const dt = Math.max(0, Math.min(100, now - lastT)); lastT = now;
  ctx.setTransform(S, 0, 0, S, 0, 0);
  drawRoom(now);
  idle(now);
  const list = Object.values(agents);
  for (const a of list) { runQueue(a, now); move(a, dt); }
  // draw back-to-front: seated agents sit behind their desks
  const items = [];
  for (const a of list) {
    items.push({ y: a.seat[1] + 8, draw: () => {
      ctx.save(); ctx.translate(a.seat[0], a.seat[1]); ctx.scale(K, K);
      desk(0, -3, a.id === 'boss' ? 34 : 26); monitor(8, -3, now, a.seated && !a.path.length);
      ctx.restore(); } });
    items.push({ y: a.y + (a.seated && !a.path.length ? 0 : 10), draw: () => drawAgent(a, now) });
  }
  items.sort((p, q) => p.y - q.y).forEach(i => i.draw());
  drawFx(now);
  for (const a of list) drawBubble(a, now);
}

// ── HUD ──
const $ = id => document.getElementById(id);
const money = v => (v < 0 ? '-$' : '$') + Math.abs(v).toLocaleString(undefined, { maximumFractionDigits: 0 });
function fmtPx(p) { return p >= 1000 ? Math.round(p).toLocaleString() : p.toFixed(2); }
function cls(v) { return v >= 0 ? 'up' : 'down'; }

function hud(s) {
  snap = s;
  const tot = s.equity - s.start;
  $('equity').textContent = money(s.equity);
  $('total').innerHTML = `<span class="${cls(tot)}">${money(tot)} (${(tot / s.start * 100).toFixed(2)}%)</span>`;
  $('today').innerHTML = `<span class="${cls(s.day_pnl)}">${money(s.day_pnl)}</span>`;
  $('risk').textContent = money(s.open_risk);
  $('fees').textContent = money(s.fees);
  const groups = {}; for (const m of Object.values(s.markets)) (groups[m.cls] ||= []).push(m.open);
  $('mkts').innerHTML = Object.entries(groups).map(([c, o]) => `<span class="mk ${o.some(Boolean) ? 'open' : 'closed'}">${c.toUpperCase()} ${o.some(Boolean) ? 'OPEN' : 'CLOSED'}</span>`).join('');
  $('pos').innerHTML = s.positions.length ? s.positions.map(p => `<tr><td>${p.sym}</td><td class="${p.side > 0 ? 'up' : 'down'}">${p.side > 0 ? 'LONG' : 'SHORT'}</td><td>${+p.qty.toFixed(4)}</td><td>${fmtPx(p.entry)}</td><td>${fmtPx(p.last)}</td><td>${fmtPx(p.stop)}</td><td class="${cls(p.upl)}">${money(p.upl)}</td></tr>`).join('')
    : '<tr><td colspan="7" class="muted">Flat. Waiting for a setup.</td></tr>';
  $('trades').innerHTML = s.trades.slice(-6).reverse().map(t => `<tr><td>${t.sym}</td><td>${t.side > 0 ? 'L' : 'S'}</td><td class="${cls(t.pnl)}">${money(t.pnl)}</td><td class="muted">${t.reason}</td></tr>`).join('') || '<tr><td class="muted">No closed trades yet.</td></tr>';
  $('headline').textContent = s.analyst_on ? (s.headline ? 'Ava: ' + s.headline : 'Ava is preparing her first report...') : 'Ava (AI analyst) is off. See README to turn her on.';
  $('roster').innerHTML = ['mo', 'rita', 'ava'].map(id => { const st = s.agents[id] || {}; const tr = st.trust ?? 1;
    return `<div><span style="color:${COLORS[id]}">${agents[id].name}</span> <span class="muted">${st.n || 0} calls</span><br>hit ${st.hit == null ? '--' : Math.round(st.hit * 100) + '%'} · edge ${st.edge_bps == null ? '--' : st.edge_bps.toFixed(1) + 'bp'}
      <div class="bar"><i style="width:${tr / 2 * 100}%;background:${tr >= 1 ? 'var(--green)' : 'var(--red)'}"></i></div></div>`; }).join('');
  spark(s.curve);
  if (selected) showCard(selected);
}
function spark(curve) {
  const c = $('spark'), g = c.getContext('2d'); g.fillStyle = '#16122a'; g.fillRect(0, 0, c.width, c.height);
  if (!curve || curve.length < 2) { g.fillStyle = '#a99fc4'; g.font = "8px 'Press Start 2P'"; g.fillText('collecting data...', 10, 60); return; }
  const v = curve.map(p => p[1]), lo = Math.min(...v), hi = Math.max(...v), span = hi - lo || 1;
  g.strokeStyle = '#4b3f72'; g.beginPath(); const y0 = c.height - 6 - (snap.start - lo) / span * (c.height - 12); g.moveTo(0, y0); g.lineTo(c.width, y0); g.stroke();
  g.strokeStyle = v[v.length - 1] >= snap.start ? '#5ee27a' : '#ff5a6a'; g.lineWidth = 2; g.beginPath();
  v.forEach((x, i) => { const px = i / (v.length - 1) * c.width, py = c.height - 6 - (x - lo) / span * (c.height - 12); i ? g.lineTo(px, py) : g.moveTo(px, py); }); g.stroke();
}
function showCard(id) {
  const a = agents[id]; $('cardTitle').textContent = a.name.toUpperCase();
  const st = snap && snap.agents[id];
  const what = a.queue.length || a.path.length ? 'busy' : a.seated ? 'at desk' : 'walking';
  let html = `<div style="color:${a.shirt}">${a.role}</div><div class="muted">Status: ${what}</div>`;
  if (st) html += `<div>Graded calls: ${st.n}</div><div>Hit rate: ${st.hit == null ? '--' : Math.round(st.hit * 100) + '%'}</div><div>Avg edge: ${st.edge_bps == null ? '--' : st.edge_bps.toFixed(1) + ' bps'}</div><div>Trust: ${(st.trust ?? 1).toFixed(2)}</div>`;
  const notes = { boss: 'Weighs every call by trust. Trades only when the vote is convincing.', rex: '1% risk per trade, 5% total, size caps. Can VETO anything.',
    eddie: 'Places paper orders, manages stops and trailing stops.', dot: 'Pulls Coinbase (live) and Yahoo (delayed) prices every minute.',
    vic: 'Watches volatility. Storm = half size.', sam: 'Grades every call one hour later. Trust comes from results.',
    mo: 'Buys breakouts above the 20-bar high in an uptrend.', rita: 'Fades moves stretched 2 std devs from the average.',
    ava: snap && snap.analyst_on ? 'Reads all markets with Claude every 30 min.' : 'Off. Needs FLOOR_LLM=claude + an API key.' };
  html += `<div class="muted" style="margin-top:6px">${notes[id] || ''}</div>`;
  if (a.bubble && performance.now() < a.bubble.until) html += `<div style="margin-top:6px">"${a.bubble.text}"</div>`;
  $('card').innerHTML = html;
}
cv.addEventListener('click', ev => {
  const r = cv.getBoundingClientRect(), x = (ev.clientX - r.left) / r.width * W, y = (ev.clientY - r.top) / r.height * H;
  let best = null, bd = 20;
  for (const a of Object.values(agents)) { const d = Math.hypot(a.x - x, a.y - 16 - y); if (d < bd) { bd = d; best = a.id; } }
  selected = best; if (best) showCard(best);
});

function logLine(e) {
  const box = $('log'), d = document.createElement('div');
  const tm = e.t ? new Date(e.t * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
  d.innerHTML = `<span class="muted">${tm}</span> <span class="who" style="color:${COLORS[e.agent] || '#fff'}">${(e.name || '').toUpperCase()}</span> ${escapeHtml(e.text)}`;
  box.appendChild(d); while (box.children.length > 150) box.firstChild.remove();
  box.scrollTop = box.scrollHeight;
}
function escapeHtml(s) { return String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }

// ── demo mode: press D (or open /?demo) to watch a fake trade play out; no money involved ──
function demo() {
  const T = (k, a, txt, extra = {}) => ({ kind: k, agent: a, name: agents[a].name, text: txt, t: Date.now() / 1000, ...extra });
  const seq = [
    [0, T('data', 'dot', 'DEMO: fresh prices! BTC breaking out...')],
    [3000, T('signal', 'mo', 'DEMO: BTC BREAKOUT above the 20-bar range. BUY!', { dir: 1 })],
    [9000, T('decision', 'boss', 'DEMO: BUY BTC! (Mo, vote +1.00). Rex, size it.', { act: 'trade' })],
    [12500, T('risk', 'rex', 'DEMO: APPROVED 0.12 BTC, risking $1,000.', { ok: true })],
    [15500, T('order', 'eddie', 'DEMO: On it! Buying BTC...')],
    [20000, T('fill', 'eddie', 'DEMO: FILLED 0.12 BTC', { sym: 'BTC' })],
    [23000, T('score', 'sam', "DEMO: Mo's BTC call was RIGHT (+0.80%).", { target: 'mo', ok: true })],
    [30000, T('close', 'eddie', 'DEMO: CLOSED BTC +$412', { pnl: 412 })],
  ];
  seq.forEach(([ms, e]) => setTimeout(() => handle(e), ms));
}
addEventListener('keydown', e => { if (e.key === 'd' || e.key === 'D') demo(); });

// ── connection ──
function connect() {
  const ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
  ws.onopen = () => { $('conn').textContent = 'live'; $('conn').className = 'up'; };
  ws.onclose = () => { $('conn').textContent = 'offline'; $('conn').className = 'down'; setTimeout(connect, 3000); };
  ws.onmessage = m => {
    const msg = JSON.parse(m.data);
    if (msg.type === 'hello') { msg.events.forEach(logLine); if (msg.snapshot) hud(msg.snapshot); }
    else if (msg.type === 'event') handle(msg.event);
    else if (msg.type === 'snapshot') hud(msg.snapshot);
  };
}
Promise.all([document.fonts.load(FONT), document.fonts.load("8px 'Press Start 2P'")]).finally(() => { connect(); requestAnimationFrame(frame); if (location.search.includes('demo')) demo(); });
