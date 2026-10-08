// JB Capital — a real trading floor on the top of a city tower, staffed by humanoid trading robots.
// The sky, city lights and sun follow your local time. Server events become animations; the UI is the fund terminal.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const $ = id => document.getElementById(id);
let snap = null;
const agents = {};
const FW = 56, FD = 34, FH = 8, FX = FW / 2, FZ = FD / 2;   // the fund's trading hall: 56 x 34 m, 8 m glass walls (x -FX..FX, z -FZ..FZ)
const stage = $('stage'), overlay = $('overlay');

// ── time of day ───────────────────────────────────────────
const NOW = new Date(), HR = NOW.getHours() + NOW.getMinutes() / 60;
const TOD = new URLSearchParams(location.search).get('tod') || ((HR >= 7.5 && HR < 17) ? 'day' : ((HR >= 17 && HR < 19.8) || (HR >= 5.8 && HR < 7.5)) ? 'dusk' : 'night');   // ?tod=day|dusk|night to preview
const SKY = {
  day:   { top: '#2c64b0', mid: '#79acdf', hor: '#d8e8f4', fog: 0xbfd2e6, sun: 0xfff2dc, sunI: 3.0, hemi: 1.3, exp: 1.0, lit: 0.08, sunY: 0.75 },
  dusk:  { top: '#1b2655', mid: '#8d4f78', hor: '#ffb06a', fog: 0xa77a7c, sun: 0xffb36e, sunI: 2.2, hemi: 0.95, exp: 1.05, lit: 0.55, sunY: 0.08 },
  night: { top: '#02040b', mid: '#0a1330', hor: '#26324f', fog: 0x141c33, sun: 0xa9bcff, sunI: 0.9, hemi: 0.55, exp: 1.12, lit: 1.0, sunY: 0.6 },
}[TOD];

// ── renderer / scene / camera ─────────────────────────────
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
const PIXEL_RATIO = Math.min(devicePixelRatio, 1.5);   // 2x+ screens render 44% fewer pixels; bloom + MSAA hide the difference
renderer.setPixelRatio(PIXEL_RATIO);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = SKY.exp;
stage.prepend(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(SKY.fog);
scene.fog = new THREE.Fog(SKY.fog, 140, 720);
const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 2600);   // near plane follows the zoom (see fitDepth): a fixed 0.1..2000 range made the ground layers flicker from far away
const HOME_POS = new THREE.Vector3(10, 31, 40), HOME_TGT = new THREE.Vector3(0, 0.5, 1.5);
camera.position.copy(HOME_POS);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.copy(HOME_TGT); controls.enableDamping = true; controls.dampingFactor = 0.09;
controls.maxPolarAngle = Math.PI * 0.47; controls.minDistance = 2.5; controls.maxDistance = 600;
controls.screenSpacePanning = false;          // pan slides along the ground instead of lifting the view into the sky
controls.zoomToCursor = true;                 // scroll zooms toward whatever is under the mouse
controls.rotateSpeed = 0.65; controls.zoomSpeed = 1.15; controls.panSpeed = 1.0;
// map-style: LEFT-drag grabs and slides the ground, RIGHT-drag (or Ctrl/Shift + left) turns and tilts, wheel zooms to the cursor;
// touch: one finger slides, two fingers pinch-zoom and twist
controls.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE };
controls.touches = { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_ROTATE };
const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
composer.addPass(new UnrealBloomPass(new THREE.Vector2(512, 512), TOD === 'day' ? 0.25 : 0.45, 0.5, 0.86));
composer.addPass(new OutputPass());
composer.setPixelRatio(PIXEL_RATIO);
function resize() { const w = stage.clientWidth, h = stage.clientHeight; renderer.setSize(w, h, false); composer.setSize(w, h); camera.aspect = w / h; camera.updateProjectionMatrix(); }
// depth precision: keep near/far ~ 1:300 at every zoom level instead of 1:20000 (the main cause of shimmering ground and roofs)
function fitDepth(camDist) {
  const near = Math.min(8, Math.max(0.1, camDist * 0.02));
  if (Math.abs(near - camera.near) / camera.near > 0.08) { camera.near = near; camera.updateProjectionMatrix(); }
}
addEventListener('resize', resize); resize();

// ── helpers ───────────────────────────────────────────────
const TEAL = 0x22d3ee, ACCENT = 0x7c8cff, VIOLET = 0xa78bfa;
const cache = {};
const _OBR = THREE.Object3D.prototype.onBeforeRender;    // (static batching, see staticBatch)
const farBatches = [];                       // small interior batches, hidden when the camera is far away (city view)
const _clickIds = new Map();
const clickId = info => info ? (_clickIds.get(info) ?? (_clickIds.set(info, _clickIds.size + 1), _clickIds.size)) : 0;
const flyIgnore = new Set();                  // meshes a double-click fly-to should look through (sky, haze, particles)
const roofSlabs = {};                         // side-tower ceiling slabs, hidden with their rooftops when you zoom in from above
// stacked flat ground layers (land < campus paint < water < road < crosswalks < light pools) win the depth test by rank,
// not by a few centimeters of height: no more shimmering from far away
const groundLayer = (m, n) => { if (!m) return m; m.material = m.material.clone();
  Object.assign(m.material, { polygonOffset: true, polygonOffsetFactor: -n, polygonOffsetUnits: -4 * n }); m.renderOrder = n; return m; };
const std = (c, r = 0.6, m = 0.05) => cache[`s${c}${r}${m}`] ||= new THREE.MeshStandardMaterial({ color: c, roughness: r, metalness: m });
const glow = (c, k = 1.4) => cache[`g${c}${k}`] ||= new THREE.MeshBasicMaterial({ color: new THREE.Color(c).multiplyScalar(k), toneMapped: false });
function mesh(geo, mat, x = 0, y = 0, z = 0, parent = scene, shadow = true) {
  const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.castShadow = shadow; m.receiveShadow = true; parent.add(m); return m;
}
const rbox = (w, h, d, r = 0.05) => new RoundedBoxGeometry(w, h, d, 3, Math.min(r, w / 2.2, h / 2.2, d / 2.2));
const box = (w, h, d, mat, x, y, z, parent = scene, shadow = true) => mesh(rbox(w, h, d, 0.025), mat, x, y, z, parent, shadow);
const bar = (w, h, d, c, x, y, z, k = 1.4, parent = scene) => mesh(new THREE.BoxGeometry(w, h, d), glow(c, k), x, y, z, parent, false);
function canvasTex(w, h, draw) {
  const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
  const g = cv.getContext('2d'); const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8;
  const t = { cv, g, tex, redraw: () => { draw(g, w, h); tex.needsUpdate = true; } };
  t.redraw(); return t;
}
function screen(w, h, tex, x, y, z, ry = 0, parent = scene, bezel = 0.06) {
  const g = new THREE.Group(); g.position.set(x, y, z); g.rotation.y = ry; parent.add(g);
  if (bezel) mesh(rbox(w + bezel * 2, h + bezel * 2, 0.06, 0.02), std(0x0a0c10, 0.35, 0.5), 0, 0, -0.035, g);
  const s = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: tex, toneMapped: false }));
  g.add(s); return { group: g, plane: s };
}
const clickables = [];
function clickable(obj, info) { obj.traverse(o => o.userData.click = info); clickables.push(obj); return obj; }
const hex = n => '#' + n.toString(16).padStart(6, '0');
const font = (px, w = 600) => `${w} ${px}px Inter, sans-serif`;
let seed = 11; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;

// ── sky, sun, lights ──────────────────────────────────────
const skyTex = canvasTex(16, 512, (g, w, h) => {
  const grd = g.createLinearGradient(0, 0, 0, h);
  grd.addColorStop(0, SKY.top); grd.addColorStop(0.42, SKY.mid); grd.addColorStop(0.5, SKY.hor); grd.addColorStop(0.53, SKY.hor); grd.addColorStop(1, '#1a1f2a');
  g.fillStyle = grd; g.fillRect(0, 0, w, h);
});
const skyMat = new THREE.MeshBasicMaterial({ map: skyTex.tex, side: THREE.BackSide, fog: false, depthWrite: false });
const skyDome = new THREE.Mesh(new THREE.SphereGeometry(1400, 32, 16), skyMat); scene.add(skyDome);
const sunDir = new THREE.Vector3(-0.55, SKY.sunY, -0.75).normalize();
if (TOD !== 'night') {
  const sTex = canvasTex(256, 256, (g, w) => { const r = g.createRadialGradient(128, 128, 0, 128, 128, 128);
    r.addColorStop(0, 'rgba(255,250,235,1)'); r.addColorStop(0.12, 'rgba(255,236,200,0.95)'); r.addColorStop(0.35, 'rgba(255,190,120,0.25)'); r.addColorStop(1, 'rgba(255,170,100,0)'); g.clearRect(0, 0, w, w); g.fillStyle = r; g.fillRect(0, 0, w, w); });
  const sun = new THREE.Sprite(new THREE.SpriteMaterial({ map: sTex.tex, fog: false, depthWrite: false, transparent: true, toneMapped: false }));
  sun.scale.setScalar(TOD === 'dusk' ? 260 : 160); sun.position.copy(sunDir).multiplyScalar(1200); scene.add(sun);
} else {
  const pts = []; for (let i = 0; i < 900; i++) { const t = rnd() * Math.PI * 2, p = 0.08 + rnd() * 0.45 * Math.PI; pts.push(Math.cos(t) * Math.cos(p) * 1300, Math.sin(p) * 1300, Math.sin(t) * Math.cos(p) * 1300); }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  scene.add(new THREE.Points(g, new THREE.PointsMaterial({ color: 0xffffff, size: 1.3, sizeAttenuation: false, fog: false, transparent: true, opacity: 0.75 })));
}
// reflections come from the sky itself, so glass towers reflect the real sky color
const envScene = new THREE.Scene(); envScene.add(new THREE.Mesh(new THREE.SphereGeometry(10, 32, 16), skyMat.clone()));
envScene.add(new THREE.HemisphereLight(0xffffff, 0x222222, 1));
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(envScene, 0.02).texture;
scene.environmentIntensity = TOD === 'night' ? 0.35 : 0.8;
scene.add(new THREE.HemisphereLight(TOD === 'day' ? 0xdfeaff : 0xb8c4ff, 0x2a2622, SKY.hemi));
const sunLight = new THREE.DirectionalLight(SKY.sun, SKY.sunI);
sunLight.position.copy(sunDir).multiplyScalar(75); sunLight.castShadow = true;
sunLight.shadow.mapSize.set(2048, 2048); sunLight.shadow.radius = 4; sunLight.shadow.bias = -0.0004; sunLight.shadow.normalBias = 0.03;   // normalBias: no striped "acne" on desks and floors
Object.assign(sunLight.shadow.camera, { left: -38, right: 38, top: 30, bottom: -30, near: 1, far: 170 });
scene.add(sunLight);
for (const x of [-21, -7, 7, 21]) for (const z of [-11, -1, 9.5]) {      // the hall's ceiling lights
  const l = new THREE.PointLight(0xfff3e2, TOD === 'day' ? 12 : 24, 24, 1.6); l.position.set(x, FH - 1.2, z); scene.add(l);
}

// ── the city ──────────────────────────────────────────────
// Just our five towers on a waterfront campus: plaza, boulevard with traffic, trees, a bay and hills on the horizon.
const STREET_Y = -110;
function facade(kind) {   // daytime facade + matching night "lit windows" texture
  const W = 256, H = 512;
  const day = canvasTex(W, H, (g) => {
    if (kind === 0) {        // blue-green curtain-wall glass with a sky reflection
      const grd = g.createLinearGradient(0, 0, W * 0.4, H); grd.addColorStop(0, '#6f93b3'); grd.addColorStop(0.5, '#3d5c78'); grd.addColorStop(1, '#2a4259'); g.fillStyle = grd; g.fillRect(0, 0, W, H);
      g.fillStyle = 'rgba(15,22,32,.85)'; for (let x = 0; x < W; x += 32) g.fillRect(x, 0, 3, H); for (let y = 0; y < H; y += 32) g.fillRect(0, y, W, 2);
    } else if (kind === 1) { // concrete with ribbon windows
      g.fillStyle = '#a7a39a'; g.fillRect(0, 0, W, H); g.fillStyle = '#26303b'; for (let y = 8; y < H; y += 32) g.fillRect(0, y, W, 16);
      g.fillStyle = 'rgba(0,0,0,.22)'; for (let x = 0; x < W; x += 21) g.fillRect(x, 0, 2, H);
    } else if (kind === 2) { // dark glass grid
      g.fillStyle = '#1d2530'; g.fillRect(0, 0, W, H); g.fillStyle = '#34445a'; for (let y = 4; y < H; y += 24) for (let x = 4; x < W; x += 18) g.fillRect(x, y, 13, 18);
    } else if (kind === 3) { // white modern: vertical fins + blue glass
      g.fillStyle = '#5a7896'; g.fillRect(0, 0, W, H); g.fillStyle = '#eef0f2'; for (let x = 0; x < W; x += 16) g.fillRect(x, 0, 5, H);
      g.fillStyle = 'rgba(255,255,255,.7)'; for (let y = 0; y < H; y += 32) g.fillRect(0, y, W, 4);
    } else {                 // warm brick with punched windows
      g.fillStyle = '#8a5a44'; g.fillRect(0, 0, W, H); g.fillStyle = 'rgba(0,0,0,.08)'; for (let y = 0; y < H; y += 4) g.fillRect(0, y, W, 1);
      g.fillStyle = '#2a2f38'; for (let y = 6; y < H; y += 32) for (let x = 5; x < W; x += 21) g.fillRect(x, y, 11, 18);
      g.fillStyle = '#d9cbb8'; for (let y = 24; y < H; y += 32) for (let x = 3; x < W; x += 21) g.fillRect(x, y, 15, 2);
    }
  });
  const lit = canvasTex(W, H, (g) => {
    g.fillStyle = '#000'; g.fillRect(0, 0, W, H);
    const cw = [32, 21, 18, 16, 21][kind], ch = [32, 32, 24, 32, 32][kind];
    const floorsLit = []; for (let y = 0; y < H; y += ch) floorsLit.push(rnd() < 0.5);
    for (let y = 0, row = 0; y < H; y += ch, row++) for (let x = 0; x < W; x += cw) { const r = rnd(); if (!floorsLit[row] || r < 0.62) continue;
      g.fillStyle = r < 0.9 ? '#ffd9a0' : '#bfe2ff'; g.globalAlpha = 0.4 + rnd() * 0.6;
      if (kind === 1) g.fillRect(x + 4, y + 10, cw - 8, 12); else if (kind === 4) g.fillRect(x + 5, y + 6, 11, 18); else if (kind === 3) g.fillRect(x + 6, y + 6, cw - 7, ch - 10); else g.fillRect(x + 4, y + 6, cw - 8, ch - 10); }
    g.globalAlpha = 1;
  });
  for (const t of [day, lit]) { t.tex.wrapS = t.tex.wrapT = THREE.RepeatWrapping; }
  return new THREE.MeshStandardMaterial({ map: day.tex, emissiveMap: lit.tex, emissive: 0xffffff, emissiveIntensity: SKY.lit * 0.7,
    roughness: [0.18, 0.85, 0.2, 0.35, 0.9][kind], metalness: [0.65, 0.05, 0.6, 0.3, 0.02][kind] });
}
const FACADES = [0, 1, 2, 3, 4].map(facade);
function uvScale(geo, w, h, d) { const uv = geo.attributes.uv; for (let k = 0; k < uv.count; k++) uv.setXY(k, uv.getX(k) * Math.max(w, d) / 9, uv.getY(k) * h / 18); return geo; }
const crowns = [], blinkers = [];                                  // the loop pulses crown materials and blinks aviation lights
const blinkMats = [0, 1, 2].map(i => { const m = new THREE.MeshBasicMaterial({ color: new THREE.Color(0xff3344).multiplyScalar(2.2), toneMapped: false }); m.userData.blink = i; return m; });

// ── the campus: our towers on a waterfront plaza (no filler city) ──
const BAY_Z = 135, BLVD = [40, 54];                              // the bay starts at BAY_Z; the boulevard runs between BLVD z values
const pave = canvasTex(256, 256, (g, w, h) => {
  g.fillStyle = TOD === 'day' ? '#b9b6ae' : '#3a3b40'; g.fillRect(0, 0, w, h);
  for (let y = 0; y < h; y += 32) for (let x = (y / 32) % 2 * 32; x < w; x += 64) { g.fillStyle = TOD === 'day' ? 'rgba(0,0,0,.05)' : 'rgba(255,255,255,.03)'; g.fillRect(x, y, 64, 32); }
  g.strokeStyle = TOD === 'day' ? 'rgba(0,0,0,.12)' : 'rgba(0,0,0,.35)'; g.lineWidth = 2; for (let i = 0; i <= w; i += 32) { g.beginPath(); g.moveTo(i, 0); g.lineTo(i, h); g.moveTo(0, i); g.lineTo(w, i); g.stroke(); }
});
pave.tex.wrapS = pave.tex.wrapT = THREE.RepeatWrapping; pave.tex.repeat.set(160, 160);
const ground = new THREE.Mesh(new THREE.PlaneGeometry(2600, 2600), new THREE.MeshStandardMaterial({ map: pave.tex, roughness: 0.92 }));
ground.rotation.x = -Math.PI / 2; ground.position.y = STREET_Y; scene.add(ground);
const grassMat = std(TOD === 'night' ? 0x1f3a24 : 0x4f7d45, 0.95);
const water = new THREE.Mesh(new THREE.PlaneGeometry(2600, 1300), new THREE.MeshStandardMaterial({ color: TOD === 'day' ? 0x2d5e80 : 0x0b1828, roughness: 0.06, metalness: 0.92 }));
water.rotation.x = -Math.PI / 2; water.position.set(0, STREET_Y + 0.04, BAY_Z + 650); scene.add(water); groundLayer(water, 2);   // sits just above the land plane
mesh(new THREE.BoxGeometry(2600, 2.2, 3), std(0x8d8678, 0.9), 0, STREET_Y - 0.1, BAY_Z, scene, false);   // sea wall
// the boulevard: road, lane marks, lamps, traffic
const road = canvasTex(256, 64, (g, w, h) => { g.fillStyle = '#26282d'; g.fillRect(0, 0, w, h); g.fillStyle = '#e8e2c8'; g.fillRect(0, 31, w, 2);
  for (let x = 0; x < w; x += 32) { g.fillRect(x, 15, 16, 1.5); g.fillRect(x, 47, 16, 1.5); } });
road.tex.wrapS = THREE.RepeatWrapping; road.tex.repeat.set(60, 1);
const roadM = new THREE.Mesh(new THREE.PlaneGeometry(1200, BLVD[1] - BLVD[0]), new THREE.MeshStandardMaterial({ map: road.tex, roughness: 0.85 }));
roadM.rotation.x = -Math.PI / 2; roadM.position.set(0, STREET_Y + 0.05, (BLVD[0] + BLVD[1]) / 2); scene.add(roadM); groundLayer(roadM, 3);
{ const trunks = [], crownsG = [];                               // trees along the boulevard and around the plaza, merged into two meshes
  const tree = (x, z, s) => { trunks.push(new THREE.CylinderGeometry(0.3 * s, 0.4 * s, 3 * s, 6).translate(x, STREET_Y + 1.5 * s, z));
    crownsG.push(new THREE.IcosahedronGeometry(2.2 * s, 1).translate(x, STREET_Y + 4.2 * s, z)); };
  for (let x = -290; x <= 290; x += 12) { if (Math.abs(x) % 24 === 0) continue; tree(x, BLVD[0] - 5, 0.9 + rnd() * 0.3); tree(x, BLVD[1] + 5, 0.9 + rnd() * 0.3); }
  scene.add(new THREE.Mesh(mergeGeometries(trunks), std(0x5b4636, 0.9)));
  scene.add(new THREE.Mesh(mergeGeometries(crownsG), std(TOD === 'night' ? 0x23402a : 0x3f7a4a, 0.85))); }
const CAR_N = 46, cars = [], carMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(4.4, 1.4, 2), TOD === 'day' ? new THREE.MeshStandardMaterial({ roughness: 0.35, metalness: 0.5 }) : new THREE.MeshBasicMaterial({ toneMapped: false }), CAR_N);
carMesh.frustumCulled = false; scene.add(carMesh);
const CAR_COLS = [0xd9dde3, 0x20242b, 0x8a1c24, 0x1d3f7a, 0x9aa1a9, 0xe7e2d6];
for (let i = 0; i < CAR_N; i++) { const dir = i % 2 ? 1 : -1; cars.push({ dir, z: dir > 0 ? BLVD[0] + 3.5 : BLVD[1] - 3.5, x: (rnd() - 0.5) * 600, v: 9 + rnd() * 6 });
  carMesh.setColorAt(i, new THREE.Color(TOD === 'day' ? CAR_COLS[i % 6] : (dir > 0 ? 0xfff1d6 : 0xff3b30)).multiplyScalar(TOD === 'day' ? 1 : 2.2)); }
const carDummy = new THREE.Object3D();
function moveCars(dt) {
  for (let i = 0; i < CAR_N; i++) { const c = cars[i]; c.x += c.v * c.dir * dt; if (c.x > 300) c.x -= 600; if (c.x < -300) c.x += 600;
    carDummy.position.set(c.x, STREET_Y + 0.8, c.z); carDummy.updateMatrix(); carMesh.setMatrixAt(i, carDummy.matrix); }
  carMesh.instanceMatrix.needsUpdate = true;
}
moveCars(0); if (carMesh.instanceColor) carMesh.instanceColor.needsUpdate = true;
// low hills on the horizon instead of a skyline
const hills = canvasTex(2048, 256, (g, w, h) => { g.clearRect(0, 0, w, h);
  for (const [c, amp, base] of [[TOD === 'day' ? '#8aa0b4' : '#141c2c', 70, 150], [TOD === 'day' ? '#6f8a7c' : '#0e1522', 50, 190]]) {
    g.fillStyle = c; g.beginPath(); g.moveTo(0, h);
    for (let x = 0; x <= w; x += 16) g.lineTo(x, base - Math.sin(x / 140) * amp * 0.5 - Math.sin(x / 47 + base) * amp * 0.25 - Math.sin(x / 300) * amp * 0.5);
    g.lineTo(w, h); g.fill(); } });
hills.tex.wrapS = THREE.RepeatWrapping; hills.tex.repeat.set(3, 1);
const hillRing = new THREE.Mesh(new THREE.CylinderGeometry(680, 680, 200, 64, 1, true), new THREE.MeshBasicMaterial({ map: hills.tex, transparent: true, side: THREE.BackSide, depthWrite: false }));
hillRing.position.y = STREET_Y + 70; scene.add(hillRing); setTimeout(() => { flyIgnore.add(skyDome); flyIgnore.add(hillRing); });

// ── tower(): the five real buildings, each with its own architecture ──
// a lobby podium, a facade shaft with floor bands (+ fins on glass towers), a crown with a lit accent band,
// all merged per material so each tower is a handful of draw calls
const TSTYLE = {
  fund:   { fac: 0, fin: 0x1b222c, band: 0x9aa3b0, accent: 0xffd166 },
  studio: { fac: 2, fin: 0x8a6440, band: 0x3e4a42, accent: 0x34d399 },
  news:   { fac: 3, fin: 0xf2f2f0, band: 0xe2e2df, accent: 0xef4444 },
  career: { fac: 4, fin: null,     band: 0xdcceb9, accent: 0x2dd4bf },
  study:  { fac: 1, fin: null,     band: 0xebe5d6, accent: 0x86efac, columns: true },
  incubator: { fac: 2, fin: 0xe8f0e4, band: 0xdfe9d8, accent: 0x86efac },
  ops:    { fac: 0, fin: 0x22262d, band: 0x4b5563, accent: 0x38bdf8 },
};
const lobbyTex = canvasTex(256, 128, (g, w, h) => { g.fillStyle = '#1a1612'; g.fillRect(0, 0, w, h);
  const lg = g.createLinearGradient(0, 0, 0, h); lg.addColorStop(0, 'rgba(255,214,160,.85)'); lg.addColorStop(1, 'rgba(255,190,120,.35)'); g.fillStyle = lg; g.fillRect(0, 8, w, h - 8);
  g.fillStyle = '#2a2d33'; for (let x = 0; x < w; x += 32) g.fillRect(x, 0, 3, h); g.fillRect(0, 0, w, 8); g.fillRect(0, 60, w, 3); });
lobbyTex.tex.wrapS = THREE.RepeatWrapping;
function tower(x, z, w, d, style) {
  const S = TSTYLE[style], parts = new Map(), top = -2, PH = 14, CROWN = 2.4, FIN_TOP = -12.6;
  const add = (geo, mat, px, py, pz) => { geo.translate(px, py, pz); if (!parts.has(mat)) parts.set(mat, []); parts.get(mat).push(geo); };
  const bandMat = std(S.band, 0.55, 0.35), finMat = S.fin != null ? std(S.fin, 0.35, 0.7) : null, stone = std(0xe9e4d8, 0.8, 0.05);
  // lobby: a warm glass storefront set back under the shaft, with stone piers
  const lobby = new THREE.MeshStandardMaterial({ map: lobbyTex.tex, emissiveMap: lobbyTex.tex, emissive: 0xffffff, emissiveIntensity: TOD === 'day' ? 0.25 : 1.1, roughness: 0.2, metalness: 0.4 });
  lobby.map.repeat.set(Math.round(w / 6), 1);
  add(new THREE.BoxGeometry(w - 2.4, PH - 1, d - 2.4), lobby, x, STREET_Y + (PH - 1) / 2, z);
  for (let i = 0; i <= Math.round(w / 6); i++) for (const sz of [-1, 1]) add(new THREE.BoxGeometry(1, PH, 1), S.columns ? stone : bandMat, x - w / 2 + 0.5 + i * (w - 1) / Math.round(w / 6), STREET_Y + PH / 2, z + sz * (d / 2 - 0.5));
  for (let i = 0; i <= Math.round(d / 6); i++) for (const sx of [-1, 1]) add(new THREE.BoxGeometry(1, PH, 1), S.columns ? stone : bandMat, x + sx * (w / 2 - 0.5), STREET_Y + PH / 2, z - d / 2 + 0.5 + i * (d - 1) / Math.round(d / 6));
  add(new THREE.BoxGeometry(w + 0.6, 1.2, d + 0.6), bandMat, x, STREET_Y + PH + 0.6, z);                         // transfer beam over the lobby
  add(new THREE.BoxGeometry(14, 0.5, 4.5), bandMat, x, STREET_Y + 7, z + d / 2 + 2.2);                             // entrance canopy
  add(new THREE.BoxGeometry(13.6, 0.08, 4.2), glow(0xfff1d6, TOD === 'day' ? 0.8 : 2.2), x, STREET_Y + 6.72, z + d / 2 + 2.2);
  if (S.columns) {                                                                                               // classical portico for the study hall
    for (let i = 0; i < 6; i++) add(new THREE.CylinderGeometry(0.75, 0.85, PH - 1, 16), stone, x - 10 + i * 4, STREET_Y + (PH - 1) / 2, z + d / 2 + 4);
    add(new THREE.BoxGeometry(24, 1.2, 6), stone, x, STREET_Y + PH - 0.4, z + d / 2 + 3.4);
    const ped = new THREE.CylinderGeometry(4, 4, 24, 3, 1); ped.rotateZ(Math.PI / 2); ped.scale(1, 0.5, 1.4); add(ped, stone, x, STREET_Y + PH + 1.4, z + d / 2 + 3.4);
    add(new THREE.BoxGeometry(26, 1.4, 9), stone, x, STREET_Y + 0.7, z + d / 2 + 3.6);                           // steps
  }
  // shaft
  const sh = top - CROWN - (STREET_Y + PH + 1.2);
  mesh(uvScale(new THREE.BoxGeometry(w, sh, d), w, sh, d), FACADES[S.fac], x, STREET_Y + PH + 1.2 + sh / 2, z, scene, false);
  for (let y = STREET_Y + PH + 5.4; y < top - CROWN - 1; y += 4.2) add(new THREE.BoxGeometry(w + 0.2, 0.32, d + 0.2), bandMat, x, y, z);   // floor slabs
  if (finMat) {                                                                                                  // vertical fins (glass towers)
    const fh = FIN_TOP - (STREET_Y + PH + 1.2), fy = STREET_Y + PH + 1.2 + fh / 2;
    for (let i = 1; i < Math.round(w / 3); i++) for (const sz of [-1, 1]) add(new THREE.BoxGeometry(0.22, fh, 0.7), finMat, x - w / 2 + i * w / Math.round(w / 3), fy, z + sz * (d / 2 + 0.35));
    for (let i = 1; i < Math.round(d / 3); i++) for (const sx of [-1, 1]) add(new THREE.BoxGeometry(0.7, fh, 0.22), finMat, x + sx * (w / 2 + 0.35), fy, z - d / 2 + i * d / Math.round(d / 3));
  }
  // crown with a lit accent band
  add(new THREE.BoxGeometry(w + 0.8, CROWN, d + 0.8), bandMat, x, top - CROWN / 2, z);
  const lit = new THREE.MeshBasicMaterial({ color: new THREE.Color(S.accent).multiplyScalar(TOD === 'day' ? 0.9 : 1.8), toneMapped: false, transparent: true, opacity: 0.85 });
  crowns.push(lit);
  add(new THREE.BoxGeometry(w + 0.9, 0.3, d + 0.9), lit, x, top - CROWN - 0.3, z);
  for (const [cx, cz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) add(new THREE.SphereGeometry(0.35, 8, 6), blinkMats[(cx + cz + 4) % 3], x + cx * (w / 2 - 0.6), 6.3, z + cz * (d / 2 - 0.6));
  for (const [mat, list] of parts) { const m = new THREE.Mesh(mergeGeometries(list), mat); scene.add(m); if (mat.userData.blink !== undefined) blinkers.push(m); }
}
// our own tower below the trading floor + the company sign
tower(0, 0, FW, FD, 'fund');
const jbSign = canvasTex(1024, 192, (g, w, h) => { g.clearRect(0, 0, w, h); g.fillStyle = '#ffffff'; g.font = font(120, 800); g.fillText('JB CAPITAL', 40, 140); });
const jbPlane = new THREE.Mesh(new THREE.PlaneGeometry(22, 4.2), new THREE.MeshBasicMaterial({ map: jbSign.tex, transparent: true, toneMapped: false }));
jbPlane.position.set(0, -6.5, FZ + 0.45); scene.add(jbPlane);
// a few planes crossing the sky (blinking nav lights)
const planes = [];
for (let i = 0; i < 4; i++) { const p = new THREE.Group(); scene.add(p); mesh(new THREE.CapsuleGeometry(0.6, 5, 4, 8), std(0xdfe3ea, 0.4, 0.5), 0, 0, 0, p, false).rotation.z = Math.PI / 2;
  mesh(new THREE.BoxGeometry(1.2, 0.15, 7), std(0xdfe3ea, 0.4, 0.5), 0, 0, 0, p, false); const l = mesh(new THREE.SphereGeometry(0.4, 8, 6), glow(i % 2 ? 0xff3344 : 0xffffff, 2.5), -3, 0, 0, p, false);
  planes.push({ g: p, l, r: 400 + rnd() * 300, y: 120 + rnd() * 120, w: 0.012 + rnd() * 0.01, t: rnd() * Math.PI * 2 }); }

// ── layout: the fund's trading hall (FW x FD, FH-tall glass walls) ──
// north (-z): the video wall · front row: every portfolio manager · main aisle (sky bridges, z = AISLE) · back row:
// research & data, analytics, risk & execution · south aisle (LOW) · conference room (SW), lounge by the windows (S),
// quant research lab (SE) · CIO corner office (NE) · pantry + servers on the west wall · execution elevator on the east wall
const AISLE = -1.5, LOW = 8.2, PM_Z = -8.5, STAFF_Z = 4;
const CROSS = [-18.25, -2.25, 13.25];            // lanes through the back row (between desks) for trips to the south rooms
const STAFF = [
  { id: 'vic',   name: 'Vic',   role: 'Volatility analyst',          seat: [-4.5, STAFF_Z],  accent: 0x38bdf8, jacket: 0x1e4f8a, badge: 21 },
  { id: 'sam',   name: 'Sam',   role: 'Performance & attribution',   seat: [0, STAFF_Z],     accent: 0xf472b6, jacket: 0x7a2a58, badge: 33 },
  { id: 'ava',   name: 'Ava',   role: 'Head of AI Research (Claude)', seat: [-16, STAFF_Z],  accent: 0x22d3ee, jacket: 0x0f5d6b, badge: 1 },
  { id: 'dot',   name: 'Dot',   role: 'Data engineering',            seat: [-11.5, STAFF_Z], accent: 0x34d399, jacket: 0x1d5e43, badge: 44 },
  { id: 'rex',   name: 'Rex',   role: 'Chief Risk Officer',          seat: [6.5, STAFF_Z],   accent: 0xf59e0b, jacket: 0x8a5a0c, badge: 7 },
  { id: 'eddie', name: 'Eddie', role: 'Head of Execution',           seat: [11, STAFF_Z],    accent: 0xfacc15, jacket: 0x8a7a12, badge: 12, headset: true },
  { id: 'boss',  name: 'The CIO', role: 'Chief Investment Officer',  seat: [23.5, -11.5],    accent: 0xffd166, jacket: 0x14181f, badge: 0, suit: true },
  { id: 'kai',   name: 'Kai',   role: 'ML Quant Researcher (models)', seat: [-20.5, STAFF_Z], accent: 0xa3e635, jacket: 0x3f6212, badge: 77 },
  { id: 'lena',  name: 'Lena',  role: 'Chief Compliance Officer',  seat: [15.5, STAFF_Z],  accent: 0xe879f9, jacket: 0x6b21a8, badge: 88 },
  { id: 'ari',   name: 'Ari',   role: 'Front desk',                seat: [24.2, 7.6],      accent: 0xfbbf24, jacket: 0x92400e, badge: 99 },
];
const FOUNDER_LOOK = {
  mo:   { seat: [-16, PM_Z],   accent: 0xfb7185, jacket: 0x9b2335, badge: 5 },
  rita: { seat: [-11.5, PM_Z], accent: 0xc084fc, jacket: 0x5b2a86, badge: 9 },
  opal: { seat: [-7, PM_Z],    accent: 0x2dd4bf, jacket: 0x14665c, badge: 16 },
};
const HIRE_SEATS = [[1.5, PM_Z], [6, PM_Z], [10.5, PM_Z]];
const HIRE_ACCENTS = [0xff9f43, 0x2dd4bf, 0xfb7185, 0x60a5fa, 0xfacc15, 0xa78bfa, 0x34d399, 0xf97316, 0x22d3ee, 0xe879f9];
const JACKETS = [0x8a4b12, 0x14665c, 0x9b2335, 0x1e4f8a, 0x8a7a12, 0x4c2a86, 0x1d5e43, 0x8a3a12, 0x0f5d6b, 0x7a2a6e];
const CIO = { x0: 17.5, z1: -6.5, door: 19.2 };   // the corner office: x > x0, z < z1, door in its south wall at x = door
const POI = {
  wall: { x: -3, z: -13 }, scoreboard: { x: 14, z: -13 }, exchange: { x: FX - 0.8, z: 3.5 },
  pantry: { x: -FX + 2.4, z: 3.4 }, cooler: { x: -FX + 2.4, z: 6.0 }, bossVisit: { x: 22.2, z: -9.4 },
  lab: { x: 21.5, z: 11.4 }, servers: { x: -FX + 2.2, z: -5.1 },
};
const MEET_SPOTS = [...[-25.5, -24, -22.5, -21, -19.5].flatMap(x => [[x, 11.6], [x, 14.8]]), [-26.8, 13.2], [-18.2, 13.2]].map(([x, z]) => ({ x, z }));
const BOSS_PATH = [{ x: CIO.door, z: AISLE }, { x: CIO.door, z: CIO.z1 - 1.1 }, POI.bossVisit];
const COLORS = {};
for (const d of STAFF) COLORS[d.id] = hex(d.accent);
const chairMat = std(0x16181d, 0.7, 0.1), metal = std(0x9aa1ab, 0.3, 0.9);

// ── the trading hall: floor, aisles, glass walls, frame, ceiling lights ──
const carpetTex = canvasTex(512, 512, (g, w, h) => {
  g.fillStyle = '#1f2633'; g.fillRect(0, 0, w, h);                                 // deep navy carpet tiles, quarter-turned
  for (let y = 0; y < h; y += 64) for (let x = 0; x < w; x += 64) { g.fillStyle = (x + y) % 128 ? '#222a38' : '#1d2430'; g.fillRect(x, y, 64, 64);
    g.strokeStyle = 'rgba(0,0,0,.22)'; g.strokeRect(x + 0.5, y + 0.5, 63, 63);
    g.strokeStyle = 'rgba(255,255,255,.035)'; for (let k = 6; k < 64; k += 6) { g.beginPath(); if ((x + y) % 128) { g.moveTo(x + k, y); g.lineTo(x + k, y + 64); } else { g.moveTo(x, y + k); g.lineTo(x + 64, y + k); } g.stroke(); }
    for (let k = 0; k < 40; k++) { g.fillStyle = `rgba(255,255,255,${rnd() * 0.04})`; g.fillRect(x + rnd() * 64, y + rnd() * 64, 2, 2); } }
});
carpetTex.tex.wrapS = carpetTex.tex.wrapT = THREE.RepeatWrapping; carpetTex.tex.repeat.set(14, 8.5);
const floor = new THREE.Mesh(new THREE.PlaneGeometry(FW + 0.4, FD + 0.4), new THREE.MeshStandardMaterial({ map: carpetTex.tex, roughness: 0.95, metalness: 0 }));
floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true; scene.add(floor);
const aisleMat = new THREE.MeshStandardMaterial({ color: 0x7d828a, roughness: 0.55, metalness: 0.1 });
mesh(new THREE.BoxGeometry(FW + 0.4, 0.02, 1.8), aisleMat, 0, 0.01, AISLE, scene, false);
mesh(new THREE.BoxGeometry(FW + 0.4, 0.02, 1.4), aisleMat, 0, 0.01, LOW, scene, false);
mesh(new THREE.BoxGeometry(FW + 1, 2.6, FD + 1), std(0x1a1d22, 0.5, 0.4), 0, -1.31, 0, scene, false);
const glass = new THREE.MeshPhysicalMaterial({ color: 0xbcd8ff, transparent: true, opacity: 0.1, roughness: 0.04, metalness: 0.1, depthWrite: false });
const mull = std(0x1c1f25, 0.35, 0.8);
const GAP = [AISLE - 1.7, AISLE + 1.7];                                            // sky-bridge doorway in the side walls
const sideRuns = [[-FZ, GAP[0]], [GAP[1], FZ]].map(([a, b]) => [b - a, (a + b) / 2]);
// north + west: full-height glass with mullions; south + east: a low parapet so the camera looks straight in
mesh(new THREE.BoxGeometry(FW, FH, 0.05), glass, 0, FH / 2, -FZ - 0.05, scene, false);
for (let x = -FX; x <= FX + 0.01; x += 2.8) box(0.08, FH, 0.12, mull, x, FH / 2, -FZ - 0.05, scene, false);
for (const [len, cz] of sideRuns) mesh(new THREE.BoxGeometry(0.05, FH, len), glass, -FX - 0.05, FH / 2, cz, scene, false);
for (let z = -FZ; z <= FZ + 0.01; z += 2.8) if (z < GAP[0] || z > GAP[1]) box(0.12, FH, 0.08, mull, -FX - 0.05, FH / 2, z, scene, false);
mesh(new THREE.BoxGeometry(FW, 1.1, 0.05), glass, 0, 0.55, FZ + 0.05, scene, false); box(FW + 0.2, 0.06, 0.08, mull, 0, 1.1, FZ + 0.05, scene, false);
for (const [len, cz] of sideRuns) { mesh(new THREE.BoxGeometry(0.05, 1.1, len), glass, FX + 0.05, 0.55, cz, scene, false); box(0.08, 0.06, len, mull, FX + 0.05, 1.1, cz, scene, false); }
for (const [cx, cz] of [[-FX, -FZ], [FX, -FZ], [-FX, FZ], [FX, FZ]]) box(0.3, FH, 0.3, mull, cx, FH / 2, cz, scene, false);   // corner posts
const soffit = std(0x2a2d33, 0.7, 0.1);
box(FW + 0.6, 0.4, 0.4, soffit, 0, FH, -FZ, scene, false); box(FW + 0.6, 0.4, 0.4, soffit, 0, FH, FZ, scene, false);       // the frame's top ring
box(0.4, 0.4, FD + 0.6, soffit, -FX, FH, 0, scene, false); box(0.4, 0.4, FD + 0.6, soffit, FX, FH, 0, scene, false);
box(0.7, 4, 4.4, std(0x22262d, 0.4, 0.6), FX + 0.4, 2, 3.5);                         // elevator core

function zoneLabel(x, z, label, w = 5.6) {
  const t = canvasTex(640, 64, g => { g.clearRect(0, 0, 640, 64); g.fillStyle = 'rgba(255,255,255,0.35)'; g.font = font(28, 700); g.fillText(label, 8, 42); });
  const p = new THREE.Mesh(new THREE.PlaneGeometry(w, 0.56), new THREE.MeshBasicMaterial({ map: t.tex, transparent: true, toneMapped: false }));
  p.rotation.x = -Math.PI / 2; p.position.set(x, 0.03, z); scene.add(p);
}
zoneLabel(-13, PM_Z + 2.9, 'PORTFOLIO MANAGERS'); zoneLabel(-15, STAFF_Z + 2.6, 'RESEARCH & DATA'); zoneLabel(-3.6, STAFF_Z + 2.6, 'ANALYTICS');
zoneLabel(8, STAFF_Z + 2.6, 'RISK & EXECUTION'); zoneLabel(-2, -14.6, 'MARKET WALL'); zoneLabel(-1.4, 10.2, 'LOUNGE'); zoneLabel(19.6, 10.2, 'QUANT RESEARCH LAB');

// ── the video wall: heatmap · NAV · PM board, ticker, world clocks ──
const VW_Y = 4.3, VW_Z = -FZ + 0.3;
const heatTex = canvasTex(1024, 640, (g, w, h) => {
  g.fillStyle = '#060a12'; g.fillRect(0, 0, w, h); g.fillStyle = '#8a96ad'; g.font = font(30, 700); g.fillText('MARKETS', 30, 50);
  const m = snap ? Object.entries(snap.markets) : []; const cols = 3, cw = (w - 60) / cols, chh = (h - 90) / Math.max(1, Math.ceil(m.length / cols));
  m.forEach(([s, v], i) => { const x = 30 + (i % cols) * cw, y = 70 + Math.floor(i / cols) * chh, c = Math.max(-1, Math.min(1, v.chg / 0.03));
    g.fillStyle = c >= 0 ? `rgba(34,197,94,${0.18 + c * 0.6})` : `rgba(244,63,94,${0.18 - c * 0.6})`; g.fillRect(x + 4, y + 4, cw - 8, chh - 8);
    g.fillStyle = '#fff'; g.font = font(Math.min(40, chh * 0.32), 800); g.fillText(s, x + 20, y + chh * 0.42); g.font = `600 ${Math.min(30, chh * 0.24)}px 'JetBrains Mono'`; g.fillText(fmtPx(v.px), x + 20, y + chh * 0.7);
    g.fillText(`${v.chg >= 0 ? '+' : ''}${(v.chg * 100).toFixed(2)}%`, x + 20 + cw * 0.5, y + chh * 0.7); });
});
const navTex = canvasTex(1280, 640, (g, w, h) => {
  g.fillStyle = '#060a12'; g.fillRect(0, 0, w, h);
  g.fillStyle = '#8a96ad'; g.font = font(30, 700); g.fillText('JB CAPITAL · NAV PER UNIT', 36, 52);
  if (!snap) return;
  const tot = snap.equity / snap.start - 1;
  g.fillStyle = tot >= 0 ? '#22c55e' : '#f43f5e'; g.font = "700 84px 'JetBrains Mono'"; g.fillText(snap.nav.toFixed(2), 36, 150);
  g.font = "600 34px 'JetBrains Mono'"; g.fillText(`${tot >= 0 ? '+' : ''}${(tot * 100).toFixed(2)}%`, 330, 150);
  g.fillStyle = '#c9d1e4'; g.font = "500 26px 'JetBrains Mono'"; g.fillText(`AUM ${money(snap.equity)}   SHARPE ${snap.sharpe == null ? 'n/a' : snap.sharpe.toFixed(2)}   MAX DD ${(snap.maxdd * 100).toFixed(2)}%`, 36, 196);
  const c = snap.curve.slice(-400).map(p => p[1]); if (c.length > 1) { const lo = Math.min(...c, snap.start), hi = Math.max(...c, snap.start), sp = hi - lo || 1;
    const Y = v => h - 40 - (v - lo) / sp * (h - 270); g.strokeStyle = '#2a3654'; g.setLineDash([8, 8]); g.beginPath(); g.moveTo(36, Y(snap.start)); g.lineTo(w - 36, Y(snap.start)); g.stroke(); g.setLineDash([]);
    g.strokeStyle = tot >= 0 ? '#22c55e' : '#f43f5e'; g.lineWidth = 5; g.beginPath(); c.forEach((v, i) => { const x = 36 + i / (c.length - 1) * (w - 72); i ? g.lineTo(x, Y(v)) : g.moveTo(x, Y(v)); }); g.stroke(); g.lineWidth = 1; }
});
const sbTex = canvasTex(1024, 640, (g, w, h) => {
  g.fillStyle = '#060a12'; g.fillRect(0, 0, w, h); g.fillStyle = '#8a96ad'; g.font = font(30, 700); g.fillText('PORTFOLIO MANAGERS', 30, 50);
  g.font = font(18, 700); g.fillText('ALLOCATION', 300, 82); g.fillText('RISK/TRADE', 560, 82); g.fillText('P&L', 720, 82);
  (snap?.roster || []).slice(0, 7).forEach((p, i) => { const y = 132 + i * 70;
    g.fillStyle = COLORS[p.id] || '#fff'; g.fillRect(30, y - 32, 8, 44);
    g.fillStyle = '#e6ebf5'; g.font = font(32, 700); g.fillText(p.name, 54, y); g.fillStyle = '#8a96ad'; g.font = font(20, 500); g.fillText(p.family, 54, y + 22);
    g.fillStyle = '#1e2840'; g.fillRect(300, y - 22, 170, 14); g.fillStyle = '#7c8cff'; g.fillRect(300, y - 22, 170 * Math.min(1, p.alloc / 0.6), 14);
    g.fillStyle = '#c9d1e4'; g.font = "600 24px 'JetBrains Mono'"; g.fillText(`${(p.alloc * 100).toFixed(0)}%`, 480, y - 8);
    g.fillText(p.risk == null ? '—' : `${(p.risk * 100).toFixed(1)}%`, 560, y - 8);
    g.fillStyle = p.pnl >= 0 ? '#22c55e' : '#f43f5e'; g.fillText(money(p.pnl), 720, y - 8);
    g.fillStyle = p.status === 'active' ? '#22c55e' : p.status === 'paused' ? '#f59e0b' : '#f43f5e'; g.font = font(18, 700); g.fillText(p.status.toUpperCase(), 890, y - 8); });
});
box(32.6, 5.0, 0.25, std(0x0a0c10, 0.3, 0.6), 0, VW_Y, VW_Z - 0.08);
const vwL = screen(9.8, 4.6, heatTex.tex, -10.95, VW_Y, VW_Z + 0.06, 0, scene, 0);
const vwC = screen(11.8, 4.6, navTex.tex, 0, VW_Y, VW_Z + 0.06, 0, scene, 0);
const vwR = screen(9.8, 4.6, sbTex.tex, 10.95, VW_Y, VW_Z + 0.06, 0, scene, 0);
clickable(vwL.group, { type: 'charts', tip: 'Markets heatmap — open charts' }); clickable(vwC.group, { type: 'tear', tip: 'Fund NAV — open the tear sheet' }); clickable(vwR.group, { type: 'pods', tip: 'PM board — pods, allocation & risk dials' });
const tkTex = canvasTex(2048, 48, (g, w, h) => {
  g.fillStyle = '#020306'; g.fillRect(0, 0, w, h); g.font = "500 30px 'JetBrains Mono'";
  const items = snap ? Object.entries(snap.markets) : [];
  let x = 12; if (!items.length) { g.fillStyle = '#8692ab'; g.fillText('CONNECTING…', x, 34); return; }
  while (x < w) for (const [s, m] of items) { g.fillStyle = '#ffb000'; g.fillText(`${s} ${fmtPx(m.px)}`, x, 34); x += g.measureText(`${s} ${fmtPx(m.px)} `).width;
    g.fillStyle = m.chg >= 0 ? '#22c55e' : '#f43f5e'; const t = `${m.chg >= 0 ? '▲' : '▼'}${Math.abs(m.chg * 100).toFixed(2)}%`; g.fillText(t, x, 34); x += g.measureText(t + '      ').width; }
});
tkTex.tex.wrapS = THREE.RepeatWrapping;
screen(32.6, 0.55, tkTex.tex, 0, VW_Y - 2.85, VW_Z + 0.06, 0, scene, 0);
const CITIES = [['NEW YORK', 'America/New_York'], ['LONDON', 'Europe/London'], ['TOKYO', 'Asia/Tokyo'], ['HONG KONG', 'Asia/Hong_Kong']];
const clocks = CITIES.map(([city, tz], i) => {
  const t = canvasTex(256, 300, (g, w) => {
    const p = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: 'numeric', minute: 'numeric', second: 'numeric', hour12: false }).formatToParts(new Date());
    const get = k => +p.find(x => x.type === k).value, H = get('hour') % 12, M = get('minute'), S = get('second');
    g.clearRect(0, 0, w, 300); g.fillStyle = '#f4f3ef'; g.beginPath(); g.arc(128, 128, 118, 0, 7); g.fill();
    g.strokeStyle = '#1c1f25'; g.lineWidth = 8; g.beginPath(); g.arc(128, 128, 118, 0, 7); g.stroke();
    for (let k = 0; k < 60; k++) { const a = k / 60 * Math.PI * 2, r1 = k % 5 ? 104 : 94; g.lineWidth = k % 5 ? 2 : 5; g.beginPath(); g.moveTo(128 + Math.sin(a) * r1, 128 - Math.cos(a) * r1); g.lineTo(128 + Math.sin(a) * 110, 128 - Math.cos(a) * 110); g.stroke(); }
    const hand = (f, len, wd, col) => { const a = f * Math.PI * 2; g.strokeStyle = col; g.lineWidth = wd; g.lineCap = 'round'; g.beginPath(); g.moveTo(128, 128); g.lineTo(128 + Math.sin(a) * len, 128 - Math.cos(a) * len); g.stroke(); };
    hand((H + M / 60) / 12, 58, 9, '#1c1f25'); hand((M + S / 60) / 60, 86, 6, '#1c1f25'); hand(S / 60, 92, 2.5, '#c8102e');
    g.fillStyle = '#1c1f25'; g.beginPath(); g.arc(128, 128, 7, 0, 7); g.fill();
    g.fillStyle = '#e6ebf5'; g.font = "700 30px Inter, sans-serif"; g.textAlign = 'center'; g.fillText(city, 128, 290); g.textAlign = 'left';
  });
  const m = new THREE.Mesh(new THREE.PlaneGeometry(1.0, 1.17), new THREE.MeshBasicMaterial({ map: t.tex, transparent: true, toneMapped: false }));
  m.position.set(-6.3 + i * 4.2, VW_Y + 3.0, VW_Z + 0.08); scene.add(m);
  return t;
});
// "JB TV" on the north wall, west of the video wall
const tvTex = canvasTex(512, 288, (g, w, h) => {
  g.fillStyle = '#0b1a33'; g.fillRect(0, 0, w, h); g.fillStyle = '#c8102e'; g.fillRect(0, 0, w, 54); g.fillStyle = '#fff'; g.font = font(30, 800); g.fillText('JB TV · MARKETS', 16, 38);
  g.fillStyle = '#e6ebf5'; g.font = font(28, 700); wrapText(g, snap?.headline || (snap ? `BTC ${fmtPx(snap.markets?.BTC?.px || 0)} · ETH ${fmtPx(snap.markets?.ETH?.px || 0)}` : 'Live coverage'), 16, 100, w - 32, 34, 3);
  g.fillStyle = '#ffb000'; g.fillRect(0, h - 46, w, 46); g.fillStyle = '#000'; g.font = "600 24px 'JetBrains Mono'";
  g.fillText(snap ? `NAV ${snap.nav.toFixed(2)}  ·  ${snap.positions.length} OPEN  ·  RISK ${money(snap.open_risk)}` : '', 14, h - 15);
});
screen(5.2, 2.92, tvTex.tex, -22.4, 4.3, VW_Z + 0.06, 0, scene, 0.08);

// ── CIO corner office (NE) ─────────────────────────────────
const CIO_H = 4.6;
mesh(new THREE.BoxGeometry(0.06, CIO_H, FZ + CIO.z1), glass, CIO.x0, CIO_H / 2, (-FZ + CIO.z1) / 2, scene, false);
mesh(new THREE.BoxGeometry(CIO.door - 1 - CIO.x0, CIO_H, 0.06), glass, (CIO.x0 + CIO.door - 1) / 2, CIO_H / 2, CIO.z1, scene, false);
mesh(new THREE.BoxGeometry(FX - CIO.door - 1, CIO_H, 0.06), glass, (CIO.door + 1 + FX) / 2, CIO_H / 2, CIO.z1, scene, false);
for (const x of [CIO.x0, CIO.door - 1, CIO.door + 1]) box(0.1, CIO_H, 0.1, mull, x, CIO_H / 2, CIO.z1, scene, false);
box(0.1, 0.1, FZ + CIO.z1, mull, CIO.x0, CIO_H, (-FZ + CIO.z1) / 2, scene, false); box(FX - CIO.x0, 0.1, 0.1, mull, (CIO.x0 + FX) / 2, CIO_H, CIO.z1, scene, false);
const signTex = canvasTex(512, 96, g => { g.clearRect(0, 0, 512, 96); g.fillStyle = 'rgba(255,255,255,.85)'; g.font = font(34, 600); g.fillText('Chief Investment Officer', 20, 60); });
const sign = new THREE.Mesh(new THREE.PlaneGeometry(3.2, 0.6), new THREE.MeshBasicMaterial({ map: signTex.tex, transparent: true, toneMapped: false })); sign.position.set(23.2, CIO_H - 0.6, CIO.z1 + 0.05); scene.add(sign);
const walnut = std(0x4a2f1c, 0.45, 0.05), leather = std(0x2b1d15, 0.55, 0.05);
mesh(new THREE.BoxGeometry(6.5, 0.012, 4.4), std(0x3b2f2a, 0.95), 23.6, 0.012, -11.2, scene, false);                 // rug
box(1.0, 0.5, 2.6, leather, 26.8, 0.3, -8.6); box(0.3, 0.6, 2.6, leather, 27.25, 0.7, -8.6); box(1, 0.45, 0.3, leather, 26.8, 0.55, -9.75); box(1, 0.45, 0.3, leather, 26.8, 0.55, -7.45);
mesh(new THREE.CylinderGeometry(0.55, 0.55, 0.04, 32), walnut, 25.4, 0.42, -8.6); mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.4, 10), walnut, 25.4, 0.2, -8.6);
box(0.5, 3, 3.4, walnut, FX - 0.35, 1.5, -15);
for (let r = 0; r < 4; r++) for (let k = 0; k < 8; k++) box(0.28, 0.45, 0.2 + rnd() * 0.1, std([0x7a4a2c, 0x2b3a5b, 0x6b2232, 0xb8962e, 0x2f4f3f][(r + k) % 5], 0.7), FX - 0.55, 0.45 + r * 0.7, -16.4 + k * 0.38, scene, false);

// ── Jason's office (NW corner): the founder's corner office, across the floor from the CIO's ──
const JO = { x1: -18.6, z1: -6.8, door: -20.6, h: 4.6 };          // x < x1, z < z1, door in its south wall at x = door
const officeLines = { pri: () => (snap?.cio?.priorities || []).map(p => p.text) };
{
  const depth = FZ + JO.z1, cz = (-FZ + JO.z1) / 2, wx = FX + JO.x1, cx = (-FX + JO.x1) / 2;
  mesh(new THREE.BoxGeometry(0.06, JO.h, depth), glass, JO.x1, JO.h / 2, cz, scene, false);
  const segW = JO.door - 1 + FX, segE = JO.x1 - JO.door - 1;
  mesh(new THREE.BoxGeometry(segW, JO.h, 0.06), glass, -FX + segW / 2, JO.h / 2, JO.z1, scene, false);
  mesh(new THREE.BoxGeometry(segE, JO.h, 0.06), glass, JO.door + 1 + segE / 2, JO.h / 2, JO.z1, scene, false);
  for (const x of [JO.x1, JO.door - 1, JO.door + 1]) box(0.1, JO.h, 0.1, mull, x, JO.h / 2, JO.z1, scene, false);
  box(0.1, 0.1, depth, mull, JO.x1, JO.h, cz, scene, false); box(wx, 0.1, 0.1, mull, cx, JO.h, JO.z1, scene, false);
  // parquet
  const pq = canvasTex(512, 512, (g, w, h) => { for (let y = 0; y < h; y += 32) for (let x = -((y / 32) % 2) * 64; x < w; x += 128) {
      const t = 0.82 + rnd() * 0.3; g.fillStyle = `rgb(${Math.round(120 * t)},${Math.round(78 * t)},${Math.round(46 * t)})`; g.fillRect(x, y, 128, 32);
      g.strokeStyle = 'rgba(30,18,8,.55)'; g.strokeRect(x + 0.5, y + 0.5, 127, 31); for (let k = 0; k < 6; k++) { g.strokeStyle = `rgba(60,36,18,${0.15 + rnd() * 0.15})`; g.beginPath(); g.moveTo(x, y + 4 + k * 5); g.lineTo(x + 128, y + 4 + k * 5 + rnd() * 2); g.stroke(); } } });
  pq.tex.wrapS = pq.tex.wrapT = THREE.RepeatWrapping; pq.tex.repeat.set(wx / 3, depth / 3);
  const pf = new THREE.Mesh(new THREE.PlaneGeometry(wx - 0.1, depth - 0.1), new THREE.MeshStandardMaterial({ map: pq.tex, roughness: 0.55, metalness: 0.05 }));
  pf.rotation.x = -Math.PI / 2; pf.position.set(cx, 0.014, cz); pf.receiveShadow = true; scene.add(pf);
  // name plaque over the door
  const plq = canvasTex(1024, 128, g => { g.clearRect(0, 0, 1024, 128); g.fillStyle = 'rgba(12,14,20,.88)'; g.beginPath(); g.roundRect(4, 4, 1016, 120, 18); g.fill();
    g.fillStyle = '#facc15'; g.font = font(54, 800); g.textAlign = 'center'; g.fillText('JASON BURMEISTER', 512, 72); g.fillStyle = '#cbd5e1'; g.font = font(28, 600); g.fillText('FOUNDER', 512, 112); });
  const pl = new THREE.Mesh(new THREE.PlaneGeometry(3.4, 0.43), new THREE.MeshBasicMaterial({ map: plq.tex, transparent: true, toneMapped: false })); pl.position.set(JO.door, JO.h - 0.5, JO.z1 + 0.05); scene.add(pl);
  // the executive desk: you sit facing the window wall, the screens face you (and the floor)
  const wal = std(0x4a2f1c, 0.4, 0.08), leather = std(0x2b1d15, 0.5, 0.05), dx = -23.3, dz = -11.6;
  const dg = new THREE.Group(); scene.add(dg);
  mesh(rbox(3.8, 0.09, 1.5, 0.03), wal, dx, 0.78, dz, dg); mesh(rbox(3.6, 0.62, 0.06, 0.02), wal, dx, 0.44, dz + 0.7, dg);
  for (const sx of [-1, 1]) mesh(rbox(0.55, 0.74, 1.3, 0.03), wal, dx + sx * 1.55, 0.37, dz, dg);
  mesh(new THREE.BoxGeometry(3.7, 0.012, 0.3), glow(0xfacc15, 0.6), dx, 0.826, dz + 0.6, dg, false);                   // brass inlay
  const jTex = canvasTex(640, 360, (c, w, h) => { c.fillStyle = '#05080f'; c.fillRect(0, 0, w, h); c.fillStyle = '#facc15'; c.font = font(26, 800); c.fillText('FOUNDER · TODAY', 22, 40);
    if (!snap) return; const C2 = snap.cio, M = snap.mydesk;
    c.fillStyle = snap.day_ret >= 0 ? '#22c55e' : '#f43f5e'; c.font = "700 46px 'JetBrains Mono'"; c.fillText(`${snap.day_ret >= 0 ? '+' : ''}${(snap.day_ret * 100).toFixed(2)}%`, 22, 100);
    c.fillStyle = '#cbd5e1'; c.font = "500 20px 'JetBrains Mono'"; c.fillText(`NAV ${snap.nav.toFixed(2)} · ${snap.positions.length} open`, 230, 96);
    c.fillText(`CIO: ${(C2?.fund?.mode || '—').toUpperCase()} · ${C2?.fund?.mult?.toFixed(2) ?? '—'}x`, 22, 140); c.fillText(`Your desk: ${M ? money(M.realized + M.upl) : '—'}`, 330, 140);
    c.fillStyle = '#94a3b8'; c.font = font(18, 700); c.fillText('PRIORITIES', 22, 186); c.fillStyle = '#e2e8f0'; c.font = font(20, 500);
    const pr = officeLines.pri(); (pr.length ? pr : ['None set: use the podium']).slice(0, 4).forEach((t, i) => c.fillText('• ' + t.slice(0, 48), 22, 216 + i * 30));
    c.fillStyle = '#94a3b8'; c.font = font(18, 700); c.fillText(`MODEL LAB: ${snap.mlab?.n_tests ?? 0} MODELS TESTED`, 22, 344); });
  const sx3 = [[-1.18, 0.28, heatTex.tex], [0, 0, jTex.tex], [1.18, -0.28, navTex.tex]];
  for (const [ox, ry, tx] of sx3) { const s = screen(1.12, 0.64, tx, dx + ox, 1.28, dz - 0.45, ry, dg, 0.03); mesh(new THREE.CylinderGeometry(0.02, 0.05, 0.42, 8), metal, dx + ox, 1.0, dz - 0.5, dg); }
  box(0.5, 0.025, 0.16, std(0x1c1f25, 0.4, 0.3), dx, 0.84, dz + 0.25, dg);
  const ch = chair(dx, dz + 1.05, dg); mesh(rbox(0.62, 0.34, 0.1, 0.04), leather, 0, 1.42, 0.31, ch);              // high-back exec chair
  clickable(dg, { type: 'office', tip: 'Your desk: run the fund from here' });
  officeLines.tex = jTex;
  // credenza under the JB TV + a bookshelf with the quant reading list
  box(4.6, 0.75, 0.55, wal, -22.4, 0.375, -FZ + 0.45);
  for (const [x, c] of [[-24.2, 0xd4a72c], [-20.7, 0x94a3b8]]) mesh(new THREE.CylinderGeometry(0.09, 0.12, 0.34, 14), std(c, 0.25, 0.9), x, 0.92, -FZ + 0.45);
  const shelf = box(0.45, 3.0, 4.6, wal, -FX + 0.3, 1.5, -13.4);
  const bk = canvasTex(1024, 640, (g, w, h) => { g.fillStyle = '#2a1a0e'; g.fillRect(0, 0, w, h);
    const cols = ['#7a2a2a', '#1f3b63', '#2f5d3a', '#6b4c1a', '#3f2a63', '#1c4f5c', '#8a6d1f', '#5a1f3b'];
    for (let r = 0; r < 4; r++) { let x = 10; const y0 = 10 + r * 158;
      g.fillStyle = '#4a2f1c'; g.fillRect(0, y0 + 140, w, 14);
      while (x < w - 30) { const bw = 22 + rnd() * 26, bh = 96 + rnd() * 40; g.fillStyle = cols[Math.floor(rnd() * cols.length)]; g.fillRect(x, y0 + 140 - bh, bw, bh);
        g.fillStyle = 'rgba(250,204,21,.55)'; g.fillRect(x + 3, y0 + 140 - bh + 10, bw - 6, 3); x += bw + 2; } } });
  const bp = new THREE.Mesh(new THREE.PlaneGeometry(4.4, 2.8), new THREE.MeshStandardMaterial({ map: bk.tex, roughness: 0.8 }));
  bp.rotation.y = Math.PI / 2; bp.position.set(-FX + 0.54, 1.5, -13.4); scene.add(bp);
  clickable(shelf, { type: 'books', tip: 'The quant reading list' }); clickable(bp, { type: 'books', tip: 'The quant reading list' });
  // sofa corner
  mesh(new THREE.BoxGeometry(2.8, 0.012, 2.4), std(0x3a2e4a, 0.95), -26.2, 0.016, -8.5, scene, false);
  box(1.0, 0.45, 2.6, leather, -27.25, 0.28, -8.5); box(0.28, 0.55, 2.6, leather, -27.7, 0.72, -8.5);
  for (const d2 of [-1.2, 1.2]) box(1.0, 0.35, 0.26, leather, -27.25, 0.62, -8.5 + d2);
  mesh(new THREE.CylinderGeometry(0.5, 0.5, 0.04, 28), wal, -25.8, 0.42, -8.5); mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.4, 8), metal, -25.8, 0.2, -8.5);
  // the founder's board (your priorities), freestanding by the east glass
  const fb = canvasTex(768, 512, (g, w, h) => { g.fillStyle = '#f5f4ef'; g.fillRect(0, 0, w, h); g.fillStyle = '#0f172a'; g.font = font(36, 800); g.fillText("FOUNDER'S BOARD", 28, 52);
    g.fillStyle = '#1d4ed8'; g.font = "600 24px 'Comic Sans MS', 'Segoe Print', cursive";
    const pr = snap ? officeLines.pri() : [];
    ['Find a REAL edge: beat random + the holdout', 'Paper first. Real money only with hard limits', 'Get the first ML model hired', ...pr.map(p => '★ ' + p)].slice(0, 8).forEach((t, i) => g.fillText(t.slice(0, 46), 28, 104 + i * 48));
    g.strokeStyle = '#dc2626'; g.lineWidth = 3; g.beginPath(); g.moveTo(560, 470); for (let x = 0; x < 180; x += 10) g.lineTo(560 + x, 470 - x * 0.9 - Math.sin(x / 15) * 14); g.stroke(); });
  const fbs = screen(2.4, 1.6, fb.tex, JO.x1 - 0.35, 1.8, -12.6, -Math.PI / 2, scene, 0.05);
  for (const z of [-13.75, -11.45]) box(0.06, 1.8, 0.06, mull, JO.x1 - 0.32, 0.9, z, scene, false);
  clickable(fbs.group, { type: 'announce', tip: "Founder's board: set the floor's priorities" });
  officeLines.board = fb;
}

// ── execution elevator (E wall) ───────────────────────────
const doorMat = new THREE.MeshStandardMaterial({ color: 0xb8bec8, roughness: 0.18, metalness: 0.95 });
const doorL = box(0.12, 2.8, 1.15, doorMat, FX + 0.05, 1.4, 2.93), doorR = box(0.12, 2.8, 1.15, doorMat, FX + 0.05, 1.4, 4.07);
box(0.2, 3.1, 0.12, mull, FX + 0.05, 1.55, 2.25); box(0.2, 3.1, 0.12, mull, FX + 0.05, 1.55, 4.75); box(0.2, 0.15, 2.65, mull, FX + 0.05, 3.05, 3.5);
const exTex = canvasTex(512, 96, g => { g.clearRect(0, 0, 512, 96); g.fillStyle = '#22c55e'; g.font = font(40, 700); g.fillText('EXECUTION ▸', 30, 62); });
const exSign = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 0.45), new THREE.MeshBasicMaterial({ map: exTex.tex, transparent: true, toneMapped: false }));
exSign.position.set(FX - 0.05, 3.4, 3.5); exSign.rotation.y = -Math.PI / 2; scene.add(exSign);
clickable(doorL, { type: 'trades', tip: 'Execution — trade blotter' }); clickable(doorR, { type: 'trades', tip: 'Execution — trade blotter' });

// ── conference room (SW, huddles) ─────────────────────────
mesh(new THREE.BoxGeometry(0.05, 3.4, FZ - 9.5), glass, -17, 1.7, (9.5 + FZ) / 2, scene, false);
box(0.08, 3.4, 0.08, mull, -17, 1.7, 9.5, scene, false); box(0.08, 0.08, FZ - 9.5, mull, -17, 3.4, (9.5 + FZ) / 2, scene, false);
const confTable = box(7.2, 0.1, 2.0, walnut, -22.5, 0.78, 13.2);
for (const x of [-25, -20]) box(0.45, 0.74, 0.45, std(0x1c1f25, 0.4, 0.7), x, 0.37, 13.2);
const confTv = screen(4.2, 2.36, navTex.tex, -FX + 0.1, 2.3, 13.2, Math.PI / 2, scene, 0.06);
clickable(confTable, { type: 'pods', tip: 'Conference room — huddles happen here' });
const meetLabel = canvasTex(512, 64, g => { g.clearRect(0, 0, 512, 64); g.fillStyle = 'rgba(255,255,255,0.35)'; g.font = font(28, 700); g.fillText('CONFERENCE ROOM', 8, 42); });
{ const p = new THREE.Mesh(new THREE.PlaneGeometry(4.8, 0.6), new THREE.MeshBasicMaterial({ map: meetLabel.tex, transparent: true, toneMapped: false })); p.rotation.x = -Math.PI / 2; p.position.set(-22.4, 0.03, 10.2); scene.add(p); }

// ── lounge by the south windows ───────────────────────────
mesh(new THREE.BoxGeometry(11, 0.012, 5.2), std(0x343a4a, 0.95), 0, 0.012, 13, scene, false);
const sofaMat = std(0x5b6170, 0.85);
for (const sx of [-1, 1]) { const x = sx * 3.6; box(1.0, 0.45, 3.0, sofaMat, x, 0.28, 13); box(0.28, 0.55, 3.0, sofaMat, x + sx * 0.45, 0.72, 13);
  for (const dz of [-1.35, 1.35]) box(1.0, 0.35, 0.28, sofaMat, x, 0.62, 13 + dz); }
box(1.6, 0.06, 1.0, walnut, 0, 0.45, 13); for (const [dx, dz] of [[-0.7, -0.4], [0.7, -0.4], [-0.7, 0.4], [0.7, 0.4]]) box(0.06, 0.42, 0.06, metal, dx, 0.21, 13 + dz);

// ── pantry, server racks, plants (W wall) ─────────────────
box(0.9, 1.0, 3.4, std(0xe8e4dc, 0.35, 0.05), -FX + 0.5, 0.5, 3.4); box(0.95, 0.06, 3.5, std(0x1b1d22, 0.2, 0.3), -FX + 0.5, 1.03, 3.4);
box(0.5, 0.6, 0.45, std(0x15171b, 0.25, 0.9), -FX + 0.5, 1.36, 2.6); box(0.8, 2.0, 0.8, std(0xcfd3d8, 0.25, 0.8), -FX + 0.5, 1.0, 6.0);
const RACK_Z = -5.1;                                                                      // racks sit between the founder's office and the west bridge
for (const dz of [-1.0, 1.0]) box(1, 3.2, 1.6, std(0x14171c, 0.35, 0.6), -FX + 0.6, 1.6, RACK_Z + dz * 0.85);
const leds = []; for (const dz of [-1.0, 1.0]) for (let i = 0; i < 14; i++) leds.push(bar(0.02, 0.04, 0.1, i % 3 ? 0x22c55e : 0x60a5fa, -FX + 1.11, 0.4 + i * 0.2, RACK_Z + dz * 0.85 + (i % 2 ? 0.45 : -0.45), 1.6));
function plant(x, z, s = 1) {
  mesh(new THREE.CylinderGeometry(0.34 * s, 0.26 * s, 0.7 * s, 24), std(0xd8d4cc, 0.6), x, 0.35 * s, z);
  const leaf = std(0x2f6b45, 0.65);
  for (let k = 0; k < 7; k++) { const a = k / 7 * Math.PI * 2; mesh(new THREE.SphereGeometry(0.28 * s, 14, 10), leaf, x + Math.cos(a) * 0.25 * s, (1.1 + rnd() * 0.5) * s, z + Math.sin(a) * 0.25 * s).scale.set(1, 1.4, 1); }
}
for (const [x, z, s] of [[-16.8, -16.2, 1.2], [16.6, -16.2, 1.2], [-FX + 0.8, 8.4, 1], [FX - 0.8, -5.2, 1], [-11.5, 16.2, 1.1], [11.5, 16.2, 1.1], [-19.4, -16.1, 1], [FX - 0.8, 8.4, 1]]) plant(x, z, s);

// ── Quant Research lab (SE) ───────────────────────────────
function wrapText(g, text, x, y, maxW, lh, maxLines) { const words = String(text).split(' '); let line = '', n = 0;
  for (const w of words) { if (g.measureText(line + w).width > maxW && line) { g.fillText(line, x, y + n * lh); line = ''; if (++n >= maxLines) return; } line += w + ' '; } g.fillText(line, x, y + n * lh); }
mesh(new THREE.BoxGeometry(0.05, 3.4, FZ - 9.5), glass, 16, 1.7, (9.5 + FZ) / 2, scene, false); box(0.08, 3.4, 0.08, mull, 16, 1.7, 9.5, scene, false); box(0.08, 0.08, FZ - 9.5, mull, 16, 3.4, (9.5 + FZ) / 2, scene, false);
const labTex = canvasTex(1024, 576, (g, w, h) => {
  g.fillStyle = '#0b0d1a'; g.fillRect(0, 0, w, h);
  g.fillStyle = '#a78bfa'; g.font = font(30, 700); g.fillText('QUANT RESEARCH · R&D LAB', 36, 56);
  const r = snap?.research;
  if (!r || !r.on) { g.fillStyle = '#8692ab'; g.font = font(30, 500); g.fillText('Ava is offline (no AI brain)', 36, 120); return; }
  const status = { idle: `Idle · next session in ${Math.ceil(r.next_in / 60)} min`, thinking: 'Ava is thinking…', idea: 'New idea on the board', backtesting: 'Backtesting…', verdict: 'Verdict', 'loading history': 'Loading history…' }[r.status] || r.status;
  g.fillStyle = '#e6ebf5'; g.font = font(30, 600); g.fillText(status, 36, 108);
  if (r.current) { g.fillStyle = '#ffffff'; g.font = font(34, 700); g.fillText(`“${r.current.name}”`.slice(0, 44), 36, 168); g.fillStyle = '#8692ab'; g.font = font(24, 500); wrapText(g, `${r.current.family} · ${r.current.desc} · ${(r.current.markets || []).join(', ')}`, 36, 204, 950, 32, 2); }
  g.fillStyle = '#8692ab'; g.font = font(22, 700); g.fillText('RECENT RESULTS', 36, 300);
  (r.log || []).slice(-5).reverse().forEach((e, i) => { const y = 344 + i * 44;
    g.fillStyle = e.passed ? '#22c55e' : '#f43f5e'; g.font = font(22, 700); g.fillText(e.tune ? (e.passed ? 'UPGR' : 'KEEP') : (e.passed ? 'PASS' : 'FAIL'), 36, y);
    g.fillStyle = '#e6ebf5'; g.font = font(24, 500); g.fillText(e.name.slice(0, 34), 120, y);
    g.fillStyle = '#c9d1e4'; g.font = "500 22px 'JetBrains Mono'"; g.fillText(`OOS PF ${e.oos.pf.toFixed(2)}  ${(e.oos.ret * 100).toFixed(1)}%`, 640, y); });
});
const labScreen = screen(5.2, 2.92, labTex.tex, FX - 0.1, 2.7, 12.2, -Math.PI / 2, scene, 0.06);
clickable(labScreen.group, { type: 'lab', tip: 'R&D lab — research log' });
// the Quant Toolbox board: the CIO's risk dial for every pod (Monte Carlo, robustness, crisis tests)
const tbTex = canvasTex(1024, 576, (g, w, h) => {
  g.fillStyle = '#07101a'; g.fillRect(0, 0, w, h);
  g.fillStyle = '#22d3ee'; g.font = font(30, 700); g.fillText('QUANT TOOLBOX · CIO RISK DIALS', 36, 56);
  const D = snap?.toolbox?.dials || {}, P = snap?.toolbox?.pods || {}, ids = Object.keys(D).sort((a, b) => D[b].risk - D[a].risk);
  if (!ids.length) { g.fillStyle = '#8692ab'; g.font = font(26, 500); g.fillText(snap?.toolbox?.running ? 'Running thousands of simulated years…' : 'Waiting for the first Monte Carlo run', 36, 120); return; }
  g.fillStyle = '#8692ab'; g.font = font(18, 700); g.fillText('RISK PER TRADE', 300, 96); g.fillText('STOP-OUT ODDS', 640, 96); g.fillText('ROBUST', 860, 96);
  const hi = Math.max(0.02, ...ids.map(i => D[i].risk));
  ids.slice(0, 7).forEach((id, k) => { const d = D[id], y = 146 + k * 60;
    g.fillStyle = COLORS[id] || '#fff'; g.fillRect(36, y - 28, 8, 38); g.fillStyle = '#e6ebf5'; g.font = font(30, 700); g.fillText(P[id]?.name || id, 56, y);
    g.fillStyle = '#1e2840'; g.fillRect(300, y - 20, 240, 16); g.fillStyle = '#22d3ee'; g.fillRect(300, y - 20, 240 * d.risk / hi, 16);
    g.fillStyle = '#e6ebf5'; g.font = "600 24px 'JetBrains Mono'"; g.fillText(`${(d.risk * 100).toFixed(1)}%`, 552, y - 4);
    g.fillStyle = d.p_ruin > 0.15 ? '#f43f5e' : '#c9d1e4'; g.fillText(`${(d.p_ruin * 100).toFixed(0)}%/yr`, 640, y - 4);
    const rb = P[id]?.robust?.score ?? 0; g.fillStyle = rb >= 0.75 ? '#22c55e' : rb >= 0.5 ? '#f59e0b' : '#f43f5e'; g.fillText(`${Math.round(rb * 100)}%`, 860, y - 4); });
});
const tbScreen = screen(5.6, 3.15, tbTex.tex, 15.95, 2.6, 13.2, -Math.PI / 2, scene, 0.06);
clickable(tbScreen.group, { type: 'lab', tip: 'Quant toolbox — risk dials & Monte Carlo' });
const wbTex = canvasTex(1024, 512, (g, w, h) => { g.fillStyle = '#f4f4f0'; g.fillRect(0, 0, w, h); g.strokeStyle = '#1d4ed8'; g.fillStyle = '#1d4ed8'; g.lineWidth = 3;
  g.font = "500 30px 'JetBrains Mono'"; ['PF = Σwins / Σlosses  ≥ 1.2', 'risk = min(k·Kelly, ruin cap)', 'P(stop-out) ≤ 20%·k per year', 'VRP = IV / RV', 'edge × 0.5 (haircut)'].forEach((t, i) => g.fillText(t, 30, 60 + i * 52));
  g.strokeStyle = '#dc2626'; g.beginPath(); g.moveTo(600, 420); for (let x = 0; x < 360; x += 12) g.lineTo(600 + x, 420 - x * 0.6 - Math.sin(x / 20) * 30); g.stroke(); });
const wb = screen(3.4, 1.7, wbTex.tex, 24.6, 1.75, 10.2, Math.PI, scene, 0.05);                 // freestanding, facing the trading floor
for (const x of [23.05, 26.15]) box(0.06, 1.75, 0.06, mull, x, 0.87, 10.15, scene, false);
clickable(wb.group, { type: 'lab', tip: 'Research whiteboard' });
const labDesk = box(2.6, 0.08, 1.2, std(0xdfe2e7, 0.3, 0.3), 21.5, 0.78, 12.8);
box(2.3, 0.72, 0.9, std(0x2a2e35, 0.4, 0.6), 21.5, 0.38, 12.8);
const racks = [];
for (const rz of [15.1, 16.3]) { box(0.9, 3, 1.15, std(0x14171c, 0.35, 0.6), FX - 0.55, 1.5, rz);          // compute racks on the east wall
  for (let i = 0; i < 12; i++) racks.push(bar(0.02, 0.03, 0.9, i % 2 ? VIOLET : 0x60a5fa, FX - 1.02, 0.35 + i * 0.22, rz, 1.6)); }
clickable(labDesk, { type: 'lab', tip: 'Backtest station' });
let testingUntil = 0;

// ── trading desks: 2x2 monitor arms, phone turret, keyboard, chair ──
function chartTex(seedN) { return canvasTex(256, 160, (g, w, h) => {
  g.fillStyle = '#05080f'; g.fillRect(0, 0, w, h); g.strokeStyle = 'rgba(255,255,255,.06)';
  for (let y = 20; y < h; y += 28) { g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke(); }
  if (seedN % 4 === 1) { g.font = "500 15px 'JetBrains Mono'"; for (let i = 0; i < 8; i++) { g.fillStyle = '#8a96ad'; g.fillText(['BTC', 'ETH', 'SOL', 'SPY', 'NVDA', 'MNQ', 'MGC', 'VIX'][i], 10, 20 + i * 18); g.fillStyle = Math.random() > 0.5 ? '#22c55e' : '#f43f5e'; g.fillText((Math.random() * 2 - 1).toFixed(2) + '%', 150, 20 + i * 18); } return; }
  let y = h / 2, o = y; const cw = 9;
  for (let x = 6; x < w - 6; x += cw) { const c = Math.max(14, Math.min(h - 14, o + (Math.random() - 0.48) * 22)); g.fillStyle = g.strokeStyle = c < o ? '#22c55e' : '#f43f5e';
    g.fillRect(x, Math.min(o, c), cw - 3, Math.max(2, Math.abs(c - o))); g.beginPath(); g.moveTo(x + 3, Math.min(o, c) - 5); g.lineTo(x + 3, Math.max(o, c) + 5); g.stroke(); o = c; }
}); }
const monTexs = [0, 1, 2, 3, 4, 5].map(chartTex);
// a Bloomberg-style terminal page (amber on black) for the middle screen of every PM desk
const bbgTex = canvasTex(256, 160, (g, w, h) => { g.fillStyle = '#000'; g.fillRect(0, 0, w, h);
  g.fillStyle = '#ff9f1a'; g.font = "700 13px 'JetBrains Mono', monospace"; g.fillText('JB <GO>  MONITOR', 6, 14); g.fillStyle = '#3b82f6'; g.fillRect(0, 18, w, 2);
  const m = snap ? Object.entries(snap.markets).slice(0, 9) : [];
  m.forEach(([s, v], i) => { const y = 34 + i * 14; g.fillStyle = '#ffb000'; g.font = "500 11px 'JetBrains Mono', monospace"; g.fillText(s.padEnd(5), 6, y);
    g.fillStyle = '#e5e7eb'; g.fillText(fmtPx(v.px).padStart(9), 52, y); g.fillStyle = v.chg >= 0 ? '#22c55e' : '#f43f5e'; g.fillText(`${v.chg >= 0 ? '+' : ''}${(v.chg * 100).toFixed(2)}%`, 150, y); });
  if (!m.length) { g.fillStyle = '#ffb000'; g.font = "500 12px 'JetBrains Mono'"; g.fillText('CONNECTING…', 6, 40); } });
function chair(x, z, parent) {
  const g = new THREE.Group(); g.position.set(x, 0, z); parent.add(g);
  mesh(rbox(0.6, 0.1, 0.58, 0.04), chairMat, 0, 0.5, 0, g); mesh(rbox(0.56, 0.7, 0.07, 0.05), chairMat, 0, 0.95, 0.3, g);
  for (const sx of [-1, 1]) mesh(rbox(0.05, 0.05, 0.4, 0.02), chairMat, sx * 0.32, 0.68, 0.02, g);
  mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.42, 10), metal, 0, 0.27, 0, g);
  for (let k = 0; k < 5; k++) { const a = k / 5 * Math.PI * 2, leg = mesh(new THREE.BoxGeometry(0.04, 0.03, 0.34), metal, Math.sin(a) * 0.15, 0.05, Math.cos(a) * 0.15, g); leg.rotation.y = a; }
  return g;
}
function desk(seat, accent, big = false, trading = false) {
  const [x, z] = seat, wide = big ? 3.2 : 2.5, dz = z - 0.95;          // the robot faces -z, the desk is in front of it
  const g = new THREE.Group(); scene.add(g);
  mesh(rbox(wide, 0.06, 1.0, 0.02), std(big ? 0x4a2f1c : 0xd9dbe0, 0.4, 0.05), x, 0.76, dz, g);
  for (const sx of [-1, 1]) box(0.06, 0.74, 0.9, std(0x2b2f36, 0.4, 0.7), x + sx * (wide / 2 - 0.05), 0.37, dz, g);
  box(wide - 0.2, 0.4, 0.03, std(0x2b2f36, 0.4, 0.7), x, 0.5, dz - 0.46, g);
  if (!big && trading) {                                                // a trading desk: 2 x 3 screens, a terminal in the middle
    for (const sx of [-0.62, 0.62]) mesh(new THREE.CylinderGeometry(0.025, 0.025, 1.0, 8), metal, x + sx, 1.27, dz - 0.36, g);
    mesh(new THREE.BoxGeometry(1.9, 0.04, 0.04), metal, x, 1.74, dz - 0.36, g);
    let k = Math.floor(Math.abs(x * 7 + z * 3)) % 6;
    for (const [mx, my] of [[-0.62, 1.08], [0, 1.08], [0.62, 1.08], [-0.62, 1.5], [0, 1.5], [0.62, 1.5]]) {
      const s = screen(0.58, 0.36, mx === 0 && my > 1.2 ? bbgTex.tex : monTexs[k++ % 6].tex, x + mx, my, dz - 0.3 + Math.abs(mx) * 0.1, 0, g, 0.025);
      s.group.rotation.y = mx < 0 ? 0.28 : mx > 0 ? -0.28 : 0;
    }
  } else if (!big) {                                                    // 2x2 monitor bank on a pole
    mesh(new THREE.CylinderGeometry(0.025, 0.025, 1.0, 8), metal, x, 1.27, dz - 0.35, g);
    let k = Math.floor(Math.abs(x * 7 + z * 3)) % 6;
    for (const [mx, my] of [[-0.31, 1.08], [0.31, 1.08], [-0.31, 1.5], [0.31, 1.5]]) {
      const s = screen(0.56, 0.36, monTexs[k++ % 6].tex, x + mx, my, dz - 0.3, Math.PI + (mx < 0 ? 0.12 : -0.12), g, 0.025);
      s.group.rotation.y = mx < 0 ? 0.12 : -0.12;   // screens face the robot (+z) — and the camera
    }
  } else { screen(0.9, 0.52, monTexs[2].tex, x - 0.5, 1.15, dz - 0.25, 0.1, g, 0.03); screen(0.9, 0.52, monTexs[3].tex, x + 0.5, 1.15, dz - 0.25, -0.1, g, 0.03); }
  box(0.5, 0.025, 0.16, std(0x1c1f25, 0.4, 0.3), x - 0.05, 0.8, dz + 0.25, g);                   // keyboard
  box(0.22, 0.05, 0.18, std(0x1c1f25, 0.4, 0.3), x + 0.55, 0.81, dz + 0.15, g);                 // phone turret
  mesh(new THREE.BoxGeometry(0.18, 0.012, 0.12), glow(accent, 0.9), x + 0.55, 0.84, dz + 0.15, g, false);
  if (rnd() < 0.6) mesh(new THREE.CylinderGeometry(0.05, 0.04, 0.12, 14), std(0xf2f2f2, 0.4), x - 0.75, 0.85, dz + 0.2, g);
  if (!big) { mesh(new THREE.BoxGeometry(0.22, 0.02, 0.3), std([0x1e3a8a, 0x7f1d1d, 0x14532d, 0x422006][Math.floor(rnd() * 4)], 0.7), x + 0.95, 0.8, dz + 0.22, g);          // notebook
    if (rnd() < 0.5) mesh(new THREE.TorusGeometry(0.09, 0.022, 8, 18, Math.PI).rotateX(-Math.PI / 2), std(0x111318, 0.4, 0.6), x - 0.42, 0.81, dz + 0.32, g); }      // headphones
  chair(x, z + 0.25, g);
  return g;
}
for (const d of STAFF) { if (d.id === 'ari') continue; const g = desk(d.seat, d.accent, d.id === 'boss'); if (d.id === 'boss') clickable(g, { type: 'cio', tip: 'CIO desk: the CIO console' }); }
for (const id of Object.keys(FOUNDER_LOOK)) desk(FOUNDER_LOOK[id].seat, FOUNDER_LOOK[id].accent, false, true);
{ const t = canvasTex(512, 96, g => { g.clearRect(0, 0, 512, 96); g.fillStyle = 'rgba(232,121,249,.95)'; g.font = font(40, 800); g.fillText('COMPLIANCE', 120, 62); });   // Lena's desk sign
  const p = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 0.3), new THREE.MeshBasicMaterial({ map: t.tex, transparent: true, toneMapped: false })); p.position.set(15.5, 2.15, STAFF_Z - 1.2); scene.add(p); }       // spare desks (screens running, nobody seated)
const openSigns = HIRE_SEATS.map(s => {
  desk(s, 0x34d399, false, true);
  const t = canvasTex(512, 96, g => { g.clearRect(0, 0, 512, 96); g.fillStyle = 'rgba(52,211,153,.95)'; g.font = font(40, 700); g.fillText('OPEN SEAT', 140, 62); });
  const p = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 0.3), new THREE.MeshBasicMaterial({ map: t.tex, transparent: true, toneMapped: false }));
  p.position.set(s[0], 2.15, s[1] - 1.2); scene.add(p); return p;
});

// ── humanoid trading robots ───────────────────────────────
const cap = (r, l) => new THREE.CapsuleGeometry(r, l, 6, 16);
const shellMat = new THREE.MeshPhysicalMaterial({ color: 0xeef1f6, roughness: 0.25, metalness: 0.15, clearcoat: 1, clearcoatRoughness: 0.15 });
const jointMat = std(0x23272f, 0.35, 0.85), darkMat = std(0x14161b, 0.4, 0.6);
function faceTex(accent) {
  const t = canvasTex(160, 112, () => {});
  t.state = '';
  t.set = (mood, blink, talk) => {
    const key = mood + blink + talk; if (key === t.state) return; t.state = key;
    const g = t.g, c = hex(accent); g.fillStyle = '#04070d'; g.fillRect(0, 0, 160, 112); g.fillStyle = c; g.strokeStyle = c; g.lineWidth = 7; g.lineCap = 'round';
    const eye = (x) => {
      if (blink) { g.beginPath(); g.moveTo(x - 14, 46); g.lineTo(x + 14, 46); g.stroke(); return; }
      if (mood === 'happy') { g.beginPath(); g.arc(x, 52, 14, Math.PI * 1.1, Math.PI * 1.9); g.stroke(); return; }
      if (mood === 'sad') { g.beginPath(); g.moveTo(x - 14, x < 80 ? 38 : 48); g.lineTo(x + 14, x < 80 ? 48 : 38); g.stroke(); g.beginPath(); g.arc(x, 56, 7, 0, 7); g.fill(); return; }
      if (mood === 'think' && x > 80) { g.beginPath(); g.arc(x, 46, 7, 0, 7); g.fill(); return; }
      g.beginPath(); g.ellipse(x, 46, 11, 14, 0, 0, 7); g.fill();
    };
    eye(52); eye(108);
    if (talk) { g.beginPath(); g.ellipse(80, 86, 14, talk === 1 ? 9 : 4, 0, 0, 7); g.fill(); }
    else if (mood === 'happy') { g.beginPath(); g.arc(80, 76, 18, 0.2, Math.PI - 0.2); g.stroke(); }
    else if (mood === 'sad') { g.beginPath(); g.arc(80, 98, 16, Math.PI + 0.3, -0.3); g.stroke(); }
    else if (mood === 'think') { for (const dx of [-14, 0, 14]) { g.beginPath(); g.arc(80 + dx, 88, 4, 0, 7); g.fill(); } }
    else { g.beginPath(); g.moveTo(68, 88); g.lineTo(92, 88); g.stroke(); }
    t.tex.needsUpdate = true;
  };
  return t;
}
function badgeTex(n, accent) { return canvasTex(128, 96, g => { g.fillStyle = '#f7f7f2'; g.fillRect(0, 0, 128, 96); g.fillStyle = hex(accent); g.fillRect(0, 0, 128, 26);
  g.fillStyle = '#111'; g.font = "800 52px 'JetBrains Mono'"; g.fillText(String(n).padStart(2, '0'), 30, 80); }); }
function robot(d) {
  const root = new THREE.Group(), jacket = std(d.jacket, 0.75, 0.02), acc = glow(d.accent, 1.6);
  const pelvis = new THREE.Group(); pelvis.position.y = 0.92; root.add(pelvis);
  mesh(rbox(0.38, 0.16, 0.24, 0.07), jointMat, 0, 0, 0, pelvis);
  const leg = sx => { const hip = new THREE.Group(); hip.position.set(sx * 0.12, -0.04, 0); pelvis.add(hip);
    mesh(cap(0.085, 0.3), d.suit ? jacket : shellMat, 0, -0.22, 0, hip); const knee = new THREE.Group(); knee.position.y = -0.44; hip.add(knee);
    mesh(new THREE.SphereGeometry(0.075, 14, 10), jointMat, 0, 0, 0, knee); mesh(cap(0.075, 0.3), shellMat, 0, -0.22, 0, knee);
    mesh(rbox(0.16, 0.08, 0.3, 0.035), darkMat, 0, -0.44, 0.06, knee); return { hip, knee }; };
  const L = leg(-1), R = leg(1);
  const torso = new THREE.Group(); torso.position.y = 0.08; pelvis.add(torso);
  mesh(new THREE.CylinderGeometry(0.13, 0.15, 0.16, 16), jointMat, 0, 0.1, 0, torso);
  const chest = mesh(cap(0.25, 0.26), jacket, 0, 0.42, 0, torso); chest.scale.set(1.05, 1, 0.75);
  mesh(rbox(0.16, 0.3, 0.05, 0.03), shellMat, 0, 0.46, 0.17, torso);                                    // chest plate (shirt)
  if (d.suit) mesh(rbox(0.06, 0.26, 0.02, 0.01), std(0x8a1c2b, 0.5), 0, 0.44, 0.2, torso);
  const badge = new THREE.Mesh(new THREE.PlaneGeometry(0.13, 0.1), new THREE.MeshBasicMaterial({ map: badgeTex(d.badge, d.accent).tex }));
  badge.position.set(0.16, 0.5, 0.2); badge.rotation.y = 0.25; torso.add(badge);
  const core = mesh(new THREE.CircleGeometry(0.035, 20), acc, -0.15, 0.52, 0.2, torso, false); core.rotation.y = -0.25;
  const arm = sx => { const sh = new THREE.Group(); sh.position.set(sx * 0.33, 0.6, 0); torso.add(sh);
    mesh(new THREE.SphereGeometry(0.1, 16, 12), jacket, 0, 0, 0, sh); mesh(cap(0.07, 0.22), jacket, 0, -0.18, 0, sh);
    const el = new THREE.Group(); el.position.y = -0.36; sh.add(el); mesh(new THREE.SphereGeometry(0.06, 12, 10), jointMat, 0, 0, 0, el);
    mesh(cap(0.058, 0.22), shellMat, 0, -0.17, 0, el); mesh(rbox(0.1, 0.12, 0.06, 0.03), jointMat, 0, -0.36, 0.01, el); return { sh, el }; };
  const AL = arm(-1), AR = arm(1);
  mesh(new THREE.CylinderGeometry(0.055, 0.065, 0.12, 12), jointMat, 0, 0.76, 0, torso);
  const head = new THREE.Group(); head.position.y = 0.98; torso.add(head);
  const skull = mesh(new THREE.SphereGeometry(0.22, 32, 24), shellMat, 0, 0, 0, head); skull.scale.set(1.05, 1.0, 1.0);
  const fT = faceTex(d.accent);
  const face = new THREE.Mesh(rbox(0.3, 0.2, 0.04, 0.05), [darkMat, darkMat, darkMat, darkMat, new THREE.MeshBasicMaterial({ map: fT.tex, toneMapped: false }), darkMat]);
  face.position.set(0, -0.01, 0.19); head.add(face);
  for (const sx of [-1, 1]) { mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.05, 20), jointMat, sx * 0.225, 0, 0, head).rotation.z = Math.PI / 2; mesh(new THREE.CircleGeometry(0.035, 16), acc, sx * 0.252, 0, 0, head, false).rotation.y = sx * Math.PI / 2; }
  let tip = null;
  if (d.headset) { mesh(new THREE.TorusGeometry(0.235, 0.015, 8, 32, Math.PI), jointMat, 0, 0.02, 0, head); tip = mesh(new THREE.SphereGeometry(0.02, 8, 8), glow(0x22c55e, 2), -0.17, -0.15, 0.18, head, false);
    mesh(new THREE.CylinderGeometry(0.01, 0.01, 0.2, 6), jointMat, -0.21, -0.1, 0.1, head).rotation.x = 1.2; }
  if (d.id === 'rex') tip = mesh(new THREE.SphereGeometry(0.05, 12, 10), glow(0xf59e0b, 2.2), 0, 0.24, 0, head, false);
  if (d.id === 'ava' || d.id === 'opal') { tip = mesh(new THREE.TorusGeometry(0.2, 0.012, 8, 40), acc, 0, 0.3, 0, head, false); tip.rotation.x = Math.PI / 2; }
  const carry = new THREE.Group(); carry.position.set(0, -0.42, 0.12); AR.el.add(carry);
  mesh(rbox(0.26, 0.34, 0.02, 0.01), darkMat, 0, 0, 0, carry); const cs = new THREE.Mesh(new THREE.PlaneGeometry(0.22, 0.29), new THREE.MeshBasicMaterial({ map: monTexs[0].tex, toneMapped: false })); cs.position.z = 0.011; carry.add(cs);
  carry.visible = false;
  root.traverse(o => { if (o.isMesh && o.material?.toneMapped !== false) o.castShadow = true; });
  root.scale.setScalar(1.05);
  scene.add(root);
  return { root, pelvis, L, R, torso, AL, AR, head, faceScr: fT, tip, carry, core };
}

function podStation(a) {
  const rug = new THREE.Mesh(new THREE.PlaneGeometry(3.4, 2.9), new THREE.MeshBasicMaterial({ color: a.accent, transparent: true, opacity: 0.13, depthWrite: false }));
  rug.rotation.x = -Math.PI / 2; rug.position.set(a.seat[0], 0.02, a.seat[1] - 0.45); scene.add(rug);
  const t = canvasTex(512, 150, (g, w, h) => {
    const p = snap?.roster?.find(r => r.id === a.id); g.clearRect(0, 0, w, h);
    g.fillStyle = 'rgba(6,10,18,.82)'; g.beginPath(); g.roundRect(4, 4, w - 8, h - 8, 22); g.fill();
    g.fillStyle = hex(a.accent); g.fillRect(4, 26, 8, h - 52);
    g.fillStyle = '#ffffff'; g.font = font(44, 800); g.fillText(a.name, 30, 58);
    if (!p) return;
    g.fillStyle = p.pnl >= 0 ? '#22c55e' : '#f43f5e'; g.font = "700 40px 'JetBrains Mono'"; g.textAlign = 'right'; g.fillText(money(p.pnl), w - 24, 58); g.textAlign = 'left';
    g.fillStyle = '#9aa6bf'; g.font = "500 28px 'JetBrains Mono'";
    if (crownOwner === a.id) { g.fillStyle = '#facc15'; g.font = font(26, 800); g.fillText('★ PM OF THE WEEK', 30, 112); return; }
    const cw = snap?.cio?.watch?.[a.id], cs = snap?.cio?.star?.[a.id];
    if (cw || cs) { g.fillStyle = cw ? '#fbbf24' : '#facc15'; g.font = font(26, 800); g.fillText(cw ? '⚠ ON WATCH · half size' : '★ STAR · 1.15x', 30, 112); return; }
    g.fillText(`${p.status === 'active' ? '' : p.status.toUpperCase() + ' · '}capital ${(p.alloc * 100).toFixed(0)}% · risk ${p.risk == null ? '—' : (p.risk * 100).toFixed(1) + '%'}`, 30, 112);
  });
  const sign = new THREE.Mesh(new THREE.PlaneGeometry(2.05, 0.6), new THREE.MeshBasicMaterial({ map: t.tex, transparent: true, toneMapped: false, depthWrite: false }));
  sign.position.set(a.seat[0], 2.6, a.seat[1] - 1.35); scene.add(sign);
  a.station = { rug, sign, tex: t };
}
function addAgent(d, spawnAtDoor = false) {
  const parts = robot(d); batchRobot(parts);
  const a = { ...d, ...parts, x: spawnAtDoor ? POI.exchange.x : d.seat[0], z: spawnAtDoor ? POI.exchange.z : d.seat[1], seated: !spawnAtDoor,
    path: [], queue: [], busy: false, run: false, speed: d.id === 'boss' ? 1.8 : 2.2, speedVar: 0.86 + Math.random() * 0.28, moodName: 'focused', headYaw: 0, phase: Math.random() * 6, bubble: null, said: [],
    hidden: false, mood: 'neutral', moodUntil: 0, glowUntil: 0, swivelUntil: 0, nextIdle: performance.now() + 12000 + Math.random() * 30000 };
  a.label = document.createElement('div'); a.label.className = 'label'; a.label.textContent = d.name; overlay.appendChild(a.label);
  a.bubbleEl = document.createElement('div'); a.bubbleEl.className = 'bubble'; a.bubbleEl.style.display = 'none'; overlay.appendChild(a.bubbleEl);
  clickable(a.root, { type: 'agent', id: d.id, tip: `${d.name} — ${d.role}` });
  agents[d.id] = a; COLORS[d.id] = hex(d.accent);
  if (d.seat[1] === PM_Z) podStation(a);
  if (spawnAtDoor) act(d.id, fx(b => feel(b, 'happy', 5000)), anim('wave', 1800), say('Hi team, new PM reporting for duty.', 2600), home());
  return a;
}
function removeAgent(id) {
  const a = agents[id]; if (!a) return;
  scene.remove(a.root); a.label.remove(); a.bubbleEl.remove();
  if (a.station) { scene.remove(a.station.rug, a.station.sign); a.station.tex.tex.dispose(); }
  const i = clickables.indexOf(a.root); if (i >= 0) clickables.splice(i, 1);
  delete agents[id]; if (selected === id) selected = null;
}
const feel = (a, mood, ms = 5000) => { if (a) { a.mood = mood; a.moodUntil = performance.now() + ms; } };
STAFF.forEach(d => addAgent(d));
window.__jb = { agents, route: (from, to) => routeTo({ seated: false, x: from[0], z: from[1] }, { x: to[0], z: to[1] }).map(p => [+p.x.toFixed(1), +p.z.toFixed(1)]) };                                          // read-only handle for headless checks

// ── JB VENTURES: the venture-studio tower next door ───────
const SX = 62, SZ = -2, SW = 26, SD = 16;                          // studio penthouse: same floor height as the trading floor
const STUDIO_STAFF = [
  { id: 'iris', name: 'Iris', role: 'Idea scout (JB Ventures)',          seat: [SX - 7, SZ + 2.2], accent: 0x34d399, jacket: 0x1d5e43, badge: 101 },
  { id: 'theo', name: 'Theo', role: 'Market analyst · web research',     seat: [SX, SZ + 2.2],     accent: 0x60a5fa, jacket: 0x1e4f8a, badge: 102, headset: true },
  { id: 'rosa', name: 'Rosa', role: 'Managing partner (JB Ventures)',    seat: [SX + 7, SZ + 2.2], accent: 0xf472b6, jacket: 0x14181f, badge: 100, suit: true },
];
const STUDIO_IDS = new Set(STUDIO_STAFF.map(d => d.id));
{
  tower(SX, SZ, SW + 4, SD + 6, 'studio');
  const wood = canvasTex(512, 512, (g, w, h) => { g.fillStyle = '#b08a64'; g.fillRect(0, 0, w, h);
    for (let i = 0; i < 16; i++) { g.fillStyle = i % 2 ? 'rgba(90,60,35,.18)' : 'rgba(255,240,220,.08)'; g.fillRect(0, i * 32, w, 31); g.fillStyle = 'rgba(60,40,20,.35)'; g.fillRect(0, i * 32 + 31, w, 1); } });
  wood.tex.wrapS = wood.tex.wrapT = THREE.RepeatWrapping; wood.tex.repeat.set(3, 2);
  const fl = new THREE.Mesh(new THREE.PlaneGeometry(SW, SD), new THREE.MeshStandardMaterial({ map: wood.tex, roughness: 0.55 }));
  fl.rotation.x = -Math.PI / 2; fl.position.set(SX, 0.005, SZ); fl.receiveShadow = true; scene.add(fl); groundLayer(fl, 1);
  box(SW + 0.4, 0.4, SD + 0.4, std(0x2a2d33, 0.7, 0.2), SX, -0.2, SZ);                                       // slab
  roofSlabs.studio = box(SW + 0.4, 0.3, SD + 0.4, soffit, SX, 5.6, SZ, scene, false);                                           // roof
  for (const [w, d, x, z] of [[SW, 0.05, SX, SZ - SD / 2], [SW, 0.05, SX, SZ + SD / 2], [0.05, SD / 2 - SZ + AISLE - 1.6, SX - SW / 2, (SZ - SD / 2 + AISLE - 1.6) / 2], [0.05, SZ + SD / 2 - AISLE - 1.6, SX - SW / 2, (SZ + SD / 2 + AISLE + 1.6) / 2], [0.05, SD / 2 - SZ + AISLE - 1.6, SX + SW / 2, (SZ - SD / 2 + AISLE - 1.6) / 2], [0.05, SZ + SD / 2 - AISLE - 1.6, SX + SW / 2, (SZ + SD / 2 + AISLE + 1.6) / 2]]) {
    mesh(new THREE.BoxGeometry(w, 5.4, d), glass, x, 2.8, z, scene, false);                                   // glass walls
    const n = Math.round(Math.max(w, d) / 3.2);
    for (let i = 0; i <= n; i++) box(w > d ? 0.08 : 0.08, 5.4, w > d ? 0.08 : 0.08, mull, w > d ? x - w / 2 + i * w / n : x, 2.7, w > d ? z : z - d / 2 + i * d / n, scene, false);
  }
  for (const x of [SX - 8, SX, SX + 8]) mesh(new THREE.BoxGeometry(5, 0.05, 1.2), glow(0xfff1dc, 1.6), x, 5.42, SZ + 1, scene, false);   // light panels (no extra lights: they slow every frame)
  const vSign = canvasTex(1024, 192, (g) => { g.clearRect(0, 0, 1024, 192); g.fillStyle = '#ffffff'; g.font = font(110, 800); g.fillText('JB VENTURES', 30, 135); });
  const vp = new THREE.Mesh(new THREE.PlaneGeometry(17, 3.2), new THREE.MeshBasicMaterial({ map: vSign.tex, transparent: true, toneMapped: false }));
  vp.position.set(SX, -6.5, SZ + SD / 2 + 3.45); scene.add(vp);
  const rp = vp.clone(); rp.scale.setScalar(0.7); rp.position.set(SX, 6.9, SZ - SD / 2 + 0.3); scene.add(rp);   // rooftop sign at the back    // rooftop sign
  for (const d of STUDIO_STAFF) desk(d.seat, d.accent, d.id === 'rosa');
  // round meeting table + whiteboard of rules
  mesh(new THREE.CylinderGeometry(1.3, 1.3, 0.06, 40), walnut, SX, 0.76, SZ + 5.6); mesh(new THREE.CylinderGeometry(0.12, 0.25, 0.74, 16), metal, SX, 0.37, SZ + 5.6);
  for (let i = 0; i < 5; i++) { const a = i / 5 * Math.PI * 2; chair(SX + Math.cos(a) * 1.9, SZ + 5.6 + Math.sin(a) * 1.9, scene); }
  plant(SX - SW / 2 + 1, SZ + SD / 2 - 1, 1.2); plant(SX + SW / 2 - 1, SZ + SD / 2 - 1, 1.2); plant(SX - SW / 2 + 1, SZ - SD / 2 + 1.2, 1);
  clickable(fl, { type: 'studio', tip: 'JB Ventures: the venture studio' });
}
// the pipeline board: every idea, its score and verdict
const VCOL = { GREENLIT: '#34d399', WATCHLIST: '#fbbf24', KILLED: '#f87171' };
const pipeTex = canvasTex(1600, 720, (g, w, h) => {
  g.fillStyle = '#0b0f17'; g.fillRect(0, 0, w, h);
  g.fillStyle = '#e5e7eb'; g.font = font(40, 800); g.fillText('JB VENTURES · IDEA PIPELINE', 36, 62);
  const st = snap?.studio, P = (st?.pipeline || []).slice().reverse();
  g.font = font(24, 500); g.fillStyle = '#94a3b8';
  g.fillText(st ? `${st.status === 'idle' ? 'next session in ' + Math.ceil((st.next_in || 0) / 60) + ' min' : st.status.toUpperCase() + '…'}  ·  greenlit ${st.counts?.GREENLIT || 0}  ·  watchlist ${st.counts?.WATCHLIST || 0}  ·  killed ${st.counts?.KILLED || 0}` : 'waiting for the studio…', 36, 102);
  const cols = [['IN RESEARCH', x => !x.verdict], ['GREENLIT', x => x.verdict === 'GREENLIT'], ['WATCHLIST', x => x.verdict === 'WATCHLIST'], ['KILLED', x => x.verdict === 'KILLED']];
  cols.forEach(([name, f], c) => {
    const x0 = 36 + c * 390; g.fillStyle = c ? VCOL[name] : '#7c8cff'; g.font = font(26, 800); g.fillText(name, x0, 152);
    P.filter(f).slice(0, 5).forEach((it, i) => { const y = 172 + i * 104;
      g.fillStyle = '#151b27'; g.fillRect(x0, y, 370, 92); g.fillStyle = c ? VCOL[name] : '#7c8cff'; g.fillRect(x0, y, 6, 92);
      g.fillStyle = '#f1f5f9'; g.font = font(26, 700); g.fillText(String(it.name).slice(0, 22), x0 + 18, y + 34);
      if (it.total != null) { g.font = font(26, 800); g.textAlign = 'right'; g.fillText(`${it.total}`, x0 + 356, y + 34); g.textAlign = 'left'; }
      g.fillStyle = '#94a3b8'; g.font = font(19, 500); wrapText(g, it.one_liner || '', x0 + 18, y + 60, 340, 22, 2); });
  });
});
const pipeBoard = screen(10.5, 4.7, pipeTex.tex, SX, 2.75, SZ - SD / 2 + 0.25, 0, scene, 0.08);
clickable(pipeBoard.group || pipeBoard, { type: 'studio', tip: 'Idea pipeline: open the Ventures tab' });
STUDIO_STAFF.forEach(d => addAgent(d));
// ── THE WIRE: a glass sky bridge between the towers + the city message board ──
const BR_X0 = FX + 0.3, BR_X1 = SX - SW / 2, BR_W = 3.2, BR_MID = (BR_X0 + BR_X1) / 2, BR_LEN = BR_X1 - BR_X0, STUDIO_LANE = SZ - 1;
function skyBridge(x0, x1) {                                   // a glass sky bridge along the main aisle from x0 to x1
  const len = x1 - x0, mid = (x0 + x1) / 2;
  box(len, 0.3, BR_W + 0.2, std(0x1a1d22, 0.5, 0.4), mid, -0.15, AISLE, scene, false);                            // deck
  mesh(new THREE.BoxGeometry(len, 0.02, BR_W - 0.4), aisleMat, mid, 0.01, AISLE, scene, false);                   // walkway
  box(len, 0.5, 1.2, std(0x30343c, 0.6, 0.5), mid, -0.6, AISLE, scene, false);                                    // spine truss
  for (const s of [-1, 1]) {
    mesh(new THREE.BoxGeometry(len, 2.9, 0.04), glass, mid, 1.5, AISLE + s * BR_W / 2, scene, false);             // glass sides
    bar(len, 0.04, 0.06, TEAL, mid, 0.05, AISLE + s * (BR_W / 2 - 0.15), 1.6);                                   // floor light strips
  }
  mesh(new THREE.BoxGeometry(len, 0.04, BR_W), glass, mid, 3.0, AISLE, scene, false);                             // glass roof
  for (let x = x0 + 1.2; x < x1; x += 2.4) {                                                                      // ribs
    for (const s of [-1, 1]) box(0.08, 3, 0.08, mull, x, 1.5, AISLE + s * BR_W / 2, scene, false);
    box(0.08, 0.08, BR_W, mull, x, 3.02, AISLE, scene, false);
  }
}
skyBridge(BR_X0, BR_X1);
const WCOL = { fund: '#7c8cff', studio: '#34d399', jason: '#fbbf24' }, WNAME = { fund: 'JB CAPITAL', studio: 'JB VENTURES', jason: 'JASON' };
const wireTex = canvasTex(1400, 520, (g, w, h) => {
  g.fillStyle = 'rgba(6,10,18,0.92)'; g.fillRect(0, 0, w, h);
  g.strokeStyle = '#22d3ee'; g.lineWidth = 4; g.strokeRect(2, 2, w - 4, h - 4);
  g.fillStyle = '#e5e7eb'; g.font = font(40, 800); g.fillText('THE WIRE', 30, 56);
  g.fillStyle = '#7dd3fc'; g.font = font(22, 600); g.fillText('city message board', 230, 54);
  const open = snap?.wire?.open || {}; g.textAlign = 'right'; g.fillStyle = '#94a3b8'; g.font = font(22, 600);
  g.fillText(`open: fund ${open.fund || 0} · studio ${open.studio || 0} · news ${open.news || 0} · careers ${open.career || 0} · study ${open.study || 0}`, w - 30, 54); g.textAlign = 'left';
  const P = (snap?.wire?.posts || []).slice(-5).reverse();
  if (!P.length) { g.fillStyle = '#64748b'; g.font = font(26, 500); g.fillText('Quiet. Messages between the towers show up here.', 30, 130); }
  P.forEach((p, i) => { const y = 84 + i * 86;
    g.fillStyle = '#111827'; g.fillRect(24, y, w - 48, 76);
    g.font = font(20, 800); g.fillStyle = WCOL[p.frm] || '#fff'; g.fillText(WNAME[p.frm] || p.frm, 40, y + 28);
    const fw = g.measureText(WNAME[p.frm] || p.frm).width; g.fillStyle = '#64748b'; g.fillText('  →  ', 40 + fw, y + 28);
    g.fillStyle = WCOL[p.to] || '#fff'; g.fillText(WNAME[p.to] || p.to, 40 + fw + g.measureText('  →  ').width, y + 28);
    g.textAlign = 'right'; g.fillStyle = p.status === 'done' ? '#34d399' : '#fbbf24'; g.fillText(p.status === 'done' ? (p.reply ? 'ANSWERED' : 'READ') : p.status.toUpperCase(), w - 40, y + 28); g.textAlign = 'left';
    g.fillStyle = '#cbd5e1'; g.font = font(22, 500); g.fillText(String(p.reply || p.text).slice(0, 96), 40, y + 60); });
});
const wireBoard = screen(8.4, 3.12, wireTex.tex, BR_MID, 4.9, AISLE, 0, scene, 0.06);
for (const s of [-3, 3]) mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.4, 8), metal, BR_MID + s, 3.2, AISLE - 0.05, scene, false);   // short posts under the board
clickable(wireBoard.group, { type: 'wire', tip: 'The Wire: messages between the towers (and Jason’s phone)' });
const WIRE_CAM = [new THREE.Vector3(BR_MID - 4, 9, AISLE + 17), new THREE.Vector3(BR_MID, 2.5, AISLE)];
// courier drones: fly a parcel between buildings (and up to / down from Jason's phone in the sky)
const BPOS = { fund: new THREE.Vector3(16, 6.5, 6), studio: new THREE.Vector3(SX - 4, 4.2, SZ + 4), jason: new THREE.Vector3(BR_MID, 70, 90) };
const drones = [];
function drone(from, to, color = TEAL) {
  const g = new THREE.Group(); scene.add(g);
  mesh(rbox(0.7, 0.18, 0.7, 0.06), std(0x1c2028, 0.35, 0.7), 0, 0, 0, g, false);
  const rotors = [];
  for (const [dx, dz] of [[-0.5, -0.5], [0.5, -0.5], [-0.5, 0.5], [0.5, 0.5]]) {
    mesh(new THREE.BoxGeometry(0.5, 0.04, 0.06), mull, dx / 2, 0.02, dz / 2, g, false).rotation.y = Math.atan2(dz, dx);
    const r = mesh(new THREE.CylinderGeometry(0.26, 0.26, 0.015, 16), new THREE.MeshBasicMaterial({ color: 0x9aa4b2, transparent: true, opacity: 0.45 }), dx, 0.1, dz, g, false); rotors.push(r);
  }
  mesh(new THREE.BoxGeometry(0.34, 0.26, 0.34), glow(color, 1.8), 0, -0.3, 0, g, false);                        // the parcel
  const light = mesh(new THREE.SphereGeometry(0.07, 8, 6), glow(0xff3344, 2.5), 0, 0.12, -0.36, g, false);
  const d = from.distanceTo(to);
  drones.push({ g, rotors, light, from: from.clone(), to: to.clone(), t0: performance.now(), ms: Math.max(3500, d * 70), arc: Math.min(14, 3 + d * 0.12) });
}
function moveDrones(now) {
  for (let i = drones.length - 1; i >= 0; i--) { const d = drones[i], k = Math.min(1, (now - d.t0) / d.ms), e = k * k * (3 - 2 * k);
    d.g.position.lerpVectors(d.from, d.to, e); d.g.position.y += Math.sin(Math.PI * k) * d.arc;
    const ahead = new THREE.Vector3().lerpVectors(d.from, d.to, Math.min(1, e + 0.02)); d.g.rotation.y = Math.atan2(ahead.x - d.g.position.x, ahead.z - d.g.position.z);
    d.rotors.forEach(r => r.rotation.y += 0.9); d.light.visible = Math.floor(now / 300) % 2 === 0;
    if (k >= 1) { scene.remove(d.g); drones.splice(i, 1); burst(10, d.to.x, d.to.y, d.to.z, true); } }
}
const wireText = t => String(t || '').replace(/^\[[^\]]*\]\s*/, '');
const WIRE_DESK = { fund: 'boss', studio: 'rosa' };
// ── JB NEWSROOM: the tower west of the fund, joined by a second sky bridge ──
const NX = -62, NZ = -2, NW = 26, ND = 16, NB_X0 = -FX - 0.3, NB_X1 = NX + NW / 2;
const NEWS_STAFF = [
  { id: 'nia', name: 'Nia', role: 'Editor-in-chief (JB Newsroom)',          seat: [NX + 7, NZ + 2.2], accent: 0xf87171, jacket: 0x7a1f1f, badge: 200, suit: true },
  { id: 'ben', name: 'Ben', role: 'Markets reporter · CNBC, Yahoo, CoinDesk', seat: [NX, NZ + 2.2],     accent: 0xfbbf24, jacket: 0x6b5512, badge: 201, headset: true },
  { id: 'lux', name: 'Lux', role: 'Tech reporter · AI & startups',           seat: [NX - 7, NZ + 2.2], accent: 0xa78bfa, jacket: 0x4c2a86, badge: 202 },
];
const NEWS_IDS = new Set(NEWS_STAFF.map(d => d.id));
skyBridge(NB_X1, NB_X0);
{
  tower(NX, NZ, NW + 4, ND + 6, 'news');
  const fl = new THREE.Mesh(new THREE.PlaneGeometry(NW, ND), new THREE.MeshStandardMaterial({ color: 0x2b2e34, roughness: 0.28, metalness: 0.2 }));
  fl.rotation.x = -Math.PI / 2; fl.position.set(NX, 0.005, NZ); fl.receiveShadow = true; scene.add(fl); groundLayer(fl, 1);
  box(NW + 0.4, 0.4, ND + 0.4, std(0x2a2d33, 0.7, 0.2), NX, -0.2, NZ);
  roofSlabs.news = box(NW + 0.4, 0.3, ND + 0.4, soffit, NX, 5.6, NZ, scene, false);
  const gapA = AISLE - 1.6, gapB = AISLE + 1.6, z0 = NZ - ND / 2, z1 = NZ + ND / 2;
  for (const [w, d, x, z] of [[NW, 0.05, NX, z0], [NW, 0.05, NX, z1], [0.05, gapA - z0, NX - NW / 2, (z0 + gapA) / 2], [0.05, z1 - gapB, NX - NW / 2, (gapB + z1) / 2], [0.05, gapA - z0, NB_X1, (z0 + gapA) / 2], [0.05, z1 - gapB, NB_X1, (gapB + z1) / 2]]) {
    mesh(new THREE.BoxGeometry(w, 5.4, d), glass, x, 2.8, z, scene, false);
    const n = Math.max(1, Math.round(Math.max(w, d) / 3.2));
    for (let i = 0; i <= n; i++) box(0.08, 5.4, 0.08, mull, w > d ? x - w / 2 + i * w / n : x, 2.7, w > d ? z : z - d / 2 + i * d / n, scene, false);
  }
  for (const x of [NX - 8, NX, NX + 8]) mesh(new THREE.BoxGeometry(5, 0.05, 1.2), glow(0xe8f0ff, 1.6), x, 5.42, NZ + 1, scene, false);
  const sign = canvasTex(1024, 192, (g) => { g.clearRect(0, 0, 1024, 192); g.fillStyle = '#ffffff'; g.font = font(104, 800); g.fillText('JB NEWSROOM', 18, 132); });
  const sp = new THREE.Mesh(new THREE.PlaneGeometry(17, 3.2), new THREE.MeshBasicMaterial({ map: sign.tex, transparent: true, toneMapped: false }));
  sp.position.set(NX, -6.5, NZ + ND / 2 + 3.45); scene.add(sp);
  const rp = sp.clone(); rp.scale.setScalar(0.7); rp.position.set(NX, 6.9, NZ - ND / 2 + 0.3); scene.add(rp);   // rooftop sign at the back, over the news wall
  for (const d of NEWS_STAFF) desk(d.seat, d.accent, d.id === 'nia');
  // rooftop satellite dish
  const dish = mesh(new THREE.SphereGeometry(2.2, 24, 12, 0, Math.PI * 2, 0, Math.PI / 3.2), std(0xe5e7eb, 0.4, 0.5), NX - 8, 8.6, NZ - 4, scene, false);
  dish.material.side = THREE.DoubleSide; dish.rotation.set(-0.9, 0.6, 0);
  mesh(new THREE.CylinderGeometry(0.15, 0.25, 2.6, 8), metal, NX - 8, 7, NZ - 4, scene, false);
  plant(NX - NW / 2 + 1, NZ + ND / 2 - 1, 1.2); plant(NX + NW / 2 - 1.2, NZ + ND / 2 - 1, 1.1);
  clickable(fl, { type: 'news', tip: 'JB Newsroom: real headlines for the whole city' });
}
// the news wall: the latest briefing + headlines, live
const DESK_COL = { markets: '#fbbf24', crypto: '#f59e0b', tech: '#a78bfa' };
const newsTex = canvasTex(1600, 720, (g, w, h) => {
  g.fillStyle = '#0b0f17'; g.fillRect(0, 0, w, h);
  g.fillStyle = '#ef4444'; g.fillRect(0, 0, w, 84); g.fillStyle = '#fff'; g.font = font(44, 800); g.fillText('JB NEWSROOM', 36, 58);
  const nw = snap?.news; g.font = font(24, 600); g.textAlign = 'right';
  g.fillText(nw ? `${nw.count} stories · next briefing in ${Math.ceil((nw.next_brief_in || 0) / 60)} min` : 'connecting…', w - 36, 54); g.textAlign = 'left';
  const b = nw?.brief;
  g.fillStyle = '#fca5a5'; g.font = font(22, 800); g.fillText('BRIEFING', 36, 130);
  g.fillStyle = '#f1f5f9'; g.font = font(34, 700); wrapText(g, b ? b.headline : 'First briefing coming up…', 36, 172, w - 72, 40, 2);
  (b?.symbols || []).slice(0, 6).forEach((s, i) => { const x = 36 + i * 250, c = s.tone > 0.15 ? '#22c55e' : s.tone < -0.15 ? '#f43f5e' : '#94a3b8';
    g.fillStyle = '#151b27'; g.fillRect(x, 236, 236, 52); g.fillStyle = c; g.fillRect(x, 236, 6, 52);
    g.font = font(26, 800); g.fillText(`${s.sym} ${s.tone > 0.15 ? '▲' : s.tone < -0.15 ? '▼' : '•'}`, x + 18, 271); });
  g.fillStyle = '#94a3b8'; g.font = font(22, 800); g.fillText('LATEST', 36, 336);
  (nw?.headlines || []).slice(0, 7).forEach((x, i) => { const y = 352 + i * 50;
    g.fillStyle = DESK_COL[x.desk] || '#fff'; g.font = font(20, 800); g.fillText(String(x.source).toUpperCase().slice(0, 14), 36, y + 32);
    g.fillStyle = x.big ? '#fecaca' : '#e2e8f0'; g.font = font(24, x.big ? 700 : 500); g.fillText(String(x.title).slice(0, 92), 230, y + 32); });
});
const newsWall = screen(10.5, 4.7, newsTex.tex, NX, 2.75, NZ - ND / 2 + 0.25, 0, scene, 0.08);
clickable(newsWall.group, { type: 'news', tip: 'News wall: open the News tab' });
const onAir = canvasTex(256, 80, g => { g.fillStyle = '#1a0606'; g.fillRect(0, 0, 256, 80); g.fillStyle = '#ff3b3b'; g.font = font(46, 900); g.fillText('ON AIR', 40, 58); });
const onAirSign = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 0.5), new THREE.MeshBasicMaterial({ map: onAir.tex, toneMapped: false })); onAirSign.position.set(NX + 7, 5.25, NZ - ND / 2 + 0.3); scene.add(onAirSign);
// the outside news ticker wrapped around the tower, like a Times Square zipper
const zipTex = canvasTex(4096, 96, (g, w, h) => {
  g.fillStyle = '#050505'; g.fillRect(0, 0, w, h); g.font = font(58, 800);
  const hs = (snap?.news?.headlines || []).slice(0, 10); let x = 20;
  for (const it of (hs.length ? hs : [{ title: 'JB NEWSROOM · LIVE HEADLINES', desk: 'tech' }])) { g.fillStyle = DESK_COL[it.desk] || '#ffb020'; g.fillText('◆', x, 70); x += 60;
    g.fillStyle = '#ffd27a'; const t = String(it.title).toUpperCase(); g.fillText(t, x, 70); x += g.measureText(t).width + 60; if (x > w) break; }
});
zipTex.tex.wrapS = THREE.RepeatWrapping;
{ const zm = new THREE.MeshBasicMaterial({ map: zipTex.tex, toneMapped: false });
  for (const [w, x, z, ry] of [[NW + 4.1, NX, NZ + ND / 2 + 3.5, 0], [NW + 4.1, NX, NZ - ND / 2 - 3.5, Math.PI], [ND + 6.1, NX - NW / 2 - 2.5, NZ, -Math.PI / 2], [ND + 6.1, NX + NW / 2 + 2.5, NZ, Math.PI / 2]]) {
    const p = new THREE.Mesh(new THREE.PlaneGeometry(w, 1.6), zm); p.position.set(x, -10.4, z); p.rotation.y = ry; scene.add(p); } }
NEWS_STAFF.forEach(d => addAgent(d));
const NEWS_CAM = [new THREE.Vector3(NX + 3, 4.4, NZ + 15.5), new THREE.Vector3(NX, 2.2, NZ - 5)];   // under the roofline, looking at the news wall
BPOS.news = new THREE.Vector3(NX + 4, 4.2, NZ + 4);
WIRE_DESK.news = 'nia';
WCOL.news = '#f87171'; WNAME.news = 'JB NEWSROOM';
function newsIdle(a) {
  const st = snap?.news;
  if (st?.status === 'fetching' && a.id !== 'nia') { act(a.id, anim('phone', 2600), say(choose(['Pulling the wires…', 'Checking the feeds…', 'Anything new on the tape?']), 2400)); return; }
  const lines = { nia: ['What leads the hour?', 'Signal, not noise.', 'Fact-check that before it goes out.'], ben: ['Watching oil and rates.', 'Crypto desk is busy.', 'Fed speakers this week.'],
                  lux: ['Another AI model launch…', 'Reading Hacker News.', 'Startup funding is hot.'] };
  if (a.id !== 'nia' && Math.random() < 0.35) act(a.id, go(deskVisit('nia')), say(choose(['Got a story for you.', 'Want this in the briefing?']), 2400), home());
  else act(a.id, anim(choose(['explain', 'point', 'nod', 'stretch']), 1800), say(choose(lines[a.id]), 2400));
}
// ── JB CAREERS: the tower east of JB Ventures (third sky bridge) ──
const CX = 117, CZ = -2, CW = 26, CD = 16, CB_X0 = SX + SW / 2, CB_X1 = CX - CW / 2;
const CAREER_STAFF = [
  { id: 'cole', name: 'Cole', role: 'Career director (JB Careers)',              seat: [CX - 7, CZ + 2.2], accent: 0x2dd4bf, jacket: 0x14665c, badge: 300, suit: true },
  { id: 'maya', name: 'Maya', role: 'Opportunity scout · programs & internships', seat: [CX, CZ + 2.2],     accent: 0x60a5fa, jacket: 0x1e4f8a, badge: 301, headset: true },
  { id: 'drew', name: 'Drew', role: 'Outreach coach · drafts only, you send',     seat: [CX + 7, CZ + 2.2], accent: 0xfb923c, jacket: 0x8a3a12, badge: 302 },
];
const CAREER_IDS = new Set(CAREER_STAFF.map(d => d.id));
skyBridge(CB_X0, CB_X1);
{
  tower(CX, CZ, CW + 4, CD + 6, 'career');
  const carpet = canvasTex(256, 256, (g, w, h) => { g.fillStyle = '#123a3a'; g.fillRect(0, 0, w, h); for (let i = 0; i < 400; i++) { g.fillStyle = `rgba(255,255,255,${rnd() * 0.05})`; g.fillRect(rnd() * w, rnd() * h, 2, 2); } });
  carpet.tex.wrapS = carpet.tex.wrapT = THREE.RepeatWrapping; carpet.tex.repeat.set(5, 3);
  const fl = new THREE.Mesh(new THREE.PlaneGeometry(CW, CD), new THREE.MeshStandardMaterial({ map: carpet.tex, roughness: 0.95 }));
  fl.rotation.x = -Math.PI / 2; fl.position.set(CX, 0.005, CZ); fl.receiveShadow = true; scene.add(fl); groundLayer(fl, 1);
  box(CW + 0.4, 0.4, CD + 0.4, std(0x2a2d33, 0.7, 0.2), CX, -0.2, CZ);
  roofSlabs.career = box(CW + 0.4, 0.3, CD + 0.4, soffit, CX, 5.6, CZ, scene, false);
  const gapA = AISLE - 1.6, gapB = AISLE + 1.6, z0 = CZ - CD / 2, z1 = CZ + CD / 2;
  for (const [w, d, x, z] of [[CW, 0.05, CX, z0], [CW, 0.05, CX, z1], [0.05, gapA - z0, CX + CW / 2, (z0 + gapA) / 2], [0.05, z1 - gapB, CX + CW / 2, (gapB + z1) / 2], [0.05, gapA - z0, CB_X1, (z0 + gapA) / 2], [0.05, z1 - gapB, CB_X1, (gapB + z1) / 2]]) {
    mesh(new THREE.BoxGeometry(w, 5.4, d), glass, x, 2.8, z, scene, false);
    const n = Math.max(1, Math.round(Math.max(w, d) / 3.2));
    for (let i = 0; i <= n; i++) box(0.08, 5.4, 0.08, mull, w > d ? x - w / 2 + i * w / n : x, 2.7, w > d ? z : z - d / 2 + i * d / n, scene, false);
  }
  for (const x of [CX - 8, CX, CX + 8]) mesh(new THREE.BoxGeometry(5, 0.05, 1.2), glow(0xfff4e0, 1.6), x, 5.42, CZ + 1, scene, false);
  const sign = canvasTex(1024, 192, (g) => { g.clearRect(0, 0, 1024, 192); g.fillStyle = '#ffffff'; g.font = font(110, 800); g.fillText('JB CAREERS', 40, 135); });
  const sp = new THREE.Mesh(new THREE.PlaneGeometry(17, 3.2), new THREE.MeshBasicMaterial({ map: sign.tex, transparent: true, toneMapped: false }));
  sp.position.set(CX, -6.5, CZ + CD / 2 + 3.45); scene.add(sp);
  const rp = sp.clone(); rp.scale.setScalar(0.7); rp.position.set(CX, 6.9, CZ - CD / 2 + 0.3); scene.add(rp);
  for (const d of CAREER_STAFF) desk(d.seat, d.accent, d.id === 'cole');
  // pitch-practice corner: a small stage with a mic stand
  mesh(new THREE.CylinderGeometry(1.5, 1.5, 0.18, 32), walnut, CX + 9.5, 0.09, CZ + 5.4);
  mesh(new THREE.CylinderGeometry(0.02, 0.02, 1.4, 8), metal, CX + 9.5, 0.88, CZ + 5.4); mesh(new THREE.SphereGeometry(0.06, 10, 8), std(0x1c1f25, 0.4, 0.5), CX + 9.5, 1.6, CZ + 5.4);
  // rooftop garden + flagpole
  for (let k = 0; k < 6; k++) mesh(new THREE.IcosahedronGeometry(0.9 + rnd() * 0.6, 0), std(0x3f7a4a, 0.85), CX - 9 + k * 3.4, 6.5, CZ + 4.5, scene, false);
  mesh(new THREE.CylinderGeometry(0.06, 0.06, 6, 8), metal, CX + 11, 8.7, CZ - 6, scene, false);
  mesh(new THREE.BoxGeometry(2.2, 1.3, 0.04), glow(0x2dd4bf, 1.2), CX + 12.1, 10.9, CZ - 6, scene, false);
  plant(CX - CW / 2 + 1.2, CZ + CD / 2 - 1, 1.2); plant(CX + CW / 2 - 1, CZ - CD / 2 + 1.2, 1);
  clickable(fl, { type: 'career', tip: 'JB Careers: your real career pipeline' });
}
// the career board: follow-ups due, deadlines, Zetamac
const careerTex = canvasTex(1600, 720, (g, w, h) => {
  g.fillStyle = '#0b1414'; g.fillRect(0, 0, w, h);
  g.fillStyle = '#2dd4bf'; g.fillRect(0, 0, w, 84); g.fillStyle = '#04201c'; g.font = font(44, 800); g.fillText('JB CAREERS · PIPELINE', 36, 58);
  const c = snap?.career; if (!c) return;
  g.textAlign = 'right'; g.font = font(24, 700); g.fillText(`${c.contacts} contacts · ladder ${c.ladder.done}/${c.ladder.total}`, w - 36, 54); g.textAlign = 'left';
  g.fillStyle = '#5eead4'; g.font = font(24, 800); g.fillText(`FOLLOW-UPS DUE (${c.due.length})`, 36, 132);
  c.due.slice(0, 8).forEach((d, i) => { const y = 150 + i * 62;
    g.fillStyle = '#132424'; g.fillRect(36, y, 740, 54); g.fillStyle = d.overdue > 0 ? '#f87171' : '#fbbf24'; g.fillRect(36, y, 6, 54);
    g.fillStyle = '#ecfeff'; g.font = font(26, 700); g.fillText(String(d.name).slice(0, 18), 56, y + 36);
    g.fillStyle = '#99f6e4'; g.font = font(20, 500); g.fillText(String(d.org).slice(0, 22), 360, y + 35);
    g.textAlign = 'right'; g.fillStyle = c.drafts?.[d.id]?.message ? '#34d399' : '#64748b'; g.font = font(18, 800); g.fillText(c.drafts?.[d.id]?.message ? 'DRAFT READY' : d.overdue > 0 ? `${d.overdue}D LATE` : 'TODAY', 760, y + 35); g.textAlign = 'left'; });
  if (!c.due.length) { g.fillStyle = '#64748b'; g.font = font(26, 500); g.fillText('Nothing due. Send one new connection request?', 36, 190); }
  g.fillStyle = '#5eead4'; g.font = font(24, 800); g.fillText('COMING UP', 830, 132);
  c.events.slice(0, 6).forEach((e, i) => { const y = 150 + i * 70;
    g.fillStyle = '#132424'; g.fillRect(830, y, 734, 60);
    g.fillStyle = e.days <= 7 ? '#fbbf24' : '#ecfeff'; g.font = font(40, 800); g.textAlign = 'right'; g.fillText(e.days === 0 ? 'NOW' : `${e.days}d`, 950, y + 46); g.textAlign = 'left';
    g.fillStyle = '#e2e8f0'; g.font = font(22, 600); g.fillText(String(e.title).slice(0, 44), 970, y + 38); });
  const z = c.zetamac; g.fillStyle = '#5eead4'; g.font = font(24, 800); g.fillText('ZETAMAC', 830, 600);
  g.fillStyle = '#ecfeff'; g.font = font(44, 800); g.fillText(z.last == null ? '—' : `${z.last}`, 830, 656);
  g.fillStyle = '#94a3b8'; g.font = font(22, 600); g.fillText(z.last == null ? 'no games yet' : `best ${z.best} · avg of last 5 ${z.avg5} · ${z.n} games`, 920, 650);
});
const careerBoard = screen(10.5, 4.7, careerTex.tex, CX, 2.75, CZ - CD / 2 + 0.25, 0, scene, 0.08);
clickable(careerBoard.group, { type: 'career', tip: 'Career board: open the Career tab' });
CAREER_STAFF.forEach(d => addAgent(d));
const CAREER_CAM = [new THREE.Vector3(CX - 3, 4.4, CZ + 15.5), new THREE.Vector3(CX, 2.2, CZ - 5)];
BPOS.career = new THREE.Vector3(CX - 4, 4.2, CZ + 4);
WIRE_DESK.career = 'cole';
WCOL.career = '#2dd4bf'; WNAME.career = 'JB CAREERS';
function careerIdle(a) {
  const c = snap?.career;
  if (a.id === 'drew' && Math.random() < 0.3) { act('drew', go({ x: CX + 9.5, z: CZ + 4.4 }), fx(b => b.face = 0), anim('explain', 3000), say(choose(['“Hi, I’m Jason, I run the algo trading club at FSW…”', 'Pitch practice: slow down, smile.', 'Thirty seconds. Name, club, one project, one question.']), 3200), home()); return; }
  const lines = { cole: [c?.due?.length ? `${c.due.length} follow-ups on the board.` : 'Pipeline looks clean.', 'Small steps, every day.', 'Who should Jason meet next?'],
                  maya: ['Checking program deadlines…', 'Reading eligibility rules.', 'Insight weeks open in the fall.'], drew: ['Short and warm beats long and perfect.', 'Rewriting a follow-up.', 'No dashes. Keep it human.'] };
  act(a.id, anim(choose(['explain', 'point', 'nod', 'stretch']), 1800), say(choose(lines[a.id]), 2400));
}
// ── JB STUDY HALL: a library tower west of the newsroom (fourth sky bridge) ──
const HX = -117, HZ = -2, HW = 26, HD = 16, HB_X1 = HX + HW / 2, HB_X0 = NX - NW / 2;   // bridge from the study hall (HB_X1) to the newsroom (HB_X0)
const STUDY_STAFF = [
  { id: 'sage',  name: 'Sage',  role: 'Study planner · small steps, no guilt', seat: [HX + 7, HZ + 2.2], accent: 0x86efac, jacket: 0x2f5d3a, badge: 400, suit: true },
  { id: 'quinn', name: 'Quinn', role: 'Quiz master · practice rounds + review deck', seat: [HX, HZ + 2.2], accent: 0xc4b5fd, jacket: 0x4c2a86, badge: 401 },
  { id: 'remy',  name: 'Remy',  role: 'Tutor · ask anything on the Wire', seat: [HX - 7, HZ + 2.2], accent: 0xfdba74, jacket: 0x8a4b12, badge: 402, headset: true },
];
const STUDY_IDS = new Set(STUDY_STAFF.map(d => d.id));
skyBridge(HB_X1, HB_X0);
const spines = canvasTex(512, 256, (g, w, h) => {                       // book spines for every shelf
  g.fillStyle = '#3b2a1d'; g.fillRect(0, 0, w, h);
  for (let row = 0; row < 4; row++) { const y0 = row * 64; g.fillStyle = '#2a1d14'; g.fillRect(0, y0 + 58, w, 6);
    for (let x = 2; x < w;) { const bw = 6 + rnd() * 12, bh = 34 + rnd() * 22, c = ['#7f1d1d', '#1e3a8a', '#14532d', '#78350f', '#4c1d95', '#334155', '#9a3412', '#0f766e', '#a16207'][Math.floor(rnd() * 9)];
      g.fillStyle = c; g.fillRect(x, y0 + 58 - bh, bw, bh); g.fillStyle = 'rgba(255,230,180,.35)'; g.fillRect(x + 1, y0 + 58 - bh + 6, bw - 2, 2); x += bw + 1; } }
});
function shelf(x, z, w, ry = 0) {
  const g = new THREE.Group(); g.position.set(x, 0, z); g.rotation.y = ry; scene.add(g);
  mesh(new THREE.BoxGeometry(w, 3.2, 0.5), std(0x3b2a1d, 0.7), 0, 1.6, 0, g, false);
  const face = new THREE.Mesh(new THREE.PlaneGeometry(w - 0.2, 3.0), new THREE.MeshStandardMaterial({ map: spines.tex, roughness: 0.8 }));
  face.position.set(0, 1.6, 0.26); g.add(face);
}
{
  tower(HX, HZ, HW + 4, HD + 6, 'study');
  const wood = canvasTex(512, 512, (g, w, h) => { g.fillStyle = '#6b4a30'; g.fillRect(0, 0, w, h);
    for (let i = 0; i < 32; i++) { g.fillStyle = i % 2 ? 'rgba(40,25,15,.25)' : 'rgba(255,230,200,.06)'; g.fillRect(0, i * 16, w, 15); } });
  wood.tex.wrapS = wood.tex.wrapT = THREE.RepeatWrapping; wood.tex.repeat.set(4, 2);
  const fl = new THREE.Mesh(new THREE.PlaneGeometry(HW, HD), new THREE.MeshStandardMaterial({ map: wood.tex, roughness: 0.6 }));
  fl.rotation.x = -Math.PI / 2; fl.position.set(HX, 0.005, HZ); fl.receiveShadow = true; scene.add(fl); groundLayer(fl, 1);
  box(HW + 0.4, 0.4, HD + 0.4, std(0x2a2d33, 0.7, 0.2), HX, -0.2, HZ);
  roofSlabs.study = box(HW + 0.4, 0.3, HD + 0.4, soffit, HX, 5.6, HZ, scene, false);
  const gapA = AISLE - 1.6, gapB = AISLE + 1.6, z0 = HZ - HD / 2, z1 = HZ + HD / 2;
  for (const [w, d, x, z] of [[HW, 0.05, HX, z0], [HW, 0.05, HX, z1], [0.05, gapA - z0, HX - HW / 2, (z0 + gapA) / 2], [0.05, z1 - gapB, HX - HW / 2, (gapB + z1) / 2], [0.05, gapA - z0, HB_X1, (z0 + gapA) / 2], [0.05, z1 - gapB, HB_X1, (gapB + z1) / 2]]) {
    mesh(new THREE.BoxGeometry(w, 5.4, d), glass, x, 2.8, z, scene, false);
    const n = Math.max(1, Math.round(Math.max(w, d) / 3.2));
    for (let i = 0; i <= n; i++) box(0.08, 5.4, 0.08, mull, w > d ? x - w / 2 + i * w / n : x, 2.7, w > d ? z : z - d / 2 + i * d / n, scene, false);
  }
  for (const x of [HX - 8, HX, HX + 8]) mesh(new THREE.BoxGeometry(5, 0.05, 1.2), glow(0xffe2b8, 1.4), x, 5.42, HZ + 1, scene, false);
  const sign = canvasTex(1024, 192, (g) => { g.clearRect(0, 0, 1024, 192); g.fillStyle = '#ffffff'; g.font = font(96, 800); g.fillText('JB STUDY HALL', 14, 130); });
  const sp = new THREE.Mesh(new THREE.PlaneGeometry(17, 3.2), new THREE.MeshBasicMaterial({ map: sign.tex, transparent: true, toneMapped: false }));
  sp.position.set(HX, -6.5, HZ + HD / 2 + 3.45); scene.add(sp);
  const rp = sp.clone(); rp.scale.setScalar(0.7); rp.position.set(HX, 6.9, HZ - HD / 2 + 0.3); scene.add(rp);
  for (const d of STUDY_STAFF) desk(d.seat, d.accent, d.id === 'sage');
  // bookshelves on the back wall (around the chalkboard) and the west wall
  shelf(HX - 9.6, HZ - HD / 2 + 0.4, 5.4); shelf(HX + 9.6, HZ - HD / 2 + 0.4, 5.4);
  shelf(HX - HW / 2 + 0.4, HZ - 4.4, 4.2, Math.PI / 2); shelf(HX - HW / 2 + 0.4, HZ + 4.2, 4.2, Math.PI / 2);   // (doorway to the Ops Center between them)
  // a long reading table with green banker's lamps
  mesh(rbox(7, 0.08, 1.6, 0.03), walnut, HX, 0.78, HZ + 5.6);
  for (const sx of [-3.2, 3.2]) mesh(new THREE.BoxGeometry(0.1, 0.74, 1.4), std(0x2b1d14, 0.6), HX + sx, 0.37, HZ + 5.6);
  for (const sx of [-2.2, 0, 2.2]) { mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.35, 8), metal, HX + sx, 0.98, HZ + 5.6, scene, false);
    mesh(new THREE.CylinderGeometry(0.1, 0.24, 0.16, 16, 1, true), glow(0x22c55e, 0.9), HX + sx, 1.18, HZ + 5.6, scene, false);
    mesh(new THREE.SphereGeometry(0.06, 8, 6), glow(0xfff1cc, 2.4), HX + sx, 1.12, HZ + 5.6, scene, false); }
  for (const sx of [-2.4, -0.8, 0.8, 2.4]) for (const sz of [-1.1, 1.1]) chair(HX + sx, HZ + 5.6 + sz, scene);
  // rooftop observatory
  mesh(new THREE.CylinderGeometry(2.6, 2.6, 1.6, 24), std(0xd8dde4, 0.5, 0.3), HX - 7, 6.6, HZ - 3, scene, false);
  mesh(new THREE.SphereGeometry(2.6, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2), std(0xc7ccd4, 0.3, 0.7), HX - 7, 7.4, HZ - 3, scene, false);
  plant(HX + HW / 2 - 1.2, HZ + HD / 2 - 1, 1.2); plant(HX - HW / 2 + 1.4, HZ + HD / 2 - 1, 1);
  clickable(fl, { type: 'study', tip: 'JB Study Hall: plans, practice quizzes, tutoring' });
}
// the chalkboard: today's plan, what's due, the streak
const chalkTex = canvasTex(1600, 720, (g, w, h) => {
  g.fillStyle = '#183326'; g.fillRect(0, 0, w, h); g.strokeStyle = '#8b6b47'; g.lineWidth = 18; g.strokeRect(9, 9, w - 18, h - 18);
  for (let i = 0; i < 160; i++) { g.fillStyle = `rgba(255,255,255,${rnd() * 0.04})`; g.fillRect(rnd() * w, rnd() * h, 30 + rnd() * 90, 2); }
  const s = snap?.study; g.fillStyle = '#f5f5ef'; g.font = font(46, 800); g.fillText('TODAY', 44, 82);
  if (!s) return;
  g.font = font(24, 600); g.fillStyle = '#d9f99d'; g.textAlign = 'right';
  g.fillText(`streak ${s.stats.streak} day${s.stats.streak === 1 ? '' : 's'} · ${s.stats.review_due} cards to review · ${s.stats.answered} answered`, w - 44, 80); g.textAlign = 'left';
  (s.plan || []).forEach((p, i) => { const y = 140 + i * 74;
    g.fillStyle = '#fef3c7'; g.font = font(30, 800); g.fillText(`${i + 1}.`, 44, y + 30);
    g.fillStyle = '#f5f5ef'; g.font = font(28, 700); g.fillText(`${p.mins} min · ${p.kind}`, 92, y + 30);
    g.fillStyle = '#cbd5c0'; g.font = font(22, 500); g.fillText(`${p.task.course}: ${p.task.title}`.slice(0, 58), 92, y + 60); });
  if (!(s.plan || []).length) { g.fillStyle = '#cbd5c0'; g.font = font(28, 500); g.fillText('Plan arrives at 8 AM. Or just start a practice round.', 44, 150); }
  g.fillStyle = '#f5f5ef'; g.font = font(30, 800); g.fillText('DUE THIS WEEK', 860, 140);
  (s.tasks || []).filter(t => t.days <= 7).slice(0, 8).forEach((t, i) => { const y = 180 + i * 50;
    g.fillStyle = t.days < 0 ? '#fca5a5' : t.test ? '#fde68a' : '#e7e5e4'; g.font = font(22, t.test ? 800 : 500);
    g.fillText(`${t.days < 0 ? 'late' : t.days === 0 ? 'today' : t.days + 'd'}`, 860, y); g.fillText(`${t.course}: ${t.title}`.slice(0, 44), 950, y); });
  const q = s.quiz; if (q) { const n = q.questions.length, a = q.questions.filter(x => x.picked != null).length, ok = q.questions.filter(x => x.picked != null && x.picked === x.answer).length;
    g.fillStyle = '#c4b5fd'; g.font = font(26, 800); g.fillText(`PRACTICE: ${q.topic}`.slice(0, 50), 44, 520); g.fillStyle = '#f5f5ef'; g.font = font(40, 800); g.fillText(`${ok}/${a} right · ${n - a} to go`, 44, 580); }
});
const chalkboard = screen(10.5, 4.7, chalkTex.tex, HX, 2.75, HZ - HD / 2 + 0.25, 0, scene, 0.08);
clickable(chalkboard.group, { type: 'study', tip: 'Chalkboard: open the Study tab' });
STUDY_STAFF.forEach(d => addAgent(d));
const STUDY_CAM = [new THREE.Vector3(HX + 3, 4.4, HZ + 15.5), new THREE.Vector3(HX, 2.2, HZ - 5)];
BPOS.study = new THREE.Vector3(HX + 4, 4.2, HZ + 4);
WIRE_DESK.study = 'sage';
WCOL.study = '#86efac'; WNAME.study = 'JB STUDY HALL';
function studyIdle(a) {
  if (Math.random() < 0.3) { act(a.id, go({ x: HX + (Math.random() - 0.5) * 5, z: HZ + 4.2 }), fx(b => b.face = 0), anim('nod', 2400), say(choose(['Reading ahead.', 'Flashcards…', 'Quiet hours.']), 2200), home()); return; }
  const lines = { sage: ['One block at a time.', 'Quick wins first.', 'Progress, not perfection.'], quinn: ['Writing fair questions.', 'Missed ones come back tomorrow.', 'Retrieval beats rereading.'],
                  remy: ['Ask me anything.', 'Examples make it stick.', 'Every expert started here.'] };
  act(a.id, anim(choose(['explain', 'point', 'nod', 'stretch']), 1800), say(choose(lines[a.id]), 2400));
}
// ── JB INCUBATOR: a greenhouse tower east of JB Careers, where new strategies earn a desk (5th sky bridge) ──
// every strategy incubating in the shadow book is a trainee robot at a practice desk; graduates walk to the trading floor
const IX = 172, IZ = -2, IW = 26, ID = 16, IB_X0 = CX + CW / 2, IB_X1 = IX - IW / 2;
const INC_STAFF = [
  { id: 'juno', name: 'Juno', role: 'Head of the Incubator · shadow book', seat: [IX + 10.5, IZ + 2.2], accent: 0x86efac, jacket: 0x166534, badge: 500, suit: true },
];
const INC_IDS = new Set(INC_STAFF.map(d => d.id));
const TRAINEE_SEATS = [IX - 9.5, IX - 4.5, IX + 0.5, IX + 5.5].flatMap(x => [[x, IZ + 2.2], [x, IZ + 6.2]]);
const TRAINEE_NAMES = ['Sprout', 'Fern', 'Basil', 'Clover', 'Mint', 'Thyme', 'Poppy', 'Aster'];
const TRAINEE_COLS = [0x86efac, 0x4ade80, 0xa3e635, 0x34d399, 0x2dd4bf, 0xbef264, 0x6ee7b7, 0x5eead4];
const INC_CAM = [new THREE.Vector3(IX - 3, 6.5, IZ + 17), new THREE.Vector3(IX, 1.5, IZ - 3)];
const INC_POT = { x: IX - 11.2, z: IZ + 6.6 };          // Juno waters the plants here
skyBridge(IB_X0, IB_X1);
{
  tower(IX, IZ, IW + 4, ID + 6, 'incubator');
  const tiles = canvasTex(256, 256, (g, w, h) => { g.fillStyle = '#d9e4d2'; g.fillRect(0, 0, w, h);
    for (let y = 0; y < h; y += 32) for (let x = 0; x < w; x += 32) { g.fillStyle = (x + y) % 64 ? '#cfdcc7' : '#e2ebdc'; g.fillRect(x + 1, y + 1, 30, 30); } });
  tiles.tex.wrapS = tiles.tex.wrapT = THREE.RepeatWrapping; tiles.tex.repeat.set(6, 4);
  const fl = new THREE.Mesh(new THREE.PlaneGeometry(IW, ID), new THREE.MeshStandardMaterial({ map: tiles.tex, roughness: 0.7 }));
  fl.rotation.x = -Math.PI / 2; fl.position.set(IX, 0.005, IZ); fl.receiveShadow = true; scene.add(fl); groundLayer(fl, 1);
  box(IW + 0.4, 0.4, ID + 0.4, std(0x2a2d33, 0.7, 0.2), IX, -0.2, IZ);
  roofSlabs.incubator = mesh(new THREE.BoxGeometry(IW + 0.4, 0.06, ID + 0.4), glass, IX, 5.6, IZ, scene, false);   // a glass ceiling: see in from above
  const gapA = AISLE - 1.6, gapB = AISLE + 1.6, z0 = IZ - ID / 2, z1 = IZ + ID / 2;
  for (const [w, d, x, z] of [[IW, 0.05, IX, z0], [IW, 0.05, IX, z1], [0.05, ID, IX + IW / 2, IZ], [0.05, gapA - z0, IB_X1, (z0 + gapA) / 2], [0.05, z1 - gapB, IB_X1, (gapB + z1) / 2]]) {
    mesh(new THREE.BoxGeometry(w, 5.4, d), glass, x, 2.8, z, scene, false);
    const n = Math.max(1, Math.round(Math.max(w, d) / 2.2));                                 // greenhouse: dense white ribs
    for (let i = 0; i <= n; i++) box(0.07, 5.4, 0.07, std(0xf1f5f2, 0.5, 0.2), w > d ? x - w / 2 + i * w / n : x, 2.7, w > d ? z : z - d / 2 + i * d / n, scene, false);
  }
  for (const x of [IX - 8, IX, IX + 8]) mesh(new THREE.BoxGeometry(5, 0.05, 1.2), glow(0xf3ffe8, 1.5), x, 5.42, IZ + 1, scene, false);
  const sign = canvasTex(1024, 192, (g) => { g.clearRect(0, 0, 1024, 192); g.fillStyle = '#ffffff'; g.font = font(100, 800); g.fillText('JB INCUBATOR', 20, 132); });
  const sp = new THREE.Mesh(new THREE.PlaneGeometry(17, 3.2), new THREE.MeshBasicMaterial({ map: sign.tex, transparent: true, toneMapped: false }));
  sp.position.set(IX, -6.5, IZ + ID / 2 + 3.45); scene.add(sp);
  const rp = sp.clone(); rp.scale.setScalar(0.7); rp.position.set(IX, 6.9, IZ - ID / 2 + 0.3); scene.add(rp);
  for (const d of INC_STAFF) desk(d.seat, d.accent, true);
  TRAINEE_SEATS.forEach((s, i) => desk(s, TRAINEE_COLS[i]));
  // planters along the walls (it's a greenhouse) + the graduation arch at the bridge door
  const wood = std(0x8a6a4a, 0.85), soil = std(0x3b2a1d, 0.95), leafA = std(TOD === 'night' ? 0x1f3a26 : 0x3f7a42, 0.8), leafB = std(TOD === 'night' ? 0x26422a : 0x5d8f3e, 0.8);
  for (const [px, pz, len, rot] of [[IX - 6, IZ - ID / 2 + 0.7, 8, 0], [IX + 6, IZ - ID / 2 + 0.7, 8, 0], [IX + IW / 2 - 0.7, IZ + 4, 5, Math.PI / 2], [IX - 6, IZ + ID / 2 - 0.6, 8, 0]]) {
    const g = new THREE.Group(); g.position.set(px, 0, pz); g.rotation.y = rot; scene.add(g);
    mesh(new THREE.BoxGeometry(len, 0.55, 0.8), wood, 0, 0.28, 0, g); mesh(new THREE.BoxGeometry(len - 0.15, 0.05, 0.66), soil, 0, 0.56, 0, g, false);
    for (let k = 0; k < len * 1.6; k++) mesh(new THREE.IcosahedronGeometry(0.22 + rnd() * 0.22, 0), k % 2 ? leafA : leafB, -len / 2 + 0.3 + k * 0.62, 0.75 + rnd() * 0.3, (rnd() - 0.5) * 0.4, g, false);
  }
  plant(INC_POT.x, INC_POT.z, 1.3); plant(IX + IW / 2 - 1.2, IZ - ID / 2 + 1.2, 1.2);
  const arch = new THREE.Mesh(new THREE.TorusGeometry(1.9, 0.09, 10, 40, Math.PI), glow(0x86efac, 1.8));
  arch.position.set(IB_X1 + 1.4, 0, AISLE); arch.rotation.y = Math.PI / 2; scene.add(arch); flyIgnore.add(arch);
  clickable(fl, { type: 'incubator', tip: 'JB Incubator: strategies earning a desk with a live paper record' });
}
// the shadow-book board: every incubating strategy, its forward record and its progress toward graduation
const incTex = canvasTex(1600, 720, (g, w, h) => {
  g.fillStyle = '#08130c'; g.fillRect(0, 0, w, h);
  g.fillStyle = '#86efac'; g.fillRect(0, 0, w, 84); g.fillStyle = '#052e16'; g.font = font(44, 800); g.fillText('JB INCUBATOR · SHADOW BOOK', 36, 58);
  const I = snap?.incubator; if (!I) return;
  const R = I.rules || {}, items = I.items || [], act = items.filter(x => x.status === 'incubating');
  g.textAlign = 'right'; g.font = font(24, 700); g.fillText(`graduate at ${R.grad_trades}+ forward trades, PF ${R.grad_pf}+  ·  no capital at risk`, w - 36, 54); g.textAlign = 'left';
  g.fillStyle = '#4ade80'; g.font = font(22, 800); g.fillText('STRATEGY', 36, 128); g.fillText('FORWARD TRADES', 640, 128); g.fillText('PF', 1080, 128); g.fillText('P&L', 1210, 128); g.fillText('DAYS', 1400, 128);
  act.slice(0, 7).forEach((x, i) => { const y = 180 + i * 64, f = x.fwd || {}, prog = Math.min(1, (f.n || 0) / (R.grad_trades || 8));
    g.fillStyle = TRAINEE_COLS[i % 8] ? hex(TRAINEE_COLS[i % 8]) : '#86efac'; g.fillRect(36, y - 30, 8, 40);
    g.fillStyle = '#ecfdf5'; g.font = font(30, 700); g.fillText(String(x.name).slice(0, 30), 58, y);
    g.fillStyle = '#14532d'; g.fillRect(640, y - 22, 380, 18); g.fillStyle = '#4ade80'; g.fillRect(640, y - 22, 380 * prog, 18);
    g.fillStyle = '#d1fae5'; g.font = "600 26px 'JetBrains Mono'"; g.fillText(`${f.n || 0}/${R.grad_trades}`, 640, y + 22);
    g.fillStyle = f.n ? (f.pf >= (R.grad_pf || 1.3) ? '#4ade80' : f.pf < 1 ? '#f87171' : '#fde68a') : '#6b7f72'; g.fillText(f.n ? (+f.pf).toFixed(2) : '—', 1080, y);
    g.fillStyle = (f.ret || 0) >= 0 ? '#4ade80' : '#f87171'; g.fillText(f.n ? `${f.ret >= 0 ? '+' : ''}${(f.ret * 100).toFixed(1)}%` : '—', 1210, y);
    g.fillStyle = '#a7c4b0'; g.fillText(String(Math.floor(x.days || 0)), 1400, y); });
  if (!act.length) { g.fillStyle = '#a7c4b0'; g.font = font(30, 500); g.fillText('Empty. Strategies land here when every desk on the trading floor is taken.', 36, 200); }
  const done = items.filter(x => x.status !== 'incubating').slice(-3).reverse();
  done.forEach((x, i) => { g.fillStyle = x.status === 'graduated' ? '#4ade80' : '#f87171'; g.font = font(22, 700);
    g.fillText(`${x.status === 'graduated' ? 'GRADUATED' : 'DROPPED'} · ${String(x.name).slice(0, 28)} · ${String(x.why || '').slice(0, 70)}`, 36, h - 110 + i * 34); });
});
const incBoard = screen(10.5, 4.7, incTex.tex, IX, 2.75, IZ - ID / 2 + 0.25, 0, scene, 0.08);
clickable(incBoard.group || incBoard, { type: 'incubator', tip: 'Shadow book: open the incubator' });
INC_STAFF.forEach(d => addAgent(d));
function traineeSign(a) {
  const t = canvasTex(512, 150, (g, w, h) => {
    const x = a.inc; g.clearRect(0, 0, w, h); if (!x) return;
    const f = x.fwd || {}, need = snap?.incubator?.rules?.grad_trades || 8;
    g.fillStyle = 'rgba(5,20,10,.84)'; g.beginPath(); g.roundRect(4, 4, w - 8, h - 8, 22); g.fill();
    g.fillStyle = hex(a.accent); g.fillRect(4, 26, 8, h - 52);
    g.fillStyle = '#ecfdf5'; g.font = font(34, 800); g.fillText(String(x.name).slice(0, 24), 28, 52);
    g.fillStyle = '#14532d'; g.fillRect(28, 78, 300, 14); g.fillStyle = '#4ade80'; g.fillRect(28, 78, 300 * Math.min(1, (f.n || 0) / need), 14);
    g.fillStyle = '#a7f3d0'; g.font = "600 26px 'JetBrains Mono'"; g.fillText(`${f.n || 0}/${need}`, 340, 92);
    g.fillText(f.n ? `PF ${(+f.pf).toFixed(2)} · ${f.ret >= 0 ? '+' : ''}${(f.ret * 100).toFixed(1)}%` : 'no forward trades yet', 28, 130);
  });
  const sign = new THREE.Mesh(new THREE.PlaneGeometry(2.05, 0.6), new THREE.MeshBasicMaterial({ map: t.tex, transparent: true, toneMapped: false, depthWrite: false }));
  sign.position.set(a.seat[0], 2.55, a.seat[1] - 1.35); scene.add(sign);
  a.station = { rug: null, sign, tex: t };
}
const trainees = new Map();              // incubator item id -> trainee agent id
let traineesSeen = false;
function syncTrainees(I) {
  if (!I) return;
  const items = I.items || [], act = items.filter(x => x.status === 'incubating');
  const used = new Set([...trainees.values()].map(id => agents[id]?.slot).filter(s => s != null));
  for (const x of act) {
    const aid = 'inc:' + x.id;
    if (agents[aid]) { agents[aid].inc = x; agents[aid].station?.tex.redraw(); continue; }
    let slot = 0; while (used.has(slot) && slot < TRAINEE_SEATS.length) slot++;
    if (slot >= TRAINEE_SEATS.length) continue;
    used.add(slot);
    const a = addAgent({ id: aid, name: TRAINEE_NAMES[slot], role: `Trainee · "${x.name}" (incubating)`, seat: TRAINEE_SEATS[slot], accent: TRAINEE_COLS[slot], jacket: 0x14532d, badge: 600 + slot });
    a.slot = slot; a.inc = x; trainees.set(x.id, aid); traineeSign(a);
    if (traineesSeen) act2(a, 'new');
  }
  for (const [iid, aid] of trainees) {
    const x = items.find(y => y.id === iid), a = agents[aid];
    if (!a) { trainees.delete(iid); continue; }
    if (!x || x.status !== 'incubating') { trainees.delete(iid); traineeLeaves(a, x); }
  }
  traineesSeen = true;
}
function act2(a, why) { if (why === 'new') act(a.id, fx(b => feel(b, 'happy', 6000)), anim('wave', 1600), say('Hi! New trainee. Proving myself forward, no capital yet.', 2800)); }
function traineeLeaves(a, x) {
  if (a.leaving) return;
  a.leaving = true;
  if (x?.status === 'graduated') {
    feel(a, 'happy', 30000); confetti(a.x, 2.2, a.z, 90); launchFireworks(IX, IZ, 5);
    act('juno', anim('clap', 2000), say(`${a.name} graduates! "${x.name}" earned a desk on the trading floor.`, 4200));
    act(a.id, anim('celebrate', 2600), say('I made it! See you on the trading floor.', 2600), go(POI.exchange, true), fx(() => removeAgent(a.id)));
  } else {
    feel(a, 'sad', 30000);
    act(a.id, anim('slump', 1800), say(x ? `Dropped: ${String(x.why || '').slice(0, 60)}.` : 'Leaving the incubator.', 3000), go({ x: IB_X1 + 0.6, z: AISLE }), fx(() => removeAgent(a.id)));
  }
}
function incIdle(a) {
  const I = snap?.incubator;
  if (a.id === 'juno') {
    const ts = [...trainees.values()].map(id => agents[id]).filter(b => b && !b.leaving);
    if (ts.length && Math.random() < 0.6) { const b = choose(ts), f = b.inc?.fwd || {}, need = I?.rules?.grad_trades || 8;
      act('juno', go(deskVisit(b.id)), faceTo(b.x, b.z), say(f.n ? `${b.name}: ${f.n} forward trades, PF ${(+f.pf).toFixed(2)}. ${Math.max(0, need - f.n)} to go.` : `${b.name}, no forward trades yet. Patience: the market decides.`, 3200), home());
      act(b.id, wait(3500), fx(c => c.swivelUntil = performance.now() + 4000), anim('nod', 1200)); return; }
    act('juno', go(INC_POT), fx(c => c.face = Math.PI), anim('point', 1600), say(choose(['Watering the plants.', 'Growth takes time. So do track records.', 'No capital, no risk, just evidence.']), 2600), home());
    return;
  }
  const f = a.inc?.fwd || {};
  act(a.id, anim(choose(['phone', 'point', 'nod', 'explain']), 1800), say(choose([f.n ? `${f.n} forward trades so far.` : 'Waiting for my first live signal.', 'Shadow book only: no capital until I prove it.', 'Every trade counts from here on.']), 2400));
}

// ── JB OPS CENTER: mission control for the city's machines, west of the Study Hall (6th sky bridge) ──
const OX = -172, OZ = -2, OW = 26, OD = 16, OB_X0 = OX + OW / 2, OB_X1 = HX - HW / 2;
const OPS_STAFF = [
  { id: 'nova', name: 'Nova', role: 'Site reliability · servers & data feeds', seat: [OX - 3.5, OZ + 2.2], accent: 0x38bdf8, jacket: 0x0f3b5f, badge: 700, headset: true },
  { id: 'kip',  name: 'Kip',  role: 'Broker ops · Alpaca link & kill switch',  seat: [OX + 3.5, OZ + 2.2], accent: 0xf97316, jacket: 0x7c2d12, badge: 701 },
];
const OPS_IDS = new Set(OPS_STAFF.map(d => d.id));
const OPS_CAM = [new THREE.Vector3(OX + 3, 6.5, OZ + 17), new THREE.Vector3(OX, 2.2, OZ - 4)];
const OPS_WALL = { x: OX, z: OZ - OD / 2 + 3.2 }, OPS_RACKS = { x: OX - OW / 2 + 2.6, z: OZ + 0.4 };
const spinners = [];                     // things the loop turns (the radar)
skyBridge(OB_X0, OB_X1);
{
  tower(OX, OZ, OW + 4, OD + 6, 'ops');
  const grid = canvasTex(256, 256, (g, w, h) => { g.fillStyle = '#0d1520'; g.fillRect(0, 0, w, h); g.strokeStyle = 'rgba(56,189,248,.22)'; g.lineWidth = 2;
    for (let i = 0; i <= w; i += 32) { g.beginPath(); g.moveTo(i, 0); g.lineTo(i, h); g.stroke(); g.beginPath(); g.moveTo(0, i); g.lineTo(w, i); g.stroke(); } });
  grid.tex.wrapS = grid.tex.wrapT = THREE.RepeatWrapping; grid.tex.repeat.set(8, 5);
  const fl = new THREE.Mesh(new THREE.PlaneGeometry(OW, OD), new THREE.MeshStandardMaterial({ map: grid.tex, emissiveMap: grid.tex, emissive: 0xffffff, emissiveIntensity: 0.35, roughness: 0.4, metalness: 0.3 }));
  fl.rotation.x = -Math.PI / 2; fl.position.set(OX, 0.005, OZ); fl.receiveShadow = true; scene.add(fl); groundLayer(fl, 1);
  box(OW + 0.4, 0.4, OD + 0.4, std(0x2a2d33, 0.7, 0.2), OX, -0.2, OZ);
  roofSlabs.ops = box(OW + 0.4, 0.3, OD + 0.4, soffit, OX, 5.6, OZ, scene, false);
  const gapA = AISLE - 1.6, gapB = AISLE + 1.6, z0 = OZ - OD / 2, z1 = OZ + OD / 2;
  for (const [w, d, x, z] of [[OW, 0.05, OX, z0], [OW, 0.05, OX, z1], [0.05, OD, OX - OW / 2, OZ], [0.05, gapA - z0, OB_X0, (z0 + gapA) / 2], [0.05, z1 - gapB, OB_X0, (gapB + z1) / 2]]) {
    mesh(new THREE.BoxGeometry(w, 5.4, d), glass, x, 2.8, z, scene, false);
    const n = Math.max(1, Math.round(Math.max(w, d) / 3.2));
    for (let i = 0; i <= n; i++) box(0.08, 5.4, 0.08, mull, w > d ? x - w / 2 + i * w / n : x, 2.7, w > d ? z : z - d / 2 + i * d / n, scene, false);
  }
  for (const x of [OX - 8, OX, OX + 8]) mesh(new THREE.BoxGeometry(5, 0.05, 1.2), glow(0xd6f0ff, 1.4), x, 5.42, OZ + 1, scene, false);
  const sign = canvasTex(1024, 192, (g) => { g.clearRect(0, 0, 1024, 192); g.fillStyle = '#ffffff'; g.font = font(96, 800); g.fillText('JB OPS CENTER', 14, 130); });
  const sp = new THREE.Mesh(new THREE.PlaneGeometry(17, 3.2), new THREE.MeshBasicMaterial({ map: sign.tex, transparent: true, toneMapped: false }));
  sp.position.set(OX, -6.5, OZ + OD / 2 + 3.45); scene.add(sp);
  const rp = sp.clone(); rp.scale.setScalar(0.7); rp.position.set(OX, 6.9, OZ - OD / 2 + 0.3); scene.add(rp);
  for (const d of OPS_STAFF) desk(d.seat, d.accent);
  for (const x of [OX - 8.5, OX + 8.5]) desk([x, OZ + 2.2], 0x38bdf8);                      // spare consoles
  // server racks along the south wall, LEDs blinking with the rest of the city's
  for (let k = 0; k < 5; k++) { const rz = OZ - 5.6 + k * 2.4;                               // racks on the west wall, facing the room
    box(0.9, 2.6, 1.2, std(0x14171c, 0.35, 0.6), OX - OW / 2 + 0.9, 1.3, rz);
    for (let i = 0; i < 10; i++) leds.push(bar(0.02, 0.03, 0.9, i % 3 ? 0x38bdf8 : 0x22c55e, OX - OW / 2 + 1.37, 0.3 + i * 0.22, rz, 1.6)); }
  plant(OX - OW / 2 + 1.2, OZ + OD / 2 - 1.2, 1); plant(OX + OW / 2 - 1.4, OZ - OD / 2 + 1.2, 1);
  clickable(fl, { type: 'ops', tip: 'JB Ops Center: is the city healthy?' });
  // the rooftop radar (turned by the loop)
  const radar = new THREE.Group(); radar.position.set(OX + 6, 8.6, OZ - 2); scene.add(radar);
  mesh(new THREE.SphereGeometry(1.8, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2.4), std(0xe8edf2, 0.4, 0.3), 0, 0.4, 0.3, radar, false).rotation.x = -1.1;
  mesh(new THREE.CylinderGeometry(0.05, 0.05, 1.4, 6), std(0x9aa1ab, 0.3, 0.9), 0, 0.9, 1.0, radar, false).rotation.x = -1.1;
  mesh(new THREE.SphereGeometry(0.14, 8, 6), glow(0x38bdf8, 2.4), 0, 1.4, 1.5, radar, false);
  mesh(new THREE.CylinderGeometry(0.25, 0.35, 2.4, 10), std(0x9aa1ab, 0.3, 0.9), OX + 6, 7.0, OZ - 2, scene, false);
  spinners.push({ obj: radar, w: 0.6 });
}
// mission control wall: SYSTEM · FEEDS · BROKER & RISK
function opsPanel(title, accent, draw) {
  return canvasTex(1024, 576, (g, w, h) => { g.fillStyle = '#060b13'; g.fillRect(0, 0, w, h); g.fillStyle = accent; g.fillRect(0, 0, w, 8);
    g.fillStyle = '#8fb3d9'; g.font = font(34, 800); g.fillText(title, 32, 62); if (snap) draw(g, w, h); });
}
const kv = (g, k, v, y, col = '#e6f1ff') => { g.fillStyle = '#7f95b3'; g.font = font(28, 600); g.fillText(k, 32, y); g.fillStyle = col; g.font = "600 34px 'JetBrains Mono'"; g.textAlign = 'right'; g.fillText(v, 990, y); g.textAlign = 'left'; };
const opsSysTex = opsPanel('SYSTEM', '#38bdf8', (g) => { const O = snap.ops || {};
  const up = O.uptime || 0; kv(g, 'Uptime', up > 86400 ? (up / 86400).toFixed(1) + ' days' : up > 3600 ? (up / 3600).toFixed(1) + ' h' : Math.round(up / 60) + ' min', 140);
  kv(g, 'Floor loop', O.loop_avg == null ? '—' : `${O.loop_avg}s avg · ${O.loop_max}s max`, 210, (O.loop_avg || 0) > 30 ? '#f87171' : '#e6f1ff');
  kv(g, 'Memory', O.rss_mb == null ? '—' : O.rss_mb + ' MB', 280); kv(g, 'Load', O.load ? `${O.load[0]} on ${O.cpus} cpus` : `${O.cpus || '?'} cpus`, 350);
  kv(g, 'Disk free', O.disk ? O.disk.free_gb + ' GB' : '—', 420); kv(g, 'Errors since restart', String(O.error_count || 0), 490, O.error_count ? '#f87171' : '#4ade80'); });
const opsFeedTex = opsPanel('DATA FEEDS', '#22c55e', (g) => { const F = Object.entries(snap.ops?.feeds || {});
  F.slice(0, 6).forEach(([k, a], i) => { const y = 132 + i * 72, ok = a < ((snap.ops?.stale_after || {})[k] || 900);
    g.fillStyle = ok ? 'rgba(34,197,94,.16)' : 'rgba(244,63,94,.2)'; g.fillRect(28, y - 44, 968, 60); g.fillStyle = ok ? '#22c55e' : '#f43f5e'; g.beginPath(); g.arc(60, y - 14, 12, 0, 7); g.fill();
    g.fillStyle = '#e6f1ff'; g.font = font(30, 700); g.fillText(k, 88, y - 4); g.font = "600 30px 'JetBrains Mono'"; g.textAlign = 'right'; g.fillText(a < 90 ? a + 's ago' : Math.round(a / 60) + 'm ago', 980, y - 4); g.textAlign = 'left'; });
  if (!F.length) { g.fillStyle = '#7f95b3'; g.font = font(30, 500); g.fillText('Waiting for the first loop…', 32, 150); } });
const opsBrokerTex = opsPanel('BROKER & RISK', '#f97316', (g) => { const b = snap.broker_link || {}, ac = b.account || {}, M = snap.margin || {};
  kv(g, 'Alpaca', !b.configured ? 'not connected' : b.killed ? 'KILL SWITCH' : b.error ? 'error' : b.enabled ? (b.live ? 'LIVE' : 'paper · mirroring') : 'off', 140, b.killed || b.error ? '#f87171' : '#4ade80');
  kv(g, 'Broker equity', ac.equity == null ? '—' : money(ac.equity), 210);
  kv(g, 'Open risk / budget', `${money(snap.open_risk)} / ${money(snap.equity * snap.settings.MAX_TOTAL_RISK)}`, 280);
  kv(g, 'Gross / net', `${(snap.gross / snap.equity * 100).toFixed(0)}% / ${(snap.net / snap.equity * 100).toFixed(0)}%`, 350);
  kv(g, 'Margin', M.max_gross > 1 ? `${M.max_gross.toFixed(2)}x · borrowed ${money(M.borrowed || 0)}` : 'off (cash only)', 420);
  kv(g, 'Max drawdown', `${(snap.maxdd * 100).toFixed(2)}%`, 490, snap.maxdd < -0.1 ? '#f87171' : '#e6f1ff'); });
for (const [t, x] of [[opsSysTex, OX - 8.2], [opsFeedTex, OX], [opsBrokerTex, OX + 8.2]]) { const s = screen(7.6, 4.28, t.tex, x, 2.9, OZ - OD / 2 + 0.25, 0, scene, 0.08); clickable(s.group || s, { type: 'ops', tip: 'Ops Center: system health' }); }
OPS_STAFF.forEach(d => addAgent(d));
function opsIdle(a) {
  const O = snap?.ops || {}, b = snap?.broker_link || {}, stale = Object.entries(O.feeds || {}).filter(([k, s]) => s > ((O.stale_after || {})[k] || 900));
  if (a.id === 'nova') {
    if (Math.random() < 0.45) { act('nova', go(OPS_RACKS), fx(c => c.face = -Math.PI / 2), anim('point', 1600), say(choose(['Racks are cool and quiet.', 'Checking disk and memory.', `Memory at ${O.rss_mb ?? '?'} MB. Fine.`]), 2600), home()); return; }
    act('nova', go(OPS_WALL), fx(c => c.face = Math.PI), say(stale.length ? `${stale[0][0]} feed is stale. Watching it.` : `All ${Object.keys(O.feeds || {}).length} feeds fresh. Loop at ${O.loop_avg ?? '?'}s.`, 3000), home()); return;
  }
  act('kip', anim(choose(['phone', 'explain', 'nod']), 1800), say(choose([b.configured ? `Alpaca ${b.live ? 'LIVE' : 'paper'} link ${b.killed ? 'KILLED' : b.error ? 'erroring' : 'healthy'}.` : 'Broker link offline.',
    'Kill switch armed at 3% daily loss.', `Margin ${(snap?.margin?.max_gross || 1) > 1 ? 'on' : 'off'}.`]), 2600));
}
// ── a holographic ticker ring floating over the trading hall (one draw call, turns slowly) ──
const ringTex = canvasTex(2048, 64, (g, w, h) => {
  g.clearRect(0, 0, w, h); g.fillStyle = 'rgba(8,14,30,.5)'; g.fillRect(0, 0, w, h);
  g.fillStyle = 'rgba(124,140,255,.9)'; g.fillRect(0, 0, w, 3); g.fillRect(0, h - 3, w, 3);
  const items = snap ? Object.entries(snap.markets) : []; g.font = "600 34px 'JetBrains Mono'"; let x = 16;
  if (!items.length) { g.fillStyle = '#a5b4fc'; g.fillText('JB CAPITAL · AI MULTI-STRATEGY FUND', x, 45); return; }
  for (let pass = 0; x < w && pass < 4; pass++) for (const [s, m] of items) { const t = `${s} ${fmtPx(m.px)} ${m.chg >= 0 ? '▲' : '▼'}${Math.abs(m.chg * 100).toFixed(2)}%    `;
    g.fillStyle = m.chg >= 0 ? '#4ade80' : '#fb7185'; g.fillText(t, x, 45); x += g.measureText(t).width; if (x > w) break; }
});
ringTex.tex.wrapS = THREE.RepeatWrapping; ringTex.tex.repeat.set(2, 1);
const tickerRing = new THREE.Mesh(new THREE.CylinderGeometry(7, 7, 0.85, 72, 1, true),
  new THREE.MeshBasicMaterial({ map: ringTex.tex, transparent: true, toneMapped: false, depthWrite: false }));
tickerRing.position.set(0, FH - 1.35, AISLE + 1.5); scene.add(tickerRing); flyIgnore.add(tickerRing);
spinners.push({ obj: tickerRing, w: -0.07 });

// ── the Beat-the-Bots kiosk in the fund lounge (two screens back to back) ──
const kioskTex = canvasTex(512, 320, (g, w, h) => {
  g.fillStyle = '#0b1020'; g.fillRect(0, 0, w, h); g.fillStyle = '#facc15'; g.font = font(40, 900); g.fillText('BEAT THE BOTS', 30, 62);
  const A = snap?.arena, sc = A?.score; g.font = font(24, 600); g.fillStyle = '#a5b4fc'; g.fillText('Call tomorrow. Sam grades it.', 30, 100);
  if (!sc) return;
  [['YOU', sc.jason, '#facc15'], ['AVA', sc.ava, '#22d3ee'], ['TREND BOT', sc.trend, '#a78bfa']].forEach(([n, s, col], i) => { const y = 160 + i * 52;
    g.fillStyle = col; g.font = font(30, 800); g.fillText(n, 30, y); g.fillStyle = '#e6ebf5'; g.font = "600 30px 'JetBrains Mono'"; g.textAlign = 'right';
    g.fillText(s.n ? `${s.hits}/${s.n}  ${Math.round(s.rate * 100)}%` : '—', w - 30, y); g.textAlign = 'left'; });
  g.fillStyle = '#7f95b3'; g.font = font(20, 600); g.fillText(`${(A.open || []).length} open call${(A.open || []).length === 1 ? '' : 's'}`, 30, h - 22);
});
{ const g = new THREE.Group(); g.position.set(0, 0, FZ - 1.4); scene.add(g);
  mesh(new THREE.BoxGeometry(0.16, 1.3, 0.16), metal, 0, 0.65, 0, g); mesh(new THREE.BoxGeometry(0.7, 0.05, 0.5), metal, 0, 0.03, 0, g);
  for (const ry of [0, Math.PI]) { const s = screen(1.6, 1.0, kioskTex.tex, 0, 1.75, ry ? -0.04 : 0.04, ry, g, 0.05); }
  clickable(g, { type: 'arena', tip: 'Beat the Bots: call a market, Sam grades it' }); }

// ── the opening bell (brass, on a stand by the video wall): rung at 9:30 and 4:00 New York time, or by you ──
const animHooks = [];                    // per-frame callbacks (dt, now) for small props
const bell = (() => {
  const g = new THREE.Group(); g.position.set(-2.75, 0, -11); scene.add(g);
  const brass = std(0xd4a72c, 0.22, 0.95), wood = std(0x3b2414, 0.55, 0.1);
  mesh(new THREE.BoxGeometry(1.5, 0.12, 0.7), wood, 0, 0.06, 0, g);                                     // plinth
  for (const sx of [-0.6, 0.6]) mesh(new THREE.BoxGeometry(0.1, 2.1, 0.1), wood, sx, 1.15, 0, g);        // two posts
  mesh(new THREE.BoxGeometry(1.42, 0.12, 0.14), wood, 0, 2.2, 0, g);                                      // crossbeam
  const pivot = new THREE.Group(); pivot.position.set(0, 2.12, 0); g.add(pivot);
  const prof = [[0.001, 0], [0.07, -0.01], [0.11, -0.05], [0.13, -0.14], [0.15, -0.26], [0.2, -0.38], [0.28, -0.47], [0.33, -0.52], [0.33, -0.55]];
  mesh(new THREE.LatheGeometry(prof.map(([x, y]) => new THREE.Vector2(x, y)), 28), brass, 0, 0, 0, pivot).material.side = THREE.DoubleSide;
  mesh(new THREE.SphereGeometry(0.06, 10, 8), metal, 0, -0.5, 0, pivot);
  zoneLabel(-2.75, -10.2, 'OPENING BELL', 3);
  clickable(g, { type: 'bell', tip: 'The opening bell: ring it' });
  const b = { g, pivot, start: 0 };
  animHooks.push((dt, now) => { const t = (now - b.start) / 1000; b.pivot.rotation.z = t < 3 ? Math.sin(t * 14) * 0.55 * (1 - t / 3) : 0; });
  return b;
})();
function ringBell(line) {
  if (line && /You rang/.test(line)) { achMark('bell'); setTimeout(() => checkAch(true), 500); }
  bell.start = performance.now(); beep([1318, 1976, 1318, 1568], 'sine', 0.07, 0.22);
  for (const a of Object.values(agents)) if (inFund(a) && !a.hidden) setTimeout(() => gest(a, a.seated ? 'clap' : 'cheer', 2200), 300 + Math.random() * 700);
  if (line && agents.boss) act('boss', anim('celebrate', 1600), say(line, 4200));
}
setInterval(() => {                      // the real opening and closing bells (weekdays, New York time)
  const p = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date());
  const get = k => p.find(x => x.type === k)?.value, wd = get('weekday'), hm = `${get('hour')}:${get('minute')}`;
  if (wd === 'Sat' || wd === 'Sun') return;
  const which = hm === '09:30' ? 'open' : hm === '16:00' ? 'close' : null; if (!which) return;
  const key = `jb.bell.${new Date().toLocaleDateString('en-CA')}.${which}`; if (lsGet(key)) return; lsSet(key, '1');
  ringBell(which === 'open' ? 'There\'s the bell. US markets are open: let\'s trade the plan.' : 'Closing bell. Good session, team. Stops are in for the night.');
}, 20000);

// ── Jason's desk: the owner's seat at the end of the PM row (gold) ──
const MY_SEAT = [15, PM_Z];
const myDesk3d = (() => {
  const g = desk(MY_SEAT, 0xfacc15, false, true);
  const rug = new THREE.Mesh(new THREE.PlaneGeometry(3.4, 2.9), new THREE.MeshBasicMaterial({ color: 0xfacc15, transparent: true, opacity: 0.16, depthWrite: false }));
  rug.rotation.x = -Math.PI / 2; rug.position.set(MY_SEAT[0], 0.02, MY_SEAT[1] - 0.45); scene.add(rug);
  const t = canvasTex(512, 150, (c, w, h) => {
    const M = snap?.mydesk; c.clearRect(0, 0, w, h);
    c.fillStyle = 'rgba(6,10,18,.85)'; c.beginPath(); c.roundRect(4, 4, w - 8, h - 8, 22); c.fill();
    c.fillStyle = '#facc15'; c.fillRect(4, 26, 8, h - 52);
    c.fillStyle = '#ffffff'; c.font = font(44, 800); c.fillText('Jason', 30, 58);
    c.fillStyle = '#facc15'; c.font = font(24, 800); c.fillText("OWNER'S DESK", 170, 56);
    if (!M) return;
    const tot = (M.realized || 0) + (M.upl || 0);
    c.fillStyle = tot >= 0 ? '#22c55e' : '#f43f5e'; c.font = "700 40px 'JetBrains Mono'"; c.textAlign = 'right'; c.fillText(money(tot), w - 24, 58); c.textAlign = 'left';
    c.fillStyle = '#9aa6bf'; c.font = "500 28px 'JetBrains Mono'";
    c.fillText(M.open.length ? `${M.open.length} open · ${M.open.map(p => p.sym).join(' ')}` : 'flat · press E for a ticket', 30, 112);
  });
  const sign = new THREE.Mesh(new THREE.PlaneGeometry(2.05, 0.6), new THREE.MeshBasicMaterial({ map: t.tex, transparent: true, toneMapped: false, depthWrite: false }));
  sign.position.set(MY_SEAT[0], 2.6, MY_SEAT[1] - 1.35); scene.add(sign);
  clickable(g, { type: 'mydesk', tip: 'Your desk: place a trade (paper)' });
  return { tex: t };
})();

// ── the Mental Math Arena cabinet in the Study Hall ──
{ const g = new THREE.Group(); g.position.set(HX + 10.6, 0, HZ + 4.4); g.rotation.y = -Math.PI / 2; scene.add(g);
  mesh(new THREE.BoxGeometry(1.1, 1.9, 0.9), std(0x312e81, 0.5, 0.3), 0, 0.95, 0, g);
  const t = canvasTex(256, 192, (c, w, h) => { c.fillStyle = '#0b1020'; c.fillRect(0, 0, w, h); c.fillStyle = '#facc15'; c.font = font(38, 900); c.fillText('MATH', 76, 72); c.fillText('ARENA', 62, 116);
    c.fillStyle = '#a5b4fc'; c.font = "600 24px 'JetBrains Mono'"; c.fillText('47 × 8 = ?', 64, 164); });
  const scr = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.68), new THREE.MeshBasicMaterial({ map: t.tex, toneMapped: false })); scr.position.set(0, 1.45, 0.46); g.add(scr);
  mesh(new THREE.BoxGeometry(1.1, 0.12, 0.5), std(0x1e1b4b, 0.5, 0.3), 0, 1.0, 0.6, g);
  mesh(new THREE.BoxGeometry(1.14, 0.08, 0.94), glow(0x818cf8, 1.4), 0, 1.92, 0, g, false);
  clickable(g, { type: 'math', tip: 'Mental Math Arena: a Zetamac-style 120-second drill' }); }

// ── Opal's options book: a standing screen between her desk and Rita's with a live payoff sketch ──
const optKiosk = (() => {
  const g = new THREE.Group(); g.position.set(-9.25, 0, -11); scene.add(g);
  mesh(new THREE.CylinderGeometry(0.05, 0.08, 1.5, 10), metal, 0, 0.75, 0, g); mesh(new THREE.CylinderGeometry(0.3, 0.34, 0.05, 18), metal, 0, 0.03, 0, g);
  const t = canvasTex(512, 300, (c, w, h) => {
    c.fillStyle = '#071018'; c.fillRect(0, 0, w, h); c.fillStyle = '#2dd4bf'; c.font = font(28, 800); c.fillText("OPAL'S OPTIONS BOOK", 20, 40);
    if (!snap) return;                       // first draw happens at load, before the payoff helpers below exist
    const S = optStructs(); c.font = "500 20px 'JetBrains Mono'";
    if (!S.length) { c.fillStyle = '#9aa6bf'; c.fillText('No open structures. Press E to look.', 20, 90); return; }
    const s0 = S[0], P = payoffCurve(s0, 0.75, 1.25, 80, true), lo = Math.min(...P.map(p => p[1])), hi = Math.max(...P.map(p => p[1]));
    const X = i => 20 + i / (P.length - 1) * (w - 40), Y = v => 70 + (1 - (v - lo) / (hi - lo || 1)) * (h - 110);
    c.strokeStyle = '#334155'; c.beginPath(); c.moveTo(20, Y(0)); c.lineTo(w - 20, Y(0)); c.stroke();
    c.strokeStyle = '#2dd4bf'; c.lineWidth = 4; c.beginPath(); P.forEach((p, i) => i ? c.lineTo(X(i), Y(p[1])) : c.moveTo(X(i), Y(p[1]))); c.stroke();
    const sx = 20 + (s0.spot - P[0][0]) / (P.at(-1)[0] - P[0][0]) * (w - 40); c.strokeStyle = '#facc15'; c.lineWidth = 2; c.beginPath(); c.moveTo(sx, 60); c.lineTo(sx, h - 36); c.stroke();
    c.fillStyle = '#e2e8f0'; c.fillText(`${s0.sym} · ${s0.dte.toFixed(1)}d · P&L ${money(s0.upl)}`, 20, h - 10);
  });
  const scr = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 0.88), new THREE.MeshBasicMaterial({ map: t.tex, toneMapped: false })); scr.position.set(0, 1.95, 0); g.add(scr);
  mesh(rbox(1.58, 0.96, 0.05, 0.02), std(0x0a0c10, 0.35, 0.5), 0, 1.95, -0.04, g);
  scr.rotation.y = 0; clickable(g, { type: 'payoff', tip: "Opal's options book: payoff chart" });
  return { tex: t };
})();

// ── the trophy shelf next to Jason's desk: one cup per achievement, gold when earned ──
const trophyShelf = (() => {
  const g = new THREE.Group(); g.position.set(17.7, 0, -8.6); g.rotation.y = -Math.PI / 2; scene.add(g);
  const wood = std(0x3b2414, 0.55, 0.1);
  for (const sx of [-1.15, 1.15]) mesh(new THREE.BoxGeometry(0.06, 2.1, 0.4), wood, sx, 1.05, 0, g);
  for (const y of [0.1, 0.75, 1.4, 2.05]) mesh(new THREE.BoxGeometry(2.36, 0.05, 0.4), wood, 0, y, 0, g);
  const gold = std(0xd4a72c, 0.22, 0.95), dim = std(0x3a3f4a, 0.6, 0.3), cups = [];
  for (let i = 0; i < 21; i++) {
    const c = new THREE.Group(), row = Math.floor(i / 7), col = i % 7;
    c.position.set(-0.93 + col * 0.31, 0.13 + row * 0.65, 0); g.add(c);
    const parts = [mesh(new THREE.CylinderGeometry(0.05, 0.06, 0.04, 10), dim, 0, 0.02, 0, c), mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.1, 6), dim, 0, 0.09, 0, c),
      mesh(new THREE.CylinderGeometry(0.075, 0.03, 0.12, 14), dim, 0, 0.2, 0, c)];
    cups.push({ c, parts });
  }
  const t = canvasTex(512, 80, (c, w, h) => { c.clearRect(0, 0, w, h); c.fillStyle = 'rgba(6,10,18,.85)'; c.beginPath(); c.roundRect(2, 2, w - 4, h - 4, 16); c.fill();
    c.fillStyle = '#facc15'; c.font = font(34, 800); c.textAlign = 'center'; c.fillText(snap ? `TROPHIES ${achUnlocked().length}/${ACH_N}` : 'TROPHIES', w / 2, 54); });   // first draw is at load, before the helpers exist
  const sign = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 0.25), new THREE.MeshBasicMaterial({ map: t.tex, transparent: true, toneMapped: false, depthWrite: false }));
  sign.position.set(0, 2.3, 0.05); g.add(sign);
  clickable(g, { type: 'trophies', tip: 'Trophy case: your achievements' });
  return { cups, tex: t, gold, dim, paint() { const got = new Set(achUnlocked()); ACH_LIST().forEach((a, i) => { const cup = cups[i]; if (!cup) return;
    for (const p of cup.parts) p.material = got.has(a.id) ? gold : dim; }); t.redraw(); } };
})();

// ── the podium in front of the NAV wall: Jason's floor announcements ──
const PODIUM = { x: 0, z: -13.4 };
{ const g = new THREE.Group(); g.position.set(PODIUM.x, 0, PODIUM.z); scene.add(g);
  const wood = std(0x2a1a0e, 0.5, 0.15);
  mesh(new THREE.BoxGeometry(2.2, 0.16, 1.4), std(0x1c2230, 0.6, 0.2), 0, 0.08, 0, g);                 // the riser
  mesh(new THREE.BoxGeometry(0.9, 1.1, 0.5), wood, 0, 0.71, 0.25, g);                                    // the lectern
  mesh(new THREE.BoxGeometry(1.0, 0.06, 0.62), wood, 0, 1.28, 0.22, g).rotation.x = -0.25;
  const t = canvasTex(256, 256, (c, w, h) => { c.fillStyle = '#0b1020'; c.fillRect(0, 0, w, h); c.fillStyle = '#facc15'; c.font = font(120, 900); c.textAlign = 'center'; c.fillText('JB', w / 2, 150);
    c.font = font(30, 700); c.fillStyle = '#e2e8f0'; c.fillText('CAPITAL', w / 2, 200); });
  const logo = new THREE.Mesh(new THREE.PlaneGeometry(0.62, 0.62), new THREE.MeshBasicMaterial({ map: t.tex, toneMapped: false })); logo.position.set(0, 0.78, 0.505); g.add(logo);
  mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.4, 6), metal, 0.18, 1.45, 0.3, g).rotation.x = 0.5;   // the microphone
  mesh(new THREE.SphereGeometry(0.04, 10, 8), std(0x111111, 0.4, 0.4), 0.18, 1.63, 0.4, g);
  zoneLabel(PODIUM.x, PODIUM.z + 1.3, 'PODIUM', 2.4);
  clickable(g, { type: 'podium', tip: 'The podium: make a floor announcement' }); }

// ── the Model Lab board behind Kai's desk: what he's training, the last verdicts, which vol models Opal may trade ──
const mlabTex = canvasTex(1024, 576, (g, w, h) => {
  g.fillStyle = '#060d0a'; g.fillRect(0, 0, w, h);
  g.fillStyle = '#a3e635'; g.font = font(32, 800); g.fillText('MODEL LAB · KAI', 36, 56);
  const M = snap?.mlab; if (!M) return;
  g.fillStyle = '#e6ebf5'; g.font = font(26, 600);
  g.fillText(M.running ? (M.current ? `Training: “${M.current.name}” (${M.current.learner}, ${M.current.horizon}d)`.slice(0, 60) : `Working: ${M.status}`) : `Idle · next model in ${Math.ceil(M.next_in / 60)} min`, 36, 104);
  g.fillStyle = '#8692ab'; g.font = font(20, 700); g.fillText(`${M.n_tests} MODELS TESTED · BAR t ≥ ${M.need_t.toFixed(2)}`, 36, 146);
  (M.models || []).slice(0, 5).forEach((m, i) => { const y = 192 + i * 46;
    g.fillStyle = m.passed ? '#22c55e' : '#f43f5e'; g.font = font(22, 800); g.fillText(m.passed ? 'PASS' : 'FAIL', 36, y);
    g.fillStyle = '#e6ebf5'; g.font = font(24, 600); g.fillText(m.name.slice(0, 30), 120, y);
    g.fillStyle = '#c9d1e4'; g.font = "500 21px 'JetBrains Mono'"; g.fillText(`IC ${(m.ic >= 0 ? '+' : '') + m.ic.toFixed(3)} t=${m.ic_t.toFixed(1)}  SR ${m.sharpe.toFixed(2)}`, 600, y); });
  g.fillStyle = '#8692ab'; g.font = font(20, 700); g.fillText('VOL MODELS (OPAL)', 36, 446);
  Object.entries(M.vol || {}).forEach(([s, v], i) => { const x = 36 + (i % 3) * 320, y = 488 + Math.floor(i / 3) * 40;
    g.fillStyle = v.tier === 'model' ? '#22c55e' : v.tier === 'premium' ? '#facc15' : '#64748b'; g.font = font(22, 800); g.fillText(s, x, y);
    g.fillStyle = '#c9d1e4'; g.font = "500 20px 'JetBrains Mono'"; g.fillText(`${(v.tier || '—').toUpperCase()}${v.now?.ratio ? ' ' + v.now.ratio.toFixed(2) + 'x' : ''}`, x + 70, y); });
});
{ const s = screen(4.2, 2.36, mlabTex.tex, -20.5, 2.25, 7.3, 0, scene, 0.06);
  for (const x of [-22.45, -18.55]) box(0.06, 2.3, 0.06, mull, x, 1.15, 7.25, scene, false);
  clickable(s.group, { type: 'mlab', tip: 'Model Lab: Kai\'s models and the volatility models' }); }

// ── the hall's ceiling: acoustic tiles, recessed light panels, sprinklers. Shown only when the camera is inside the hall ──
const hallCeil = (() => {
  const g = new THREE.Group(); scene.add(g);
  const t = canvasTex(256, 256, (c, w, h) => { c.fillStyle = '#d9dbdf'; c.fillRect(0, 0, w, h); c.strokeStyle = '#9ca3af'; c.lineWidth = 3;
    for (let k = 0; k <= 256; k += 128) { c.beginPath(); c.moveTo(k, 0); c.lineTo(k, 256); c.stroke(); c.beginPath(); c.moveTo(0, k); c.lineTo(256, k); c.stroke(); }
    for (let k = 0; k < 900; k++) { c.fillStyle = `rgba(0,0,0,${Math.random() * 0.06})`; c.fillRect(Math.random() * w, Math.random() * h, 1.5, 1.5); } });
  t.tex.wrapS = t.tex.wrapT = THREE.RepeatWrapping; t.tex.repeat.set(FW / 2.4, FD / 2.4);
  const plane = new THREE.Mesh(new THREE.PlaneGeometry(FW, FD), new THREE.MeshStandardMaterial({ map: t.tex, roughness: 0.95, side: THREE.DoubleSide }));
  plane.rotation.x = Math.PI / 2; plane.position.y = FH - 0.25; g.add(plane);
  const lamp = glow(0xfff6e5, 1.25), pts = [];
  for (let x = -24; x <= 24; x += 6) for (let z = -14; z <= 14; z += 4.5) { const p = new THREE.Mesh(new THREE.PlaneGeometry(1.2, 0.6), lamp); p.rotation.x = Math.PI / 2; p.position.set(x, FH - 0.27, z); g.add(p);
    if ((x + z) % 12 === 0) pts.push([x + 1.5, z + 1.2]); }
  for (const [x, z] of pts) mesh(new THREE.CylinderGeometry(0.03, 0.05, 0.07, 8), std(0xd1d5db, 0.3, 0.8), x, FH - 0.3, z, g, false);   // sprinkler heads
  g.traverse(o => flyIgnore.add(o)); g.visible = false;
  return g;
})();
function updateCeiling() { const c = camera.position; hallCeil.visible = c.y < FH - 0.5 && Math.abs(c.x) < FX + 0.2 && Math.abs(c.z) < FZ + 0.2; }

// ── reception: the lobby by the execution elevator (logo wall, front desk, Ari, waiting seats) ──
{
  const wal = std(0x3b2414, 0.45, 0.08), stone = std(0xe7e5e4, 0.35, 0.05);
  const lw = new THREE.Group(); lw.position.set(24.2, 0, 8.85); scene.add(lw);
  box(6.6, 3.5, 0.28, std(0x111318, 0.5, 0.3), 0, 1.75, 0, lw);
  const lt = canvasTex(1024, 512, (g, w, h) => { const gr = g.createLinearGradient(0, 0, w, h); gr.addColorStop(0, '#15120a'); gr.addColorStop(1, '#07080c'); g.fillStyle = gr; g.fillRect(0, 0, w, h);
    for (let k = 0; k < 14; k++) { g.strokeStyle = `rgba(212,167,44,${0.05 + k * 0.006})`; g.beginPath(); g.moveTo(0, 60 + k * 30); g.bezierCurveTo(300, 20 + k * 34, 700, 160 + k * 18, w, 80 + k * 26); g.stroke(); }
    g.fillStyle = '#facc15'; g.font = font(150, 900); g.textAlign = 'center'; g.fillText('JB CAPITAL', w / 2, 270);
    g.fillStyle = '#e5e7eb'; g.font = font(34, 600); g.fillText('AI MULTI-STRATEGY  ·  RESEARCH · RISK · EXECUTION', w / 2, 340);
    g.fillStyle = '#94a3b8'; g.font = font(26, 500); g.fillText('Paper first. Evidence always.', w / 2, 400); });
  const lp = new THREE.Mesh(new THREE.PlaneGeometry(6.3, 3.15), new THREE.MeshBasicMaterial({ map: lt.tex, toneMapped: false })); lp.rotation.y = Math.PI; lp.position.set(0, 1.75, -0.15); lw.add(lp);
  mesh(new THREE.BoxGeometry(6.6, 0.04, 0.1), glow(0xfacc15, 1.4), 0, 3.52, -0.1, lw, false);
  // front desk: stone counter, walnut base, a gold light line
  const rd = new THREE.Group(); scene.add(rd);
  mesh(rbox(3.4, 1.05, 0.6, 0.05), wal, 24.2, 0.53, 6.55, rd); mesh(rbox(3.6, 0.07, 0.75, 0.03), stone, 24.2, 1.09, 6.55, rd);
  mesh(new THREE.BoxGeometry(3.3, 0.03, 0.02), glow(0xfacc15, 1.2), 24.2, 0.75, 6.24, rd, false);
  mesh(rbox(3.2, 0.06, 0.5, 0.02), stone, 24.2, 0.76, 7.0, rd);
  screen(0.55, 0.34, monTexs[1].tex, 23.7, 1.05, 6.85, Math.PI, rd, 0.02);
  mesh(new THREE.CylinderGeometry(0.06, 0.08, 0.12, 14), std(0xf2f2f2, 0.4), 25.1, 0.85, 6.9, rd);
  chair(24.2, 7.85, rd);
  clickable(rd, { type: 'frontdesk', tip: 'Front desk: Ari has your briefing' });
  // waiting seats + a low table
  const fab = std(0x334155, 0.85);
  for (const z of [5.2, 6.4]) { box(0.8, 0.42, 0.8, fab, 20.6, 0.26, z); box(0.18, 0.5, 0.8, fab, 20.2, 0.62, z); }
  mesh(new THREE.CylinderGeometry(0.35, 0.35, 0.04, 24), wal, 21.5, 0.42, 5.8); mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.4, 8), metal, 21.5, 0.2, 5.8);
  zoneLabel(24.2, 5.2, 'RECEPTION', 3.2);
}

// ── the market globe: a holographic Earth in the lobby; each city glows with its market's move today ──
const globe = (() => {
  const g = new THREE.Group(); g.position.set(19.3, 0, 3.6); scene.add(g);
  mesh(new THREE.CylinderGeometry(0.42, 0.55, 0.9, 32), std(0x111318, 0.3, 0.8), 0, 0.45, 0, g);
  mesh(new THREE.TorusGeometry(0.5, 0.025, 8, 48).rotateX(Math.PI / 2), glow(0x22d3ee, 1.8), 0, 0.92, 0, g, false);
  const holo = new THREE.Group(); holo.position.y = 2.05; g.add(holo);
  const R = 0.82;
  holo.add(new THREE.LineSegments(new THREE.WireframeGeometry(new THREE.SphereGeometry(R, 24, 16)), new THREE.LineBasicMaterial({ color: 0x22d3ee, transparent: true, opacity: 0.35 })));
  holo.add(new THREE.Mesh(new THREE.SphereGeometry(R * 0.985, 32, 20), new THREE.MeshBasicMaterial({ color: 0x0e7490, transparent: true, opacity: 0.12, depthWrite: false })));
  const CITIES = [['New York', 40.7, -74, 'SPY'], ['Chicago', 41.9, -87.6, 'QQQ'], ['San Francisco', 37.8, -122.4, 'NVDA'], ['London', 51.5, -0.1, 'EFA'], ['Frankfurt', 50.1, 8.7, 'EFA'],
    ['Tokyo', 35.7, 139.7, 'EEM'], ['Hong Kong', 22.3, 114.2, 'EEM'], ['Mumbai', 19.1, 72.9, 'EEM'], ['Sydney', -33.9, 151.2, 'EEM'], ['São Paulo', -23.5, -46.6, 'EEM']];
  const dots = CITIES.map(([n, lat, lon, sym]) => { const la = lat * Math.PI / 180, lo = lon * Math.PI / 180;
    const m = new THREE.Mesh(new THREE.SphereGeometry(0.045, 10, 8), new THREE.MeshBasicMaterial({ color: 0x22d3ee, toneMapped: false }));
    m.position.set(R * Math.cos(la) * Math.sin(lo), R * Math.sin(la), R * Math.cos(la) * Math.cos(lo)); holo.add(m); return { m, sym }; });
  const orbit = new THREE.Mesh(new THREE.TorusGeometry(1.08, 0.012, 6, 64), new THREE.MeshBasicMaterial({ color: 0xf59e0b, toneMapped: false, transparent: true, opacity: 0.8 }));
  orbit.rotation.x = 1.2; holo.add(orbit);
  const coin = new THREE.Mesh(new THREE.SphereGeometry(0.07, 12, 10), new THREE.MeshBasicMaterial({ color: 0xf59e0b, toneMapped: false })); holo.add(coin);
  spinners.push({ obj: holo, w: 0.25 });
  animHooks.push((dt, now) => { const a = now / 1600; coin.position.set(Math.cos(a) * 1.08, Math.sin(a) * 1.08 * Math.cos(1.2), Math.sin(a) * 1.08 * Math.sin(1.2));
    for (const d of dots) d.m.scale.setScalar(1 + 0.35 * Math.sin(now / 300 + d.m.position.x * 9));
    lab.quaternion.copy(camera.quaternion); });                                                  // the label always faces you
  const t = canvasTex(512, 96, (c, w, h) => { c.clearRect(0, 0, w, h); c.fillStyle = 'rgba(6,10,18,.8)'; c.beginPath(); c.roundRect(2, 2, w - 4, h - 4, 14); c.fill();
    c.fillStyle = '#67e8f9'; c.font = font(30, 800); c.textAlign = 'center'; c.fillText('GLOBAL MARKETS · LIVE', w / 2, 42);
    if (snap?.markets) { c.font = "600 24px 'JetBrains Mono'"; const m = snap.markets, f = s => m[s] ? `${s} ${m[s].chg >= 0 ? '+' : ''}${(m[s].chg * 100).toFixed(1)}%` : '';
      c.fillStyle = '#e2e8f0'; c.fillText([f('SPY'), f('EFA'), f('EEM'), f('BTC')].filter(Boolean).join('  '), w / 2, 78); } });
  const lab = new THREE.Mesh(new THREE.PlaneGeometry(2.0, 0.375), new THREE.MeshBasicMaterial({ map: t.tex, transparent: true, toneMapped: false, depthWrite: false, side: THREE.DoubleSide }));
  lab.position.set(0, 3.25, 0); g.add(lab); flyIgnore.add(lab);
  clickable(g, { type: 'charts', tip: 'Global markets: open the charts' });
  return { paint() { for (const d of dots) { const v = snap?.markets?.[d.sym]?.chg ?? 0; d.m.material.color.set(v > 0.0005 ? 0x22c55e : v < -0.0005 ? 0xf43f5e : 0x22d3ee); }
    const b = snap?.markets?.BTC?.chg ?? 0; coin.material.color.set(b >= 0 ? 0x22c55e : 0xf43f5e); t.redraw(); } };
})();

// ── phone booths (quiet calls), next to the conference room ──
for (const x of [-14.7, -12.7]) {
  const g = new THREE.Group(); g.position.set(x, 0, 12.6); scene.add(g);
  for (const [w, d, px, pz] of [[1.3, 0.05, 0, -0.65], [0.05, 1.3, -0.65, 0], [0.05, 1.3, 0.65, 0]]) mesh(new THREE.BoxGeometry(w, 2.3, d), glass, px, 1.15, pz, g, false);
  mesh(new THREE.BoxGeometry(1.3, 0.08, 1.3), std(0x1f2937, 0.4, 0.5), 0, 2.34, 0, g);
  for (const [px, pz] of [[-0.65, -0.65], [0.65, -0.65], [-0.65, 0.65], [0.65, 0.65]]) box(0.06, 2.34, 0.06, mull, px, 1.17, pz, g, false);
  mesh(new THREE.BoxGeometry(1.3, 0.02, 1.3), std(0x374151, 0.9), 0, 0.012, 0, g, false);
  mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.06, 18), std(0xfbbf24, 0.6), 0, 0.62, -0.1, g); mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.58, 8), metal, 0, 0.3, -0.1, g);
  mesh(new THREE.BoxGeometry(0.9, 0.04, 0.32), std(0x4a2f1c, 0.45), 0, 1.0, -0.45, g);
  mesh(new THREE.CircleGeometry(0.16, 18).rotateX(Math.PI / 2), glow(0xfff1dc, 1.6), 0, 2.29, 0, g, false);
}

// ── decoration: a warmer, richer trading floor ──
const pnlStrip = new THREE.MeshBasicMaterial({ color: 0xfde68a, toneMapped: false });      // the aisle light strips: green / red with today's P&L
function paintStrips() { const r = snap?.day_ret ?? 0, k = Math.min(1, Math.abs(r) / 0.01), base = new THREE.Color(0xfde68a);
  pnlStrip.color.copy(base.lerp(new THREE.Color(r >= 0 ? 0x22c55e : 0xf43f5e), 0.25 + 0.75 * k)).multiplyScalar(1.2 + k); }
{
  // oak walkways with soft light strips on both edges of the main aisle
  const oak = canvasTex(512, 128, (g, w, h) => { for (let y = 0; y < h; y += 16) for (let x = -((y / 16) % 3) * 70; x < w; x += 210) {
      const t = 0.85 + rnd() * 0.25; g.fillStyle = `rgb(${Math.round(176 * t)},${Math.round(134 * t)},${Math.round(92 * t)})`; g.fillRect(x, y, 210, 16); g.strokeStyle = 'rgba(70,45,20,.45)'; g.strokeRect(x + 0.5, y + 0.5, 209, 15); } });
  oak.tex.wrapS = oak.tex.wrapT = THREE.RepeatWrapping; oak.tex.repeat.set(18, 1);
  aisleMat.map = oak.tex; aisleMat.color.set(0xffffff); aisleMat.roughness = 0.5; aisleMat.needsUpdate = true;
  for (const dz of [-0.93, 0.93]) mesh(new THREE.BoxGeometry(FW, 0.012, 0.05), pnlStrip, 0, 0.026, AISLE + dz, scene, false);
  // the JB medallion in the middle of the aisle
  const md = canvasTex(512, 512, (g, w, h) => { g.clearRect(0, 0, w, h); g.fillStyle = '#0b1020'; g.beginPath(); g.arc(256, 256, 250, 0, 7); g.fill();
    g.strokeStyle = '#d4a72c'; g.lineWidth = 10; g.beginPath(); g.arc(256, 256, 236, 0, 7); g.stroke(); g.lineWidth = 3; g.beginPath(); g.arc(256, 256, 214, 0, 7); g.stroke();
    for (let k = 0; k < 24; k++) { const a = k / 24 * Math.PI * 2; g.beginPath(); g.moveTo(256 + Math.cos(a) * 218, 256 + Math.sin(a) * 218); g.lineTo(256 + Math.cos(a) * 232, 256 + Math.sin(a) * 232); g.stroke(); }
    g.fillStyle = '#facc15'; g.font = font(190, 900); g.textAlign = 'center'; g.fillText('JB', 256, 300); g.font = font(30, 700); g.fillStyle = '#e2e8f0'; g.fillText('CAPITAL', 256, 352); });
  const med = new THREE.Mesh(new THREE.CircleGeometry(1.5, 48), new THREE.MeshStandardMaterial({ map: md.tex, transparent: true, roughness: 0.35, metalness: 0.4 }));
  med.rotation.x = -Math.PI / 2; med.position.set(-8, 0.03, AISLE); scene.add(med); flyIgnore.add(med);
  // suspended linear LED fixtures over both desk rows (warm light, slim housings)
  const shade = std(0x111318, 0.35, 0.85), bulb = glow(0xffe8c2, 1.7);
  for (const [x0, x1, z] of [[-17.5, 16.5, PM_Z - 0.95], [-22, 12.5, STAFF_Z - 0.95]]) {
    const L = x1 - x0, cx = (x0 + x1) / 2;
    mesh(new THREE.BoxGeometry(L, 0.07, 0.2), shade, cx, 3.62, z, scene, false);
    mesh(new THREE.BoxGeometry(L - 0.1, 0.012, 0.14), bulb, cx, 3.58, z, scene, false);
    for (const x of [x0 + 0.6, cx, x1 - 0.6]) mesh(new THREE.CylinderGeometry(0.006, 0.006, FH - 3.66, 4), shade, x, (FH + 3.66) / 2, z, scene, false);
    flyIgnore.add(scene.children[scene.children.length - 1]); }
  // hanging JB CAPITAL signs over the aisle
  const sg = canvasTex(1024, 200, (g, w, h) => { g.fillStyle = '#07090f'; g.fillRect(0, 0, w, h); g.strokeStyle = '#d4a72c'; g.lineWidth = 6; g.strokeRect(8, 8, w - 16, h - 16);
    g.fillStyle = '#facc15'; g.font = font(96, 900); g.textAlign = 'center'; g.fillText('JB CAPITAL', w / 2, 112); g.fillStyle = '#cbd5e1'; g.font = font(30, 600); g.fillText('AI MULTI-STRATEGY  ·  PAPER  ·  EST. 2026', w / 2, 166); });
  for (const x of [-19, 19]) { const s = new THREE.Mesh(new THREE.PlaneGeometry(4.6, 0.9), new THREE.MeshBasicMaterial({ map: sg.tex, toneMapped: false, side: THREE.DoubleSide }));
    s.position.set(x, 6.1, AISLE + 2.2); scene.add(s); flyIgnore.add(s);
    for (const dx2 of [-2, 2]) mesh(new THREE.CylinderGeometry(0.01, 0.01, FH - 6.55, 4), shade, x + dx2, (FH + 6.55) / 2, AISLE + 2.2, scene, false); }
  // more greenery between the PM desks and along the south windows
  for (const [x, z, s] of [[-13.75, -10.9, 0.9], [3.75, -10.9, 0.9], [8.25, -10.9, 0.9], [12.75, -10.9, 0.85], [-6.5, 16.2, 1.1], [6.5, 16.2, 1.1], [-27.2, 12.2, 1]]) plant(x, z, s);
  // framed art on the side walls
  const art = (seed, title) => canvasTex(768, 512, (g, w, h) => { g.fillStyle = '#0d1117'; g.fillRect(0, 0, w, h);
    const cols = ['#22d3ee', '#a78bfa', '#facc15', '#f472b6', '#34d399'];
    for (let k = 0; k < 5; k++) { g.strokeStyle = cols[(k + seed) % 5]; g.lineWidth = 3 + k; g.globalAlpha = 0.85 - k * 0.12; g.beginPath(); let y = h * (0.75 - k * 0.05);
      for (let x = 0; x <= w; x += 8) { y += (Math.sin(x / (40 + k * 13) + seed + k) + (rnd() - 0.48)) * (seed === 1 ? 6 + k * 2 : 4) - (seed === 1 ? 0 : 0.6); g.lineTo(x, Math.max(30, Math.min(h - 30, y))); } g.stroke(); }
    g.globalAlpha = 1; g.fillStyle = 'rgba(255,255,255,.75)'; g.font = font(26, 700); g.fillText(title, 24, h - 24); });
  for (const [x, z, ry, seed, title] of [[-FX + 0.08, 8.15, Math.PI / 2, 0, 'THE LONG RUN'], [FX - 0.08, -4.9, -Math.PI / 2, 1, 'VOLATILITY CLUSTERS']]) {
    const t = art(seed, title); box(0.06, 1.75, 2.55, std(0xb8962e, 0.35, 0.8), x, 2.2, z, scene, false);
    const p = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 1.6), new THREE.MeshBasicMaterial({ map: t.tex, toneMapped: false })); p.rotation.y = ry; p.position.set(x + Math.sign(-x) * 0.05, 2.2, z); scene.add(p); }
}

// ── the Market Making Pit cabinet (next to the Math Arena) ──
{ const g = new THREE.Group(); g.position.set(HX + 10.6, 0, HZ + 6.1); g.rotation.y = -Math.PI / 2; scene.add(g);
  mesh(new THREE.BoxGeometry(1.1, 1.9, 0.9), std(0x14532d, 0.5, 0.3), 0, 0.95, 0, g);
  const t = canvasTex(256, 192, (c, w, h) => { c.fillStyle = '#0b1020'; c.fillRect(0, 0, w, h); c.fillStyle = '#4ade80'; c.font = font(34, 900); c.fillText('MARKET', 64, 66); c.fillText('MAKING', 66, 106);
    c.fillStyle = '#86efac'; c.font = "600 24px 'JetBrains Mono'"; c.fillText('13.5 @ 15.5', 52, 160); });
  const scr = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.68), new THREE.MeshBasicMaterial({ map: t.tex, toneMapped: false })); scr.position.set(0, 1.45, 0.46); g.add(scr);
  mesh(new THREE.BoxGeometry(1.1, 0.12, 0.5), std(0x052e16, 0.5, 0.3), 0, 1.0, 0.6, g);
  mesh(new THREE.BoxGeometry(1.14, 0.08, 0.94), glow(0x4ade80, 1.4), 0, 1.92, 0, g, false);
  clickable(g, { type: 'mm', tip: 'Market Making Pit: quote the sum of four dice' }); }

// ── PM of the week: a gold crown over the PM who made the most P&L over the last 7 days (live, 30-min samples) ──
const crown = (() => { const g = new THREE.Group(), m = glow(0xfacc15, 1.6);
  g.add(new THREE.Mesh(new THREE.TorusGeometry(0.17, 0.035, 8, 28).rotateX(Math.PI / 2), m));
  for (let i = 0; i < 5; i++) { const a = i / 5 * Math.PI * 2, c = new THREE.Mesh(new THREE.ConeGeometry(0.045, 0.15, 6), m); c.position.set(Math.cos(a) * 0.17, 0.08, Math.sin(a) * 0.17); g.add(c); }
  g.position.y = 0.34; g.visible = false; return g; })();
spinners.push({ obj: crown, w: 1.4 });
let crownOwner = null;
function pmOfWeek(roster) {
  let best = null, bv = 0;
  for (const p of roster || []) { const h = p.hist || [], v = h.length >= 2 ? h.at(-1)[1] - h[0][1] : p.pnl; if (v > bv && agents[p.id] && p.status === 'active') { bv = v; best = p.id; } }
  if (best === crownOwner) return;
  crown.removeFromParent(); crown.visible = false; crownOwner = best;
  if (best) { agents[best].head.add(crown); crown.visible = true; }
}

// ── fireworks over the city: new all-time highs and incubator graduations ──
const fireworks = [];
const fwGeo = n => { const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(n * 3), 3)); return g; };
const FW_COLS = [0xfacc15, 0x7c8cff, 0x22d3ee, 0xf472b6, 0x4ade80, 0xfb923c, 0xffffff];
function firework(x, y, z, color = choose(FW_COLS), n = 140) {
  const geo = fwGeo(n), pos = geo.attributes.position.array, vel = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { const u = Math.random() * 2 - 1, th = Math.random() * Math.PI * 2, r = Math.sqrt(1 - u * u), sp = 9 + Math.random() * 7;
    pos[i * 3] = x; pos[i * 3 + 1] = y; pos[i * 3 + 2] = z; vel[i * 3] = r * Math.cos(th) * sp; vel[i * 3 + 1] = u * sp; vel[i * 3 + 2] = r * Math.sin(th) * sp; }
  const mat = new THREE.PointsMaterial({ color: new THREE.Color(color).multiplyScalar(1.15), size: 1.8, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false });
  const pts = new THREE.Points(geo, mat); pts.frustumCulled = false; scene.add(pts); flyIgnore.add(pts); SFX.pop();
  fireworks.push({ pts, vel, born: performance.now() });
}
function launchFireworks(cx = 0, cz = 0, n = 7) {
  for (let k = 0; k < n; k++) setTimeout(() => firework(cx + (Math.random() - 0.5) * 50, 30 + Math.random() * 25, cz - 10 + (Math.random() - 0.5) * 30), k * 420 + Math.random() * 200);
}
function updateFireworks(dt, now) {
  for (let i = fireworks.length - 1; i >= 0; i--) {
    const f = fireworks[i], age = (now - f.born) / 1000, pos = f.pts.geometry.attributes.position.array, v = f.vel;
    for (let j = 0; j < v.length; j += 3) { v[j + 1] -= 6 * dt; v[j] *= 1 - dt * 0.9; v[j + 1] *= 1 - dt * 0.9; v[j + 2] *= 1 - dt * 0.9;
      pos[j] += v[j] * dt; pos[j + 1] += v[j + 1] * dt; pos[j + 2] += v[j + 2] * dt; }
    f.pts.geometry.attributes.position.needsUpdate = true;
    f.pts.material.opacity = Math.max(0, 1 - age / 2.6);
    if (age > 2.7) { scene.remove(f.pts); f.pts.geometry.dispose(); f.pts.material.dispose(); flyIgnore.delete(f.pts); fireworks.splice(i, 1); }
  }
}
// ── CITY HALL: the civic building on the plaza + the city's status board ──
const CH = { x: 0, z: 84 };
{
  const stone = std(0xece6d8, 0.75, 0.05), dark = std(0x2a2d33, 0.6, 0.3), y0 = STREET_Y;
  mesh(new THREE.BoxGeometry(52, 1.2, 34), stone, CH.x, y0 + 0.6, CH.z, scene, false);                                   // plinth
  for (let i = 0; i < 3; i++) mesh(new THREE.BoxGeometry(30, 1.2 - i * 0.4, 2), stone, CH.x, y0 + (1.2 - i * 0.4) / 2, CH.z - 18 - i * 2, scene, false);   // steps down toward the towers
  mesh(new THREE.BoxGeometry(40, 15, 22), stone, CH.x, y0 + 8.7, CH.z, scene, false);                                    // hall
  const win = canvasTex(256, 128, (g, w, h) => { g.fillStyle = '#e8e2d4'; g.fillRect(0, 0, w, h);
    for (let x = 14; x < w; x += 40) { g.fillStyle = TOD === 'day' ? '#2d3a4a' : '#ffd79a'; g.fillRect(x, 20, 18, 64); g.beginPath(); g.arc(x + 9, 20, 9, Math.PI, 0); g.fill(); } });
  win.tex.wrapS = THREE.RepeatWrapping; win.tex.repeat.set(4, 1);
  for (const sz of [-1, 1]) { const p = new THREE.Mesh(new THREE.PlaneGeometry(39, 12), new THREE.MeshStandardMaterial({ map: win.tex, emissiveMap: win.tex, emissive: 0xffffff, emissiveIntensity: TOD === 'day' ? 0 : 0.5, roughness: 0.8 }));
    p.position.set(CH.x, y0 + 9, CH.z + sz * 11.02); if (sz < 0) p.rotation.y = Math.PI; scene.add(p); }
  for (let i = 0; i < 8; i++) for (const sz of [-1, 1]) mesh(new THREE.CylinderGeometry(0.8, 0.9, 13, 16), stone, CH.x - 15.75 + i * 4.5, y0 + 8.2, CH.z + sz * 13.2, scene, false);   // colonnades
  for (const sz of [-1, 1]) { mesh(new THREE.BoxGeometry(40, 1.4, 4), stone, CH.x, y0 + 15.3, CH.z + sz * 12.6, scene, false);
    const ped = new THREE.CylinderGeometry(4.5, 4.5, 40, 3, 1); ped.rotateZ(Math.PI / 2); ped.scale(1, 0.55, 1.1); mesh(ped, stone, CH.x, y0 + 17.5, CH.z + sz * 11, scene, false); }
  mesh(new THREE.BoxGeometry(41, 1.6, 23), stone, CH.x, y0 + 16.9, CH.z, scene, false);                                   // cornice
  mesh(new THREE.CylinderGeometry(8.5, 9, 6, 32), stone, CH.x, y0 + 20.7, CH.z, scene, false);                            // drum
  for (let i = 0; i < 16; i++) { const a = i / 16 * Math.PI * 2; mesh(new THREE.BoxGeometry(0.5, 4.4, 0.5), stone, CH.x + Math.cos(a) * 9.1, y0 + 20.7, CH.z + Math.sin(a) * 9.1, scene, false); }
  mesh(new THREE.SphereGeometry(8.6, 32, 16, 0, Math.PI * 2, 0, Math.PI / 2), std(0x6fa58f, 0.45, 0.55), CH.x, y0 + 23.6, CH.z, scene, false);   // copper dome
  mesh(new THREE.CylinderGeometry(1.2, 1.4, 2.6, 12), stone, CH.x, y0 + 33.4, CH.z, scene, false);
  mesh(new THREE.SphereGeometry(1.0, 12, 8), glow(0xffd166, TOD === 'day' ? 1 : 2.4), CH.x, y0 + 35.2, CH.z, scene, false);
  mesh(new THREE.CylinderGeometry(0.1, 0.1, 6, 6), metal, CH.x + 18, y0 + 20, CH.z + 9, scene, false);
  mesh(new THREE.BoxGeometry(3, 1.8, 0.05), glow(0x7c8cff, 1.1), CH.x + 19.6, y0 + 22.1, CH.z + 9, scene, false);         // city flag
  const hit = new THREE.Mesh(new THREE.BoxGeometry(44, 40, 30), new THREE.MeshBasicMaterial({ visible: false })); hit.position.set(CH.x, y0 + 18, CH.z); scene.add(hit);
  clickable(hit, { type: 'cityhall', tip: 'City Hall: the whole city at a glance' });
}
// the city status board: a giant screen floating over the plaza, facing the towers' camera views
const BCOL = { fund: '#7c8cff', studio: '#34d399', news: '#f87171', career: '#2dd4bf', study: '#f0abfc', incubator: '#86efac', ops: '#38bdf8' };
const cityTex = canvasTex(2048, 900, (g, w, h) => {
  g.fillStyle = 'rgba(6,10,18,0.94)'; g.fillRect(0, 0, w, h); g.strokeStyle = '#7c8cff'; g.lineWidth = 6; g.strokeRect(3, 3, w - 6, h - 6);
  g.fillStyle = '#e5e7eb'; g.font = font(60, 800); g.fillText('JB CITY · CITY HALL', 48, 86);
  const c = snap?.city; if (!c) return;
  const hl = c.health; g.font = font(30, 700); g.textAlign = 'right';
  g.fillStyle = hl.ok ? '#34d399' : '#fbbf24'; g.fillText(hl.ok ? '● ALL SYSTEMS NORMAL' : `● ${hl.issues.length} ISSUE${hl.issues.length > 1 ? 'S' : ''}`, w - 48, 84); g.textAlign = 'left';
  c.buildings.forEach((b, i) => { const col = i % 4, row = Math.floor(i / 4), x = 48 + col * 490, y = 130 + row * 370;
    g.fillStyle = '#111827'; g.fillRect(x, y, 470, 340); g.fillStyle = BCOL[b.id] || '#fff'; g.fillRect(x, y, 470, 8);
    g.fillStyle = '#f8fafc'; g.font = font(40, 800); g.fillText(b.name, x + 24, y + 62);
    g.font = font(24, 700); g.fillStyle = b.working ? '#fbbf24' : '#64748b'; g.fillText(b.working ? `● ${b.status}`.toUpperCase().slice(0, 30) : '○ IDLE', x + 24, y + 100);
    b.kpis.slice(0, 4).forEach(([k, v], j) => { g.fillStyle = '#94a3b8'; g.font = font(22, 600); g.fillText(k, x + 24, y + 146 + j * 44); g.fillStyle = '#e2e8f0'; g.font = font(26, 700); g.textAlign = 'right'; g.fillText(String(v).slice(0, 18), x + 446, y + 146 + j * 44); g.textAlign = 'left'; });
    g.fillStyle = '#64748b'; g.font = font(20, 500); g.fillText(b.last ? `${b.last.name}: ${b.last.text}`.slice(0, 40) : 'quiet', x + 24, y + 320); });
  const x = 48 + 3 * 490, y = 500; g.fillStyle = '#111827'; g.fillRect(x, y, 470, 340); g.fillStyle = '#fbbf24'; g.fillRect(x, y, 470, 8);
  g.fillStyle = '#f8fafc'; g.font = font(40, 800); g.fillText('THE WIRE · 24H', x + 24, y + 62);
  (c.routes || []).slice(0, 6).forEach(([r, n], j) => { g.fillStyle = '#94a3b8'; g.font = font(22, 600); g.fillText(r, x + 24, y + 112 + j * 40); g.fillStyle = '#e2e8f0'; g.font = font(26, 800); g.textAlign = 'right'; g.fillText(n, x + 446, y + 112 + j * 40); g.textAlign = 'left'; });
});
const cityScreen = screen(34, 14.9, cityTex.tex, CH.x, STREET_Y + 45, CH.z - 4, 0, scene, 0.35);
cityScreen.group.rotation.x = -0.12;
clickable(cityScreen.group, { type: 'cityhall', tip: 'City status board: open City Hall' });
const CITYHALL_CAM = [new THREE.Vector3(CH.x + 10, STREET_Y + 46, CH.z + 70), new THREE.Vector3(CH.x, STREET_Y + 40, CH.z)];
const STUDIO_CAM = [new THREE.Vector3(SX - 3, 4.4, SZ + 15.5), new THREE.Vector3(SX, 2.2, SZ - 5)];
function studioIdle(a) {
  const st = snap?.studio; if (!st?.on) return;
  if (st.status !== 'idle') { if (a.id === 'theo' && st.status === 'researching') act('theo', anim('phone', 3000), say(choose(['Pulling competitor pricing…', 'Reading customer reviews…', 'Checking Reddit threads…']), 2600)); return; }
  const lines = { iris: ['Scanning new launches…', 'Reading founder forums.', 'Noting pain points.'], theo: ['Updating market sizing.', 'Bookmarking sources.', 'Comparing pricing pages.'],
                  rosa: ['Reviewing the pipeline.', 'What would get to revenue fastest?', 'Most ideas should die. That’s the job.'] };
  act(a.id, anim(choose(['explain', 'point', 'nod', 'stretch']), 1800), say(choose(lines[a.id]), 2400));
}
function syncRoster(roster, fresh) {
  const ids = new Set(roster.map(r => r.id));
  for (const r of roster) {
    if (agents[r.id]) continue;
    const c = r.color || 0;
    const look = FOUNDER_LOOK[r.id] || { seat: HIRE_SEATS[r.slot ?? 0], accent: HIRE_ACCENTS[c % 10], jacket: JACKETS[c % 10], badge: 50 + c };
    const role = r.family === 'options' ? 'PM · options desk (Deribit)' : r.founder ? `PM · ${r.family} pod (founder)` : `PM · "${r.idea}"`;
    addAgent({ id: r.id, name: r.name, role, ...look }, !fresh && !r.founder && Date.now() / 1000 - (r.hired || 0) < 120);
  }
  for (const id of Object.keys(agents)) if (!ids.has(id) && !STAFF.some(s => s.id === id) && !STUDIO_IDS.has(id) && !NEWS_IDS.has(id) && !CAREER_IDS.has(id) && !STUDY_IDS.has(id) && !INC_IDS.has(id) && !OPS_IDS.has(id) && !id.startsWith('inc:') && !agents[id].leaving) removeAgent(id);
  HIRE_SEATS.forEach((s, i) => openSigns[i].visible = !roster.some(r => !r.founder && r.slot === i));
}
function nameOf(id) { return agents[id]?.name || (snap?.roster || []).find(r => r.id === id)?.name || id; }
const deskVisit = id => { const a = agents[id]; return a ? { x: a.seat[0] - 1.65, z: a.seat[1] - 0.4 } : null; };

// ── scenery: a living waterfront campus instead of a blank grid ──
// one painted ground texture (lawns, plazas, paths, parking, promenade), merged street furniture, varied trees,
// fountains, parked + moving cars, pedestrians, a pier with boats, low hills, clouds and birds. Plus real roofs:
// every tower gets a rooftop that hides itself when you zoom in from above, so you can still look inside.
const nonIdx = g => g.index ? g.toNonIndexed() : g;
const merged = (list, mat, shadow = false) => { if (!list.length) return null; const m = new THREE.Mesh(mergeGeometries(list.map(nonIdx)), mat); m.castShadow = shadow; m.receiveShadow = true; scene.add(m); return m; };
const NIGHT = TOD === 'night', DAY = TOD === 'day';
const CAMPUS = { x0: -300, x1: 300, z0: -150, z1: BAY_Z };
{ // painted campus ground
  const PX = 4, W = (CAMPUS.x1 - CAMPUS.x0) * PX, H = (CAMPUS.z1 - CAMPUS.z0) * PX;
  const U = (x) => (x - CAMPUS.x0) * PX, V = (z) => (z - CAMPUS.z0) * PX;
  const col = (day, dusk, night) => DAY ? day : NIGHT ? night : dusk;
  const tex = canvasTex(W, H, (g) => {
    // grass with mowing stripes and soft blotches
    g.fillStyle = col('#5f8f4c', '#4f6e45', '#1d3322'); g.fillRect(0, 0, W, H);
    for (let i = 0; i < 900; i++) { const r = 6 + rnd() * 40; g.fillStyle = rnd() < 0.5 ? col('rgba(40,70,30,.10)', 'rgba(30,50,25,.1)', 'rgba(0,0,0,.12)') : col('rgba(150,190,90,.08)', 'rgba(120,150,80,.07)', 'rgba(60,90,50,.06)');
      g.beginPath(); g.ellipse(rnd() * W, rnd() * H, r, r * (0.5 + rnd()), rnd() * 3, 0, 7); g.fill(); }
    const stone = col('#cfc8b8', '#a99f93', '#3b3c42'), stone2 = col('#bdb5a4', '#958c80', '#33343a'), walk = col('#d9d0bb', '#b5a893', '#45444a');
    const tiles = (x0, z0, x1, z1, a, b, step = 3) => { g.fillStyle = a; g.fillRect(U(x0), V(z0), (x1 - x0) * PX, (z1 - z0) * PX);
      g.fillStyle = b; for (let x = x0; x < x1; x += step) for (let z = z0; z < z1; z += step) if (((x - x0) / step + (z - z0) / step) % 2 < 1) g.fillRect(U(x), V(z), step * PX, step * PX);
      g.strokeStyle = 'rgba(0,0,0,.08)'; g.lineWidth = 1; for (let x = x0; x <= x1; x += step) { g.beginPath(); g.moveTo(U(x), V(z0)); g.lineTo(U(x), V(z1)); g.stroke(); } };
    tiles(-150, -24, 150, 36, stone, stone2, 4);                                   // tower plaza
    // parking lots behind the towers, with stall lines and a service road
    g.fillStyle = col('#3a3c40', '#34363a', '#1c1d21'); g.fillRect(U(-260), V(-60), 520 * PX, 8 * PX);
    for (const [x0, x1] of [[-100, -30], [30, 100], [-210, -140], [140, 210]]) { g.fillStyle = col('#46484c', '#3d3f43', '#222327'); g.fillRect(U(x0), V(-50), (x1 - x0) * PX, 24 * PX);
      g.fillStyle = col('#e9e6dc', '#cfcabd', '#77766f'); for (let x = x0 + 1; x < x1; x += 3) { g.fillRect(U(x), V(-50), 2, 9 * PX); g.fillRect(U(x), V(-35), 2, 9 * PX); } }
    for (const z of [36, 54]) { g.fillStyle = col('#c4bfb3', '#9d978b', '#38393e'); g.fillRect(U(-300), V(z), 600 * PX, 4 * PX); }   // sidewalks
    // civic plaza around City Hall with a radial paving pattern
    tiles(-56, 58, 56, 112, stone, stone2, 4);
    g.strokeStyle = col('rgba(120,100,70,.35)', 'rgba(90,70,50,.3)', 'rgba(255,255,255,.06)'); g.lineWidth = 3;
    for (const fx of [-36, 36]) for (let r = 6; r <= 14; r += 4) { g.beginPath(); g.arc(U(fx), V(CH.z), r * PX, 0, 7); g.stroke(); }
    // curving garden paths from the plazas down to the promenade
    g.strokeStyle = walk; g.lineCap = 'round';
    const path = (pts, w = 3) => { g.lineWidth = w * PX; g.beginPath(); g.moveTo(U(pts[0][0]), V(pts[0][1])); for (let i = 1; i < pts.length - 2; i += 3) g.bezierCurveTo(U(pts[i][0]), V(pts[i][1]), U(pts[i + 1][0]), V(pts[i + 1][1]), U(pts[i + 2][0]), V(pts[i + 2][1])); g.stroke(); };
    path([[-56, 100], [-90, 105], [-110, 115], [-140, 126]]); path([[56, 100], [90, 105], [110, 115], [140, 126]]);
    path([[-56, 70], [-120, 64], [-170, 80], [-230, 126]]); path([[56, 70], [120, 64], [170, 80], [230, 126]]);
    path([[0, 112], [-6, 118], [6, 122], [0, 126]], 4);
    path([[-150, 62], [-200, 70], [-250, 60], [-290, 70]], 2.5); path([[150, 62], [200, 70], [250, 60], [290, 70]], 2.5);
    // a pond with a sandy rim
    for (const [px, pz, rx, rz] of [[-170, 98, 22, 12], [178, 92, 16, 10]]) { g.fillStyle = col('#c8b88e', '#a08f6d', '#3a372f'); g.beginPath(); g.ellipse(U(px), V(pz), (rx + 2) * PX, (rz + 2) * PX, 0.2, 0, 7); g.fill();
      const pg = g.createRadialGradient(U(px), V(pz), 0, U(px), V(pz), rx * PX); pg.addColorStop(0, col('#2f6f8f', '#3a5a78', '#0c1a2a')); pg.addColorStop(1, col('#4b8fa8', '#56708a', '#14263a'));
      g.fillStyle = pg; g.beginPath(); g.ellipse(U(px), V(pz), rx * PX, rz * PX, 0.2, 0, 7); g.fill(); }
    // flower beds
    const flowers = ['#f43f5e', '#facc15', '#fb923c', '#e879f9', '#ffffff', '#60a5fa'];
    for (const [bx, bz, rx, rz] of [[-44, 62, 8, 2.5], [44, 62, 8, 2.5], [-48, 108, 6, 2.5], [48, 108, 6, 2.5], [-90, 30, 10, 2.5], [90, 30, 10, 2.5], [-30, 30, 6, 2.5], [30, 30, 6, 2.5], [-140, 110, 7, 4], [140, 110, 7, 4]]) {
      g.fillStyle = col('#5a3f2c', '#4a3526', '#21170f'); g.beginPath(); g.ellipse(U(bx), V(bz), rx * PX, rz * PX, 0, 0, 7); g.fill();
      for (let i = 0; i < rx * rz * 6; i++) { const a = rnd() * 7, rr = Math.sqrt(rnd()); g.fillStyle = flowers[Math.floor(rnd() * flowers.length)]; g.globalAlpha = NIGHT ? 0.35 : 0.95;
        g.fillRect(U(bx + Math.cos(a) * rr * rx * 0.92), V(bz + Math.sin(a) * rr * rz * 0.85), 3, 3); } g.globalAlpha = 1; }
    // the bayside promenade: a timber boardwalk
    g.fillStyle = col('#a0794f', '#83623f', '#2e241a'); g.fillRect(0, V(124), W, 11 * PX);
    g.fillStyle = 'rgba(0,0,0,.18)'; for (let x = 0; x < W; x += 6) g.fillRect(x, V(124), 1, 11 * PX);
  });
  tex.tex.anisotropy = 8;
  const campus = new THREE.Mesh(new THREE.PlaneGeometry(CAMPUS.x1 - CAMPUS.x0, CAMPUS.z1 - CAMPUS.z0), new THREE.MeshStandardMaterial({ map: tex.tex, roughness: 0.95 }));
  campus.rotation.x = -Math.PI / 2; campus.position.set((CAMPUS.x0 + CAMPUS.x1) / 2, STREET_Y + 0.02, (CAMPUS.z0 + CAMPUS.z1) / 2); campus.receiveShadow = true; scene.add(campus); groundLayer(campus, 1);
  // the land beyond the campus: plain grass that fades into the fog (no tile grid)
  const far = canvasTex(256, 256, (g, w, h) => { g.fillStyle = col('#5b8648', '#4b6a42', '#1a2e1f'); g.fillRect(0, 0, w, h);
    for (let i = 0; i < 260; i++) { g.fillStyle = rnd() < 0.5 ? 'rgba(0,0,0,.06)' : 'rgba(255,255,255,.04)'; g.beginPath(); g.arc(rnd() * w, rnd() * h, 4 + rnd() * 18, 0, 7); g.fill(); } });
  far.tex.wrapS = far.tex.wrapT = THREE.RepeatWrapping; far.tex.repeat.set(40, 40);
  ground.material = new THREE.MeshStandardMaterial({ map: far.tex, roughness: 0.95 });
  // crosswalks over the boulevard + a planted median
  const zebra = []; for (const cx of [0, -62, 62, -117, 117]) for (let k = -3; k <= 3; k++) zebra.push(new THREE.BoxGeometry(0.9, 0.02, 12).translate(cx + k * 1.6, STREET_Y + 0.08, (BLVD[0] + BLVD[1]) / 2));
  groundLayer(merged(zebra, std(DAY ? 0xf2efe6 : 0x8d8b84, 0.7)), 4);
}
{ // street furniture: lamps (merged), benches, bins, bus shelter
  const poles = [], heads = [], pools = [], benches = [], bins = [];
  const lamp = (x, z, h = 7, arm = 1) => { poles.push(new THREE.CylinderGeometry(0.12, 0.18, h, 6).translate(x, STREET_Y + h / 2, z));
    poles.push(new THREE.BoxGeometry(0.1, 0.1, 1.4).translate(x, STREET_Y + h - 0.1, z + arm * 0.6));
    heads.push(new THREE.BoxGeometry(0.7, 0.18, 0.4).translate(x, STREET_Y + h - 0.25, z + arm * 1.2)); pools.push([x, z + arm * 1.2]); };
  for (let x = -290; x <= 290; x += 24) { lamp(x, BLVD[0] - 2, 7, 1); lamp(x + 12, BLVD[1] + 2, 7, -1); }
  for (let x = -280; x <= 280; x += 20) lamp(x, 123, 4.5, 1);                                                    // promenade
  for (const [x, z] of [[-56, 60], [56, 60], [-56, 110], [56, 110], [-20, 60], [20, 60], [-140, 34], [140, 34], [-90, 34], [90, 34], [-30, 34], [30, 34]]) lamp(x, z, 5, 1);
  merged(poles, std(0x2a2e35, 0.45, 0.75));
  merged(heads, glow(0xffe2ad, DAY ? 0.9 : 2.6));
  if (!DAY) { // warm pools of light on the ground under every lamp (one instanced draw call)
    const pt = canvasTex(128, 128, (g, w) => { const r = g.createRadialGradient(64, 64, 0, 64, 64, 64); r.addColorStop(0, 'rgba(255,214,150,.22)'); r.addColorStop(1, 'rgba(255,200,130,0)'); g.clearRect(0, 0, w, w); g.fillStyle = r; g.fillRect(0, 0, w, w); });
    const im = new THREE.InstancedMesh(new THREE.PlaneGeometry(7, 7).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ map: pt.tex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }), pools.length);
    const d = new THREE.Object3D(); pools.forEach(([x, z], i) => { d.position.set(x, STREET_Y + 0.12, z); d.updateMatrix(); im.setMatrixAt(i, d.matrix); }); scene.add(im); flyIgnore.add(im); groundLayer(im, 5);
  }
  const bench = (x, z, rot = 0) => { const parts = [new THREE.BoxGeometry(2.2, 0.12, 0.6).translate(0, 0.5, 0), new THREE.BoxGeometry(2.2, 0.5, 0.1).translate(0, 0.8, -0.28),
    new THREE.BoxGeometry(0.1, 0.5, 0.5).translate(-0.95, 0.25, 0), new THREE.BoxGeometry(0.1, 0.5, 0.5).translate(0.95, 0.25, 0)];
    for (const p of parts) benches.push(p.rotateY(rot).translate(x, STREET_Y, z)); };
  for (let x = -270; x <= 270; x += 20) bench(x + 10, 125.2, Math.PI);
  for (const x of [-46, -26, 26, 46]) { bench(x, 112.5, Math.PI); bench(x, 57.6, 0); }
  for (let x = -130; x <= 130; x += 26) if (Math.abs(x) > 12) bench(x, 33.5, 0);
  merged(benches, std(0x7a5233, 0.8));
  for (let x = -270; x <= 270; x += 40) bins.push(new THREE.CylinderGeometry(0.35, 0.3, 0.9, 10).translate(x, STREET_Y + 0.45, 125.6));
  merged(bins, std(0x2d3a33, 0.6, 0.3));
  // bus shelters on the boulevard
  for (const x of [-35, 35]) { const g = [new THREE.BoxGeometry(6, 0.15, 2.2).translate(x, STREET_Y + 2.8, BLVD[1] + 3.2), new THREE.BoxGeometry(0.12, 2.8, 2.2).translate(x - 3, STREET_Y + 1.4, BLVD[1] + 3.2),
      new THREE.BoxGeometry(0.12, 2.8, 2.2).translate(x + 3, STREET_Y + 1.4, BLVD[1] + 3.2)]; merged(g, std(0x2a2e35, 0.4, 0.7));
    mesh(new THREE.BoxGeometry(6, 2.4, 0.05), glass, x, STREET_Y + 1.5, BLVD[1] + 4.25, scene, false); mesh(new THREE.BoxGeometry(1.4, 2, 0.08), glow(0x7c8cff, DAY ? 0.9 : 1.8), x + 2.2, STREET_Y + 1.4, BLVD[1] + 4.2, scene, false); }
}
{ // trees: round deciduous, conifers, palms along the water, bushes, all merged by material
  const trunk = [], leafA = [], leafB = [], leafC = [], palmTrunk = [], frond = [], bush = [];
  const round = (x, z, s) => { trunk.push(new THREE.CylinderGeometry(0.25 * s, 0.38 * s, 3 * s, 6).translate(x, STREET_Y + 1.5 * s, z));
    const L = rnd() < 0.5 ? leafA : leafB; L.push(new THREE.IcosahedronGeometry(2.1 * s, 1).translate(x, STREET_Y + 4.2 * s, z)); if (rnd() < 0.6) L.push(new THREE.IcosahedronGeometry(1.4 * s, 1).translate(x + 0.9 * s, STREET_Y + 5.2 * s, z - 0.5 * s)); };
  const cone = (x, z, s) => { trunk.push(new THREE.CylinderGeometry(0.2 * s, 0.3 * s, 1.6 * s, 6).translate(x, STREET_Y + 0.8 * s, z));
    leafC.push(new THREE.ConeGeometry(1.9 * s, 3.6 * s, 7).translate(x, STREET_Y + 2.9 * s, z), new THREE.ConeGeometry(1.4 * s, 3 * s, 7).translate(x, STREET_Y + 4.6 * s, z)); };
  const palm = (x, z, s) => { const lean = (rnd() - 0.5) * 0.25;
    for (let i = 0; i < 5; i++) palmTrunk.push(new THREE.CylinderGeometry(0.22 * s, 0.28 * s, 1.6 * s, 7).translate(0, 0.8 * s, 0).rotateZ(lean * i * 0.3).translate(x + lean * i * i * 0.35 * s, STREET_Y + i * 1.55 * s, z));
    const tx = x + lean * 16 * 0.35 * s, ty = STREET_Y + 7.8 * s;
    for (let k = 0; k < 7; k++) { const a = k / 7 * Math.PI * 2 + rnd() * 0.3; frond.push(new THREE.ConeGeometry(0.5 * s, 3.6 * s, 4).rotateX(Math.PI / 2).scale(1, 0.18, 1).translate(0, 0, 1.7 * s).rotateX(0.35).rotateY(a).translate(tx, ty, z)); } };
  const shrub = (x, z, s) => bush.push(new THREE.IcosahedronGeometry(0.9 * s, 0).scale(1.3, 0.8, 1.1).translate(x, STREET_Y + 0.6 * s, z));
  const free = (x, z) => !(Math.abs(x) < 60 && z > 55 && z < 115) && !(z > 120) && !(Math.hypot((x + 170) / 24, (z - 98) / 14) < 1) && !(Math.hypot((x - 178) / 18, (z - 92) / 12) < 1);
  for (let x = -290; x <= 290; x += 11) if (Math.abs(x % 24) > 2) palm(x + rnd() * 3, 120.5, 0.9 + rnd() * 0.25);   // palms on the promenade
  for (let k = 0; k < 150; k++) { const x = (rnd() - 0.5) * 580, z = 62 + rnd() * 56; if (!free(x, z)) continue; (rnd() < 0.7 ? round : cone)(x, z, 0.8 + rnd() * 0.6); }
  for (let k = 0; k < 90; k++) { const x = (rnd() - 0.5) * 600, z = -140 + rnd() * 75; if (Math.abs(z + 56) < 6 || (z > -52 && z < -24 && Math.abs(x) < 215)) continue; (rnd() < 0.5 ? cone : round)(x, z, 0.9 + rnd() * 0.7); }
  for (const x of [-150, -90, -35, 35, 90, 150]) for (const dz of [-1, 1]) round(x, 30 + dz * 0.5, 0.75);           // plaza trees
  for (let k = 0; k < 220; k++) { const x = (rnd() - 0.5) * 580, z = 60 + rnd() * 60; if (free(x, z)) shrub(x, z, 0.6 + rnd() * 0.8); }
  for (let x = -54; x <= 54; x += 4) { shrub(x, 112.8, 0.5); }
  merged(trunk, std(0x5b4636, 0.9)); merged(palmTrunk, std(0x8a6f4e, 0.9));
  merged(leafA, std(NIGHT ? 0x1f3a26 : 0x3f7a42, 0.85)); merged(leafB, std(NIGHT ? 0x26422a : 0x5d8f3e, 0.85)); merged(leafC, std(NIGHT ? 0x16301f : 0x2f5e3c, 0.85));
  merged(frond, std(NIGHT ? 0x23402a : 0x4f8a3a, 0.8)); merged(bush, std(NIGHT ? 0x1c3523 : 0x46803f, 0.9));
}
// fountains on the civic plaza (animated spray)
const fountains = [];
for (const fx of [-36, 36]) {
  const fz = CH.z, y0 = STREET_Y;
  mesh(new THREE.CylinderGeometry(5, 5.3, 0.8, 32), std(0xd8d2c4, 0.7), fx, y0 + 0.4, fz, scene, false);
  mesh(new THREE.CylinderGeometry(4.5, 4.5, 0.2, 32), new THREE.MeshStandardMaterial({ color: DAY ? 0x5aa6c8 : 0x1c4a66, roughness: 0.05, metalness: 0.3, emissive: NIGHT ? 0x0e3a5a : 0x000000 }), fx, y0 + 0.75, fz, scene, false);
  mesh(new THREE.CylinderGeometry(0.5, 0.8, 2.4, 12), std(0xd8d2c4, 0.7), fx, y0 + 1.6, fz, scene, false);
  mesh(new THREE.CylinderGeometry(1.6, 1.2, 0.3, 20), std(0xd8d2c4, 0.7), fx, y0 + 2.9, fz, scene, false);
  const N = 160, pos = new Float32Array(N * 3), g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const pts = new THREE.Points(g, new THREE.PointsMaterial({ color: NIGHT ? 0x9fd8ff : 0xe8f6ff, size: 0.28, transparent: true, opacity: 0.85, depthWrite: false }));
  pts.frustumCulled = false; scene.add(pts); flyIgnore.add(pts);
  fountains.push({ x: fx, z: fz, y: y0 + 3.1, pos, g, parts: Array.from({ length: N }, () => ({ t: rnd() * 1.6, a: rnd() * 7, s: 0.6 + rnd() * 0.9 })) });
}
// parked cars + a nicer car shape for the moving traffic
const carGeo = (() => { const body = new THREE.BoxGeometry(4.4, 1.0, 2).translate(0, -0.2, 0), cab = new THREE.BoxGeometry(2.4, 0.8, 1.8).translate(-0.2, 0.7, 0); return mergeGeometries([nonIdx(body), nonIdx(cab)]); })();
carMesh.geometry.dispose(); carMesh.geometry = carGeo;
{ const spots = []; for (const [x0, x1] of [[-100, -30], [30, 100], [-210, -140], [140, 210]]) for (let x = x0 + 2.5; x < x1 - 1; x += 3) for (const z of [-45.5, -30.5]) if (rnd() < 0.72) spots.push([x, z]);
  const pk = new THREE.InstancedMesh(carGeo, new THREE.MeshStandardMaterial({ roughness: 0.35, metalness: 0.55 }), spots.length), d = new THREE.Object3D();
  spots.forEach(([x, z], i) => { d.position.set(x, STREET_Y + 0.8, z); d.rotation.y = Math.PI / 2 + (rnd() - 0.5) * 0.06; d.updateMatrix(); pk.setMatrixAt(i, d.matrix);
    pk.setColorAt(i, new THREE.Color(CAR_COLS[Math.floor(rnd() * CAR_COLS.length)]).multiplyScalar(NIGHT ? 0.35 : 1)); });
  scene.add(pk); }
// pedestrians strolling the sidewalks, plazas and promenade
const PED_N = 70, peds = [], pedMesh = new THREE.InstancedMesh(mergeGeometries([nonIdx(new THREE.CapsuleGeometry(0.28, 0.9, 3, 8).translate(0, 0.75, 0)), nonIdx(new THREE.SphereGeometry(0.22, 8, 6).translate(0, 1.58, 0))]),
  new THREE.MeshStandardMaterial({ roughness: 0.7 }), PED_N);
pedMesh.frustumCulled = false; scene.add(pedMesh);
const PED_ROUTES = [[[-280, 126.5], [280, 126.5]], [[-280, 38], [280, 38]], [[-280, 56], [280, 56]], [[-52, 60], [52, 60], [52, 110], [-52, 110], [-52, 60]],
  [[-145, 24], [145, 24]], [[-56, 70], [-120, 64], [-170, 80], [-230, 124]], [[56, 70], [120, 64], [170, 80], [230, 124]], [[0, 112], [0, 124]]];
const PED_COLS = [0x2b4c7e, 0x9b2335, 0xe9e4d8, 0x2f5d3a, 0xf59e0b, 0x4c2a86, 0x1f2937, 0xdb2777, 0x0ea5e9];
for (let i = 0; i < PED_N; i++) { const r = PED_ROUTES[i % PED_ROUTES.length]; peds.push({ r, seg: Math.floor(rnd() * (r.length - 1)), t: rnd(), dir: rnd() < 0.5 ? 1 : -1, v: 1.1 + rnd() * 0.7, off: (rnd() - 0.5) * 2.4, ph: rnd() * 7 });
  pedMesh.setColorAt(i, new THREE.Color(PED_COLS[i % PED_COLS.length]).multiplyScalar(NIGHT ? 0.4 : 1)); }
const pedD = new THREE.Object3D();
function movePeds(dt, now) {
  for (let i = 0; i < PED_N; i++) { const p = peds[i], a = p.r[p.seg], b = p.r[p.seg + 1], len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    p.t += p.dir * p.v * dt / len;
    if (p.t > 1) { if (p.seg < p.r.length - 2) { p.seg++; p.t = 0; } else { p.t = 1; p.dir = -1; } }
    if (p.t < 0) { if (p.seg > 0) { p.seg--; p.t = 1; } else { p.t = 0; p.dir = 1; } }
    const dx = (b[0] - a[0]) / len, dz = (b[1] - a[1]) / len;
    pedD.position.set(a[0] + (b[0] - a[0]) * p.t - dz * p.off, STREET_Y + Math.abs(Math.sin(now / 160 + p.ph)) * 0.06, a[1] + (b[1] - a[1]) * p.t + dx * p.off);
    pedD.rotation.y = Math.atan2(dx * p.dir, dz * p.dir); pedD.updateMatrix(); pedMesh.setMatrixAt(i, pedD.matrix); }
  pedMesh.instanceMatrix.needsUpdate = true;
}
movePeds(0, 0); if (pedMesh.instanceColor) pedMesh.instanceColor.needsUpdate = true;
// the bay: a pier with a lighthouse, and sailboats
{ const wood = std(0x8a6a48, 0.85), piles = [], deck = [];
  deck.push(new THREE.BoxGeometry(6, 0.4, 46).translate(70, STREET_Y + 0.6, BAY_Z + 23), new THREE.BoxGeometry(18, 0.4, 8).translate(70, STREET_Y + 0.6, BAY_Z + 48));
  for (let z = BAY_Z + 3; z < BAY_Z + 52; z += 4) for (const dx of [-2.7, 2.7]) piles.push(new THREE.CylinderGeometry(0.25, 0.25, 4, 6).translate(70 + dx, STREET_Y - 1.4, z));
  for (let k = 0; k < 9; k++) deck.push(new THREE.BoxGeometry(0.12, 1, 0.12).translate(67.1, STREET_Y + 1.3, BAY_Z + 3 + k * 5), new THREE.BoxGeometry(0.12, 1, 0.12).translate(72.9, STREET_Y + 1.3, BAY_Z + 3 + k * 5));
  deck.push(new THREE.BoxGeometry(0.1, 0.1, 44).translate(67.1, STREET_Y + 1.8, BAY_Z + 23), new THREE.BoxGeometry(0.1, 0.1, 44).translate(72.9, STREET_Y + 1.8, BAY_Z + 23));
  merged(deck, wood); merged(piles, std(0x4a3a2a, 0.9));
  const lx = 76, lz = BAY_Z + 50;
  mesh(new THREE.CylinderGeometry(1.1, 1.5, 9, 16), std(0xf3f1ea, 0.6), lx, STREET_Y + 5.3, lz, scene, false);
  for (const y of [2.5, 5.5]) mesh(new THREE.CylinderGeometry(1.3, 1.35, 1.1, 16), std(0xc0392b, 0.6), lx, STREET_Y + y + 0.8, lz, scene, false);
  mesh(new THREE.CylinderGeometry(0.8, 0.8, 1.2, 12), glow(0xfff3c4, DAY ? 0.9 : 3), lx, STREET_Y + 10.4, lz, scene, false);
  mesh(new THREE.ConeGeometry(1.1, 1.2, 12), std(0x2a2e35, 0.5, 0.6), lx, STREET_Y + 11.6, lz, scene, false); }
const boats = [];
for (let i = 0; i < 7; i++) { const b = new THREE.Group(), hull = std([0xffffff, 0x1d3f7a, 0x8a1c24][i % 3], 0.5, 0.2);
  mesh(new THREE.BoxGeometry(1.8, 0.8, 5.5), hull, 0, 0.3, 0, b, false); mesh(new THREE.ConeGeometry(0.9, 1.6, 4).rotateX(Math.PI / 2).rotateZ(Math.PI / 4).scale(1, 0.5, 1), hull, 0, 0.3, 3.4, b, false);
  mesh(new THREE.CylinderGeometry(0.06, 0.06, 7, 6), std(0xcccccc, 0.4, 0.6), 0, 4, 0.4, b, false);
  const sail = new THREE.BufferGeometry(); sail.setAttribute('position', new THREE.Float32BufferAttribute([0, 0.9, 0.5, 0, 7.2, 0.45, 0, 0.9, -2.4], 3)); sail.computeVertexNormals();
  mesh(sail, new THREE.MeshStandardMaterial({ color: 0xf8f6ef, side: THREE.DoubleSide, roughness: 0.8, emissive: NIGHT ? 0x222222 : 0 }), 0, 0, 0, b, false);
  b.position.set(-260 + i * 80 + rnd() * 30, STREET_Y + 0.1, BAY_Z + 40 + rnd() * 160); scene.add(b);
  boats.push({ g: b, v: (1.2 + rnd() * 1.5) * (i % 2 ? 1 : -1), ph: rnd() * 7 }); }
// low hills around the horizon (real 3D, tinted by the fog) + clouds + birds
{ const hl = [];
  for (let k = 0; k < 46; k++) { const a = (k / 46) * Math.PI * 2, r = 520 + rnd() * 120; if (Math.sin(a) > 0.02) continue;     // leave the bay side open
    hl.push(new THREE.IcosahedronGeometry(60 + rnd() * 70, 1).scale(1.6, 0.35 + rnd() * 0.3, 1.2).translate(Math.cos(a) * r, STREET_Y - 6, Math.sin(a) * r - 40)); }
  merged(hl, std(NIGHT ? 0x15231a : DAY ? 0x587a52 : 0x4a5a48, 0.95)); }
const clouds = [];
if (!NIGHT) { const ct = canvasTex(256, 128, (g, w, h) => { g.clearRect(0, 0, w, h); for (let i = 0; i < 14; i++) { const x = 40 + rnd() * 176, y = 50 + rnd() * 40, r = 18 + rnd() * 30;
    const gr = g.createRadialGradient(x, y, 0, x, y, r); gr.addColorStop(0, 'rgba(255,255,255,.9)'); gr.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = gr; g.beginPath(); g.arc(x, y, r, 0, 7); g.fill(); } });
  for (let i = 0; i < 22; i++) { const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: ct.tex, transparent: true, depthWrite: false, opacity: TOD === 'dusk' ? 0.55 : 0.85, color: TOD === 'dusk' ? 0xffc8a8 : 0xffffff, fog: false }));
    s.scale.set(120 + rnd() * 120, 45 + rnd() * 35, 1); s.position.set((rnd() - 0.5) * 1400, STREET_Y + 170 + rnd() * 140, -200 + (rnd() - 0.5) * 1000); scene.add(s); clouds.push(s); flyIgnore.add(s); } }
const BIRD_N = 24, birdGeo = new THREE.BufferGeometry();
birdGeo.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0.25, -1, 0.25, -0.2, 0, 0, -0.15, 0, 0, 0.25, 1, 0.25, -0.2, 0, 0, -0.15], 3)); birdGeo.computeVertexNormals();
const birdMesh = new THREE.InstancedMesh(birdGeo, new THREE.MeshBasicMaterial({ color: NIGHT ? 0x444a55 : 0x262a30, side: THREE.DoubleSide }), BIRD_N); birdMesh.frustumCulled = false; scene.add(birdMesh);
const flocks = [0, 1, 2].map(i => ({ cx: (rnd() - 0.5) * 300, cz: 40 + rnd() * 150, r: 60 + rnd() * 80, y: STREET_Y + 45 + rnd() * 40, w: (0.05 + rnd() * 0.05) * (i % 2 ? 1 : -1), t: rnd() * 7 }));
const birdOff = Array.from({ length: BIRD_N }, (_, i) => ({ f: i % 3, dx: (rnd() - 0.5) * 10, dy: (rnd() - 0.5) * 3, dz: (rnd() - 0.5) * 10, ph: rnd() * 7 })), birdD = new THREE.Object3D();
function moveScenery(dt, now) {
  movePeds(dt, now);
  for (const f of fountains) { for (let i = 0; i < f.parts.length; i++) { const p = f.parts[i]; p.t += dt; if (p.t > 1.6) { p.t = 0; p.a = Math.random() * 7; p.s = 0.6 + Math.random() * 0.9; }
      const r = p.t * p.s * 1.6, y = 4.2 * p.t - 4.9 * p.t * p.t * 1.1; f.pos[i * 3] = f.x + Math.cos(p.a) * r; f.pos[i * 3 + 1] = f.y + Math.max(-2.3, y); f.pos[i * 3 + 2] = f.z + Math.sin(p.a) * r; }
    f.g.attributes.position.needsUpdate = true; }
  for (const b of boats) { b.g.position.x += b.v * dt; if (b.g.position.x > 400) b.g.position.x = -400; if (b.g.position.x < -400) b.g.position.x = 400;
    b.g.rotation.y = b.v > 0 ? Math.PI / 2 : -Math.PI / 2; b.g.rotation.z = Math.sin(now / 1400 + b.ph) * 0.05; b.g.position.y = STREET_Y + 0.1 + Math.sin(now / 900 + b.ph) * 0.12; }
  for (const c of clouds) { c.position.x += dt * 2.2; if (c.position.x > 800) c.position.x = -800; }
  for (const f of flocks) f.t += f.w * dt;
  for (let i = 0; i < BIRD_N; i++) { const o = birdOff[i], f = flocks[o.f], x = f.cx + Math.cos(f.t) * f.r + o.dx, z = f.cz + Math.sin(f.t) * f.r + o.dz;
    birdD.position.set(x, f.y + o.dy + Math.sin(now / 700 + o.ph) * 0.8, z); birdD.rotation.set(0, -f.t - (f.w > 0 ? 0 : Math.PI), 0);
    const flap = 0.4 + 0.6 * Math.abs(Math.sin(now / 160 + o.ph)); birdD.scale.set(1.2, flap * 1.4, 1.2); birdD.updateMatrix(); birdMesh.setMatrixAt(i, birdD.matrix); }
  birdMesh.instanceMatrix.needsUpdate = true;
}
// ── rooftops: parapets, plant, antennas, a helipad, a roof garden, solar arrays and a pitched library roof ──
// a roof hides itself when you zoom in over its building, so the floor inside stays visible
const roofs = [];
function roof(x, z, w, d, y, kind, slab = null) {
  const g = new THREE.Group(); scene.add(g);
  const conc = std(0x8d9099, 0.85, 0.05), dark = std(0x3a3e46, 0.6, 0.4), metalR = std(0xb8bec8, 0.35, 0.8);
  const parts = new Map(), add = (geo, mat) => { if (!parts.has(mat)) parts.set(mat, []); parts.get(mat).push(nonIdx(geo)); };
  if (!slab) add(new THREE.BoxGeometry(w, 0.4, d).translate(x, y - 0.2, z), conc);
  const ph = 0.9, top = y;
  for (const [pw, pd, px, pz] of [[w, 0.3, 0, -d / 2 + 0.15], [w, 0.3, 0, d / 2 - 0.15], [0.3, d, -w / 2 + 0.15, 0], [0.3, d, w / 2 - 0.15, 0]]) add(new THREE.BoxGeometry(pw, ph, pd).translate(x + px, top + ph / 2, z + pz), dark);
  const hvac = (hx, hz, s = 1) => { add(new THREE.BoxGeometry(3 * s, 1.4 * s, 2 * s).translate(hx, top + 0.7 * s, hz), metalR);
    for (const fx of [-0.7, 0.7]) add(new THREE.CylinderGeometry(0.55 * s, 0.55 * s, 0.1, 16).translate(hx + fx * s, top + 1.42 * s, hz), dark); };
  if (kind === 'fund') {
    hvac(x - 13, z - 6); hvac(x - 13, z + 3); hvac(x - 8, z - 7, 0.8);
    add(new THREE.BoxGeometry(6, 2.6, 5).translate(x - 2, top + 1.3, z - 6), conc);                                  // stair / lift penthouse
    add(new THREE.CylinderGeometry(0.18, 0.3, 14, 6).translate(x - 16, top + 7, z - 8.5), metalR);                    // antenna mast
    for (let k = 1; k < 4; k++) add(new THREE.BoxGeometry(1.6 - k * 0.3, 0.08, 0.08).translate(x - 16, top + 3 + k * 3, z - 8.5), metalR);
    const pad = canvasTex(256, 256, (cg, cw) => { cg.fillStyle = '#2b2f36'; cg.beginPath(); cg.arc(128, 128, 126, 0, 7); cg.fill(); cg.strokeStyle = '#facc15'; cg.lineWidth = 10; cg.beginPath(); cg.arc(128, 128, 104, 0, 7); cg.stroke();
      cg.fillStyle = '#ffffff'; cg.font = '900 130px Inter, sans-serif'; cg.textAlign = 'center'; cg.textBaseline = 'middle'; cg.fillText('H', 128, 136); });
    const padM = new THREE.Mesh(new THREE.CircleGeometry(6, 40), new THREE.MeshStandardMaterial({ map: pad.tex, roughness: 0.8, transparent: true }));
    padM.rotation.x = -Math.PI / 2; padM.position.set(x + 9, top + 0.03, z + 2); g.add(padM);
    for (let k = 0; k < 12; k++) { const a = k / 12 * Math.PI * 2; add(new THREE.SphereGeometry(0.14, 6, 4).translate(x + 9 + Math.cos(a) * 6.2, top + 0.12, z + 2 + Math.sin(a) * 6.2), glow(0x34d399, DAY ? 1 : 2.6)); }
    const tip = new THREE.Mesh(new THREE.SphereGeometry(0.35, 8, 6), blinkMats[0]); tip.position.set(x - 16, top + 14.2, z - 8.5); g.add(tip); blinkers.push(tip);
  } else if (kind === 'studio') {                                                                                      // roof garden + deck
    add(new THREE.BoxGeometry(w - 3, 0.5, d - 6).translate(x - 2, top + 0.25, z), std(0x5b4636, 0.9));
    add(new THREE.BoxGeometry(w - 3.4, 0.08, d - 6.4).translate(x - 2, top + 0.52, z), std(NIGHT ? 0x23402a : 0x4f8a3a, 0.95));
    add(new THREE.BoxGeometry(6, 0.15, d - 3).translate(x + w / 2 - 4, top + 0.08, z), std(0xa0794f, 0.8));
    for (let k = 0; k < 7; k++) { const tx = x - w / 2 + 3 + k * 3, tz = z + (k % 2 ? 2.5 : -2.5);
      add(new THREE.CylinderGeometry(0.12, 0.16, 1.4, 6).translate(tx, top + 1.2, tz), std(0x5b4636, 0.9)); add(new THREE.IcosahedronGeometry(0.9 + (k % 3) * 0.2, 1).translate(tx, top + 2.3, tz), std(NIGHT ? 0x1f3a26 : 0x3f7a42, 0.85)); }
    for (let k = 0; k < 3; k++) add(new THREE.CylinderGeometry(0.9, 0.9, 0.1, 16).translate(x + w / 2 - 4, top + 0.9, z - 4 + k * 4), std(0xe9e4d8, 0.6));      // café tables
    for (let k = 0; k < 10; k++) add(new THREE.SphereGeometry(0.1, 6, 4).translate(x + w / 2 - 6.5 + (k % 5) * 1.3, top + 2.6 - Math.abs(Math.sin(k)) * 0.3, z - 4 + Math.floor(k / 5) * 8), glow(0xffd79a, DAY ? 0.8 : 2.6));
  } else if (kind === 'news') {                                                                                        // broadcast mast + satellite dishes
    for (let k = 0; k < 6; k++) add(new THREE.CylinderGeometry(0.35 - k * 0.04, 0.4 - k * 0.04, 3, 4).translate(x + 6, top + 1.5 + k * 3, z - 3), k % 2 ? std(0xffffff, 0.5) : std(0xd12b2b, 0.5));
    for (const [dx, dz, s] of [[-7, -3, 1.4], [-3, 3, 1], [-9, 3, 0.9]]) { add(new THREE.CylinderGeometry(0.15, 0.2, 1.4 * s, 6).translate(x + dx, top + 0.7 * s, z + dz), metalR);
      add(new THREE.SphereGeometry(1.2 * s, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2.6).rotateX(-1.0).translate(x + dx, top + 1.6 * s, z + dz), std(0xeef0f2, 0.4, 0.3)); }
    hvac(x + 1, z + 4, 0.8);
    const tip = new THREE.Mesh(new THREE.SphereGeometry(0.35, 8, 6), blinkMats[1]); tip.position.set(x + 6, top + 18.4, z - 3); g.add(tip); blinkers.push(tip);
  } else if (kind === 'career') {                                                                                      // solar arrays + water tank
    for (let r = 0; r < 3; r++) for (let c = 0; c < 4; c++) add(new THREE.BoxGeometry(4, 0.1, 2.2).rotateX(-0.45).translate(x - w / 2 + 4 + c * 4.6, top + 0.9, z - d / 2 + 3.5 + r * 3.6), std(0x1d3557, 0.25, 0.7));
    add(new THREE.CylinderGeometry(1.8, 1.8, 3.2, 20).translate(x + w / 2 - 4, top + 2.8, z + 3), std(0x7a5233, 0.8));
    add(new THREE.ConeGeometry(1.9, 1, 20).translate(x + w / 2 - 4, top + 4.9, z + 3), dark);
    for (const [dx, dz] of [[-1.3, -1.3], [1.3, -1.3], [-1.3, 1.3], [1.3, 1.3]]) add(new THREE.BoxGeometry(0.15, 1.2, 0.15).translate(x + w / 2 - 4 + dx, top + 0.6, z + 3 + dz), dark);
  } else if (kind === 'incubator') {                                                                                  // greenhouse: a glass gable on white ribs
    const ridge = 3.4, half = d / 2, slope = Math.hypot(half, ridge), ang = Math.atan2(ridge, half), rib = std(0xf1f5f2, 0.5, 0.2);
    for (const s of [-1, 1]) { add(new THREE.BoxGeometry(w - 0.4, 0.06, slope).rotateX(s * ang).translate(x, top + ridge / 2, z + s * half / 2), glass);
      for (let i = 0; i <= 10; i++) add(new THREE.BoxGeometry(0.1, 0.12, slope).rotateX(s * ang).translate(x - w / 2 + 0.2 + i * (w - 0.4) / 10, top + ridge / 2 + 0.05, z + s * half / 2), rib); }
    add(new THREE.BoxGeometry(w - 0.2, 0.16, 0.16).translate(x, top + ridge, z), rib);
  } else if (kind === 'ops') {                                                                                        // antenna farm + dishes (the radar turns)
    for (const [dx, dz, hgt] of [[-9, -4, 9], [-6, 4, 6], [10, 4, 7]]) { add(new THREE.CylinderGeometry(0.08, 0.14, hgt, 6).translate(x + dx, top + hgt / 2, z + dz), metalR);
      for (let k = 1; k < 4; k++) add(new THREE.BoxGeometry(1.2 - k * 0.25, 0.06, 0.06).translate(x + dx, top + hgt * k / 4, z + dz), metalR); }
    for (const [dx, dz, s] of [[-2, 4, 1.1], [2.5, 4.5, 0.8]]) add(new THREE.SphereGeometry(1.2 * s, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2.6).rotateX(-1.0).translate(x + dx, top + 1.4 * s, z + dz), std(0xeef0f2, 0.4, 0.3));
    hvac(x - 1, z - 5, 0.8);
  } else if (kind === 'study') {                                                                                       // a pitched (hipped) copper roof with a clock cupola
    add(new THREE.CylinderGeometry(0.42, 1, 5, 4, 1).rotateY(Math.PI / 4).scale(w / 2 * Math.SQRT2 * 1.02, 1, d / 2 * Math.SQRT2 * 1.02).translate(x, top + 2.5, z), std(0x5f8f7f, 0.5, 0.5));
    add(new THREE.BoxGeometry(2.6, 2.4, 2.6).translate(x, top + 6, z), std(0xece6d8, 0.75));
    add(new THREE.ConeGeometry(2.1, 2.6, 4).rotateY(Math.PI / 4).translate(x, top + 8.5, z), std(0x5f8f7f, 0.5, 0.5));
    const clk = canvasTex(128, 128, (cg) => { cg.fillStyle = '#f8f5ec'; cg.beginPath(); cg.arc(64, 64, 60, 0, 7); cg.fill(); cg.strokeStyle = '#222'; cg.lineWidth = 6; cg.beginPath(); cg.moveTo(64, 64); cg.lineTo(64, 24); cg.moveTo(64, 64); cg.lineTo(94, 70); cg.stroke(); });
    const cm = new THREE.Mesh(new THREE.CircleGeometry(0.9, 24), new THREE.MeshBasicMaterial({ map: clk.tex })); cm.position.set(x, top + 6.2, z + 1.31); g.add(cm);
  }
  for (const [mat, list] of parts) { const m = new THREE.Mesh(mergeGeometries(list), mat); m.castShadow = false; m.receiveShadow = true; g.add(m); }
  roofs.push({ x, z, r: Math.max(w, d) / 2, y, g, slab });
  return g;
}
roof(0, 0, FW + 1.2, FD + 1.2, FH + 1, 'fund');
roof(SX, SZ, SW + 0.4, SD + 0.4, 5.75, 'studio', roofSlabs.studio);
roof(NX, NZ, NW + 0.4, ND + 0.4, 5.75, 'news', roofSlabs.news);
roof(CX, CZ, CW + 0.4, CD + 0.4, 5.75, 'career', roofSlabs.career);
roof(HX, HZ, HW + 0.4, HD + 0.4, 5.75, 'study', roofSlabs.study);
roof(IX, IZ, IW + 0.4, ID + 0.4, 5.75, 'incubator', roofSlabs.incubator);
roof(OX, OZ, OW + 0.4, OD + 0.4, 5.75, 'ops', roofSlabs.ops);
function updateRoofs() {
  const c = camera.position;
  for (const R of roofs) {
    const hd = Math.hypot(c.x - R.x, c.z - R.z), dist = c.distanceTo(_roofV.set(R.x, R.y, R.z));
    const inside = Math.abs(c.x - R.x) < R.r && Math.abs(c.z - R.z) < R.r && c.y < R.y && c.y > -1;
    // hysteresis: once hidden, the roof needs a clearly wider margin to come back (no on/off flicker at the edge)
    const m = R.hidden ? 1.35 : 1, up = c.y > R.y + (R.hidden ? -0.5 : 0.5);
    const hide = up && ((hd < (R.r + 22) * m && dist < 80 * m) || (controls.target.distanceTo(_roofV) < (R.r + 6) * m && dist < 70 * m));
    if (hide !== !!R.hidden) { R.hidden = hide; R.g.visible = !hide; }
    if (R.slab) R.slab.visible = !hide || inside;
  }
}
const _roofV = new THREE.Vector3();

// ── movement & action queues ──────────────────────────────
const seatExit = a => ({ x: a.seat[0] + 1.65, z: a.seat[1] + 0.3 });
// the towers stand in a row along the main aisle: study | news | fund | studio | careers, joined by sky bridges.
// side towers have doors (W/E, just inside each wall) and an inner walking lane; the fund uses its own aisles.
const ORDER = ['ops', 'study', 'news', 'fund', 'studio', 'career', 'incubator'];
const TOWERS = { ops: { lane: OZ - 1, E: OB_X0 - 1 }, study: { lane: HZ - 1, W: OB_X1 + 1, E: HB_X1 - 1 }, incubator: { lane: IZ - 1, W: IB_X1 + 1 }, news: { lane: NZ - 1, W: HB_X0 + 1, E: NB_X1 - 1 }, fund: { W: -FX + 1.4, E: FX - 1.4 },
                 studio: { lane: STUDIO_LANE, W: BR_X1 + 1, E: CB_X0 - 1 }, career: { lane: CZ - 1, W: CB_X1 + 1, E: IB_X0 - 1 } };
const towerOf = p => p.x < (OB_X0 + OB_X1) / 2 ? 'ops' : p.x < (HB_X0 + HB_X1) / 2 ? 'study' : p.x < (NB_X0 + NB_X1) / 2 ? 'news' : p.x < BR_MID ? 'fund' : p.x < (CB_X0 + CB_X1) / 2 ? 'studio' : p.x < (IB_X0 + IB_X1) / 2 ? 'career' : 'incubator';
function routeTo(a, dest) {
  const s = a.seated ? seatExit(a) : { x: a.x, z: a.z };
  const from = towerOf(s), to = towerOf(dest);
  if (from === to) { if (from === 'fund') return fundRoute(s, dest); const L = TOWERS[from].lane; return [s, { x: s.x, z: L }, { x: dest.x, z: L }, dest]; }
  const dir = ORDER.indexOf(to) > ORDER.indexOf(from) ? 1 : -1, out = dir > 0 ? 'E' : 'W', inn = dir > 0 ? 'W' : 'E';
  let pts = [];
  for (let i = ORDER.indexOf(from); ; i += dir) {
    const name = ORDER[i], T = TOWERS[name], first = name === from;
    const cur = first ? s : { x: T[inn], z: AISLE };
    if (name === to) return pts.concat(name === 'fund' ? fundRoute(cur, dest) : [cur, { x: cur.x, z: T.lane }, { x: dest.x, z: T.lane }, dest]);
    if (name === 'fund') pts = pts.concat(fundRoute(cur, { x: T[out], z: AISLE }));
    else pts.push(cur, { x: cur.x, z: T.lane }, { x: T[out], z: T.lane }, { x: T[out], z: AISLE });
  }
}
// the hall has three bands: N (the PM row and the video wall, north of the main aisle), M (the back row, between the
// aisles) and S (the south rooms past LOW). Walk along an aisle, never through a row: N <-> S trips cross the back row
// through a gap (CROSS); the CIO's corner office is entered through its door.
const inCio = p => p.x > CIO.x0 && p.z < CIO.z1;
const band = p => p.z <= AISLE + 0.5 ? 'N' : p.z >= LOW - 0.5 ? 'S' : 'M';
function fundRoute(s, dest) {
  const pts = [s], door = { x: CIO.door, z: CIO.z1 - 1.1 };
  let cur = s;
  if (inCio(s)) { pts.push(door, { x: CIO.door, z: AISLE }); cur = pts[pts.length - 1]; }
  const tgt = inCio(dest) ? door : dest, bf = band(cur), bt = band(tgt);
  if ((bf === 'N' && bt === 'S') || (bf === 'S' && bt === 'N')) {
    const mid = (cur.x + tgt.x) / 2, cx = CROSS.reduce((b, c) => Math.abs(c - mid) < Math.abs(b - mid) ? c : b);
    const [l1, l2] = bf === 'N' ? [AISLE, LOW] : [LOW, AISLE];
    pts.push({ x: cur.x, z: l1 }, { x: cx, z: l1 }, { x: cx, z: l2 }, { x: tgt.x, z: l2 });
  } else {
    const lane = bf === 'S' || bt === 'S' ? LOW : AISLE;
    pts.push({ x: cur.x, z: lane }, { x: tgt.x, z: lane });
  }
  pts.push(tgt);
  if (tgt !== dest) pts.push(dest);
  return pts;
}
function routeHome(a) {
  const ex = seatExit(a);
  if (a.id === 'boss' && towerOf(a) === 'fund' && inCio(a)) return [{ x: ex.x, z: ex.z }, { x: a.seat[0], z: a.seat[1] }];
  const pts = routeTo(a, ex); pts.push({ x: a.seat[0], z: a.seat[1] }); return pts;
}
function act(id, ...steps) { agents[id]?.queue.push(...steps); }
const say = (text, ms = 3500) => ({ t: 'say', text, ms });
const go = (dest, run = false, carry = false) => ({ t: 'go', dest, run, carry });
const home = () => ({ t: 'home' });
const wait = ms => ({ t: 'wait', ms });
const fx = fn => ({ t: 'fx', fn });
const anim = (name, ms) => ({ t: 'anim', name, ms });          // play a gesture and wait for it
const gest = (a, name, ms) => { if (a && !a.hidden) { a.gesture = name; a.gestureUntil = performance.now() + ms; } };   // react without waiting
const near = (x, z, d) => Object.values(agents).filter(b => !b.hidden && !b.leaving && Math.hypot(b.x - x, b.z - z) < d);
function runQueue(a, now) {
  if (a.busy || !a.queue.length) return;
  const s = a.queue.shift(); a.busy = true;
  if (s.t === 'say') { a.bubble = { text: s.text, until: now + s.ms }; a.said.push(s.text); a.said = a.said.slice(-6); setTimeout(() => a.busy = false, Math.min(s.ms, 1500)); }
  else if (s.t === 'wait') setTimeout(() => a.busy = false, s.ms);
  else if (s.t === 'fx') { s.fn(a); a.busy = false; }
  else if (s.t === 'anim') { gest(a, s.name, s.ms); setTimeout(() => a.busy = false, s.ms); }
  else if (s.t === 'go') { if (!s.dest) { a.busy = false; return; } a.path = routeTo(a, s.dest); a.seated = false; a.run = s.run; a.carry.visible = s.carry; a.onArrive = () => a.busy = false; }
  else if (s.t === 'home') { a.path = routeHome(a); a.run = false; a.onArrive = () => { a.seated = true; a.carry.visible = false; a.busy = false; }; }
}
const angDiff = (from, to) => { let d = (to - from) % (Math.PI * 2); if (d > Math.PI) d -= Math.PI * 2; if (d < -Math.PI) d += Math.PI * 2; return d; };
const lerp = (o, k, v, t) => { o[k] += (v - o[k]) * t; };
function animate(a, dt, now) {
  const moving = a.path.length > 0;
  if (moving) {
    const p = a.path[0], sp = a.speed * (a.run ? 1.9 : 1) * a.speedVar * moodPace(a) * dt;
    const dx = p.x - a.x, dz = p.z - a.z, d = Math.hypot(dx, dz);
    if (d <= sp) { a.x = p.x; a.z = p.z; a.path.shift(); if (!a.path.length && a.onArrive) { const f = a.onArrive; a.onArrive = null; f(); } }
    else { a.x += dx / d * sp; a.z += dz / d * sp; a.face = Math.atan2(dx, dz); }
    a.phase += dt * (a.run ? 13 : 8.5) * a.speedVar * moodPace(a);
  }
  const seated = a.seated && !moving;
  const swivel = seated && now < a.swivelUntil;
  const faceTo = moving ? a.face : seated ? (swivel ? 0 : Math.PI) : (a.face ?? 0);   // seated robots face their screens (-z)
  a.root.rotation.y += angDiff(a.root.rotation.y, faceTo) * Math.min(1, dt * 7);
  const k = Math.min(1, dt * 10), sw = moving ? Math.sin(a.phase) : 0;
  a.root.position.set(a.x, seated ? -0.36 : (moving ? Math.abs(Math.cos(a.phase)) * 0.04 : 0), a.z);
  if (seated) {
    lerp(a.L.hip.rotation, 'x', -1.5, k); lerp(a.R.hip.rotation, 'x', -1.5, k); lerp(a.L.knee.rotation, 'x', 1.45, k); lerp(a.R.knee.rotation, 'x', 1.45, k);
    const typing = Math.sin(now / 2600 + a.phase * 3) > -0.15, ty = swivel ? 0 : Math.sin(now / 85 + a.phase) * (typing ? 0.09 : 0.01);
    lerp(a.AL.sh.rotation, 'x', swivel ? -0.2 : -0.75 + ty, k); lerp(a.AR.sh.rotation, 'x', swivel ? -0.2 : -0.75 - ty, k);
    lerp(a.AL.el.rotation, 'x', swivel ? -0.3 : -0.9, k); lerp(a.AR.el.rotation, 'x', swivel ? -0.3 : -0.9, k);
    lerp(a.torso.rotation, 'x', swivel ? -0.05 : typing ? 0.12 : -0.04, k);
  } else {
    const st = a.run ? 0.75 : 0.5;
    lerp(a.L.hip.rotation, 'x', sw * st, k); lerp(a.R.hip.rotation, 'x', -sw * st, k);
    lerp(a.L.knee.rotation, 'x', Math.max(0, -sw) * st * 1.4, k); lerp(a.R.knee.rotation, 'x', Math.max(0, sw) * st * 1.4, k);
    lerp(a.AL.sh.rotation, 'x', -sw * st * 0.8, k); lerp(a.AR.sh.rotation, 'x', a.carry.visible ? -0.6 : sw * st * 0.8, k);
    lerp(a.AL.el.rotation, 'x', -0.35, k); lerp(a.AR.el.rotation, 'x', a.carry.visible ? -1.0 : -0.35, k);
    lerp(a.torso.rotation, 'x', moving ? 0.06 : 0, k);
  }
  let yaw = seated && !swivel ? Math.sin(now / 1900 + a.phase) * 0.3 : 0;
  const tk = !(a.bubble && now < a.bubble.until) && !moving ? nearestTalker(a) : null;
  if (tk) yaw = Math.max(-1.1, Math.min(1.1, angDiff(a.root.rotation.y, Math.atan2(tk.x - a.x, tk.z - a.z))));
  a.headYaw += (yaw - a.headYaw) * Math.min(1, dt * 5); a.head.rotation.y = a.headYaw;
  lerp(a.head.rotation, 'x', 0, k); lerp(a.head.rotation, 'z', 0, k); lerp(a.AL.sh.rotation, 'z', 0, k); lerp(a.AR.sh.rotation, 'z', 0, k);
  const gst = now < (a.gestureUntil || 0) ? a.gesture : (a.bubble && now < a.bubble.until && !moving && !seated ? 'explain' : null);
  if (gst) gesture(a, gst, now, k, seated);
  else if (a.moodName === 'frustrated' || a.moodName === 'uneasy') { lerp(a.head.rotation, 'x', seated ? 0.16 : 0.24, k); if (!seated) lerp(a.torso.rotation, 'x', 0.15, k); }
  else if ((a.moodName === 'fired up' || a.moodName === 'confident') && moving) a.root.position.y += Math.abs(Math.cos(a.phase)) * 0.05;
  const talking = a.bubble && now < a.bubble.until;
  const mood = now < a.moodUntil ? a.mood : 'neutral';
  const blink = (now + a.phase * 1000) % 4300 < 140;
  a.faceScr.set(mood, blink ? 1 : 0, talking ? (Math.floor(now / 140) % 2 ? 1 : 2) : 0);
  if (a.tip) a.tip.visible = a.id === 'rex' ? Math.floor(now / 450) % 2 === 0 : true;
  if (a.tip && (a.id === 'ava' || a.id === 'opal')) a.tip.rotation.z += dt * 1.2;
  a.core.scale.setScalar(now < a.glowUntil ? 1.8 + Math.sin(now / 60) * 0.5 : 1);
  a.root.visible = !a.hidden && !a.far;
}

function gesture(a, g, now, k, seated) {
  const t = now / 1000, sn = Math.sin, L = (o, key, v) => lerp(o, key, v, k);
  const arms = (lx, rx, lz, rz, le, re) => { L(a.AL.sh.rotation, 'x', lx); L(a.AR.sh.rotation, 'x', rx); L(a.AL.sh.rotation, 'z', lz); L(a.AR.sh.rotation, 'z', rz); L(a.AL.el.rotation, 'x', le); L(a.AR.el.rotation, 'x', re); };
  const stand = () => { a.root.position.y = 0; for (const leg of [a.L, a.R]) { L(leg.hip.rotation, 'x', 0); L(leg.knee.rotation, 'x', 0); } };
  switch (g) {
    case 'celebrate': { const j = Math.abs(sn(t * 8.5)); stand(); a.root.position.y = j * 0.3;          // jump with both arms up
      for (const leg of [a.L, a.R]) { L(leg.hip.rotation, 'x', -0.35 * (1 - j)); L(leg.knee.rotation, 'x', 0.7 * (1 - j)); }
      arms(-2.95, -2.95, -0.35 - 0.25 * sn(t * 8.5), 0.35 + 0.25 * sn(t * 8.5), -0.25, -0.25); L(a.torso.rotation, 'x', -0.12); L(a.head.rotation, 'x', -0.3); break; }
    case 'fistpump': arms(-0.3, -2.3 - 0.45 * Math.max(0, sn(t * 11)), 0, 0.1, -0.3, -1.4); L(a.head.rotation, 'x', -0.15); break;
    case 'clap': arms(-1.35, -1.35, 0.32 + 0.22 * sn(t * 17), -0.32 - 0.22 * sn(t * 17), -0.6, -0.6); break;
    case 'facepalm': arms(-0.3, -2.4, 0, 0.3, -0.2, -2.1); L(a.head.rotation, 'x', 0.45); L(a.torso.rotation, 'x', 0.25); break;
    case 'slump': arms(0.05, 0.05, 0.08, -0.08, -0.1, -0.1); L(a.head.rotation, 'x', 0.55); L(a.torso.rotation, 'x', 0.35); break;
    case 'nod': a.head.rotation.x = 0.12 + 0.16 * sn(t * 7); break;
    case 'shakehead': a.head.rotation.y = 0.45 * sn(t * 10); L(a.head.rotation, 'x', 0.2); break;
    case 'point': arms(seated ? -0.75 : -0.2, -1.65, 0, 0.05, -0.9, -0.05); L(a.head.rotation, 'x', -0.1); break;
    case 'phone': arms(seated ? -0.75 : -0.2, -2.05, 0, 0.45, -0.9, -2.35); a.head.rotation.z = 0.2; break;
    case 'stretch': arms(-3.0, -3.0, -0.3, 0.3, -0.15, -0.15); L(a.torso.rotation, 'x', -0.22); L(a.head.rotation, 'x', -0.35); break;
    case 'explain': arms(-0.75 + 0.3 * sn(t * 5), -0.85 + 0.3 * sn(t * 5 + 2), -0.25 * sn(t * 3), 0.25 * sn(t * 3 + 1), -1.0, -1.0); break;
    case 'wave': arms(-0.2, -2.75, 0, 0.45 + 0.4 * sn(t * 10), -0.2, -0.45); break;
    case 'highfive': stand(); arms(-0.2, -2.95, 0, 0.15, -0.2, 0); L(a.head.rotation, 'x', -0.2); break;
    case 'pat': stand(); arms(-0.15, -1.45 + 0.1 * sn(t * 9), 0, -0.3, -0.2, -0.55); L(a.head.rotation, 'x', 0.15); break;     // hand on a colleague's shoulder
    case 'thumbsup': arms(seated ? -0.75 : -0.2, -1.25, 0, 0.1, -0.9, -1.7); L(a.head.rotation, 'x', -0.1); break;
    case 'shrug': arms(-0.35, -0.35, -0.45, 0.45, -1.35, -1.35); L(a.head.rotation, 'z', 0.18); break;
    case 'laugh': { const b = sn(t * 14); arms(-0.4, -0.4, -0.1, 0.1, -1.2 + b * 0.1, -1.2 - b * 0.1); L(a.head.rotation, 'x', -0.3 + b * 0.08); L(a.torso.rotation, 'x', -0.08 + b * 0.05); break; }
    case 'cheer': { const j = Math.abs(sn(t * 7)); arms(-2.7 - 0.25 * j, -2.7 - 0.25 * j, -0.25, 0.25, -0.5, -0.5); if (!seated) a.root.position.y = j * 0.12; L(a.head.rotation, 'x', -0.3); break; }
  }
}
const confMats = [0xff4d6d, 0xffd166, 0x22d3ee, 0x34d399, 0xa78bfa, 0xffffff].map(c => new THREE.MeshBasicMaterial({ color: c, side: THREE.DoubleSide, toneMapped: false }));
const confGeo = new THREE.PlaneGeometry(0.07, 0.11);
function confetti(x, y, z, n = 60) {
  for (let i = 0; i < n; i++) { const m = new THREE.Mesh(confGeo, confMats[i % confMats.length]); m.position.set(x, y, z); m.rotation.set(Math.random() * 6, Math.random() * 6, 0); scene.add(m);
    coins.push({ m, conf: true, v: new THREE.Vector3((Math.random() - 0.5) * 4, 3 + Math.random() * 3, (Math.random() - 0.5) * 4), born: performance.now() + 900 }); }
}

// ── overlay ───────────────────────────────────────────────
const v3 = new THREE.Vector3();
function toScreen(x, y, z) { v3.set(x, y, z).project(camera); return { x: (v3.x + 1) / 2 * stage.clientWidth, y: (1 - v3.y) / 2 * stage.clientHeight, ok: v3.z < 1 }; }
function placeOverlay(now) {
  for (const a of Object.values(agents)) {
    const p = toScreen(a.x, a.seated && !a.path.length ? 2.05 : 2.45, a.z);
    const showLabel = p.ok && !a.hidden && !a.far && (selected === a.id || hovered === a.id || a.path.length > 0);
    a.label.style.display = showLabel ? 'block' : 'none';
    const lc = 'label' + (selected === a.id ? ' sel' : ''); if (a.label.className !== lc) a.label.className = lc;
    if (showLabel) { a.label.style.left = p.x + 'px'; a.label.style.top = p.y + 'px'; }
    const b = a.bubble && now < a.bubble.until && p.ok && !a.hidden && (selected === a.id || Math.hypot(a.x - controls.target.x, a.z - controls.target.z) < (walk.on ? 16 : 36));
    a.bubbleEl.style.display = b ? 'block' : 'none';
    if (b) { const html = `<span class="who" style="color:${COLORS[a.id]}">${esc(a.name)}</span>${esc(a.bubble.text)}`;
      if (a.bubbleEl.dataset.h !== html) { a.bubbleEl.innerHTML = html; a.bubbleEl.dataset.h = html; a.bubbleEl.classList.toggle('big', !!a.bubble.big); }
      a.bubbleEl.style.left = Math.max(135, Math.min(stage.clientWidth - 135, p.x)) + 'px'; a.bubbleEl.style.top = Math.max(70, p.y - (showLabel ? 26 : 8)) + 'px'; }
  }
  placePlayer(now);
  for (const f of overlayFx) { const p = toScreen(f.x, f.y, f.z); f.el.style.left = p.x + 'px'; f.el.style.top = p.y + 'px'; }
}
const overlayFx = [];
function popFx(cls, text, x, y, z, ms = 2400) {
  const el = document.createElement('div'); el.className = cls; el.textContent = text; overlay.appendChild(el);
  const f = { el, x, y, z }; overlayFx.push(f);
  setTimeout(() => { el.remove(); overlayFx.splice(overlayFx.indexOf(f), 1); }, ms);
  return el;
}
const coins = [];
const coinGeo = new THREE.CylinderGeometry(0.12, 0.12, 0.035, 20), coinMat = new THREE.MeshStandardMaterial({ color: 0xf5c451, roughness: 0.25, metalness: 0.9 });
const sparkGeo = new THREE.OctahedronGeometry(0.06);
function burst(n, x = POI.exchange.x - 0.2, y = 2, z = 3.5, spark = false) {
  for (let i = 0; i < n; i++) { const m = new THREE.Mesh(spark ? sparkGeo : coinGeo, spark ? glow(TEAL, 2) : coinMat); m.position.set(x, y, z); scene.add(m);
    coins.push({ m, v: new THREE.Vector3((Math.random() - 0.5) * 5 - (spark ? 0 : 1.5), 3 + Math.random() * 4, (Math.random() - 0.5) * 5), born: performance.now() }); }
}

// ── server events → animations ────────────────────────────
let doorOpenUntil = 0, onAirUntil = 0;
function openWire() { follow = false; setFollowBtn(); tweenCam(WIRE_CAM[0].clone(), WIRE_CAM[1].clone(), 1400); openTab('wire'); }
function openCityHall() { follow = false; setFollowBtn(); tweenCam(CITYHALL_CAM[0].clone(), CITYHALL_CAM[1].clone(), 1600); modal('cityhall', 'City Hall · JB City at a glance', '<div id="chBody"></div>'); renderCityHall(); }
const GO = { incubator: () => openIncubator(), ops: () => goOps(), fund: () => tweenCam(HOME_POS.clone(), HOME_TGT.clone()), studio: () => openStudio(), news: () => openNews(), career: () => openCareer(), study: () => openStudy() };
const ago = t => { const s = Date.now() / 1000 - t; return s < 60 ? 'just now' : s < 3600 ? Math.floor(s / 60) + 'm ago' : Math.floor(s / 3600) + 'h ago'; };
function renderCityHall() {
  const c = snap?.city, el = $('chBody'); if (!c || !el) return;
  const h = c.health, maxR = Math.max(1, ...c.routes.map(r => r[1]));
  el.innerHTML = `<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px">
      <span class="pill ${h.ok ? 'ok' : ''}" style="${h.ok ? '' : 'color:var(--amber);border-color:rgba(245,158,11,.5)'}">${h.ok ? '● all systems normal' : '● ' + h.issues.length + ' issue' + (h.issues.length > 1 ? 's' : '')}</span>
      <span class="pill">up ${esc(h.uptime)}</span><span class="pill ${h.brain === 'off' ? '' : 'ai'}">AI · ${esc(h.brain)}</span>
      ${Object.entries(h.feeds || {}).map(([k, v]) => `<span class="pill ${/real time|live/.test(v) ? 'ok' : ''}" title="${esc(v)}">${esc(k)} · ${/real time|live/.test(v) ? 'RT' : 'delayed'}</span>`).join('')}</div>
    ${h.issues.length ? `<div class="rlog fail" style="margin-bottom:12px">${h.issues.map(esc).join('<br>')}</div>` : ''}
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:10px">${c.buildings.map(b => `<div class="pod" style="margin:0;border-top:3px solid ${BCOL[b.id]}">
      <div class="row1"><span class="nm">${esc(b.name)}</span><span class="tag ${b.working ? 'paused' : ''}">${b.working ? esc(b.status) : 'idle'}</span></div>
      <table style="margin-top:6px">${b.kpis.map(([k, v]) => `<tr><td class="t muted" style="padding:3px 0;border:0;white-space:nowrap">${esc(k)}</td><td style="padding:3px 0 3px 8px;border:0;text-align:right" title="${esc(String(v))}">${esc(String(v).length > 24 ? String(v).slice(0, 23) + '…' : String(v))}</td></tr>`).join('')}</table>
      <div class="faint" style="font-size:11.5px;margin-top:6px;min-height:30px">${b.last ? `<b style="color:var(--muted)">${esc(b.last.name)}</b> · ${esc(b.last.text.slice(0, 90))} <span class="mono">${ago(b.last.t)}</span>` : 'quiet so far'}</div>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-top:6px"><span class="faint mono" style="font-size:11px">${b.events_today} events today · ${b.inbox} on the Wire</span><button class="btn sm" data-go="${b.id}">Go there</button></div></div>`).join('')}</div>
    <h3 style="margin:16px 0 8px">The Wire · last 24 hours</h3>
    ${c.routes.length ? c.routes.slice(0, 10).map(([r, n]) => `<div style="display:grid;grid-template-columns:200px 1fr 34px;gap:8px;align-items:center;margin:4px 0;font-size:12.5px"><span class="muted">${esc(r)}</span><div class="bar" style="margin:0"><i style="width:${n / maxR * 100}%"></i></div><span class="mono" style="text-align:right">${n}</span></div>`).join('') : '<div class="muted">No messages yet today.</div>'}`;
  el.querySelectorAll('[data-go]').forEach(btn => btn.onclick = () => { closeModal(); GO[btn.dataset.go]?.(); });
}
function openIncubator() { follow = false; setFollowBtn(); tweenCam(INC_CAM[0].clone(), INC_CAM[1].clone(), 1400); openTab('research'); setTimeout(() => $('incSec')?.scrollIntoView({ block: 'start' }), 60); }
function goOps() { follow = false; setFollowBtn(); tweenCam(OPS_CAM[0].clone(), OPS_CAM[1].clone(), 1400); }
function openStudy() { follow = false; setFollowBtn(); tweenCam(STUDY_CAM[0].clone(), STUDY_CAM[1].clone(), 1400); openTab('studyp'); }
function openCareer() { follow = false; setFollowBtn(); tweenCam(CAREER_CAM[0].clone(), CAREER_CAM[1].clone(), 1400); openTab('careerp'); }
function openNews() { follow = false; setFollowBtn(); tweenCam(NEWS_CAM[0].clone(), NEWS_CAM[1].clone(), 1400); openTab('newsp'); }
function openStudio() { follow = false; setFollowBtn(); tweenCam(STUDIO_CAM[0].clone(), STUDIO_CAM[1].clone(), 1400); openTab('ventures'); }
let actx = null, soundOn = (() => { try { return localStorage.getItem('jb.sound') === '1'; } catch { return false; } })();
function beep(notes, type = 'sine', vol = 0.05, dur = 0.1) {
  if (!soundOn) return;
  try { actx ||= new (window.AudioContext || window.webkitAudioContext)(); if (actx.state === 'suspended') actx.resume(); const t0 = actx.currentTime;
    notes.forEach((f, i) => { const o = actx.createOscillator(), g = actx.createGain(), t = t0 + i * dur; o.type = type; o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + 0.012); g.gain.exponentialRampToValueAtTime(0.0001, t + dur * 1.7);
      o.connect(g).connect(actx.destination); o.start(t); o.stop(t + dur * 1.8); }); } catch { /* no audio */ }
}
const SFX = { fill: () => beep([1046], 'triangle', 0.035, 0.07), win: () => beep([659, 880, 1319], 'triangle', 0.05, 0.09), loss: () => beep([330, 247], 'sine', 0.05, 0.13),
  hire: () => beep([523, 659, 784, 1047], 'triangle', 0.05, 0.11), pop: () => beep([140 + Math.random() * 160], 'square', 0.02, 0.05), round: () => beep([988, 1319], 'triangle', 0.04, 0.07),
  alert: () => beep([440, 440], 'square', 0.025, 0.09) };
function sfxFor(e) {
  if (e.kind === 'fill') SFX.fill(); else if (e.kind === 'close') (e.pnl || 0) >= 0 ? SFX.win() : SFX.loss();
  else if (e.kind === 'hire') SFX.hire(); else if (e.kind === 'ops' && e.ok === false) SFX.alert();
}
function handle(e) {
  logLine(e); gameFeed(e); sfxFor(e);
  const t = e.text, me = agents[e.agent];
  switch (e.kind) {
    case 'data': act('dot', go(POI.wall), fx(() => heatTex.redraw()), say(t, 3000), wait(800), home()); break;
    case 'signal':
      feel(me, 'think', 3500);
      act(e.agent, anim('point', 1100), say(t, 3400), go(POI.bossVisit, false, true), say(e.agent === 'opal' ? 'Options trade proposal.' : e.dir > 0 ? 'Long idea for you.' : 'Short idea for you.', 2000), home());
      act('boss', wait(4000), fx(b => feel(b, 'think', 2500)), say('Checking your limits and the team’s view…', 2000));
      if (Math.random() < 0.5) act('vic', say(`Vol check on ${e.sym}: ${snap?.vic?.[e.sym] || 'normal'}.`, 2500));
      break;
    case 'analysis': act('ava', say(t, 5000), go(POI.bossVisit, false, true), say('Market brief, as promised.', 2000), home()); break;
    case 'decision': act('boss', say(t, 3400)); if (e.act === 'trade') act('rex', wait(700), say('Checking limits…', 1400)); break;
    case 'risk': {
      act('rex', fx(() => popFx('stamp ' + (e.ok ? 'ok' : 'no'), e.ok ? 'APPROVED' : 'VETO', agents.rex ? agents.rex.x : 6.5, 2.8, agents.rex ? agents.rex.z - 1.2 : 2.6)), say(t, 3600));
      if (!e.ok) { feel(agents[e.target], 'sad', 4000); gest(agents[e.target], 'facepalm', 2000); }
      const dv = e.target && deskVisit(e.target); if (dv && e.ok) act('rex', go(dv), say('Stop is set. You’re within limits.', 2000), home());
      break;
    }
    case 'order': act('eddie', say(t, 2000), go(POI.exchange, true, true), fx(a => { a.hidden = true; doorOpenUntil = performance.now() + 1600; }), wait(1300), fx(a => a.hidden = false), home()); break;
    case 'fill': popFx('floater', 'FILLED ' + (e.sym || ''), POI.exchange.x - 0.6, 3.2, 3.5).style.color = '#7c8cff'; burst(8); feel(agents.eddie, 'happy', 3000); break;
    case 'close': {
      const up = (e.pnl || 0) >= 0;
      popFx('floater', (up ? '+$' : '-$') + Math.abs(e.pnl || 0).toFixed(0), POI.exchange.x - 0.6, 3.2, 3.5).style.color = up ? '#22c55e' : '#f43f5e';
      if (up) burst(20);
      feel(agents.eddie, up ? 'happy' : 'sad', 4000); feel(agents[e.pod], up ? 'happy' : 'sad', 8000);
      act('eddie', anim(up ? 'fistpump' : 'shakehead', 1400), say(up ? 'Profit booked.' : 'Small loss. The stop did its job.', 2200));
      const pa = agents[e.pod];
      if (pa && up) {
        act(e.pod, fx(b => { b.swivelUntil = performance.now() + 6000; confetti(b.x, 2.2, b.z); }), anim('celebrate', 3200), say(choose(['YES! Let’s go!', 'Called it!', 'Money printer!', 'That’s how it’s done.']), 2600), anim('fistpump', 1200));
        for (const b of near(pa.x, pa.z, 9)) if (b !== pa && b.id !== 'eddie') setTimeout(() => gest(b, 'clap', 2600), 400 + Math.random() * 600);
        if ((e.pnl || 0) > 150) act('boss', go(deskVisit(e.pod)), anim('highfive', 1300), fx(() => { gest(agents[e.pod], 'highfive', 1300); burst(14, pa.x - 0.8, 2.4, pa.z - 0.3, true); }), say('Great trade. That’s the process working.', 2600), home());
        else congratulate(e.pod, (e.pnl || 0) > 60);
      } else if (pa) {
        act(e.pod, anim('facepalm', 1800), anim('slump', 2200), say(choose(['Ugh. Noted.', 'Feeding this back to Sam.', 'The stop did its job…']), 2400));
        if (Math.random() < 0.6) consolePM(e.pod);
        setTimeout(() => gest(agents.rex, 'nod', 1800), 900);
      }
      break;
    }
    case 'trail': act('eddie', say(t, 2600)); break;
    case 'score': act('sam', go(POI.scoreboard), fx(() => sbTex.redraw()), say(t, 3600), home()); if (e.target && agents[e.target]) { feel(agents[e.target], e.ok ? 'happy' : 'sad', 4000); act(e.target, say(e.ok ? 'Called it.' : 'Hm. Updating my priors.', 1500)); } break;
    case 'vol': act('vic', go(POI.wall), say(t, 3200), home()); break;
    case 'arena': feel(agents.sam, e.ok === false ? 'think' : 'happy', 5000); act('sam', anim('explain', 1600), say(t, 5200)); if (modalKind === 'arena') renderArena(); break;
    case 'math': feel(agents.quinn, 'happy', 6000); act('quinn', anim('clap', 1800), say(t, 5000)); break;
    case 'incubator': feel(agents.juno, 'happy', 6000); act('juno', anim('explain', 2200), say(t, 5000));
      if (/goes into the incubator/.test(t) && agents.ava && !agents.ava.leaving && agents.ava.seated)
        act('ava', say('This one goes to the Incubator. Back in a bit.', 2400), go({ x: IX - 10.5, z: IZ - 1 }, false, true), faceTo(IX + 10.5, IZ + 2.2),
          say('Juno, a new strategy for the shadow book.', 2800), fx(() => act('juno', anim('nod', 1400), say('Got it. Desk is ready.', 2400))), wait(2600), home());
      break;
    case 'ops': feel(me, e.ok === false ? 'think' : 'happy', 6000); act(e.agent, go(OPS_WALL), fx(b => b.face = Math.PI), say(t, 4500), home()); break;
    case 'research': {
      feel(agents.ava, 'think', 9000);
      const dv = e.target && deskVisit(e.target);
      if (e.step === 'go') act('ava', say(t, 3000), ...(dv ? [go(dv), say(`${nameOf(e.target)}, I'm retraining your model.`, 2200)] : []), go(POI.lab, false, true), fx(a => a.face = Math.PI));
      else act('ava', say(t, 6000));
      break;
    }
    case 'study_visit':
      if (e.step === 'go') { const sx = HX + choose([-2.4, -0.8, 0.8, 2.4]), sz = HZ + 5.6 + choose([-1.6, 1.6]);
        act(e.agent, say(t, 3200), go({ x: sx, z: sz }), fx(b => { b.face = sz > HZ + 5.6 ? Math.PI : 0; feel(b, 'think', 20000); }), anim('nod', 2600), say('Reading…', 4000), wait(12000), anim('nod', 2600), say('Taking notes.', 3000), wait(12000)); }
      else act(e.agent, say(t, 3500), home());
      break;
    case 'study_note': feel(me, 'happy', 5000); act(e.agent, anim('nod', 1400), say(t, 6000), home()); break;
    case 'experiment':
      if (e.step === 'go') { feel(me, 'think', 12000); act(e.agent, say(t, 3500), go(POI.lab, false, true), fx(b => b.face = Math.PI)); }
      else if (e.step === 'done') { if (e.adopted) { feel(me, 'happy', 8000); act(e.agent, fx(b => confetti(b.x, 2.2, b.z)), anim('celebrate', 2600)); for (const b of near(POI.lab.x, POI.lab.z, 10)) if (b !== me) setTimeout(() => gest(b, 'clap', 2400), 600); setTimeout(() => congratulate(e.agent, true), 9000); } act(e.agent, say(t, 4500), home()); }
      else { act(e.agent, fx(() => labTex.redraw()), anim(e.ok ? 'fistpump' : 'shakehead', 1200), say(t, 4200)); }
      break;
    case 'model': feel(me, 'think', 7000); act('kai', say(t, 5200)); mlabTex.redraw(); break;
    case 'model_verdict': act('kai', say(t, 6000), anim(e.ok ? 'fistpump' : 'shakehead', 1400)); mlabTex.redraw();
      if (agents.kai) popFx('stamp ' + (e.ok ? 'ok' : 'no'), e.ok ? 'PASSED' : 'FAILED', agents.kai.x, 3.2, agents.kai.z, 2600);
      if (e.ok && agents.kai) burst(16, agents.kai.x, 2.2, agents.kai.z, true); if (modalKind === 'mlab') loadMlab(); break;
    case 'idea': feel(agents.ava, 'think', 8000); act('ava', say(t, 6000), fx(() => labTex.redraw())); break;
    case 'backtest': testingUntil = performance.now() + 7000; act('ava', say(t, 3500)); break;
    case 'verdict':
      popFx('stamp ' + (e.ok ? 'ok' : 'no'), e.ok ? 'PASSED' : 'FAILED', POI.lab.x, 3.2, POI.lab.z + 1.4, 2600);
      feel(agents.ava, e.ok ? 'happy' : 'sad', 5000);
      act('ava', anim(e.ok ? 'celebrate' : 'shakehead', e.ok ? 2600 : 1600), say(t, 4500), say(e.ok ? 'This one goes to the CIO.' : 'Back to the drawing board.', 2200));
      if (e.ok && agents.ava) confetti(agents.ava.x, 2.2, agents.ava.z, 40);
      if (e.ok) { burst(16, POI.lab.x, 2.2, POI.lab.z + 1.4, true); for (const b of Object.values(agents)) if (b.seated && inFund(b) && b.id !== 'ava') setTimeout(() => gest(b, 'clap', 2200), 1500 + Math.random() * 900); }
      break;
    case 'promotion': act('boss', say(t, 4500)); if (e.target) { floorCheer(e.target, null); setTimeout(() => congratulate(e.target, true), 4000); } break;
    case 'pitch': feel(me, 'think', 6000); act(e.agent, anim('explain', 2600), say(t, 5200)); for (const b of near(me?.x ?? 0, me?.z ?? 0, 8)) if (b !== me) setTimeout(() => gest(b, 'nod', 1600), 1500); break;
    case 'chat': if (me && !me.hidden) { me.bubble = { text: t, until: performance.now() + Math.min(18000, 5000 + t.length * 45), big: true }; me.said.push(t); me.said = me.said.slice(-6);
        gest(me, 'explain', 2200); feel(me, 'happy', 6000); if (isGame() && selected === e.agent) renderCard(true); } break;
    case 'announce': announceFx(e); break;
    case 'compliance': feel(me, e.ok === false ? 'think' : 'happy', 5000); act('lena', say(t, 5000), anim(e.ok === false ? 'shakehead' : 'nod', 1400)); if (modalKind === 'compliance') renderCompliance(); break;
    case 'report': act(e.agent, say(t, 6000), anim('explain', 2000)); break;
    case 'journal': feel(me, 'think', 6000); act(e.agent, say(t, 5500), anim(choose(['nod', 'shrug']), 1200)); break;
    case 'reflect': act('boss', anim('explain', 2000), say(t, 3500)); break;
    case 'upgrade': {
      act('boss', say(t, 4500));
      const a = agents[e.target];
      if (a) { a.glowUntil = performance.now() + 5000; feel(a, 'happy', 8000); burst(24, a.seat[0], 2, a.seat[1], true); act(e.target, wait(800), say('Upgrade installed. New version online.', 3000)); }
      break;
    }
    case 'hire': feel(agents.boss, 'happy', 5000); act('boss', anim('clap', 2000), say(t, 5000)); burst(24, POI.exchange.x - 0.2, 2.2, 3.5);
      for (const b of Object.values(agents)) if (b.seated) setTimeout(() => gest(b, 'clap', 3000), 3000 + Math.random() * 800);
      break;
    case 'fire': {
      act('boss', say(t, 4000));
      const a = agents[e.target];
      if (a) { a.leaving = true; feel(a, 'sad', 20000); act(e.target, anim('slump', 1800), say('Understood. Clearing my desk.', 2500), go(POI.exchange, false, true), fx(() => removeAgent(e.target))); }
      break;
    }
    case 'huddle': {
      let i = 0;
      for (const a of Object.values(agents)) { if (a.leaving || a.hidden || STUDIO_IDS.has(a.id) || NEWS_IDS.has(a.id) || CAREER_IDS.has(a.id) || STUDY_IDS.has(a.id)) continue; const spot = MEET_SPOTS[i++ % MEET_SPOTS.length];
        act(a.id, go(spot), fx(b => b.face = Math.atan2(-10.8 - b.x, 9.75 - b.z)), wait(a.id === 'boss' ? 400 : 26000), home()); }
      act('boss', say(t, 8000));
      break;
    }
    case 'meeting': {
      act(e.agent, say(t, 4500));
      for (const b of Object.values(agents)) if (b !== me && !b.seated && Math.random() < 0.6) setTimeout(() => gest(b, 'nod', 2200), Math.random() * 1500);
      if (/back to work/i.test(t)) for (const b of Object.values(agents)) if (!b.seated) setTimeout(() => gest(b, 'clap', 2600), 1600 + Math.random() * 500);
      break;
    }
    case 'studio': {
      const ph = e.phase;
      if (ph === 'start') { act('rosa', anim('explain', 2000), say(t, 3000)); act('iris', wait(1200), fx(b => feel(b, 'happy', 4000)), anim('nod', 1200)); }
      else if (ph === 'scout') act('iris', anim('explain', 2600), say(t, 5000));
      else if (ph === 'idea') { feel(agents.iris, 'happy', 5000); act('iris', anim('point', 1800), say(t, 5500)); pipeTex.redraw(); }
      else if (ph === 'research') { feel(agents.theo, 'think', 30000); act('theo', say(t, 3500), anim('phone', 4000)); }
      else if (ph === 'report') act('theo', anim('explain', 3000), say(t, 6000));
      else if (ph === 'score') { feel(agents.rosa, 'think', 6000); act('rosa', anim('nod', 1500), say(t, 2500)); }
      else if (ph === 'verdict') {
        pipeTex.redraw();
        if (e.verdict === 'GREENLIT') { for (const id of STUDIO_IDS) { feel(agents[id], 'happy', 7000); act(id, anim('celebrate', 2400)); } act('rosa', say(t, 6000)); confetti(SX, 3.5, SZ + 1, 90);
          showToast(`JB Ventures greenlit "${e.title}"`, () => openTab('ventures')); }
        else if (e.verdict === 'WATCHLIST') { act('rosa', anim('nod', 1500), say(t, 5500)); feel(agents.iris, 'think', 4000); }
        else { act('rosa', anim('shakehead', 1500), say(t, 5500)); feel(agents.iris, 'sad', 5000); act('iris', wait(1500), anim('slump', 1800), say('Back to scouting.', 1800)); }
      } else act(e.agent, say(t, 3200));
      break;
    }
    case 'wire': {
      wireTex.redraw(); if (activeTab === 'wire') renderWire();
      const msg = wireText(t), short = msg.length > 120 ? msg.slice(0, 117) + '…' : msg;
      if (e.frm === 'jason') {                                   // Jason's phone -> a drone delivers it
        drone(BPOS.jason, BPOS[e.to], 0xfbbf24); const who = WIRE_DESK[e.to];
        act(who, wait(4200), fx(b => feel(b, 'think', 5000)), anim('phone', 2200), say('Message from Jason: “' + short + '”', 4500));
      } else if (e.to === 'jason') {                             // a building reports back to Jason
        act(e.agent, anim('phone', 1800), say(short, 4200), fx(() => drone(BPOS[e.frm], BPOS.jason, 0x34d399)));
        if (e.topic === 'greenlit') showToast('JB Ventures sent you a greenlit idea', () => openTab('wire'));
        else if (e.reply) showToast('Reply on the Wire: ' + short.slice(0, 60), () => openTab('wire'));
      } else {                                                   // tower to tower: the messenger walks the sky bridge
        const rcpt = { studio: 'iris', news: 'nia', career: 'cole', study: 'sage', fund: e.topic === 'news_brief' ? 'ava' : 'boss' }[e.to] || 'boss';
        const dest = rcpt === 'boss' ? POI.bossVisit : deskVisit(rcpt);
        act(e.agent, say(`Taking this over to ${{ fund: 'the fund', studio: 'JB Ventures', news: 'the newsroom', career: 'JB Careers', study: 'the study hall' }[e.to] || e.to}.`, 2000), go(dest, true, true), say(short, 5000), home());
        if (e.to === 'career' || e.frm === 'career') careerTex.redraw();
        const dist = agents[e.agent] ? Math.abs(agents[e.agent].x - dest.x) + 8 : 30;
        setTimeout(() => { gest(agents[rcpt], 'nod', 2200); feel(agents[rcpt], 'happy', 3000); }, dist / (2.2 * 1.9) * 1000 + 2500);
      }
      break;
    }
    case 'news': {
      newsTex.redraw(); zipTex.redraw(); if (activeTab === 'newsp') renderNews();
      if (e.phase === 'meeting') { act('nia', anim('explain', 2200), say(t, 3200)); act('ben', wait(1500), anim('nod', 1200)); act('lux', wait(1800), anim('nod', 1200)); }
      else if (e.phase === 'brief') { feel(agents.nia, e.big ? 'think' : 'happy', 5000); act('nia', anim('explain', 2600), say(t, 6000)); onAirUntil = performance.now() + 20000;
        if (e.big) showToast('Breaking: ' + wireText(t).slice(0, 70), () => openTab('newsp')); }
      else { feel(me, 'happy', 3000); act(e.agent, anim('phone', 2200), say(t, 4500)); }
      break;
    }
    case 'career': {
      careerTex.redraw(); if (activeTab === 'careerp') renderCareer();
      if (e.phase === 'standup') { act('cole', anim('explain', 2600), say(t, 6500)); act('maya', wait(2000), anim('nod', 1200)); act('drew', wait(2400), anim('nod', 1200)); }
      else if (e.phase === 'scout') { feel(agents.maya, 'think', 20000); act('maya', say(t, 3500), anim('phone', 5000)); }
      else if (e.phase === 'found') { feel(agents.maya, 'happy', 5000); act('maya', anim('point', 1800), say(t, 5000)); }
      else if (e.phase === 'draft' || e.phase === 'prep') { feel(agents.drew, 'think', 12000); act('drew', say(t, 4000)); }
      else if (e.phase === 'ready') { feel(agents.drew, 'happy', 5000); act('drew', anim('fistpump', 1200), say(t, 4500)); }
      else act(e.agent, say(t, 3500));
      break;
    }
    case 'study': {
      chalkTex.redraw(); if (activeTab === 'studyp') renderStudy();
      if (e.phase === 'plan') { act('sage', anim('explain', 2600), say(t, 7000)); act('quinn', wait(2000), anim('nod', 1200)); }
      else if (e.phase === 'writing') { feel(agents.quinn, 'think', 30000); act('quinn', say(t, 4000)); }
      else if (e.phase === 'ready' || e.phase === 'quiz') { feel(agents.quinn, 'happy', 5000); act('quinn', anim('point', 1600), say(t, 5000)); showToast('Practice round ready (Study tab)', () => openTab('studyp')); }
      else if (e.phase === 'answer') {
        if (e.ok) { feel(agents.quinn, 'happy', 3000); gest(agents.quinn, 'fistpump', 1200); } else { feel(agents.quinn, 'think', 3000); gest(agents.quinn, 'nod', 1500); }
        act('quinn', say(t, 3000));
        if (e.done && e.score >= e.of - 1 && agents.quinn) { confetti(agents.quinn.x, 2.2, agents.quinn.z, 60); for (const id of STUDY_IDS) gest(agents[id], 'clap', 2600); }
      } else act(e.agent, say(t, 3500));
      break;
    }
    case 'letter': act('boss', say(t, 4500)); showToast('New investor letter — read it', () => openTab('letters')); break;
    case 'chatter': case 'system': act(e.agent, say(t, 3200)); break;
  }
}
// what each robot does between trades: their actual jobs
const choose = l => l[Math.floor(Math.random() * l.length)];

// ── body language & social life ───────────────────────────
const moodPace = a => ({ 'fired up': 1.18, confident: 1.07, focused: 1, uneasy: 0.9, frustrated: 0.8 })[a.moodName] || 1;
let talkers = [];
function nearestTalker(a) { let best = null, bd = 7; for (const b of talkers) { if (b === a) continue; const d = Math.hypot(b.x - a.x, b.z - a.z); if (d < bd) { bd = d; best = b; } } return best; }
const inFund = b => towerOf(b) === 'fund';
const freeMates = (x, z, d, exclude) => near(x, z, d).filter(b => b.seated && !b.path.length && b.queue.length < 3 && !b.leaving && b.id !== exclude && b.id !== 'boss' && towerOf(b) === towerOf({ x, z }))
  .sort((p, q) => (p.queue.length + (p.busy ? 1 : 0)) - (q.queue.length + (q.busy ? 1 : 0)));
const busyFund = () => Object.values(agents).filter(b => b.id !== 'boss' && inFund(b) && (!b.seated || b.path.length)).length;
const faceTo = (x, z) => fx(b => b.face = Math.atan2(x - b.x, z - b.z));
let socialUntil = 0, cheerUntil = 0;
const CONGRATS = ['Great trade!', 'That’s how it’s done!', 'You’re on fire!', 'Textbook execution.', 'Nice! Drinks on you.'];
const CONSOLE = ['Shake it off. The stop did its job.', 'Happens to all of us.', 'Small loss, good process.', 'Next one’s yours.'];
function congratulate(podId, big = false) {
  const pa = agents[podId], now = performance.now(); if (!pa || now < socialUntil) return; socialUntil = now + 25000;
  const dv = deskVisit(podId); if (!dv) return;
  freeMates(pa.x, pa.z, 12, podId).slice(0, 3).sort(() => Math.random() - 0.5).slice(0, big ? 2 : 1).forEach((b, i) =>
    act(b.id, wait(900 + i * 1600), fx(c => feel(c, 'happy', 8000)), go({ x: dv.x - i * 0.9, z: dv.z - 0.4 - i * 0.5 }), faceTo(pa.x, pa.z),
      anim(i ? 'thumbsup' : 'highfive', 1300), fx(() => { pa.swivelUntil = performance.now() + 4500; gest(pa, i ? 'laugh' : 'highfive', 1300); }),
      say(choose(CONGRATS), 2400), anim('laugh', 1100), home()));
}
function consolePM(podId) {
  const pa = agents[podId], now = performance.now(); if (!pa || now < socialUntil) return; socialUntil = now + 25000;
  const dv = deskVisit(podId), b = freeMates(pa.x, pa.z, 12, podId)[0]; if (!dv || !b) return;
  act(b.id, wait(2500), go(dv), faceTo(pa.x, pa.z), anim('pat', 1600), say(choose(CONSOLE), 2600), wait(1200), home());
  act(podId, wait(9000), fx(c => { c.swivelUntil = performance.now() + 4000; feel(c, 'neutral', 100); }), anim('nod', 1200), say(choose(['Thanks. On to the next one.', 'Yeah. Process over outcome.', 'Appreciate it.']), 2400));
}
function floorCheer(focusId, line) {
  const now = performance.now(); if (now < cheerUntil) return; cheerUntil = now + 60000;
  launchFireworks(0, 0);
  const fa = agents[focusId];
  for (const b of Object.values(agents)) { if (b.hidden || b.leaving || !inFund(b) || b === fa) continue;
    setTimeout(() => { gest(b, b.seated ? choose(['clap', 'cheer', 'clap']) : 'cheer', 2600); feel(b, 'happy', 6000); }, 300 + Math.random() * 900); }
  if (fa) { feel(fa, 'happy', 10000); fa.glowUntil = now + 6000; act(focusId, fx(b => confetti(b.x, 2.4, b.z, 90)), anim('celebrate', 3000), say(choose(['Let’s GO!', 'Team effort!', 'Thank you all!']), 2600)); }
  if (line) act('boss', anim('clap', 1600), say(line, 4200));
  burst(26, fa ? fa.x : 0, 2.4, fa ? fa.z : 0, true);
}
// quiet moments when nothing is happening: chats at a desk, the water cooler, looking out at the bay
const CHATS = [['Did you see BTC this morning?', 'Wild. My stops were nervous.'], ['What’s your read on rates?', 'Higher for longer. Trend’s your friend.'],
  ['Lunch later?', 'Only if the market lets me.'], ['Sam graded me harshly today.', 'Sam grades everyone harshly. That’s the point.'],
  ['Read anything good in the Study Hall?', 'A trend-following paper. Testing it tonight.'], ['Think the CIO saw my last trade?', 'Everyone saw it. Nice work.'],
  ['Dot says we’re all making the same bet.', 'Then I need a different idea.'], ['Coffee machine is broken again.', 'Worst risk event of the week.']];
const MOOD_CHATS = { frustrated: [['Rough week. Nothing’s working.', 'Stick to the process. It turns.']], uneasy: [['Volatility is making me nervous.', 'Smaller size, same rules.']],
  'fired up': [['I’m on a heater!', 'Don’t jinx it!']], confident: [['My new version is working.', 'Told you trial and error pays.']] };
const WINDOW_SPOTS = [{ x: -7.5, z: FZ - 0.8 }, { x: 7.5, z: FZ - 0.8 }];
const COOLER_SPOTS = [{ x: POI.cooler.x + 1.4, z: POI.cooler.z }, { x: POI.cooler.x + 0.8, z: POI.cooler.z + 1.2 }, { x: POI.cooler.x + 0.8, z: POI.cooler.z - 1.2 }];
function chatWith(a) {
  const nb = freeMates(a.x, a.z, 14, a.id).filter(b => inFund(b) && b.id !== a.id)[0]; if (!nb) return false;
  const [line, reply] = choose(MOOD_CHATS[a.moodName] || CHATS), dv = deskVisit(nb.id); if (!dv) return false;
  act(a.id, go(dv), faceTo(nb.x, nb.z), anim('wave', 700), say(line, 3000),
    fx(() => act(nb.id, fx(c => c.swivelUntil = performance.now() + 7000), wait(1300), anim(choose(['nod', 'laugh', 'shrug']), 1100), say(reply, 3000))),
    anim('explain', 2400), wait(2200), anim(choose(['laugh', 'nod']), 1100), say(choose(['Ha. Fair.', 'Good point.', 'Back to it.']), 1800), home());
  return true;
}
function coolerChat(a) {
  const others = freeMates(a.x, a.z, 30, a.id).filter(inFund).slice(0, 1 + (Math.random() < 0.5 ? 1 : 0)); if (!others.length) return false;
  const [line, reply] = choose(CHATS), cx = POI.cooler.x + 0.4, cz = POI.cooler.z;
  act(a.id, go(COOLER_SPOTS[0]), faceTo(cx, cz), anim('explain', 1800), say(line, 3200), wait(5200), anim('laugh', 1200), wait(1500), home());
  others.forEach((b, i) => act(b.id, wait(600 + i * 900), go(COOLER_SPOTS[i + 1]), faceTo(cx, cz), wait(2600 + i * 2400), anim(i ? 'laugh' : 'nod', 1100), say(i ? choose(['Ha!', 'Classic.', 'True story.']) : reply, 2800), wait(2400), home()));
  return true;
}
function lookOutside(a) {
  const sp = choose(WINDOW_SPOTS);
  act(a.id, go(sp), fx(b => b.face = 0), wait(1400), say(choose(['Boats are out on the bay.', 'Nice day out there.', 'Clear skies, choppy tape.', 'Needed a minute away from the screens.']), 2800), anim('stretch', 2000), wait(2500), home());
}
function moodBeat(a) {
  const m = a.moodName;
  if ((m === 'frustrated' || m === 'uneasy') && Math.random() < 0.35) { act(a.id, anim(choose(['facepalm', 'slump', 'shakehead']), 1700), say(choose(['Ugh.', 'Why did I take that trade…', 'Back to the drawing board.', 'Need a better idea.']), 2200)); return true; }
  if ((m === 'fired up' || m === 'confident') && Math.random() < 0.3) { act(a.id, anim(choose(['fistpump', 'thumbsup']), 1300), say(choose(['Feeling it today.', 'The new version is working.', 'Let’s keep it rolling.']), 2000)); return true; }
  return false;
}
function idle(now) {
  for (const a of Object.values(agents)) {
    if (a.id === 'boss' || a.busy || a.queue.length || !a.seated || now < a.nextIdle || a.leaving) continue;
    a.nextIdle = now + 30000 + Math.random() * 45000;
    if (STUDIO_IDS.has(a.id)) { studioIdle(a); continue; }
    if (NEWS_IDS.has(a.id)) { newsIdle(a); continue; }
    if (CAREER_IDS.has(a.id)) { careerIdle(a); continue; }
    if (STUDY_IDS.has(a.id)) { studyIdle(a); continue; }
    if (INC_IDS.has(a.id) || a.id.startsWith('inc:')) { incIdle(a); continue; }
    if (OPS_IDS.has(a.id)) { opsIdle(a); continue; }
    if (a.id === 'ava' && (!snap?.analyst_on || (snap?.research?.status && snap.research.status !== 'idle'))) continue;
    const pod = snap?.roster?.find(r => r.id === a.id);
    if (pod && pod.status !== 'active') { feel(a, 'sad', 9000); act(a.id, go(POI.pantry), say(pod.status === 'stopped' ? 'Stopped out. Reviewing what went wrong…' : 'Paused. Catching up on research.', 3000), wait(6000), home()); continue; }
    if (busyFund() >= 3) { if (Math.random() < 0.5) act(a.id, anim(choose(['stretch', 'nod', 'thumbsup']), 1600)); continue; }   // the floor is busy enough: stay put
    const r = Math.random();
    const openPos = snap?.positions || [];
    if (a.id === 'rex' && openPos.length) { const p = choose(openPos), dv = deskVisit(p.pod); act('rex', go(dv), say(`${p.pod_name}, checking your ${p.sym}. P&L ${money(p.upl)}.`, 2600), home()); continue; }
    if (a.id === 'dot') { act('dot', go(POI.servers), say(choose(['Data pipeline healthy.', 'Re-indexing tick data.', 'Coinbase and Deribit feeds OK.']), 2600), home()); continue; }
    if (a.id === 'vic') { act('vic', go(POI.wall), say(choose(['Watching realized vol.', 'Updating vol regimes.', 'Correlations look stable.']), 2600), home()); continue; }
    if (a.id === 'sam') { act('sam', go(POI.scoreboard), say(choose(['Updating attribution.', 'Recomputing hit rates.', 'Trust scores refreshed.']), 2600), home()); continue; }
    if (a.id === 'eddie') { act('eddie', go(POI.exchange), say(choose(['Checking venue latency.', 'Spreads look tight.', 'Order router warmed up.']), 2400), home()); continue; }
    if (a.id === 'ava') { const weak = (snap?.roster || []).filter(p => p.family !== 'options').sort((x, y) => (x.stats?.trust ?? 1) - (y.stats?.trust ?? 1))[0];
      if (weak && agents[weak.id]) { act('ava', go(deskVisit(weak.id)), say(`${weak.name}, let's review your hit rate. Ideas for the lab?`, 3000), home()); act(weak.id, wait(4000), fx(b => b.swivelUntil = performance.now() + 5000), say('Sending you my worst trades.', 2200)); continue; } }
    if (moodBeat(a)) continue;
    if (r < 0.16 && chatWith(a)) continue;
    if (r < 0.26 && coolerChat(a)) continue;
    if (r < 0.34) { lookOutside(a); continue; }
    if (r < 0.48) act(a.id, go(POI.pantry), say(choose(['Coffee run.', 'Need a refill.', 'Quick break.']), 2000), anim('nod', 900), wait(1500), say(choose(['Ahh. Better.', 'Okay, back to it.']), 1600), home());
    else if (r < 0.56) act(a.id, go(POI.cooler), say(choose(['Did you see that print?', 'Quiet tape today.', 'Hydrating the circuits.']), 2200), wait(1200), home());
    else if (r < 0.7) act(a.id, go(POI.wall), say(choose(['Scanning the heatmap.', 'Any new setups?', 'Watching the tape.']), 2400), home());
    else { const h = Math.random();
      if (h < 0.3) act(a.id, anim('phone', 4200), say(choose(['Yes… understood. I’ll call you back.', 'Broker says liquidity is thin today.', 'Got it, thanks for the color.']), 3600));
      else if (h < 0.5) act(a.id, anim('stretch', 2200), say(choose(['Long day on the tape.', 'Stretch break.']), 1800));
      else if (h < 0.75) act(a.id, anim('point', 1600), say(choose(['Look at that wick!', 'Volume is picking up.', 'Support is holding.']), 2400));
      else { const nb = near(a.x, a.z, 7).find(b => b !== a && b.seated); act(a.id, fx(b => b.swivelUntil = performance.now() + 5000), anim('explain', 2600), say(choose(['Anyone else seeing this?', 'What’s your read on gold?', 'Correlations are breaking down.']), 2600));
        if (nb) setTimeout(() => { nb.swivelUntil = performance.now() + 4000; gest(nb, 'nod', 2000); act(nb.id, say(choose(['Agreed.', 'Same here.', 'Not sure yet, watching it.']), 2000)); }, 2400); } }
  }
}

// ── picking & camera ──────────────────────────────────────
const ray = new THREE.Raycaster(), mouse = new THREE.Vector2();
let selected = null, hovered = null, follow = false, downAt = null;
function pick(ev) {
  const r = renderer.domElement.getBoundingClientRect();
  mouse.set((ev.clientX - r.left) / r.width * 2 - 1, -(ev.clientY - r.top) / r.height * 2 + 1);
  ray.setFromCamera(mouse, camera);
  const hit = ray.intersectObjects(clickables, true)[0];
  return hit ? hit.object.userData.click : null;
}
renderer.domElement.addEventListener('pointermove', ev => {
  if (ev.buttons) { $('tip').style.display = 'none'; return; }   // dragging: no hover raycasts (smoother, and the cursor stays "grabbing")
  const info = pick(ev), tip = $('tip');
  hovered = info?.type === 'agent' ? info.id : null;
  renderer.domElement.style.cursor = info ? 'pointer' : 'grab';
  if (info) { const r = stage.getBoundingClientRect(); tip.style.display = 'block'; tip.textContent = info.tip; tip.style.left = (ev.clientX - r.left + 14) + 'px'; tip.style.top = (ev.clientY - r.top + 12) + 'px'; }
  else tip.style.display = 'none';
});
renderer.domElement.addEventListener('pointerdown', ev => downAt = [ev.clientX, ev.clientY]);
renderer.domElement.addEventListener('pointerup', ev => {
  if (!downAt || Math.hypot(ev.clientX - downAt[0], ev.clientY - downAt[1]) > 5) return;
  const info = pick(ev);
  if (walk.on && walkClick(ev, info)) return;
  if (!info) return;
  if (info.type === 'agent') selectAgent(info.id, false);
  else if (info.type === 'charts') openCharts();
  else if (info.type === 'settings') openSettings();
  else if (info.type === 'cio') openCIO();
  else if (info.type === 'podium') openAnnounce();
  else if (info.type === 'studio') openStudio();
  else if (info.type === 'wire') openWire();
  else if (info.type === 'news') openNews();
  else if (info.type === 'career') openCareer();
  else if (info.type === 'study') openStudy();
  else if (info.type === 'incubator') openIncubator();
  else if (info.type === 'math') openMath();
  else if (info.type === 'arena') openArena();
  else if (info.type === 'mydesk') openMyDesk();
  else if (info.type === 'mlab') openMlab();
  else if (info.type === 'office') openOffice();
  else if (info.type === 'frontdesk') openFrontDesk();
  else if (info.type === 'books') openBooks();
  else if (info.type === 'announce') openAnnounce();
  else if (info.type === 'mm') openMM();
  else if (info.type === 'payoff') openPayoff();
  else if (info.type === 'trophies') openTrophies();
  else if (info.type === 'bell') ringBell('You rang the bell, Jason. Back to work, team!');
  else if (info.type === 'tear') openTear();
  else if (info.type === 'ops') openOps();
  else if (info.type === 'cityhall') openCityHall();
  else if (info.type === 'trades') openTrades();
  else if (info.type === 'lab') { openTab('research'); focusOn(POI.lab.x, 1.5, POI.lab.z + 1.4, 13); }
  else if (info.type === 'pods') openTab('pods');
});
let camTween = null;
const walk = { on: false, target: null };           // walk mode: you walk the floor as a robot (see "walk mode" below)
function camTo(pos, tgt, ms = 900) { camTween = { p0: camera.position.clone(), t0: controls.target.clone(), p1: pos, t1: tgt, start: performance.now(), ms }; }
function tweenCam(pos, tgt, ms = 900) { if (!walk.on) camTo(pos, tgt, ms); }   // walking: the camera stays on you
// whatever the user does with the mouse or keys wins over automatic camera moves (tweens and follow mode)
function userTookOver(stopFollow = true) { camTween = null; if (stopFollow && follow) { follow = false; setFollowBtn(); } }
controls.addEventListener('start', () => { camTween = null; });
let dragFrom = null;
renderer.domElement.addEventListener('pointerdown', ev => { dragFrom = [ev.clientX, ev.clientY]; });
renderer.domElement.addEventListener('pointermove', ev => { if (dragFrom && ev.buttons && Math.hypot(ev.clientX - dragFrom[0], ev.clientY - dragFrom[1]) > 4) {
  userTookOver(!(follow && (ev.buttons & 2 || ev.ctrlKey || ev.shiftKey || ev.metaKey))); dragFrom = null; } });
addEventListener('pointerup', () => { dragFrom = null; });
renderer.domElement.addEventListener('contextmenu', ev => ev.preventDefault());
// keyboard: WASD / arrows move, Q/E turn, R/F (or +/-, PageUp/PageDown) zoom, Shift = faster
const NAV_KEYS = new Set(['w', 'a', 's', 'd', 'q', 'e', 'r', 'f', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'pageup', 'pagedown', '+', '=', '-', '_']);
const keys = new Set();
addEventListener('keydown', ev => {
  if (ev.target.closest && ev.target.closest('input, textarea, select, [contenteditable]')) return;
  if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
  const k = ev.key.toLowerCase(); if (!NAV_KEYS.has(k)) return;
  if (walk.on && k === 'e') return;                                     // walking: E means "interact", not "turn"
  keys.add(k); ev.preventDefault(); userTookOver();
});
addEventListener('keyup', ev => keys.delete(ev.key.toLowerCase()));
addEventListener('keydown', ev => { if (ev.key === 'Shift') keys.add('shift'); });
addEventListener('blur', () => keys.clear());
const _off = new THREE.Vector3(), _fwd = new THREE.Vector3(), _right = new THREE.Vector3(), _mv = new THREE.Vector3();
function keyNav(dt, fast) {
  if (!keys.size) return;
  _off.copy(camera.position).sub(controls.target);
  let dist = _off.length();
  _fwd.set(-_off.x, 0, -_off.z); if (_fwd.lengthSq() < 1e-6) _fwd.set(0, 0, -1); _fwd.normalize();
  _right.set(-_fwd.z, 0, _fwd.x);
  const sp = Math.min(150, Math.max(5, dist * 0.85)) * dt * (fast ? 2.4 : 1);
  _mv.set(0, 0, 0);
  if (keys.has('w') || keys.has('arrowup')) _mv.add(_fwd);
  if (keys.has('s') || keys.has('arrowdown')) _mv.sub(_fwd);
  if (keys.has('d') || keys.has('arrowright')) _mv.add(_right);
  if (keys.has('a') || keys.has('arrowleft')) _mv.sub(_right);
  if (_mv.lengthSq()) controls.target.addScaledVector(_mv.normalize(), sp);
  const turn = (keys.has('q') ? 1 : 0) - (keys.has('e') ? 1 : 0);
  if (turn) _off.applyAxisAngle(THREE.Object3D.DEFAULT_UP, turn * 1.5 * dt);
  const zoom = (keys.has('f') || keys.has('pagedown') || keys.has('-') || keys.has('_') ? 1 : 0) - (keys.has('r') || keys.has('pageup') || keys.has('+') || keys.has('=') ? 1 : 0);
  if (zoom) { dist = Math.min(controls.maxDistance, Math.max(controls.minDistance, dist * (1 + zoom * 1.6 * dt))); _off.setLength(dist); }
  camera.position.copy(controls.target).add(_off);
}
// on-screen nav pad: press and hold works like holding the matching key (touch friendly)
document.querySelectorAll('#navpad [data-nav]').forEach(b => {
  const k = b.dataset.nav;
  if (k === 'home') { b.onclick = () => $('bOverview').click(); return; }
  const on = ev => { ev.preventDefault(); keys.add(k); b.classList.add('held'); userTookOver(); try { b.setPointerCapture(ev.pointerId); } catch { /* synthetic or already released */ } };
  const off = () => { keys.delete(k); b.classList.remove('held'); };
  b.addEventListener('pointerdown', on); b.addEventListener('pointerup', off); b.addEventListener('pointercancel', off); b.addEventListener('lostpointercapture', off);
});
renderer.domElement.addEventListener('pointerdown', () => { renderer.domElement.style.cursor = 'grabbing'; });
addEventListener('pointerup', () => { if (renderer.domElement.style.cursor === 'grabbing') renderer.domElement.style.cursor = 'grab'; });
// compass: the needle shows where north (-z, toward the towers) is; click to face north again
const _sph = new THREE.Spherical();
function heading() { _off.copy(camera.position).sub(controls.target); return Math.atan2(_off.x, _off.z); }   // 0 = looking north
$('compass').onclick = () => {
  userTookOver();
  _off.copy(camera.position).sub(controls.target); _sph.setFromVector3(_off); _sph.theta = 0;
  tweenCam(controls.target.clone().add(new THREE.Vector3().setFromSpherical(_sph)), controls.target.clone(), 600);
};
// short hint, dismissible (remembered)
const lsGet = k => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode etc. */ } };
if (lsGet('jb.hint') === 'off') $('hint').style.display = 'none';
$('hintX').onclick = () => { $('hint').style.display = 'none'; lsSet('jb.hint', 'off'); };
// mini-map: the campus from above; click to fly there
const MM = { x0: -205, x1: 205, z0: -80, z1: 175 };
const mmC = $('minimap'), mmG = mmC.getContext('2d');
const mmXY = (x, z) => [(x - MM.x0) / (MM.x1 - MM.x0) * mmC.width, (z - MM.z0) / (MM.z1 - MM.z0) * mmC.height];
const MM_PLACES = () => [['Ops', OX, OZ], ['Study', HX, HZ], ['News', NX, NZ], ['Fund', 0, 0], ['Ventures', SX, SZ], ['Careers', CX, CZ], ['Incubator', IX, IZ], ['City Hall', CH.x, CH.z]];
function drawMinimap() {
  const g = mmG, W = mmC.width, H = mmC.height;
  g.fillStyle = NIGHT ? '#16241a' : '#3f6a3a'; g.fillRect(0, 0, W, H);
  const [, bay] = mmXY(0, BAY_Z); g.fillStyle = NIGHT ? '#0b1828' : '#2d5e80'; g.fillRect(0, bay, W, H - bay);
  const [, b0] = mmXY(0, BLVD[0]), [, b1] = mmXY(0, BLVD[1]); g.fillStyle = '#2a2c31'; g.fillRect(0, b0, W, b1 - b0);
  g.font = '700 19px Inter, sans-serif'; g.textAlign = 'center';
  MM_PLACES().forEach(([name, x, z], i) => {
    const [px, py] = mmXY(x, z), w = name === 'City Hall' ? 30 : 34, h = name === 'City Hall' ? 22 : 26;
    g.fillStyle = name === 'Fund' ? '#7c8cff' : name === 'City Hall' ? '#e5e7eb' : '#cbd5e1'; g.fillRect(px - w / 2, py - h / 2, w, h);
    const ly = i % 2 && i < 7 ? py - h / 2 - 7 : py + h / 2 + 20;     // alternate labels above / below so neighbors don't collide
    g.fillStyle = '#fff'; g.strokeStyle = 'rgba(0,0,0,.7)'; g.lineWidth = 4; g.strokeText(name, px, ly); g.fillText(name, px, ly);
  });
  const t = controls.target, [mx, my] = mmXY(t.x, t.z), hd = heading();      // camera: where you look + which way (pinned to the edge when off the map)
  const cx = Math.min(W - 9, Math.max(9, mx)), cy = Math.min(H - 9, Math.max(9, my));
  g.save(); g.translate(cx, cy); g.rotate(-hd); g.fillStyle = 'rgba(250,204,21,.35)'; g.beginPath(); g.moveTo(0, 0); g.lineTo(-26, -46); g.lineTo(26, -46); g.closePath(); g.fill(); g.restore();
  g.fillStyle = '#facc15'; g.beginPath(); g.arc(cx, cy, 7, 0, 7); g.fill(); g.strokeStyle = '#111'; g.lineWidth = 2; g.stroke();
  $('needle').style.transform = `rotate(${hd}rad)`;
}
mmC.addEventListener('click', ev => {
  const r = mmC.getBoundingClientRect(), x = MM.x0 + (ev.clientX - r.left) / r.width * (MM.x1 - MM.x0), z = MM.z0 + (ev.clientY - r.top) / r.height * (MM.z1 - MM.z0);
  userTookOver(); selected = null;
  const near = MM_PLACES().find(([, px, pz]) => Math.hypot(px - x, pz - z) < 14);      // clicked a building: go to its floor
  if (walk.on) { if (near) near[0] === 'City Hall' ? (setWalk(false), openCityHall()) : travel({ Study: 'study', News: 'news', Fund: 'fund', Ventures: 'studio', Careers: 'career' }[near[0]]); return; }
  const tgt = near ? new THREE.Vector3(near[1], near[0] === 'City Hall' ? STREET_Y + 2 : 0.5, near[2]) : new THREE.Vector3(x, Math.abs(controls.target.y - STREET_Y) < 20 ? STREET_Y + 2 : controls.target.y, z);
  const off = camera.position.clone().sub(controls.target); if (near && near[0] !== 'City Hall') off.setLength(Math.min(off.length(), 32));
  tweenCam(tgt.clone().add(off), tgt, 1000);
});
setInterval(drawMinimap, 150);
// remember where you were looking (per browser); URL test hooks win
const VIEW_KEY = 'jb.view';
function saveView() { if (camTween) return; const p = camera.position, t = controls.target; lsSet(VIEW_KEY, JSON.stringify([p.x, p.y, p.z, t.x, t.y, t.z].map(v => +v.toFixed(2)))); }
setInterval(saveView, 2000); addEventListener('beforeunload', saveView);
if (!/[?&](city|open|focus|celebrate|ventures|courier|tod)\b/.test(location.search)) {
  try { const v = JSON.parse(lsGet(VIEW_KEY) || 'null'); if (Array.isArray(v) && v.length === 6 && v.every(Number.isFinite)) { camera.position.set(v[0], v[1], v[2]); controls.target.set(v[3], v[4], v[5]); controls.update(); } } catch { /* ignore */ }
}
// keep the view over the campus: the target can't leave the map or sink under the street
const VIEW_BOUNDS = { x0: -240, x1: 240, z0: -160, z1: 290, y0: STREET_Y + 0.5, y1: 45 };
const _clamp = new THREE.Vector3();
function clampView() {
  const t = controls.target, b = VIEW_BOUNDS;
  _clamp.set(Math.min(b.x1, Math.max(b.x0, t.x)), Math.min(b.y1, Math.max(b.y0, t.y)), Math.min(b.z1, Math.max(b.z0, t.z))).sub(t);
  if (_clamp.lengthSq() > 0) { t.add(_clamp); camera.position.add(_clamp); }
  if (camera.position.y < STREET_Y + 1.2) camera.position.y = STREET_Y + 1.2;
}
// double-click anything (ground, a building, a desk) to fly there
renderer.domElement.addEventListener('dblclick', ev => {
  if (walk.on) { if (fp.on) renderer.domElement.requestPointerLock?.(); return; }
  const r = renderer.domElement.getBoundingClientRect();
  mouse.set((ev.clientX - r.left) / r.width * 2 - 1, -(ev.clientY - r.top) / r.height * 2 + 1);
  ray.setFromCamera(mouse, camera);
  const hit = ray.intersectObjects(scene.children, true).find(h => h.distance < 900 && h.object.visible && !flyIgnore.has(h.object) && !h.object.isPoints && !h.object.isSprite && !(h.object.material && h.object.material.transparent && h.object.material.opacity < 0.2));
  if (!hit) return;
  userTookOver();
  const off = camera.position.clone().sub(controls.target), dist = off.length();
  const want = Math.min(dist, Math.max(10, hit.distance * 0.45));
  const tgt = hit.point.clone();
  tweenCam(tgt.clone().add(off.setLength(want)), tgt, 900);
});
function focusOn(x, y, z, dist = 12) { follow = false; setFollowBtn(); tweenCam(new THREE.Vector3(x + dist * 0.35, y + dist * 0.6, z + dist), new THREE.Vector3(x, y, z)); }
$('bOverview').onclick = () => { follow = false; selected = null; setFollowBtn(); tweenCam(HOME_POS.clone(), HOME_TGT.clone()); };
$('bFollow').onclick = () => { if (!selected) selected = 'eddie'; follow = !follow; setFollowBtn(); if (follow) openProfile(selected); };
function setFollowBtn() { $('bFollow').textContent = 'Follow: ' + (follow && selected && agents[selected] ? agents[selected].name : 'off'); $('bFollow').classList.toggle('on', follow && !!selected); }
$('bSettings').onclick = openSettings; $('bCharts').onclick = () => openCharts(); $('bLab').onclick = () => { openTab('research'); focusOn(POI.lab.x, 1.5, POI.lab.z + 1.4, 13); }; $('bDemo').onclick = demo;
const CITY_CAM = [new THREE.Vector3(0, 30, 420), new THREE.Vector3(0, STREET_Y + 2, -70)];   // orbit around a point on the ground, so you can zoom all the way down to the street   // all five towers + City Hall   // wide enough for all five towers   // wide enough for all four towers
const bVent = $('bVentures'); if (bVent) bVent.onclick = () => { follow = false; setFollowBtn(); tweenCam(STUDIO_CAM[0].clone(), STUDIO_CAM[1].clone(), 1600); openTab('ventures'); };
const bCityHall = $('bCityHall'); if (bCityHall) bCityHall.onclick = openCityHall;
const bStudy = $('bStudy'); if (bStudy) bStudy.onclick = openStudy;
const bCareer = $('bCareer'); if (bCareer) bCareer.onclick = openCareer;
const bNews = $('bNews'); if (bNews) bNews.onclick = openNews;
const bWire = $('bWire'); if (bWire) bWire.onclick = openWire;
const bIncubator = $('bIncubator'); if (bIncubator) bIncubator.onclick = openIncubator;
const bOps = $('bOps'); if (bOps) bOps.onclick = () => { goOps(); openOps(); };
window.__jb.view = (p, t, ms = 10) => tweenCam(new THREE.Vector3(...p), new THREE.Vector3(...t), ms);   // headless camera checks
window.__jb.info = () => new Promise(res => requestAnimationFrame(() => { renderer.info.autoReset = false; renderer.info.reset(); requestAnimationFrame(() => { const r = { calls: renderer.info.render.calls, tris: renderer.info.render.triangles, meshes: (() => { let n = 0; scene.traverseVisible(o => { if (o.isMesh) n++; }); return n; })() }; renderer.info.autoReset = true; res(r); }); }));   // draw calls in one frame (all passes)
window.__jb.event = e => handle({ t: Date.now() / 1000, name: e.agent, ...e });             // headless event checks
window.__jb.scene = scene; window.__jb.camera = camera; window.__jb.controls = controls;     // read-only debug handles
const bCity = $('bCity'); if (bCity) bCity.onclick = () => { follow = false; setFollowBtn(); tweenCam(CITY_CAM[0].clone(), CITY_CAM[1].clone(), 1600); };

// ── getting around: rooms menu, agent cycling, game mode, help ──
const ROOM_CAMS = {
  floor: [HOME_POS, HOME_TGT], pms: [[-4, 11, 5], [-4, 1, PM_Z]], wall: [[0, 6.5, -1], [0, 4, -FZ]], cio: [[15.5, 10, -1], [23.5, 1, -11.5]],
  lab: [[11, 9.5, 3], [POI.lab.x + 1, 1, POI.lab.z + 1.5]], conf: [[-11, 9.5, 3], [-22.5, 1, 13]], lounge: [[0, 8.5, 2], [0, 1, 13.5]],
  office: [[-15.5, 6.5, -2.5], [-23.3, 1.2, -12.2]],
};
const v3of = v => v.isVector3 ? v.clone() : new THREE.Vector3(...v);
const goMenu = $('goMenu'), closeGo = () => { goMenu.classList.remove('open'); $('bGo').setAttribute('aria-expanded', 'false'); };
function goRoom(k) { const [p, t] = ROOM_CAMS[k]; follow = false; selected = null; setFollowBtn(); renderCard(); tweenCam(v3of(p), v3of(t), 1100); closeGo(); }
$('bGo').onclick = ev => { ev.stopPropagation(); const o = !goMenu.classList.contains('open'); goMenu.classList.toggle('open', o); $('bGo').setAttribute('aria-expanded', String(o)); };
addEventListener('pointerdown', ev => { if (!goMenu.contains(ev.target)) closeGo(); });
goMenu.querySelectorAll('[data-go]').forEach(b => b.onclick = () => goRoom(b.dataset.go));
goMenu.querySelectorAll('.mi[id]').forEach(b => b.addEventListener('click', closeGo));
// agents: the ones in the building you're looking at, front row first
function agentsHere() {
  const here = towerOf(controls.target);
  return Object.values(agents).filter(a => !a.hidden && !a.leaving && towerOf(a) === here).sort((p, q) => p.z - q.z || p.x - q.x);
}
function selectAgent(id, zoom = true) {
  if (walk.on) return walkTalk(id);
  const a = agents[id]; if (!a) return;
  selected = id; follow = true; setFollowBtn(); if (a.seated) a.swivelUntil = performance.now() + 5000;
  if (isGame()) { renderCard(); renderStrip(); } else openProfile(id);
  if (!zoom) return;             // a close, clear 3/4 view from the direction you were already looking
  const off = camera.position.clone().sub(controls.target), hd = Math.atan2(off.x, off.z), el = 0.62, d = 12;
  const tgt = new THREE.Vector3(a.x, 1.2, a.z);
  tweenCam(tgt.clone().add(new THREE.Vector3(Math.sin(hd) * Math.cos(el) * d, Math.sin(el) * d, Math.cos(hd) * Math.cos(el) * d)), tgt, 700);
}
function cycleAgent(dir) {
  const list = agentsHere(); if (!list.length) return;
  const i = list.findIndex(a => a.id === selected);
  selectAgent(list[i < 0 ? (dir > 0 ? 0 : list.length - 1) : (i + dir + list.length) % list.length].id);
}
const agentState = a => a.leaving ? 'leaving' : a.bubble && performance.now() < a.bubble.until ? 'talking' : a.path.length ? 'walking' : !a.seated ? 'away from desk' : (a.moodName || 'focused');
// game mode: the floor fills the window, with a live story feed, the agents of this building and a card for the one you follow
const isGame = () => document.body.classList.contains('game');
function setGame(on) {
  document.body.classList.toggle('game', on); lsSet('jb.game', on ? '1' : '0');
  const b = $('bGame'); b.classList.toggle('on', on); b.innerHTML = on ? '&#10005; Exit game mode' : '&#9974; Game mode';
  resize(); stripHtml = ''; renderStrip(); renderCard();
  if (on) setWalk(lsGet('jb.walk') !== '0', false); else { setWalk(false, false); showPanel(false); }
}
$('bGame').onclick = () => setGame(!isGame());
function setSound(on) { soundOn = on; lsSet('jb.sound', on ? '1' : '0'); $('bSound').innerHTML = on ? '&#128266;' : '&#128263;'; $('bSound').title = on ? 'Sound on (click to mute)' : 'Sound off (click for trade/hire/firework cues)'; if (on) SFX.win(); }
$('bSound').onclick = () => setSound(!soundOn); setSound(soundOn);
let stripHtml = '';
function renderStrip() {
  if (!isGame()) return;
  const pods = Object.fromEntries((snap?.roster || []).map(p => [p.id, p]));
  const html = agentsHere().map(a => { const p = pods[a.id];
    return `<button class="chip${a.id === selected ? ' on' : ''}" data-ag="${a.id}" title="${esc(a.role)}"><span><i style="background:${COLORS[a.id]}"></i>${esc(a.name)}</span><small>${p ? `<span class="${cls(p.pnl)}">${money(p.pnl)}</span> · ` : ''}${esc(agentState(a))}</small></button>`; }).join('');
  if (html !== stripHtml) { stripHtml = html; $('gStrip').innerHTML = html || '<small class="muted" style="padding:6px">Nobody in this building right now.</small>'; }
}
$('gStrip').addEventListener('pointerdown', ev => { const b = ev.target.closest('[data-ag]'); if (b) selectAgent(b.dataset.ag); });
setInterval(renderStrip, 700);
function renderCard(force = false) {
  const el = $('gCard'), a = selected && agents[selected];
  if (!force && el.contains(document.activeElement) && document.activeElement.id === 'gcQ') return;
  el.classList.toggle('on', !!a && isGame());
  if (!a || !isGame()) return;
  const p = snap?.roster?.find(r => r.id === a.id), mind = snap?.minds?.people?.find(x => x.id === a.id);
  el.innerHTML = `<div style="display:flex;justify-content:space-between;align-items:start;gap:8px"><div><div style="font-size:15px;font-weight:700;color:${COLORS[a.id]}">${esc(a.name)}</div><div class="muted" style="font-size:12px">${esc(a.role)}</div></div><button class="btn sm" id="gcX" title="Close">&#10005;</button></div>
    <div class="stat-grid">${p ? `<div><b>P&amp;L</b><span class="mono ${cls(p.pnl)}">${money(p.pnl)}</span></div><div><b>Capital</b><span class="mono">${(p.alloc * 100).toFixed(0)}%</span></div><div><b>Risk/trade</b><span class="mono">${p.risk == null ? '—' : (p.risk * 100).toFixed(1) + '%'}</span></div>` : ''}
      <div><b>Mood</b><span>${esc(a.moodName || 'focused')}</span></div><div><b>Doing</b><span>${esc(agentState(a))}</span></div>${mind ? `<div><b>Level</b><span>${esc(mind.title || '')}</span></div>` : ''}</div>
    ${p?.desc ? `<div class="faint" style="font-size:11.5px;margin-top:6px">${esc(p.desc)}</div>` : ''}
    ${mind?.goal ? `<div style="margin-top:8px"><span class="muted">Goal:</span> ${esc(mind.goal)}</div>` : ''}
    ${a.said.length ? `<div class="muted" style="font-size:10.5px;margin-top:10px;text-transform:uppercase;letter-spacing:.5px">Recently said</div>` + a.said.filter(x => !(snap?.asks?.log || []).some(l => l.a === x)).slice(-3).reverse().map(x => `<div style="margin-top:4px">“${esc(x)}”</div>`).join('') : ''}
    ${askBox(a)}
    <div style="display:flex;gap:6px;margin-top:10px;flex-wrap:wrap"><button class="btn sm" id="gcF">${walk.on ? 'Talk (when close)' : follow ? 'Stop following' : 'Follow'}</button><button class="btn sm" id="gcP">Full profile</button></div>`;
  $('gcX').onclick = () => { selected = null; follow = false; setFollowBtn(); renderCard(); renderStrip(); };
  $('gcF').onclick = () => { if (walk.on) return walkTalk(a.id); follow = !follow; setFollowBtn(); renderCard(); };
  $('gcP').onclick = () => { const id = a.id; setGame(false); openProfile(id); };
  wireAsk(a);
}
// ── ask anyone: a question box on every agent's card; the agent answers in character from its own live numbers ──
const ASK_HINTS = { boss: 'How is the fund doing?', rex: 'What worries you in the book?', ava: 'What are you researching?', eddie: 'How much are we paying in fees?',
  vic: 'Which markets are wild right now?', sam: 'Who is the best PM?', juno: 'Who is close to graduating?', nova: 'Is everything healthy?' };
function askBox(a) {
  const log = (snap?.asks?.log || []).filter(x => x.agent === a.id).slice(-2), busy = snap?.asks?.busy;
  return `<div style="margin-top:10px;border-top:1px solid var(--border);padding-top:8px">
    ${log.map(x => `<div style="font-size:12px;margin:4px 0"><span class="muted">You:</span> ${esc(x.q)}<div style="margin-top:2px">${esc(x.a)}</div></div>`).join('')}
    <div style="display:flex;gap:6px;margin-top:6px"><input id="gcQ" maxlength="300" autocomplete="off" placeholder="Ask ${esc(a.name)}: ${esc(ASK_HINTS[a.id] || 'How are your trades going?')}"
      aria-label="Ask ${esc(a.name)} a question" style="flex:1;min-width:0;background:var(--bg2);color:var(--text);border:1px solid var(--border2);border-radius:8px;padding:6px 8px;font-size:12.5px">
      <button class="btn sm" id="gcA" ${busy ? 'disabled' : ''}>${busy ? '…' : 'Ask'}</button></div></div>`;
}
function wireAsk(a) {
  const q = $('gcQ'), b = $('gcA'); if (!q || !b) return;
  const go = () => { const text = q.value.trim(); if (!text) return; send({ type: 'ask', agent: a.id, text }); achBump('ask'); setTimeout(() => checkAch(true), 500); q.value = ''; b.disabled = true; b.textContent = '…';
    if (walk.on) pSay(text.length > 60 ? text.slice(0, 57) + '…' : text, 2600);
    a.bubble = { text: '…', until: performance.now() + 20000 }; q.blur(); };
  b.onclick = go; q.onkeydown = ev => { if (ev.key === 'Enter') go(); };
}
setInterval(() => { if (isGame() && selected && !$('gCard').matches(':hover')) renderCard(); }, 1500);
function gameFeed(e) {
  if (!isGame() || !e.text || e.kind === 'chatter' || e.kind === 'data') return;
  const box = $('gFeed'), d = document.createElement('div');
  d.innerHTML = `<span class="who" style="color:${COLORS[e.agent] || '#fff'}">${esc(e.name || '')}</span>${esc(e.text)}`;
  box.prepend(d); while (box.children.length > 5) box.lastChild.remove();
  setTimeout(() => { d.style.opacity = '0'; setTimeout(() => d.remove(), 700); }, 14000);
}
function toggleHelp(on = $('help').hidden) { $('help').hidden = !on; lsSet('jb.help', 'seen'); }
$('bHelp').onclick = () => toggleHelp(); $('helpX').onclick = () => toggleHelp(false);
$('help').addEventListener('pointerdown', ev => { if (ev.target.id === 'help') toggleHelp(false); });
const JUMP = { 1: 'bOverview', 2: 'bVentures', 3: 'bNews', 4: 'bCareer', 5: 'bStudy', 6: 'bCityHall', 7: 'bCity', 8: 'bIncubator', 9: 'bOps' };
addEventListener('keydown', ev => {
  const k = ev.key, el = ev.target.closest ? ev.target : document.body;
  if (el.closest('input, textarea, select, [contenteditable]') && k !== 'Escape') return;
  if (el.closest('button') && (k === ' ' || k === 'Enter')) return;               // a focused button handles its own Space/Enter
  if (ev.ctrlKey || ev.metaKey || ev.altKey || modalKind) return;
  if (k === 'Tab') { const f = document.activeElement; if (f && f !== document.body && f !== renderer.domElement) return;   // Tab still moves focus between buttons
    ev.preventDefault(); walk.on ? walkCycle(ev.shiftKey ? -1 : 1) : cycleAgent(ev.shiftKey ? -1 : 1); }
  else if (k === 'g' || k === 'G') setGame(!isGame());
  else if (k === 'c' || k === 'C') setWalk(!walk.on, isGame());
  else if ((k === 'v' || k === 'V') && walk.on) setFP(!fp.on);
  else if ((k === 'e' || k === 'E') && walk.on) interact();
  else if (k === '?') toggleHelp();
  else if (k === 'h' || k === 'H' || k === 'Home') $('bOverview').click();
  else if (k === ' ' && walk.on) { ev.preventDefault(); hop(); }
  else if (k === ' ' && selected) { ev.preventDefault(); follow = !follow; setFollowBtn(); renderCard(); }
  else if (k === 'Escape') { if (!$('help').hidden) toggleHelp(false); else if (!$('travel').hidden) openTravel(false); else if (panelOpen()) showPanel(false); else if (goMenu.classList.contains('open')) closeGo(); else if (follow) { follow = false; setFollowBtn(); renderCard(); } else if (isGame()) setGame(false); }
  else if (JUMP[k]) walk.on ? walkJump(+k) : $(JUMP[k]).click();
});
if (lsGet('jb.game') === '1' || /[?&]game\b/.test(location.search)) setTimeout(() => setGame(true), 0);
if (lsGet('jb.help') !== 'seen' && !/[?&](city|open|focus|celebrate|ventures|courier|tod|game|demo)\b/.test(location.search)) setTimeout(() => toggleHelp(true), 2500);

// ── walk mode: you (Jason, the fund owner) walk the floor as a gold robot, third person ──
// WASD walks relative to the camera, Shift runs, Space hops, drag orbits, scroll zooms; click the floor to walk there,
// click a robot (or Tab) to walk over and talk; E talks to / uses whatever is in front of you. Collision: a 2D occupancy
// grid built once from the furniture (buildNavGrid, before static batching). The drone camera (C) is the old free camera.
const P = (() => {
  const d = { id: 'you', name: 'You', role: 'Fund owner (Jason)', accent: 0xfacc15, jacket: 0x101216, badge: 1, suit: true };
  const parts = robot(d); batchRobot(parts);
  const a = { ...d, ...parts, x: POI.exchange.x - 1.5, z: 3.5, seated: false, path: [], queue: [], busy: false, run: false, speed: 3.0, speedVar: 1, moodName: 'focused',
    headYaw: 0, phase: 0, bubble: null, said: [], hidden: false, far: false, mood: 'happy', moodUntil: 0, glowUntil: 0, swivelUntil: 0, face: -Math.PI / 2,
    onArrive: null, vy: 0, hy: 0, step: { x: 0, z: 0 } };
  a.root.scale.setScalar(1.12); a.root.rotation.y = a.face; a.root.position.set(a.x, 0, a.z);
  a.ring = new THREE.Mesh(new THREE.RingGeometry(0.46, 0.6, 48), new THREE.MeshBasicMaterial({ color: new THREE.Color(0xfacc15).multiplyScalar(1.7), toneMapped: false, transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false }));
  a.ring.rotation.x = -Math.PI / 2; a.ring.position.set(a.x, 0.03, a.z); scene.add(a.ring);
  a.label = document.createElement('div'); a.label.className = 'label you'; a.label.textContent = 'YOU'; overlay.appendChild(a.label);
  a.bubbleEl = document.createElement('div'); a.bubbleEl.className = 'bubble'; a.bubbleEl.style.display = 'none'; overlay.appendChild(a.bubbleEl);
  return a;
})();
COLORS.you = '#facc15';
const isPlayerObj = o => { for (let x = o; x; x = x.parent) if (x === P.root) return true; return false; };
function pSay(text, ms = 3200) { P.bubble = { text, until: performance.now() + ms }; }

// ── collision grid: 0 = outside the floors, 1 = free, 2 = furniture ──
const NAV = { cell: 0.25, x0: -192, z0: -20, w: 1536, h: 160, g: null };            // x -192..192: all seven towers
const navAt = (x, z) => { const i = Math.floor((x - NAV.x0) / NAV.cell), j = Math.floor((z - NAV.z0) / NAV.cell); return i < 0 || j < 0 || i >= NAV.w || j >= NAV.h ? 0 : NAV.g[j * NAV.w + i]; };
function navFill(x0, z0, x1, z1, v, onlyInside = false) {
  const i0 = Math.max(0, Math.floor((x0 - NAV.x0) / NAV.cell)), i1 = Math.min(NAV.w - 1, Math.floor((x1 - NAV.x0) / NAV.cell));
  const j0 = Math.max(0, Math.floor((z0 - NAV.z0) / NAV.cell)), j1 = Math.min(NAV.h - 1, Math.floor((z1 - NAV.z0) / NAV.cell));
  for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) { const k = j * NAV.w + i; if (!onlyInside || NAV.g[k]) NAV.g[k] = v; }
}
function buildNavGrid() {
  NAV.g = new Uint8Array(NAV.w * NAV.h);
  const m = 0.35, bw = BR_W / 2;
  const rects = [[-FX, -FZ, FX, FZ], [SX - SW / 2, SZ - SD / 2, SX + SW / 2, SZ + SD / 2], [NX - NW / 2, NZ - ND / 2, NX + NW / 2, NZ + ND / 2],
    [CX - CW / 2, CZ - CD / 2, CX + CW / 2, CZ + CD / 2], [HX - HW / 2, HZ - HD / 2, HX + HW / 2, HZ + HD / 2],
    [BR_X0 - 1, AISLE - bw, BR_X1 + 1, AISLE + bw], [NB_X1 - 1, AISLE - bw, NB_X0 + 1, AISLE + bw], [CB_X0 - 1, AISLE - bw, CB_X1 + 1, AISLE + bw], [HB_X1 - 1, AISLE - bw, HB_X0 + 1, AISLE + bw],
    [IX - IW / 2, IZ - ID / 2, IX + IW / 2, IZ + ID / 2], [OX - OW / 2, OZ - OD / 2, OX + OW / 2, OZ + OD / 2],
    [IB_X0 - 1, AISLE - bw, IB_X1 + 1, AISLE + bw], [OB_X0 - 1, AISLE - bw, OB_X1 + 1, AISLE + bw]];
  for (const [a, b, c, d] of rects) navFill(a + m, b + m, c - m, d - m, 1);
  scene.updateMatrixWorld(true);
  const skip = new Set([P.root, P.ring, ...Object.values(agents).map(a => a.root)]), bx = new THREE.Box3();
  const visit = o => {
    if (skip.has(o) || flyIgnore.has(o) || o.isPoints || o.isSprite || o.isInstancedMesh || o.isLight) return;
    if (o.isMesh && o.geometry?.attributes?.position) {
      const g = o.geometry; if (!g.boundingBox) g.computeBoundingBox();
      bx.copy(g.boundingBox).applyMatrix4(o.matrixWorld);
      if (bx.max.y > 0.15 && bx.min.y < 1.6 && bx.max.x - bx.min.x < 40 && bx.max.z - bx.min.z < 40) navFill(bx.min.x - 0.05, bx.min.z - 0.05, bx.max.x + 0.05, bx.max.z + 0.05, 2, true);
    }
    for (const c of o.children) visit(c);
  };
  visit(scene);
}
const R0 = 0.28;                                                        // your footprint
const canStand = (x, z) => !NAV.g || (navAt(x, z) === 1 && navAt(x + R0, z) === 1 && navAt(x - R0, z) === 1 && navAt(x, z + R0) === 1 && navAt(x, z - R0) === 1);
const inArea = (x, z) => !NAV.g || navAt(x, z) > 0;
function nearestFree(x, z) {
  if (canStand(x, z)) return { x, z };
  for (let r = 1; r <= 16; r++) for (let dj = -r; dj <= r; dj++) for (let di = -r; di <= r; di++) {
    if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue;
    const px = x + di * NAV.cell, pz = z + dj * NAV.cell; if (canStand(px, pz)) return { x: px, z: pz };
  }
  return null;
}
function lineFree(x0, z0, x1, z1) {
  const n = Math.ceil(Math.hypot(x1 - x0, z1 - z0) / 0.2);
  for (let k = 1; k <= n; k++) { const t = k / n; if (!canStand(x0 + (x1 - x0) * t, z0 + (z1 - z0) * t)) return false; }
  return true;
}

// ── moving ──
function walkTo(x, z, cb = null) {
  const d = nearestFree(x, z); if (!d) return false;
  const dist = Math.hypot(d.x - P.x, d.z - P.z);
  P.path = lineFree(P.x, P.z, d.x, d.z) ? [{ x: P.x, z: P.z }, d] : routeTo(P, d);
  P.onArrive = cb; P.run = dist > 14;
  return true;
}
function walkTalk(id) {                                                        // talk if you're close; otherwise point them out (you walk there)
  const a = agents[id]; if (!a) return;
  selected = id; if (isGame()) { renderStrip(); renderCard(); }
  if (Math.hypot(a.x - P.x, a.z - P.z) < 2.6) return talkTo(id);
  const dx = a.x - P.x, dz = a.z - P.z, dir = Math.abs(dx) > Math.abs(dz) ? (dx > 0 ? 'east' : 'west') : (dz > 0 ? 'south' : 'north');
  pSay(`${a.name} is ${Math.round(Math.hypot(dx, dz))} m ${dir}. Walk over (WASD) and press E.`, 2600);
}
function walkCycle(dir) {
  const list = agentsHere(); if (!list.length) return;
  const i = list.findIndex(a => a.id === selected);
  walkTalk(list[i < 0 ? (dir > 0 ? 0 : list.length - 1) : (i + dir + list.length) % list.length].id);
}
function hop() { if (P.hy === 0 && P.vy === 0) P.vy = 4.3; }
const _wT = new THREE.Vector3(), _wD = new THREE.Vector3();
// ── walk mode camera: third person that never clips through walls, or first person (V) ──
const fp = { on: false, yaw: 0, pitch: 0, drag: null };
const _ray = new THREE.Raycaster(), _cd = new THREE.Vector3();
let camOccluders = null;
function buildOccluders() {                 // walls, glass partitions, big screens: tall, thin and long meshes
  camOccluders = []; const bx = new THREE.Box3(); scene.updateMatrixWorld(true);
  scene.traverse(o => {
    if (!o.isMesh || o.isInstancedMesh || flyIgnore.has(o) || isPlayerObj(o) || o === hallCeil) return;
    const g = o.geometry; if (!g?.attributes?.position) return; if (!g.boundingBox) g.computeBoundingBox();
    bx.copy(g.boundingBox).applyMatrix4(o.matrixWorld);
    const sx = bx.max.x - bx.min.x, sy = bx.max.y - bx.min.y, sz = bx.max.z - bx.min.z;
    if (sy > 2.0 && Math.min(sx, sz) < 0.7 && Math.max(sx, sz) > 1.0 && bx.min.y < 2.5) camOccluders.push(o);
  });
  window.__jb.occ = camOccluders;                                                            // headless checks
}
function setFP(on) {
  if (!walk.on) return; fp.on = on;
  P.hidden = on; P.root.visible = !on; P.ring.visible = !on; P.label.style.visibility = on ? 'hidden' : '';
  controls.enabled = !on;
  if (on) { const d = controls.target.clone().sub(camera.position); fp.yaw = Math.atan2(d.x, d.z); fp.pitch = 0; gToast('First person · drag (or double-click to lock the mouse) to look · V for third person'); }
  else { if (document.pointerLockElement) document.exitPointerLock(); const tgt = new THREE.Vector3(P.x, 1.3, P.z);
    camera.position.copy(tgt).add(new THREE.Vector3(-Math.sin(fp.yaw) * 6, 3.5, -Math.cos(fp.yaw) * 6)); controls.target.copy(tgt); walk.camActual = walk.camDist; }
  lsSet('jb.fp', on ? '1' : '0');
}
const look = (dx, dy) => { fp.yaw -= dx * 0.0032; fp.pitch = Math.max(-1.25, Math.min(1.25, fp.pitch - dy * 0.0032)); };
renderer.domElement.addEventListener('pointerdown', ev => { if (fp.on && walk.on) fp.drag = [ev.clientX, ev.clientY]; });
addEventListener('pointermove', ev => {
  if (!fp.on || !walk.on) return;
  if (document.pointerLockElement === renderer.domElement) look(ev.movementX, ev.movementY);
  else if (fp.drag) { look(ev.clientX - fp.drag[0], ev.clientY - fp.drag[1]); fp.drag = [ev.clientX, ev.clientY]; }
});
addEventListener('pointerup', () => { fp.drag = null; });
renderer.domElement.addEventListener('wheel', ev => { if (!walk.on || fp.on) return; ev.preventDefault();
  walk.camDist = Math.min(22, Math.max(2.2, walk.camDist * (ev.deltaY > 0 ? 1.1 : 0.9))); }, { passive: false });
walk.camDist = 9; walk.camActual = 9;
function walkCam(dt) {
  const eye = _wT.set(P.x, (fp.on ? 1.62 : 1.3) + P.hy * 0.4, P.z);
  if (fp.on) {
    const turn = (keys.has('q') ? 1 : 0) - (keys.has('e') ? 1 : 0); if (turn) fp.yaw += turn * 1.8 * dt;
    const cp = Math.cos(fp.pitch);
    _cd.set(Math.sin(fp.yaw) * cp, Math.sin(fp.pitch), Math.cos(fp.yaw) * cp);
    camera.position.copy(eye); controls.target.copy(eye).addScaledVector(_cd, 0.1); camera.lookAt(controls.target);
    return;
  }
  _wD.copy(eye).sub(controls.target).multiplyScalar(Math.min(1, dt * 9));
  controls.target.add(_wD); camera.position.add(_wD);
  const zoom = (keys.has('f') || keys.has('pagedown') || keys.has('-') || keys.has('_') ? 1 : 0) - (keys.has('r') || keys.has('pageup') || keys.has('+') || keys.has('=') ? 1 : 0);
  if (zoom) walk.camDist = Math.min(22, Math.max(2.2, walk.camDist * (1 + zoom * 1.6 * dt)));
  _cd.copy(camera.position).sub(controls.target);
  const turn = (keys.has('q') ? 1 : 0) - (keys.has('e') ? 1 : 0);                        // Q / the nav pad's turn buttons orbit around you
  if (turn) _cd.applyAxisAngle(THREE.Object3D.DEFAULT_UP, turn * 1.6 * dt);
  if (_cd.lengthSq() < 1e-6) _cd.set(0, 0.6, 1);
  _cd.normalize();
  if (!camOccluders) buildOccluders();
  let d = walk.camDist;
  _ray.set(controls.target, _cd); _ray.far = d + 0.4;
  const hit = _ray.intersectObjects(camOccluders, false)[0];
  if (hit) d = Math.max(0.7, hit.distance - 0.4);                                        // something between you and the camera: come in front of it
  walk.camActual += (d - walk.camActual) * Math.min(1, dt * (d < walk.camActual ? 22 : 3));
  camera.position.copy(controls.target).addScaledVector(_cd, walk.camActual);
  if (camera.position.y < 0.6) camera.position.y = 0.6;
}
let nextPrompt = 0, labTickAt = 0;
function updatePlayer(dt, now) {
  if (walk.on) {
    let ix = 0, iz = 0;
    if (keys.has('w') || keys.has('arrowup')) iz += 1;
    if (keys.has('s') || keys.has('arrowdown')) iz -= 1;
    if (keys.has('d') || keys.has('arrowright')) ix += 1;
    if (keys.has('a') || keys.has('arrowleft')) ix -= 1;
    if (ix || iz) {
      if (P.path.length || P.onArrive) { P.path.length = 0; P.onArrive = null; }          // any key cancels an auto-walk
      _off.copy(camera.position).sub(controls.target);
      let fx = -_off.x, fz = -_off.z; const fl = Math.hypot(fx, fz) || 1; fx /= fl; fz /= fl;
      let dx = fx * iz - fz * ix, dz = fz * iz + fx * ix; const dl = Math.hypot(dx, dz) || 1; dx /= dl; dz /= dl;
      P.run = keys.has('shift'); P.face = Math.atan2(dx, dz);
      const sp = P.speed * (P.run ? 1.9 : 1) * dt, ok = canStand(P.x, P.z) ? canStand : inArea;   // stuck inside furniture? any move inside the floors is fine
      let nx = P.x, nz = P.z;
      if (ok(P.x + dx * sp, P.z)) nx = P.x + dx * sp;
      if (ok(nx, P.z + dz * sp)) nz = P.z + dz * sp;
      for (const a of Object.values(agents)) {                                             // robots are solid too (soft push)
        if (a.hidden || a.far) continue;
        const ax = nx - a.x, az = nz - a.z, d = Math.hypot(ax, az);
        if (d < 0.85 && d > 1e-4) { const px = a.x + ax / d * 0.85, pz = a.z + az / d * 0.85; if (ok(px, pz)) { nx = px; nz = pz; } }
      }
      if (nx !== P.x || nz !== P.z) { P.step.x = nx; P.step.z = nz; P.path.length = 0; P.path.push(P.step); }
    }
  }
  if (P.hy > 0 || P.vy > 0) { P.vy -= 14 * dt; P.hy = Math.max(0, P.hy + P.vy * dt); if (P.hy === 0) P.vy = 0; }
  animate(P, dt, now);
  P.root.position.y += P.hy;
  P.ring.position.set(P.x, 0.03, P.z); P.ring.scale.setScalar(1 - Math.min(0.4, P.hy * 0.5)); P.ring.material.opacity = 0.55 + 0.35 * Math.abs(Math.sin(now / 600));
  if (!walk.on) return;
  if (now > labTickAt) { labTickAt = now + 500; if (P.x > 16.2 && P.z > 9.6 && P.x < FX && P.z < FZ) tickRound('lab'); }
  if (now > nextPrompt) { nextPrompt = now + 120; updatePrompt(); }
}
function placePlayer(now) {
  const p = toScreen(P.x, 2.6 + P.hy, P.z);
  P.label.style.display = p.ok ? 'block' : 'none';
  if (p.ok) { P.label.style.left = p.x + 'px'; P.label.style.top = p.y + 'px'; }
  const b = P.bubble && now < P.bubble.until && p.ok;
  P.bubbleEl.style.display = b ? 'block' : 'none';
  if (b) { const html = `<span class="who" style="color:#b45309">You</span>${esc(P.bubble.text)}`; if (P.bubbleEl.dataset.h !== html) { P.bubbleEl.innerHTML = html; P.bubbleEl.dataset.h = html; }
    P.bubbleEl.style.left = Math.max(135, Math.min(stage.clientWidth - 135, p.x)) + 'px'; P.bubbleEl.style.top = Math.max(70, p.y - 26) + 'px'; }
}

// ── talking ──
function talkLine(a) {
  const s = snap; if (!s) return `Hi Jason!`;
  const p = s.roster?.find(r => r.id === a.id), mind = s.minds?.people?.find(x => x.id === a.id);
  if (p) {
    const out = [];
    if (p.status === 'stopped') out.push(`I'm stopped out (${p.stop_reason || 'drawdown limit'}). The lab has to clear me.`);
    else if (p.status === 'paused') out.push('My pod is paused right now.');
    out.push(`${p.pnl >= 0 ? 'Up' : 'Down'} ${money(Math.abs(p.pnl))} so far on ${(p.alloc * 100).toFixed(0)}% of the fund${p.risk != null ? `, risking ${(p.risk * 100).toFixed(1)}% a trade` : ''}.`);
    if (mind?.goal) out.push(`Goal: ${mind.goal}`);
    return out.join(' ');
  }
  if (a.inc) { const f = a.inc.fwd || {}, need = s.incubator?.rules?.grad_trades || 8;
    return `I'm incubating "${a.inc.name}". ${f.n ? `${f.n} forward trades, PF ${(+f.pf).toFixed(2)}, ${f.ret >= 0 ? '+' : ''}${(f.ret * 100).toFixed(1)}%.` : 'No forward trades yet.'} ${Math.max(0, need - (f.n || 0))} more to go, no capital until then.`; }
  const pods = (s.roster || []).filter(r => r.status === 'active');
  switch (a.id) {
    case 'juno': { const act = (s.incubator?.items || []).filter(x => x.status === 'incubating'), best = act.filter(x => x.fwd?.n).sort((x, y) => y.fwd.pf - x.fwd.pf)[0];
      return `${act.length} strategies incubating with no capital.${best ? ` ${best.name} leads: PF ${(+best.fwd.pf).toFixed(2)} over ${best.fwd.n} forward trades.` : ' No forward trades yet: the market decides, not the backtest.'}`; }
    case 'nova': { const O = s.ops || {}, F = Object.entries(O.feeds || {}), stale = F.filter(([k, x]) => x > ((O.stale_after || {})[k] || 900));
      return `Up ${Math.round((O.uptime || 0) / 3600)}h, loop ${O.loop_avg ?? '?'}s, ${O.rss_mb ?? '?'} MB. ${stale.length ? `${stale.map(([k]) => k).join(', ')} stale.` : `All ${F.length} feeds fresh.`}`; }
    case 'kip': { const b = s.broker_link || {}, ac = b.account || {};
      return b.configured ? `Alpaca ${b.live ? 'LIVE' : 'paper'}: ${b.killed ? 'kill switch FIRED' : b.error ? 'erroring' : 'healthy'}${ac.equity != null ? `, equity ${money(ac.equity)}` : ''}. Kill switch at a 3% daily loss.` : 'The broker link is offline.'; }
    case 'boss': { const best = pods.slice().sort((x, y) => y.pnl - x.pnl)[0];
      return `NAV ${s.nav.toFixed(2)}, ${pct(s.day_ret)} today.${best ? ` ${best.name} is our best pod (${money(best.pnl)}).` : ''} I size everyone by what the Monte Carlo says they can survive.`; }
    case 'rex': { const rb = s.riskbook, top = rb?.syms?.[0];
      return `${money(s.open_risk)} at risk across ${s.positions.length} positions.` + (top && Math.abs(top[1]) > rb.sym_cap * 1.1 ? ` ${top[0]} is ${Math.round(Math.abs(top[1]) * 100)}% of the fund, over my ${Math.round(rb.sym_cap * 100)}% limit. I trim it at the open.` : ' Every fund limit is green.'); }
    case 'eddie': return `${s.positions.length} positions open, ${(s.trades || []).length} recent fills on the blotter. Fees so far ${money(s.fees || 0)}.`;
    case 'sam': { const graded = pods.filter(r => r.stats?.n).sort((x, y) => (y.stats.trust ?? 1) - (x.stats.trust ?? 1))[0];
      return graded ? `${graded.name} has the best record: trust ${(graded.stats.trust ?? 1).toFixed(2)} after ${graded.stats.n} graded calls.` : 'Not enough graded calls yet to rank anyone. Results first, opinions later.'; }
    case 'vic': { const storms = Object.entries(s.vic || {}).filter(([, r]) => r === 'storm').map(([k]) => k);
      return storms.length ? `Storm regime in ${storms.slice(0, 4).join(', ')}. Those trade half size.` : 'Volatility is normal across the board.'; }
    case 'dot': return `Data pipeline is up. BTC ${s.markets?.BTC ? fmtPx(s.markets.BTC.px) : '—'}, SPY ${s.markets?.SPY ? fmtPx(s.markets.SPY.px) : '—'}.`;
    case 'ava': { const e = (s.research?.log || []).at(-1);
      return e ? `Last idea in the lab: "${e.name}", it ${e.passed ? 'passed' : 'failed'} (${e.reason || ''}).`.slice(0, 160) : `The lab is ${s.research?.status || 'idle'}.`; }
  }
  const last = a.said.at(-1);
  return last ? `Busy! ${last}`.slice(0, 160) : `Hi Jason! ${a.role}.`;
}
function talkTo(id) {
  const a = agents[id]; if (!a) return;
  const now = performance.now();
  P.path.length = 0; P.onArrive = null; P.face = Math.atan2(a.x - P.x, a.z - P.z);
  if (a.seated && !a.path.length) a.swivelUntil = now + 8000; else if (!a.path.length) a.face = Math.atan2(P.x - a.x, P.z - a.z);
  pSay(choose([`Hey ${a.name}, how's it going?`, `${a.name}, quick update?`, `What's the latest, ${a.name}?`]), 1800);
  setTimeout(() => { if (!agents[id]) return; const line = talkLine(a); a.bubble = { text: line, until: performance.now() + 7000 }; a.said.push(line); a.said = a.said.slice(-6);
    gest(a, a.seated ? 'wave' : 'explain', 1800); feel(a, 'happy', 5000); }, 900);
  selected = id; if (isGame()) { renderCard(); renderStrip(); } else openProfile(id);
  const pod = snap?.roster?.some(r => r.id === id);
  tickRound(pod ? 'pm:' + id : id);
}
function coffee() { gest(P, 'nod', 1400); pSay(choose(['Ahh. Coffee.', 'One espresso for the owner.', 'Caffeine: the only free alpha.', 'Hydrating between trades.'])); }

// ── things you can use (E) ──
let INTERACTS = null;
function interacts() {
  if (INTERACTS) return INTERACTS;
  const wall = (k, label, run) => ({ x: [-10.95, 0, 10.95][k], z: -15.2, r: 3.4, label, run: () => { run(); tickRound('wall'); } });
  return INTERACTS = [
    { x: 23.5, z: -13.7, r: 1.9, label: 'CIO console', run: () => openCIO() },
    { x: -23.3, z: -10.0, r: 1.5, label: 'Your office desk: run the fund', run: () => openOffice() },
    { x: 24.2, z: 5.4, r: 1.5, label: 'Front desk: your briefing (Ari)', run: () => openFrontDesk() },
    { x: 19.3, z: 2.4, r: 1.3, label: 'Global markets globe', run: () => openCharts() },
    { x: 15.5, z: 5.3, r: 1.1, label: 'Compliance (Lena)', run: () => openCompliance() },
    { x: 6.5, z: 5.3, r: 1.0, label: 'Risk report: VaR (Rex)', run: () => openRiskReport() },
    { x: 0, z: 5.3, r: 1.0, label: 'Reports & investor statement (Sam)', run: () => openReports() },
    { x: -26.6, z: -13.4, r: 1.6, label: 'Bookshelf: the quant reading list', run: () => openBooks() },
    { x: -19.6, z: -12.6, r: 1.2, label: "Founder's board: set priorities", run: () => openAnnounce() },
    { x: PODIUM.x, z: PODIUM.z + 1.3, r: 1.3, label: 'Podium: make a floor announcement', run: () => openAnnounce() },
    wall(0, 'Markets heatmap', () => openCharts()), wall(1, 'Fund tear sheet', () => openTear()), wall(2, 'PM board · pods', () => openTab('pods')),
    { x: -22.5, z: 13.2, r: 3.6, label: 'Conference table · pods', run: () => openTab('pods') },
    { x: 21.5, z: 11.6, r: 2.0, label: 'Strategy Builder: backtest your own idea', run: () => { openBuilder(); tickRound('lab'); } },
    { x: 15.2, z: 13.2, r: 2.0, label: 'Quant toolbox board', run: () => { openTab('research'); tickRound('lab'); } },
    { x: -20.5, z: 6.3, r: 1.6, label: 'Model Lab (Kai)', run: () => openMlab() },
    { x: FX - 1.4, z: 12.2, r: 2.0, label: 'Research log', run: () => { openTab('research'); tickRound('lab'); } },
    { x: FX - 0.9, z: 3.5, r: 2.0, label: 'Elevator · fast travel', run: () => openTravel(true) },
    { x: -FX + 1.4, z: 3.4, r: 1.9, label: 'Grab a coffee', run: coffee },
    { x: -FX + 1.4, z: 6.0, r: 1.6, label: 'Water cooler', run: coffee },
    { x: BR_MID, z: AISLE, r: 3.4, label: 'The Wire · city message board', run: () => openWire() },
    { x: SX, z: SZ - SD / 2 + 1.6, r: 3.4, label: 'JB Ventures pipeline', run: () => openStudio() },
    { x: NX, z: NZ - ND / 2 + 1.6, r: 3.4, label: 'Newsroom wall', run: () => openNews() },
    { x: CX, z: CZ - CD / 2 + 1.6, r: 3.4, label: 'Careers board', run: () => openCareer() },
    { x: HX, z: HZ - HD / 2 + 1.6, r: 3.4, label: 'Study Hall chalkboard', run: () => openStudy() },
    { x: IX, z: IZ - ID / 2 + 1.6, r: 3.4, label: 'Incubator · shadow book', run: () => openIncubator() },
    { x: HX + 9.4, z: HZ + 4.4, r: 1.8, label: 'Mental Math Arena (120 s drill)', run: () => openMath() },
    { x: HX + 9.4, z: HZ + 6.1, r: 1.2, label: 'Market Making Pit (quote four dice)', run: () => openMM() },
    { x: 0, z: FZ - 2.4, r: 1.9, label: 'Beat the Bots (call a market)', run: () => openArena() },
    { x: MY_SEAT[0], z: MY_SEAT[1] + 1.1, r: 1.5, label: 'Your desk: place a trade', run: () => openMyDesk() },
    { x: 16.9, z: -8.6, r: 0.9, label: 'Trophy case', run: () => openTrophies() },
    { x: -9.25, z: -9.9, r: 1.2, label: "Opal's options book: payoff chart", run: () => openPayoff() },
    { x: -2.75, z: -9.9, r: 1.4, label: 'Ring the opening bell', run: () => ringBell('You rang the bell, Jason. Back to work, team!') },
    { x: 6.5, z: STAFF_Z - 2.0, r: 1.2, label: "Rex's stress test: shock the live book", run: () => openStress() },
    { x: OX, z: OZ - OD / 2 + 1.6, r: 4.4, label: 'Ops Center · system health', run: () => openOps() },
  ];
}
walk.target = null;
function updatePrompt() {
  if (!walk.on) { walk.target = null; $('gPrompt').classList.remove('on'); return; }
  let best = null, bs = 1e9;
  for (const a of Object.values(agents)) {
    if (a.hidden || a.leaving) continue;
    const d = Math.hypot(a.x - P.x, a.z - P.z); if (d < 2.3 && d < bs) { bs = d; best = { kind: 'agent', id: a.id, label: `Talk to ${a.name}` }; }
  }
  for (const o of interacts()) { const d = Math.hypot(o.x - P.x, o.z - P.z); if (d < o.r) { const sc = d / o.r * 2.3 + 0.4; if (sc < bs) { bs = sc; best = { kind: 'obj', o, label: o.label }; } } }
  walk.target = best;
  const el = $('gPrompt'), txt = best ? best.label : '';
  el.classList.toggle('on', !!best && $('travel').hidden);
  if ($('gPromptTxt').textContent !== txt) $('gPromptTxt').textContent = txt;
}
function interact() {
  const t = walk.target; if (!t) { pSay(choose(['Nothing to use here.', 'Hmm. Walk up to someone or something.']), 1800); return; }
  if (t.kind === 'agent') talkTo(t.id); else { P.face = Math.atan2(t.o.x - P.x, t.o.z - P.z); t.o.run(); }
}
$('gPrompt').onclick = interact;

// ── clicking in walk mode: the floor = walk there, a robot = walk over and talk ──
function walkClick(ev, info) {                                                    // walking is WASD only: no click-to-walk
  if (fp.on) return true;
  if (info?.type === 'agent') { walkTalk(info.id); return true; }
  return !info;                                                                    // the floor: nothing; a screen / desk / door: open it
}

// ── fast travel (1-5, the elevator, Go to) ──
const SPAWN = { fund: [POI.exchange.x - 1.5, 3.5], studio: [SX, AISLE], news: [NX, AISLE], career: [CX, AISLE], study: [HX, AISLE], incubator: [IX - 8, AISLE], ops: [OX + 8, AISLE] };
const ROOM_SPOT = { office: [-23.3, -9.6], floor: [0, AISLE], pms: [-3, -5.4], wall: [0, -14.4], cio: [CIO.door + 1.2, CIO.z1 - 2.2], lab: [20.6, 11.0], conf: [-19.6, 11], lounge: [0, 10.4] };
function openTravel(on = true) { $('travel').hidden = !on; updatePrompt(); }
$('travel').addEventListener('click', ev => { const b = ev.target.closest('[data-tr]'); if (!b) return; const t = b.dataset.tr;
  if (t === 'close') openTravel(false); else if (t === 'cityhall') { openTravel(false); setWalk(false); openCityHall(); } else if (t === 'city') { openTravel(false); setWalk(false); $('bCity').click(); } else travel(t); });
function fadeThrough(mid) { const f = $('fade'); f.classList.add('on'); setTimeout(() => { mid(); setTimeout(() => f.classList.remove('on'), 80); }, 300); }
function travel(t, x, z) {
  openTravel(false); closeGo();
  const [sx, sz] = x != null ? [x, z] : SPAWN[t]; const d = nearestFree(sx, sz) || { x: sx, z: sz };
  fadeThrough(() => {
    const dx = d.x - P.x, dz = d.z - P.z;
    P.x = d.x; P.z = d.z; P.path.length = 0; P.onArrive = null; P.root.position.set(P.x, 0, P.z);
    controls.target.x += dx; controls.target.z += dz; camera.position.x += dx; camera.position.z += dz; camTween = null;
    if (t === 'fund' && x == null) { doorOpenUntil = performance.now() + 1600; P.face = -Math.PI / 2; }
    stripHtml = ''; renderStrip(); nextPrompt = 0;
  });
}
function walkJump(k) {
  if (k === 8 || k === 9) return travel(k === 8 ? 'incubator' : 'ops');
  if (k <= 5) travel(['fund', 'studio', 'news', 'career', 'study'][k - 1]);
  else { setWalk(false); $(k === 6 ? 'bCityHall' : 'bCity').click(); }
}
goMenu.addEventListener('click', ev => {                     // in walk mode the Go-to menu moves YOU, not the camera
  if (!walk.on) return;
  const b = ev.target.closest('.mi'); if (!b) return;
  const moves = { bIncubator: () => travel('incubator'), bOps: () => travel('ops'), bVentures: () => travel('studio'), bNews: () => travel('news'), bCareer: () => travel('career'), bStudy: () => travel('study'), bWire: () => travel('fund', BR_MID, AISLE),
     bCityHall: () => { setWalk(false); openCityHall(); }, bCity: () => { setWalk(false); $('bCity').click(); } };
  closeGo();
  if (!b.dataset.go && !moves[b.id]) return;                 // windows (tear sheet, games, stress test) open as usual
  ev.stopPropagation(); ev.preventDefault();
  if (b.dataset.go) { const [x, z] = ROOM_SPOT[b.dataset.go]; travel('fund', x, z); return; }
  moves[b.id]();
}, true);
{ const ov = $('bOverview').onclick; $('bOverview').onclick = () => walk.on ? travel('fund') : ov(); }

// ── walk <-> drone ──
const HINTS = { walk: '<b>WASD</b> walk · <b>Shift</b> run · <b>E</b> talk / use · <b>V</b> first person · <b>scroll</b> zoom · <b>C</b> drone · <b>?</b> help',
  drone: '<b>Drag</b> move · <b>right-drag</b> turn · <b>scroll</b> zoom · <b>Tab</b> next agent · <b>C</b> walk · <b>G</b> game mode · <b>?</b> help' };
function setWalk(on, save = isGame()) {
  if (save) lsSet('jb.walk', on ? '1' : '0');
  const b = $('bWalk'); b.innerHTML = on ? '&#128760; Drone' : '&#128694; Walk'; b.title = on ? 'Fly the drone camera (C)' : 'Walk around as yourself (C)';
  $('hint').querySelector('span').innerHTML = on ? HINTS.walk : HINTS.drone;
  if (on === walk.on) return;
  walk.on = on;
  if (on && lsGet('jb.greet') !== new Date().toDateString() && snap) setTimeout(() => {
    if (!walk.on || !agents.boss) return;
    lsSet('jb.greet', new Date().toDateString());
    const best = (snap.roster || []).filter(p => p.status === 'active').sort((x, y) => y.pnl - x.pnl)[0];
    const inc = (snap.incubator?.items || []).filter(x => x.status === 'incubating').length;
    act('boss', anim('wave', 1600), say(`Welcome in, Jason. NAV ${snap.nav.toFixed(2)}, ${pct(snap.day_ret)} today.${best ? ` ${best.name} leads.` : ''}${inc ? ` ${inc} strategies in the Incubator.` : ''} Your rounds are on the board.`, 6500));
    gToast(`The CIO: NAV ${snap.nav.toFixed(2)} · ${pct(snap.day_ret)} today · daily rounds are up`, true);
  }, 1800);
  if (on) {
    follow = false; setFollowBtn();
    controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE };
    controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_ROTATE };
    controls.enablePan = false; controls.enableZoom = false; controls.minDistance = 0.05; controls.maxDistance = 30;
    walk.camDist = walk.camActual = 9;
    const off = camera.position.clone().sub(controls.target), hd = Math.atan2(off.x, off.z), el = 0.5, d = 9;
    if (lsGet('jb.fp') === '1') setTimeout(() => { if (walk.on && !fp.on) setFP(true); }, 1000);
    const tgt = new THREE.Vector3(P.x, 1.3, P.z);
    camTo(tgt.clone().add(new THREE.Vector3(Math.sin(hd) * Math.cos(el) * d, Math.sin(el) * d, Math.cos(hd) * Math.cos(el) * d)), tgt, 900);
    stripHtml = ''; renderStrip();
  } else {
    controls.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE };
    controls.touches = { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_ROTATE };
    if (fp.on) { setFP(false); lsSet('jb.fp', '1'); }
    controls.enabled = true; controls.enablePan = true; controls.enableZoom = true; controls.minDistance = 2.5; controls.maxDistance = 600;
    P.path.length = 0; P.onArrive = null; walk.target = null; $('gPrompt').classList.remove('on'); openTravel(false);
  }
}
$('bWalk').onclick = () => setWalk(!walk.on, isGame());

// ── the game-mode panel: the terminal tabs float over the floor ──
function showPanel(on) { document.body.classList.toggle('panel', !!on && isGame()); }
const panelOpen = () => document.body.classList.contains('panel');
$('panelX').onclick = () => showPanel(false);

// ── daily rounds: a manager's walk around the floor ──
const roundsKey = () => 'jb.rounds.' + new Date().toLocaleDateString('en-CA');
let roundsDay = roundsKey(), roundsDone = new Set((() => { try { return JSON.parse(lsGet(roundsDay) || '[]'); } catch { return []; } })());
function roundItems() {
  const pms = (snap?.roster || []).filter(p => agents[p.id]).map(p => ({ k: 'pm:' + p.id, label: `Talk to ${p.name}` }));
  return [...pms, { k: 'rex', label: 'Check in with Rex (risk)' }, { k: 'boss', label: 'Visit the CIO' }, { k: 'lab', label: 'Visit the quant lab' }, { k: 'wall', label: 'Read the video wall' },
    { k: 'juno', label: 'Visit Juno in the Incubator' }, { k: 'nova', label: 'Check systems with Nova (Ops Center)' }];
}
function gToast(text, big = false) {
  const box = $('gToasts'), d = document.createElement('div'); d.textContent = text; if (big) d.className = 'big';
  box.appendChild(d); while (box.children.length > 3) box.firstChild.remove();
  setTimeout(() => { d.style.opacity = '0'; d.style.transform = 'translateY(-8px)'; setTimeout(() => d.remove(), 520); }, big ? 5200 : 2600);
}
function tickRound(k) {
  if (roundsKey() !== roundsDay) { roundsDay = roundsKey(); roundsDone = new Set(); }
  const items = roundItems(), it = items.find(i => i.k === k);
  if (!it || roundsDone.has(k)) return;
  roundsDone.add(k); lsSet(roundsDay, JSON.stringify([...roundsDone]));
  const n = items.filter(i => roundsDone.has(i.k)).length;
  gToast(`✓ ${it.label} · rounds ${n}/${items.length}`); SFX.round();
  renderRounds();
  if (n === items.length && lsGet(roundsDay + '.cheer') !== '1') {
    lsSet(roundsDay + '.cheer', '1'); markStreak();
    setTimeout(() => { gToast('Daily rounds complete! The floor salutes you.', true); confetti(P.x, 2.6, P.z, 140); gest(P, 'celebrate', 2600);
      floorCheer(null, 'Full rounds done, Jason. That is how an owner runs a floor.'); }, 700);
  }
}
function markStreak() {
  let d = []; try { d = JSON.parse(lsGet('jb.roundsDays') || '[]'); } catch { /* fresh */ }
  const today = new Date().toLocaleDateString('en-CA'); if (!d.includes(today)) d.push(today); lsSet('jb.roundsDays', JSON.stringify(d.slice(-60)));
}
function roundsStreak() {               // days in a row with full rounds, ending today (or yesterday if today isn't done yet)
  let d = []; try { d = JSON.parse(lsGet('jb.roundsDays') || '[]'); } catch { return 0; }
  const set = new Set(d), day = new Date(); let n = 0;
  if (!set.has(day.toLocaleDateString('en-CA'))) day.setDate(day.getDate() - 1);
  while (set.has(day.toLocaleDateString('en-CA'))) { n++; day.setDate(day.getDate() - 1); }
  return n;
}
let roundsHtml = '';
function renderRounds() {
  if (roundsKey() !== roundsDay) { roundsDay = roundsKey(); roundsDone = new Set(); }
  const items = roundItems(), n = items.filter(i => roundsDone.has(i.k)).length, all = items.length && n === items.length;
  const streak = roundsStreak();
  $('gRoundsTxt').textContent = (all ? 'Rounds done ✓' : `Daily rounds ${n}/${items.length}`) + (streak > 1 ? ` · 🔥 ${streak}-day streak` : '');
  $('gRoundsBar').style.width = (items.length ? n / items.length * 100 : 0) + '%';
  $('gRounds').classList.toggle('done', !!all);
  const html = items.map(i => `<div class="${roundsDone.has(i.k) ? 'ok' : ''}"><b>${roundsDone.has(i.k) ? '✓' : '○'}</b> ${esc(i.label)}</div>`).join('') + '<div class="faint" style="font-size:11px;margin-top:4px">Walk mode: talk with E. Resets every day.</div>';
  if (html !== roundsHtml) { roundsHtml = html; $('gRoundsList').innerHTML = html; }
}
$('gRounds').onclick = () => { $('gRoundsList').hidden = !$('gRoundsList').hidden; renderRounds(); };
setInterval(renderRounds, 2000);
if (/[?&]walk\b/.test(location.search)) setTimeout(() => setWalk(true, false), 50);
window.__jb.player = P; window.__jb.walk = { setWalk, travel, walkTo, walkTalk, talkTo, interact, canStand, nearestFree, NAV, tickRound, roundItems, state: walk, navAt,
  sim: sec => { const t0 = performance.now(); for (let t = 0; t < sec; t += 1 / 60) updatePlayer(1 / 60, t0 + t * 1000); nextPrompt = 0; labTickAt = 0; return [+P.x.toFixed(2), +P.z.toFixed(2)]; },   // headless tests: fixed-step walking
  blockers: (x, z) => { const out = [], bx = new THREE.Box3(); scene.traverse(o => { if (!o.isMesh || !o.geometry?.boundingBox) return; bx.copy(o.geometry.boundingBox).applyMatrix4(o.matrixWorld);
    if (bx.min.x - 0.35 <= x && bx.max.x + 0.35 >= x && bx.min.z - 0.35 <= z && bx.max.z + 0.35 >= z && bx.max.y > 0.15 && bx.min.y < 1.6) out.push([o.type, o.material?.color?.getHexString?.(), +bx.min.x.toFixed(2), +bx.max.x.toFixed(2), +bx.min.z.toFixed(2), +bx.max.z.toFixed(2), +bx.min.y.toFixed(2), +bx.max.y.toFixed(2)]); }); return out.slice(0, 12); } };

// ── static batching: one draw call per (parent, material) instead of one per prop ──
// Everything built above is merged once at startup, EXCEPT what moves, blinks, gets clicked or is referenced by name.
function batchable(m, deny) {
  if (!m.isMesh || m.isInstancedMesh || m.isSkinnedMesh || deny.has(m) || m.children.length || !m.visible) return false;
  if (Array.isArray(m.material) || m.material.userData.blink !== undefined || flyIgnore.has(m) || clickables.includes(m)) return false;
  const g = m.geometry; if (!g.attributes.position || g.morphAttributes.position || g.drawRange.count !== Infinity) return false;   // (box 'groups' are fine: one material)
  if (m.onBeforeRender !== _OBR || m.renderOrder !== 0 || !m.frustumCulled) return false;
  m.updateMatrix(); return m.matrix.determinant() > 0;   // mirrored parts would flip their faces when baked
}
function batchTree(root, deny, chunk = 0) {
  const buckets = new Map();
  const visit = obj => { for (const ch of obj.children) { if (deny.has(ch)) continue;
    if (batchable(ch, deny)) {
      const g = ch.geometry, sig = Object.keys(g.attributes).sort().join(',') + (g.index ? '|i' : '|n');
      let cell = ''; if (chunk && obj === scene) { const p = ch.position; cell = `${Math.floor(p.x / chunk)},${Math.floor(p.z / chunk)},${p.y < -50 ? 0 : 1}`; }
      const key = `${obj.id}|${ch.material.uuid}|${+ch.castShadow}${+ch.receiveShadow}|${sig}|${cell}|${clickId(ch.userData.click)}`;
      let b = buckets.get(key); if (!b) buckets.set(key, b = { parent: obj, list: [] }); b.list.push(ch);
    } else if (ch.children.length && !ch.isInstancedMesh) visit(ch); } };
  visit(root);
  let removed = 0, made = 0;
  for (const { parent, list } of buckets.values()) {
    if (list.length < 2) continue;
    const geo = mergeGeometries(list.map(m => { const g = m.geometry.clone().applyMatrix4(m.matrix); g.clearGroups(); return g; }));
    if (!geo) continue;
    const m0 = list[0], big = new THREE.Mesh(geo, m0.material);
    big.castShadow = m0.castShadow; big.receiveShadow = m0.receiveShadow; big.matrixAutoUpdate = false; big.userData.batch = true;
    if (m0.userData.click) big.userData.click = m0.userData.click;   // still clickable (only merged with props that open the same thing)
    for (const m of list) parent.remove(m);
    parent.add(big); big.updateMatrix(); removed += list.length; made++;
    if (parent === scene) { geo.computeBoundingSphere(); const s = geo.boundingSphere; if (s.radius < 14 && s.center.y > -50) farBatches.push({ m: big, c: s.center.clone() }); }
  }
  return { removed, made };
}
function staticBatch() {
  buildNavGrid();
  buildOccluders();          // before batching merges the walls (the originals keep their geometry + world matrix for ray tests)
  const deny = new Set([P.root, P.ring, doorL, doorR, onAirSign, ...leds, ...racks, ...blinkers, ...openSigns, ...spinners.map(s => s.obj), ...Object.values(roofSlabs).filter(Boolean),
    ...planes.map(p => p.l)]);
  for (const a of Object.values(agents)) deny.add(a.root);
  const r = batchTree(scene, deny, 30);
  window.__jb.batched = r;
}
// robots: merge each body part's static pieces (same joint, same material); joints keep moving as before
function batchRobot(parts) {
  const deny = new Set(Object.values(parts).filter(v => v && v.isObject3D && v !== parts.root && v.isMesh));
  batchTree(parts.root, deny);
  // fingers, joints, antennas, eyes: too small to show in the shadow map, but each one costs a shadow draw call
  parts.root.traverse(o => { if (o.isMesh && o.castShadow) { o.geometry.computeBoundingSphere(); if (o.geometry.boundingSphere.radius < 0.13) o.castShadow = false; } });
}
setTimeout(staticBatch, 0);   // after every module-level build step has run

// ── main loop ─────────────────────────────────────────────
let last = performance.now(), lastMon = 0, lastSlow = 0, lastTick = 0, monIdx = 0, lastCull = 0;
function loop() {
  const now = performance.now(), dt = Math.max(0, Math.min(0.1, (now - last) / 1000)); last = now;
  idle(now);
  talkers = Object.values(agents).filter(b => !b.hidden && b.bubble && now < b.bubble.until);
  for (const a of Object.values(agents)) { runQueue(a, now); animate(a, dt, now); }
  updatePlayer(dt, now);
  if (now - lastMon > 400) { monTexs[monIdx++ % 6].redraw(); lastMon = now; leds.forEach((l, i) => l.visible = (Math.floor(now / 350) + i) % 4 !== 0); }
  if (now - lastSlow > 20000) { cityTex.redraw(); wireTex.redraw(); newsTex.redraw(); careerTex.redraw(); chalkTex.redraw(); pipeTex.redraw(); labTex.redraw(); tvTex.redraw(); tbTex.redraw(); lastSlow = now; }
  if (now - lastTick > 1000) { clocks.forEach(c => c.redraw()); lastTick = now; }
  crowns.forEach((c, i) => c.opacity = 0.65 + Math.sin(now / 1500 + i) * 0.2);
  moveCars(dt); moveDrones(now); moveScenery(dt, now); updateRoofs(); updateCeiling();
  for (const s of spinners) s.obj.rotation.y += s.w * dt;
  for (const h of animHooks) h(dt, now);
  updateFireworks(dt, now);
  zipTex.tex.offset.x = (now / 60000) % 1; onAirSign.material.color.setScalar(now < onAirUntil && Math.floor(now / 500) % 2 ? 1 : 0.35);
  tkTex.tex.offset.x = (now / 90000) % 1;
  const open = now < doorOpenUntil ? 1 : 0;
  doorL.position.z += ((2.93 - open * 0.9) - doorL.position.z) * Math.min(1, dt * 8); doorR.position.z += ((4.07 + open * 0.9) - doorR.position.z) * Math.min(1, dt * 8);
  const testing = now < testingUntil;
  racks.forEach((l, i) => l.visible = testing ? (Math.floor(now / 220) + i) % 2 === 0 : (Math.floor(now / 600) + i) % 5 !== 0);   // a busy blink, not a 14 Hz strobe
  for (const p of planes) { p.t += p.w * dt; p.g.position.set(Math.cos(p.t) * p.r, p.y, Math.sin(p.t) * p.r); p.g.rotation.y = -p.t - Math.PI / 2; p.l.visible = Math.floor(now / 600) % 2 === 0; }
  blinkers.forEach(b => b.visible = (Math.floor(now / 900) + b.material.userData.blink) % 3 === 0);
  for (const c of coins) { if (c.conf) { c.v.y -= 3 * dt; c.v.multiplyScalar(1 - dt * 1.2); c.m.rotation.x += dt * 6; c.m.rotation.y += dt * 4; } else { c.v.y -= 12 * dt; c.m.rotation.x += dt * 8; }
    c.m.position.addScaledVector(c.v, dt); if (c.m.position.y < 0.04) { c.m.position.y = 0.04; c.v.set(c.v.x * 0.5, c.conf ? 0 : -c.v.y * 0.3, c.v.z * 0.5); } }
  for (let i = coins.length - 1; i >= 0; i--) if (now - coins[i].born > 2600) { scene.remove(coins[i].m); coins.splice(i, 1); }
  if (camTween) { const k = Math.min(1, (now - camTween.start) / camTween.ms), e = k * k * (3 - 2 * k);
    camera.position.lerpVectors(camTween.p0, camTween.p1, e); controls.target.lerpVectors(camTween.t0, camTween.t1, e); if (k >= 1) camTween = null; }
  else if (walk.on) walkCam(dt);
  else if (follow && selected && agents[selected]) { const a = agents[selected], tgt = new THREE.Vector3(a.x, 1.2, a.z), delta = tgt.clone().sub(controls.target).multiplyScalar(Math.min(1, dt * 4));
    controls.target.add(delta); camera.position.add(delta); }
  if (!walk.on) keyNav(dt, keys.has('shift'));
  controls.zoomToCursor = !follow && !walk.on;
  controls.update(); clampView();
  const camDist = camera.position.distanceTo(controls.target); scene.fog.near = Math.max(140, camDist * 0.9); scene.fog.far = Math.max(720, camDist * 3.2);   // haze scales with zoom
  fitDepth(camDist);
  if (now - lastCull > 250) { lastCull = now; cullFar(camDist); }
  composer.render(); placeOverlay(now);
}
// far away (city view) the robots and small interior props are a few pixels big: skip drawing them,
// and stop re-rendering the office shadow map (it only covers the trading floor)
const _cv = new THREE.Vector3();
function cullFar(camDist) {
  const cp = camera.position;
  for (const a of Object.values(agents)) a.far = Math.hypot(cp.x - a.x, cp.z - a.z, cp.y) > 140;
  for (const b of farBatches) b.m.visible = cp.distanceTo(b.c) < 190;
  renderer.shadowMap.autoUpdate = Math.hypot(cp.x, cp.z) < 160 && camDist < 150;      // the sun shadow box sits over the trading floor (origin)
  if (!renderer.shadowMap.autoUpdate && !cullFar.froze) { renderer.shadowMap.needsUpdate = true; cullFar.froze = true; } else if (renderer.shadowMap.autoUpdate) cullFar.froze = false;
}
renderer.setAnimationLoop(loop);
// backup clock only when animation frames have STOPPED (throttled background tab), never alongside them: no double renders
setInterval(() => { if (!document.hidden && performance.now() - last > 1000) loop(); }, 500);

// ── terminal UI ───────────────────────────────────────────
function money(v) { return (v < 0 ? '-$' : '$') + Math.abs(v).toLocaleString(undefined, { maximumFractionDigits: 0 }); }
const pct = (v, d = 2) => v == null ? '—' : `${v >= 0 ? '+' : ''}${(v * 100).toFixed(d)}%`;
function fmtPx(p) { return p >= 1000 ? Math.round(p).toLocaleString() : p.toFixed(2); }
const cls = v => v >= 0 ? 'up' : 'down';
function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
let activeTab = 'feed', profileId = null;
document.querySelectorAll('.tab').forEach(t => t.onclick = () => openTab(t.dataset.p));
function openTab(p) { activeTab = p; profileId = null; if (isGame()) showPanel(true);
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('on', t.dataset.p === p));
  document.querySelectorAll('.pane').forEach(x => x.classList.toggle('on', x.id === p)); renderPane(); }
function renderPane() {
  if (!snap) return;
  const el = $(profileId ? 'pods' : activeTab), top = el ? el.scrollTop : 0;          // keep your place while the pane refreshes
  if (profileId) renderProfile(profileId);
  else ({ pods: renderPods, team: renderTeam, riskp: renderRisk, research: renderResearch, letters: renderLetters, ventures: renderVentures, wire: renderWire, newsp: renderNews, careerp: renderCareer, studyp: renderStudy })[activeTab]?.();
  if (el && el.scrollTop !== top) el.scrollTop = top;
}

let navChart, navSeries, firstSnap = true;
let navHigh = null;
function hud(s) {
  snap = s;
  for (const p of s.minds?.people || []) if (agents[p.id]) agents[p.id].moodName = p.mood;
  if (navHigh == null) navHigh = Math.max(100, ...((s.curve || []).map(c => 100 * c[1] / s.start)));
  else if (s.nav > navHigh + 0.01) { navHigh = s.nav; floorCheer('boss', `New all-time high for the fund: NAV ${s.nav.toFixed(2)}!`); }
  cityTex.redraw();
  if (modalKind === 'cityhall') renderCityHall();
  syncRoster(s.roster || [], firstSnap); firstSnap = false; pmOfWeek(s.roster);
  for (const a of Object.values(agents)) if (a.station) a.station.tex.redraw();
  myDesk3d.tex.redraw(); officeLines.tex.redraw(); officeLines.board.redraw(); if (modalKind === 'mydesk') renderMyDesk();
  if (modalKind === 'cio') renderCIO(); if (modalKind === 'manage') renderManage(); if (modalKind === 'announce') annHist();
  optKiosk.tex.redraw(); mlabTex.redraw(); bbgTex.redraw(); globe.paint(); paintStrips();
  if (modalKind === 'riskrep') renderRiskReport(); if (modalKind === 'compliance') renderCompliance(); if (modalKind === 'payoff' && document.activeElement?.id !== 'payMv') renderPayoff();
  maybeAway(); if (!trophyShelf.painted) { trophyShelf.painted = true; trophyShelf.paint(); } checkAch();
  kioskTex.redraw(); if (modalKind === 'arena') renderArena(); if (modalKind === 'tear') renderTear(); if (modalKind === 'stress') renderStress(); if (modalKind === 'builder') renderBuilder();
  syncTrainees(s.incubator); incTex.redraw(); opsSysTex.redraw(); opsFeedTex.redraw(); opsBrokerTex.redraw(); ringTex.redraw();
  if (modalKind === 'ops') renderOps();
  const tot = s.equity / s.start - 1;
  $('kNav').innerHTML = `<span class="${cls(tot)}">${s.nav.toFixed(2)}</span>`;
  $('kAum').textContent = money(s.equity);
  $('gNav').innerHTML = `<span class="${cls(tot)}">${s.nav.toFixed(2)}</span>`; $('gAum').textContent = money(s.equity); $('gDay').innerHTML = `<span class="${cls(s.day_ret)}">${pct(s.day_ret)}</span>`;
  $('kDay').innerHTML = `<span class="${cls(s.day_ret)}">${pct(s.day_ret)}</span>`;
  $('kTot').innerHTML = `<span class="${cls(tot)}">${pct(tot)}</span>`;
  $('kSharpe').textContent = s.sharpe == null ? 'n/a' : s.sharpe.toFixed(2);
  $('kDD').innerHTML = `<span class="${s.maxdd < -0.0001 ? 'down' : ''}">${(s.maxdd * 100).toFixed(2)}%</span>`;
  $('kExp').textContent = `${(s.gross / s.equity * 100).toFixed(0)}% / ${(s.net / s.equity * 100).toFixed(0)}%`;
  const groups = {}; for (const m of Object.values(s.markets)) (groups[m.cls] ||= []).push(m.open);
  const feedOf = c => (s.feeds || {})[c === 'etf' || c === 'stock' ? 'stocks' : c] || '';
  $('mkts').innerHTML = Object.entries(groups).map(([c, o]) => `<span class="pill ${o.some(Boolean) ? 'ok' : ''}" title="prices: ${esc(feedOf(c))}">${c} ${o.some(Boolean) ? 'open' : 'closed'}${/real time/.test(feedOf(c)) ? ' · RT' : ''}</span>`).join('') +
    `<span class="pill ${s.chain_ok ? 'ok' : ''}">options ${s.chain_ok ? 'live' : '…'}</span>` +
    `<span class="pill ${s.analyst_on ? 'ai' : ''}">AI ${s.analyst_on ? (s.brain === 'claude-code' ? '· Claude (Max)' : '· Claude API') : 'off'}</span>`;
  $('pos').innerHTML = s.positions.length ? s.positions.map(p => p.option
    ? `<tr><td class="t" style="color:${COLORS[p.pod] || '#fff'}">${esc(p.pod_name)}</td><td class="t">${esc(p.sym)}</td><td class="t muted">${p.dte.toFixed(1)}d</td><td>${p.entry >= 0 ? 'cr ' : 'db '}${money(Math.abs(p.entry))}</td><td>max -${money(p.max_loss)}</td><td class="${cls(p.upl)}">${money(p.upl)}</td></tr>`
    : `<tr><td class="t" style="color:${COLORS[p.pod] || '#fff'}">${esc(p.pod_name)}</td><td>${p.sym}</td><td class="${p.side > 0 ? 'up' : 'down'}">${p.side > 0 ? 'LONG' : 'SHORT'}</td><td>${fmtPx(p.entry)}</td><td>${fmtPx(p.last)}</td><td class="${cls(p.upl)}">${money(p.upl)}</td></tr>`).join('')
    : '<tr><td colspan="6" class="t muted">No open positions.</td></tr>';
  $('posInfo').textContent = `${s.positions.length} open · risk ${money(s.open_risk)}`;
  const tr = s.trades.slice().reverse();
  $('trades').innerHTML = tr.slice(0, 8).map(t => `<tr><td class="t" style="color:${COLORS[t.pod] || '#fff'}">${esc(nameOf(t.pod))}</td><td class="t">${esc(t.sym)}</td><td class="${cls(t.pnl)}">${money(t.pnl)}</td><td class="t muted">${esc(t.reason)}</td></tr>`).join('') || '<tr><td colspan="4" class="t muted">No closed trades yet.</td></tr>';
  $('trInfo').textContent = `fees ${money(s.fees)}`;
  drawNav(s);
  heatTex.redraw(); navTex.redraw(); sbTex.redraw(); tkTex.redraw(); labTex.redraw(); tvTex.redraw();
  const ava = agents.ava;
  if (ava && s.research?.status === 'idle' && !ava.seated && !ava.queue.length && !ava.path.length) act('ava', say('Session wrapped. Back to my desk.', 2000), home());
  renderPane();
  if ($('modal').style.display === 'flex' && modalKind === 'settings') renderSettings(false);
}
function drawNav(s) {
  if (!window.LightweightCharts) return;
  if (!navChart) {
    navChart = LightweightCharts.createChart($('navChart'), { autoSize: true, layout: { background: { color: 'transparent' }, textColor: '#8692ab', fontFamily: 'Inter' },
      grid: { vertLines: { color: 'rgba(30,40,64,.5)' }, horzLines: { color: 'rgba(30,40,64,.5)' } }, rightPriceScale: { borderColor: '#1e2840' },
      timeScale: { borderColor: '#1e2840', timeVisible: true }, crosshair: { mode: 0 } });
    navSeries = navChart.addAreaSeries({ lineColor: '#7c8cff', topColor: 'rgba(124,140,255,.35)', bottomColor: 'rgba(124,140,255,0)', lineWidth: 2, priceFormat: { type: 'price', precision: 3, minMove: 0.001 } });
    navSeries.createPriceLine({ price: 100, color: '#5b6684', lineStyle: 2, lineWidth: 1, axisLabelVisible: false });
  }
  const data = []; let lastT = 0;
  for (const [t, eq] of s.curve) { if (t <= lastT) continue; lastT = t; data.push({ time: t, value: 100 * eq / s.start }); }
  data.push({ time: Math.max(Math.floor(s.ts), lastT + 1), value: s.nav });
  navSeries.setData(data);
  $('navInfo').innerHTML = `<span class="mono ${cls(s.nav - 100)}">${s.nav.toFixed(3)}</span>`;
}
function exprHtml(p) {
  const x = snap.stockopts?.pods?.[p.id]; if (!x || p.family === 'options' || p.tf !== '1d') return '';
  const f = (e, v) => `${e} ${v.n ? `${v.avg_r >= 0 ? '+' : ''}${v.avg_r.toFixed(2)}R · ${Math.round(v.win * 100)}% win · ${v.n}` : 'no trades yet'}`;
  return `<div class="faint" style="font-size:11.5px;margin-top:6px">Shares vs options (learned live): ${f('shares', x.shares)} | ${f('spreads', x.spread)}</div>`;
}
function pnlSpark(h, w = 340, ht = 46) {           // the pod's live P&L, sampled every 30 minutes (one series)
  if (!h || h.length < 3) return '';
  const v = h.map(x => x[1]), lo = Math.min(0, ...v), hi = Math.max(0, ...v), X = i => 2 + i / (v.length - 1) * (w - 4), Y = y => 4 + (1 - (y - lo) / (hi - lo || 1)) * (ht - 8);
  const last = v.at(-1), col = last >= 0 ? 'var(--green)' : 'var(--red)';
  return `<svg viewBox="0 0 ${w} ${ht}" width="100%" role="img" aria-label="Live P&L, last ${Math.round((h.at(-1)[0] - h[0][0]) / 3600)} hours" style="margin-top:6px">
    <line x1="2" x2="${w - 2}" y1="${Y(0)}" y2="${Y(0)}" stroke="var(--border2)" stroke-dasharray="3 3"/>
    <path d="${v.map((y, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(y).toFixed(1)}`).join('')}" fill="none" stroke="${col}" stroke-width="2" stroke-linejoin="round"/></svg>
    <div class="faint" style="font-size:10.5px">live P&amp;L · last ${Math.max(1, Math.round((h.at(-1)[0] - h[0][0]) / 3600))}h</div>`;
}
function riskLine(p) {
  const d = snap.toolbox?.dials?.[p.id], r = p.risk ?? 0;
  if (!d) return `<div class="faint" style="font-size:11.5px;margin-top:6px">Risk: ${(r * 100).toFixed(1)}% of pod capital per trade (starting size: no Monte Carlo evidence yet).</div>`;
  const cut = r < d.risk * 0.99 ? ` <span class="down">· cut to ${(r * 100).toFixed(1)}%: drawdown throttle</span>` : '';
  return `<div class="faint" style="font-size:11.5px;margin-top:6px">CIO risk dial: <b style="color:var(--text)">${(d.risk * 100).toFixed(1)}%</b> of pod capital per trade (${esc(d.why[0])}; stop-out odds ${(d.p_ruin * 100).toFixed(0)}%/yr)${cut}. Evidence in R&amp;D → Quant toolbox.</div>`;
}
function podCard(p) {
  const st = p.stats || {};
  return `<div class="pod"><div class="row1"><span><span class="nm" style="color:${COLORS[p.id] || '#fff'}">${esc(p.name)}</span> <span class="muted">· ${p.family === 'options' ? 'options desk' : p.founder ? 'founder' : 'hire'}</span></span><span class="tag ${p.status}">${p.status}</span></div>
    <div class="muted" style="font-size:12px;margin-top:3px">${esc(p.desc)}${p.markets ? ' · ' + p.markets.join(', ') : ' · all markets'}</div>
    <div class="bar"><i style="width:${Math.min(100, p.alloc / 0.6 * 100)}%"></i></div>
    <div class="stat-grid"><div><b>Allocation</b><span class="mono">${(p.alloc * 100).toFixed(0)}% · ${money(p.capital)}</span></div><div><b>P&amp;L</b><span class="mono ${cls(p.pnl)}">${money(p.pnl)}</span></div><div><b>Trust</b><span class="mono">${(st.trust ?? 1).toFixed(2)}</span></div>
      <div><b>Hit rate</b><span class="mono">${st.hit == null ? '—' : Math.round(st.hit * 100) + '%'}</span></div><div><b>Edge</b><span class="mono">${st.edge_bps == null ? '—' : st.edge_bps.toFixed(1) + 'bp'}</span></div><div><b>${p.family === 'options' ? 'Graded / trades' : 'Calls / trades'}</b><span class="mono">${st.n || 0} / ${p.trades}</span></div></div>
    ${p.stop_reason ? `<div class="down" style="font-size:12px;margin-top:6px">Stopped: ${esc(p.stop_reason)}</div>` : ''}
    ${riskLine(p)}
    ${pnlSpark(p.hist)}
    ${p.dup >= 1.5 ? `<div class="faint" style="font-size:11.5px;margin-top:6px">Overlap: the team holds this kind of bet ~${p.dup.toFixed(1)}x, so the CIO sizes it ÷${p.dup.toFixed(1)}.</div>` : ''}
    ${exprHtml(p)}
    <div style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap"><button class="btn sm" data-bench="${p.id}">${p.status === 'active' ? 'Pause pod' : 'Reactivate'}</button>
      <button class="btn sm" data-focus="${p.id}">Find on floor</button>${p.founder ? '' : `<button class="btn sm danger" data-fire="${p.id}">Fire PM</button>`}</div></div>`;
}
const MOODC = { 'fired up': 'var(--green)', confident: 'var(--green)', focused: 'var(--accent)', uneasy: 'var(--amber)', frustrated: 'var(--red)' };
function trialHtml(id) {
  const T = snap.trials, me = T?.people?.[id]; if (!me) return '';
  const ops = Object.entries(me.ops).sort((a, b) => b[1].tries - a[1].tries).map(([o, v]) => `<span class="tag" title="${esc(T.labels[o] || o)}" style="${v.wins ? 'color:var(--green)' : ''}">${esc(T.labels[o] || o)} ${v.wins}/${v.tries}</span>`).join(' ');
  return `<div style="font-size:12px;margin-top:6px"><b>Strategy v${me.version}</b> · trial-and-error record (what works for me):<div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:4px">${ops || '<span class="faint">no experiments yet</span>'}</div>${me.ideas ? `<div class="faint" style="margin-top:3px">${me.ideas} Study Hall idea(s) waiting to be tested</div>` : ''}</div>`;
}
function mindCard(p) {
  const prev = [0, 100, 300, 700, 1500, 3000][p.level] || 0, prog = p.next_xp ? (p.xp - prev) / (p.next_xp - prev) : 1;
  const j = p.journal[p.journal.length - 1];
  return `<div class="pod"><div class="row1"><span><span class="nm" style="color:${COLORS[p.id] || '#fff'}">${esc(p.name)}</span> <span class="muted">· ${esc(p.role)} · ${esc(p.title)}</span></span><span class="tag" style="color:${MOODC[p.mood] || 'var(--muted)'}">${esc(p.mood)}</span></div>
    <div class="faint" style="font-size:11.5px;margin-top:2px">${esc(p.traits)}</div>
    <div class="bar" title="${p.xp} XP"><i style="width:${Math.round(prog * 100)}%"></i></div>
    <div class="mono faint" style="font-size:11px">${p.xp} XP${p.next_xp ? ' · next level at ' + p.next_xp : ' · top of the ladder'} · ${p.wins}W/${p.losses}L ${money(p.pnl)} · ideas ${p.passed}✓ ${p.failed}✗ · pitches ${p.pitched}</div>
    ${p.goal ? `<div style="font-size:12.5px;margin-top:6px"><b>Goal:</b> ${esc(p.goal)}</div>` : ''}
    ${j ? `<div style="font-size:12.5px;margin-top:4px;font-style:italic">“${esc(j.text)}” <span class="faint">${ago(j.t)}</span></div>` : ''}
    ${p.lessons.length ? `<div style="font-size:12px;margin-top:6px"><b>Learned:</b><ul style="margin:3px 0 0 16px;padding:0">${p.lessons.slice().reverse().map(l => `<li>${esc(l.text)}</li>`).join('')}</ul></div>` : ''}
    ${trialHtml(p.id)}
    ${p.memories.length ? `<details style="margin-top:6px;font-size:12px"><summary class="muted">Recent memories</summary>${p.memories.slice().reverse().map(m => `<div class="${m.v > 0 ? 'up' : m.v < 0 ? 'down' : 'muted'}">• ${esc(m.text)} <span class="faint">${ago(m.t)}</span></div>`).join('')}</details>` : ''}</div>`;
}
function labSections() {
  const T = snap.trials || {}, L = snap.library || {}, cur = T.current;
  const exp = cur ? `<div class="rlog"><b>${esc(cur.name)}</b> is at the backtest machine now<div class="faint">${esc(cur.desc)}</div>${cur.tries.map(x => `<div class="${x.win ? 'up' : 'muted'}">• ${esc(x.what)} → ${esc(x.verdict)}</div>`).join('')}</div>` : '';
  const recent = Object.entries(T.people || {}).flatMap(([id, me]) => me.log.map(x => ({ ...x, id }))).sort((a, b) => b.t - a.t).slice(0, 8);
  const notes = (L.notes || []).slice().reverse().slice(0, 5);
  return `<h3 style="margin:12px 0 6px">Trial and error</h3><div style="display:flex;justify-content:space-between;align-items:center;gap:8px"><div class="muted" style="font-size:12px">PMs keep testing changes to their own strategy. A change only sticks if it's better on the training years AND holds up on the last ${T.holdout_years || 3} years they didn't tune on, then passes the full hiring bar. ${T.running ? '' : `Next round in ${Math.ceil((T.next_in || 0) / 60)} min.`}</div><button class="btn sm" id="tExp" ${T.running ? 'disabled' : ''}>Experiment now</button></div>
    ${exp}${recent.map(x => `<div class="rlog ${x.win ? 'pass' : ''}" style="padding:4px 10px"><b style="color:${COLORS[x.id] || '#fff'}">${esc(nameOf(x.id))}</b> ${esc(x.what)} <span class="${x.win ? 'up' : 'faint'}">→ ${esc(x.verdict)}</span> <span class="faint">${ago(x.t)}</span></div>`).join('') || '<div class="faint" style="font-size:12px">No experiments yet.</div>'}
    <h3 style="margin:14px 0 6px">Study Hall library</h3><div style="display:flex;justify-content:space-between;align-items:center;gap:8px"><div class="muted" style="font-size:12px">${L.reading ? `<b>${esc(L.reading.name)}</b> is reading <i>${esc(L.reading.title)}</i> right now.` : `Agents read real finance &amp; business material (papers, arXiv, essays) and bring back ideas to test. Next visit in ${Math.ceil((L.next_in || 0) / 60)} min.`}</div><button class="btn sm" id="tRead" ${L.reading ? 'disabled' : ''}>Send someone to read</button></div>
    ${notes.map(n => `<div class="rlog"><div style="display:flex;justify-content:space-between;gap:6px"><b><span style="color:${COLORS[n.aid] || '#fff'}">${esc(n.name)}</span> read: ${esc(n.topic)}</b><span class="faint">${ago(n.t)}</span></div>
      <div style="margin-top:3px">${esc(n.notes)}</div>${n.takeaways.length ? `<ul style="margin:4px 0 0 16px;padding:0">${n.takeaways.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
      ${n.experiment ? `<div class="up" style="margin-top:4px">Will test: ${esc(n.experiment)}</div>` : ''}
      <div class="faint" style="margin-top:4px">${n.sources.map(s => /^https?:\/\//.test(s.url) ? `<a href="${esc(s.url)}" target="_blank" rel="noopener" style="color:var(--accent)">${esc(s.title)}</a>` : esc(s.title)).join(' · ')}</div></div>`).join('') || '<div class="faint" style="font-size:12px">Nobody has visited the library yet.</div>'}`;
}
function renderTeam() {
  const M = snap.minds; if (!M) { $('team').innerHTML = '<div class="muted">Loading…</div>'; return; }
  const kit = Object.entries(M.blocks || {}).map(([b, v]) => `${b} ${v.passed}/${v.passed + v.failed}`).join(' · ');
  $('team').innerHTML = `<div style="display:flex;justify-content:space-between;align-items:center;gap:8px"><div class="muted" style="font-size:12px">Every agent remembers what happens to them, earns XP, gets promoted, experiments on their own strategy, reads in the Study Hall, and reflects every 8h: journal, lessons, goals, new strategy pitches and tool requests. ${M.reflecting ? '<b>Reflecting now…</b>' : `Next reflection in ${Math.ceil(M.next_reflect / 3600)}h.`}</div><button class="btn" id="tReflect" ${M.reflecting ? 'disabled' : ''}>Reflect now</button></div>
    ${M.firm_lessons.length ? `<h3 style="margin:12px 0 6px">What the firm has learned</h3>` + M.firm_lessons.slice().reverse().map(l => `<div class="rlog pass">${esc(l.text)} <span class="faint">${ago(l.t)}</span></div>`).join('') : ''}
    ${M.pitches.length ? `<h3 style="margin:12px 0 6px">Pitches waiting for the lab</h3>` + M.pitches.map(p => `<div class="rlog"><b>${esc(p.name)}</b> <span class="muted">by ${esc(nameOf(p.by))}</span><div>${esc(p.hypothesis)}</div><div class="faint">${(p.params.rules || []).map(r => r.block).join(' + ')} · ${p.params.direction}</div></div>`).join('') : ''}
    ${M.requests.length ? `<h3 style="margin:12px 0 6px">Tools they asked you for</h3>` + M.requests.slice().reverse().map(r => `<div class="rlog"><b>${esc(nameOf(r.by))}:</b> ${esc(r.what)}<div class="faint">${esc(r.why)}</div></div>`).join('') : ''}
    ${labSections()}
    <div class="faint" style="font-size:11.5px;margin:10px 0">Lego kit (${M.kit.length} blocks) — invented strategies so far: ${kit || 'none tested yet'}</div>
    ${M.people.slice().sort((a, b) => b.xp - a.xp).map(mindCard).join('')}`;
  $('tReflect').onclick = () => send({ type: 'reflect_now' });
  $('tExp').onclick = () => send({ type: 'experiment_now' });
  $('tRead').onclick = () => send({ type: 'read_now' });
}
function renderPods() {
  const el = $('pods');
  el.innerHTML = `<div class="muted" style="font-size:12px;margin-bottom:10px">The CIO allocates capital by earned trust, divided by how many teammates make the same bet (Dot's overlap report). A pod down ${(snap.settings.POD_DD_LIMIT * 100).toFixed(0)}% of its capital from its peak gets shut down by the CRO; the lab can retrain it and bring it back.</div>` + snap.roster.map(podCard).join('');
  wirePodButtons(el);
}
function wirePodButtons(el) {
  el.querySelectorAll('[data-bench]').forEach(b => b.onclick = () => { const p = snap.roster.find(x => x.id === b.dataset.bench); send({ type: 'bench', agent: p.id, on: p.status === 'active' }); });
  el.querySelectorAll('[data-fire]').forEach(b => b.onclick = () => send({ type: 'fire', agent: b.dataset.fire }));
  el.querySelectorAll('[data-focus]').forEach(b => b.onclick = () => { selected = b.dataset.focus; follow = true; setFollowBtn(); });
}
function gauge(label, v, max, txt, color = 'var(--accent)') { return `<div class="gauge"><div class="l"><span>${label}</span><span class="mono" style="color:var(--text)">${txt}</span></div><div class="bar"><i style="width:${Math.min(100, Math.abs(v) / max * 100)}%;background:${color}"></i></div></div>`; }
function riskBookHtml() {
  const R = snap.riskbook; if (!R) return '';
  const row = (name, v, cap, who) => { const r = Math.abs(v) / cap;
    return gauge(`${esc(name)}${who ? ` <span class="faint">· ${esc(who)}</span>` : ''}`, Math.abs(v), cap, `${(v * 100).toFixed(0)}% / ${(cap * 100).toFixed(0)}%`,
      r > 1.1 ? 'var(--red)' : r > 0.8 ? 'var(--amber)' : 'var(--green)'); };
  let h = `<h3 style="margin:14px 0 4px">Fund limits · Rex's risk book</h3><div class="faint" style="font-size:12px;margin-bottom:8px">All pods together. One market can be at most ${(R.sym_cap * 100).toFixed(0)}% of NAV, and a group of look-alike markets at most ${(R.grp_cap * 100).toFixed(0)}%. New trades only get the room that's left; anything more than 10% over gets trimmed from every pod in it, pro rata, during market hours.</div>`;
  if (!R.groups.length) return h + '<div class="muted" style="font-size:12.5px">Flat.</div>';
  h += `<div class="muted" style="font-size:12px;margin:4px 0">Market groups</div>` + R.groups.map(([g, v, syms]) => row(g, v, R.grp_cap, syms.join(', '))).join('');
  h += `<div class="muted" style="font-size:12px;margin:8px 0 4px">Single markets</div>` + R.syms.map(([s, v, pods]) => row(s, v, R.sym_cap, pods.join(', '))).join('');
  return h;
}
function overlapHtml() {
  const O = snap.overlap || {}, r = O.report;
  let h = `<h3 style="margin:16px 0 6px">Correlation &amp; overlap · Dot's report</h3>`;
  if (!r) return h + `<div class="muted" style="font-size:12.5px">${O.running ? 'Crunching…' : 'First report runs a minute after the lab finishes re-certifying.'}</div>`;
  if (r.n < 2) return h + `<div class="muted" style="font-size:12.5px">${esc(r.note || 'Need at least 2 daily PMs.')}</div>`;
  const nm = r.names, ids = r.ids, effPct = r.n_eff / r.n;
  const cell = (v, diag, kind) => { if (diag) return `<td class="mono faint" style="text-align:center">—</td>`;
    const a = Math.max(0, Math.min(1, kind === 'ov' ? v : v)), col = kind === 'ov' ? `rgba(245,158,11,${a * 0.75})` : v >= 0 ? `rgba(244,63,94,${a * 0.8})` : `rgba(34,197,94,${Math.min(1, -v) * 0.8})`;
    return `<td class="mono" style="text-align:center;background:${col}">${kind === 'ov' ? Math.round(v * 100) + '%' : v.toFixed(2)}</td>`; };
  const table = (M, kind) => `<table style="width:100%;font-size:11.5px;border-collapse:collapse;margin-top:4px"><tr><td></td>${ids.map(i => `<td class="t" style="text-align:center;color:${COLORS[i] || '#fff'}">${esc(nm[i])}</td>`).join('')}</tr>` +
    ids.map((i, a) => `<tr><td class="t" style="color:${COLORS[i] || '#fff'}">${esc(nm[i])}</td>${ids.map((j, b) => cell(M[a][b], a === b, kind)).join('')}</tr>`).join('') + '</table>';
  h += `<div class="stat-grid" style="grid-template-columns:1fr 1fr"><div><b>Daily PMs</b><span class="mono">${r.n}</span></div><div><b>Independent bets</b><span class="mono ${effPct < 0.6 ? 'down' : 'up'}">${r.n_eff.toFixed(1)}</span></div></div>
    ${gauge('Diversification', effPct, 1, Math.round(effPct * 100) + '%', effPct < 0.6 ? 'var(--red)' : 'var(--green)')}
    ${r.clusters.length ? r.clusters.map(g => `<div class="down" style="font-size:12.5px;margin-top:6px">Acts like ONE bet: ${g.map(i => esc(nm[i])).join(' + ')}</div>`).join('') : '<div class="up" style="font-size:12.5px;margin-top:6px">No clusters: the PMs make genuinely different bets.</div>'}
    <div class="muted" style="font-size:12px;margin-top:10px">Return correlation (weekly, mark-to-market, ${esc(r.since || '')} →). Red = move together.</div>${table(r.corr, 'c')}
    <div class="muted" style="font-size:12px;margin-top:10px">Same positions (share of the smaller book's position-days held identically).</div>${table(r.overlap, 'ov')}
    ${r.live.length ? `<div style="font-size:12.5px;margin-top:8px"><b>Doubled up right now:</b> ${r.live.map(x => `${esc(x.sym)} (${x.pods.map(p => esc(p.name) + (p.side > 0 ? ' long' : ' short')).join(', ')})`).join(' · ')}</div>` : ''}
    <div class="faint" style="font-size:11.5px;margin-top:6px">Updated ${new Date(r.t * 1000).toLocaleString()} · refreshes every 6h or when a strategy changes.</div>`;
  return h;
}
function renderRisk() {
  const s = snap, eq = s.equity, gk = s.greeks || {};
  const bl = s.broker_link || {}, ac = bl.account || {};
  let h = `<h3 style="margin:0 0 8px">Broker link · Alpaca ${bl.live ? '<span class="down">LIVE MONEY</span>' : 'paper'}</h3>`;
  if (!bl.configured) {
    h += `<div class="muted" style="font-size:12.5px;line-height:1.7">Not connected. Add your Alpaca paper keys to <span class="mono">ai-trading-floor/.env</span> and restart the floor. Until then every trade is simulated.</div>`;
  } else {
    const st = bl.killed ? `<span class="down">KILL SWITCH: ${bl.killed}</span>` : bl.error ? `<span class="down">${bl.error}</span>`
      : bl.enabled ? '<span class="up">connected · mirroring the fund</span>' : '<span class="muted">off</span>';
    const drift = Object.entries(bl.drift || {});
    h += `<div class="stat-grid" style="grid-template-columns:1fr 1fr"><div><b>Account equity</b><span class="mono">${ac.equity == null ? '—' : money(ac.equity)}</span></div>
        <div><b>Cash</b><span class="mono">${ac.cash == null ? '—' : money(ac.cash)}</span></div></div>
      <div style="font-size:12.5px;margin:6px 0">${st}</div>
      <table><thead><tr><th>Holding at broker</th><th>Qty</th></tr></thead><tbody>${Object.entries(bl.positions || {}).map(([k, q]) => `<tr><td>${k}</td><td class="mono">${(+q).toFixed(4).replace(/\.?0+$/, '')}</td></tr>`).join('') || '<tr><td colspan="2" class="t muted">Flat</td></tr>'}</tbody></table>
      ${drift.length ? `<div class="faint" style="font-size:12px;margin-top:6px">Waiting to sync: ${drift.map(([k, d]) => `${k} ${d > 0 ? '+' : ''}${(+d).toFixed(4).replace(/\.?0+$/, '')}`).join(', ')} (ETFs sync during market hours)</div>` : ''}
      <button class="btn" style="margin-top:8px" id="brokerToggle">${bl.enabled && !bl.killed ? 'Turn broker link OFF' : 'Turn broker link ON'}</button>`;
  }
  h += `<h3 style="margin:14px 0 8px">Exposure</h3>` + gauge('Gross exposure', s.gross / eq, 3, `${(s.gross / eq * 100).toFixed(0)}% of NAV`) +
    gauge('Net exposure', s.net / eq, 3, `${(s.net / eq * 100).toFixed(0)}% of NAV`, s.net >= 0 ? 'var(--green)' : 'var(--red)') +
    gauge('Open risk vs budget', s.open_risk, eq * s.settings.MAX_TOTAL_RISK, `${money(s.open_risk)} / ${money(eq * s.settings.MAX_TOTAL_RISK)}`, 'var(--amber)') +
    gauge('Max drawdown', s.maxdd, 0.2, `${(s.maxdd * 100).toFixed(2)}%`, 'var(--red)');
  h += `<div style="display:flex;gap:6px;margin:10px 0"><button class="btn sm" data-stress="1">&#9889; Stress-test the book</button><button class="btn sm" data-tear="1">Fund tear sheet</button></div>`;
  h += riskBookHtml();
  h += marginHtml(s);
  h += `<h3 style="margin:14px 0 8px">Options book (Opal)</h3><div class="stat-grid" style="grid-template-columns:1fr 1fr">
      <div><b>Delta</b><span class="mono ${cls(gk.delta || 0)}">${money(gk.delta || 0)}</span></div><div><b>Gamma / 1% move</b><span class="mono">${money(gk.gamma || 0)}</span></div>
      <div><b>Vega / vol pt</b><span class="mono ${cls(gk.vega || 0)}">${money(gk.vega || 0)}</span></div><div><b>Theta / day</b><span class="mono ${cls(gk.theta || 0)}">${money(gk.theta || 0)}</span></div></div>
    <table style="margin-top:10px"><thead><tr><th>Coin</th><th>Implied</th><th>Realized</th><th>IV/RV</th><th>Expiry</th></tr></thead><tbody>${
      Object.entries(s.optvol || {}).map(([c, v]) => `<tr><td>${c}</td><td>${v.iv == null ? '—' : (v.iv * 100).toFixed(0) + '%'}</td><td>${v.rv == null ? '—' : (v.rv * 100).toFixed(0) + '%'}</td><td class="${v.vrp >= 1.2 ? 'up' : v.vrp != null && v.vrp <= 0.9 ? 'down' : ''}">${v.vrp == null ? '—' : v.vrp.toFixed(2)}</td><td class="t muted">${v.dte == null ? '—' : v.dte.toFixed(1) + 'd'}</td></tr>`).join('') || '<tr><td colspan="5" class="t muted">Waiting for the Deribit chain…</td></tr>'}</tbody></table>
    <div class="faint" style="font-size:12px;margin-top:6px">IV/RV ≥ 1.20 → sell an iron condor · ≤ 0.90 with momentum → buy a call/put. Real Deribit bid/ask fills, defined risk.</div>`;
  h += `<h3 style="margin:14px 0 8px">Net by asset class</h3>` + (Object.entries(s.by_cls).map(([c, v]) => gauge(c, v / eq, 1, money(v), v >= 0 ? 'var(--green)' : 'var(--red)')).join('') || '<div class="muted">Flat.</div>');
  h += `<h3 style="margin:14px 0 8px">Volatility regimes</h3>` + (Object.entries(s.vic).map(([sym, r]) => `<span class="pill" style="margin:0 4px 6px 0;display:inline-block;color:${r === 'storm' ? 'var(--red)' : r === 'calm' ? 'var(--accent2)' : 'var(--muted)'}">${sym} · ${r}</span>`).join('') || '<span class="muted">Waiting for bars.</span>');
  h += gexSection(s.gex);
  h += `<h3 style="margin:14px 0 8px">Policy</h3><div class="muted" style="font-size:12.5px;line-height:1.8">Risk per trade: set per pod by the CIO (Quant toolbox), ${Math.round(s.settings.RISK_APPETITE * 100)}% of Kelly, max <b style="color:var(--text)">${(s.settings.MAX_POD_RISK * 100).toFixed(1)}%</b>; unproven pods start at <b style="color:var(--text)">${(s.settings.RISK_PER_TRADE * 100).toFixed(2)}%</b><br>Fund risk cap: <b style="color:var(--text)">${(s.settings.MAX_TOTAL_RISK * 100).toFixed(1)}%</b> of NAV<br>Pod drawdown limit: <b style="color:var(--text)">${(s.settings.POD_DD_LIMIT * 100).toFixed(0)}%</b> · Max positions: <b style="color:var(--text)">${s.settings.MAX_POSITIONS}</b><br>Fund limit per market: <b style="color:var(--text)">${(s.settings.MAX_SYM_NOTIONAL * 100).toFixed(0)}%</b> of NAV · per market group: <b style="color:var(--text)">${(s.settings.MAX_GROUP_NOTIONAL * 100).toFixed(0)}%</b><br>Volatility (ann.): <b style="color:var(--text)">${s.vol == null ? 'needs 24h of data' : (s.vol * 100).toFixed(1) + '%'}</b></div>
    <button class="btn" style="margin-top:10px" id="openPolicy">Edit policy at the CIO desk</button>`;
  h += overlapHtml();
  $('riskp').innerHTML = h; $('openPolicy').onclick = openSettings; wireGexHover();
  if ($('brokerToggle')) $('brokerToggle').onclick = () => send({ type: 'broker', on: !(bl.enabled && !bl.killed) });
}
// ── Vic's GEX desk: dealer gamma by strike (mirrored bars: calls above the line, puts below) ──
const GEX_CALL = '#3987e5', GEX_PUT = '#e66767';
const bigMoney = v => { const a = Math.abs(v); return (v < 0 ? '-' : '+') + '$' + (a >= 1e9 ? (a / 1e9).toFixed(2) + 'B' : a >= 1e6 ? (a / 1e6).toFixed(1) + 'M' : (a / 1e3).toFixed(0) + 'K'); };
function gexChart(x) {
  const P = x.profile || []; if (P.length < 3) return '<div class="faint">Not enough open interest near spot.</div>';
  const W = 340, H = 150, padL = 4, padR = 4, mid = 70, half = 60;
  const max = Math.max(1, ...P.map(p => Math.max(p[1], -p[2])));
  const k0 = P[0][0], k1 = P[P.length - 1][0], X = k => padL + (k - k0) / (k1 - k0 || 1) * (W - padL - padR);
  const bw = Math.max(2, (W - padL - padR) / P.length - 2);                // 2px gap between bars
  const bars = P.map(([k, c, p], i) => `<g class="gx" data-i="${i}"><rect x="${X(k) - bw / 2 - 1}" y="0" width="${bw + 2}" height="${H}" fill="transparent"/>
    ${c > 0 ? `<rect x="${X(k) - bw / 2}" y="${mid - c / max * half}" width="${bw}" height="${c / max * half}" rx="1.5" fill="${GEX_CALL}"/>` : ''}
    ${p < 0 ? `<rect x="${X(k) - bw / 2}" y="${mid}" width="${bw}" height="${-p / max * half}" rx="1.5" fill="${GEX_PUT}"/>` : ''}</g>`).join('');
  const vline = (v, dash, label, ty) => v >= k0 && v <= k1 ? `<line x1="${X(v)}" x2="${X(v)}" y1="4" y2="${H - 4}" stroke="var(--muted)" stroke-width="1" ${dash ? 'stroke-dasharray="3 3"' : ''}/><text x="${X(v) + 3}" y="${ty}" fill="var(--muted)" font-size="10">${label}</text>` : '';
  return `<svg viewBox="0 0 ${W} ${H + 14}" width="100%" role="img" aria-label="${esc(x.sym)} dealer gamma by strike" data-sym="${esc(x.sym)}" class="gexsvg">
    <line x1="0" x2="${W}" y1="${mid}" y2="${mid}" stroke="var(--border2)" stroke-width="1"/>${bars}${vline(x.spot, false, 'spot', 12)}${x.flip ? vline(x.flip, true, 'flip', 24) : ''}
    <text x="0" y="${H + 12}" fill="var(--faint)" font-size="10">${fmtPx(k0)}</text><text x="${W}" y="${H + 12}" fill="var(--faint)" font-size="10" text-anchor="end">${fmtPx(k1)}</text></svg>`;
}
function gexSection(G) {
  if (!G) return '';
  const S = Object.values(G.syms || {}), T = G.test || {};
  let h = `<h3 style="margin:14px 0 4px">Dealer gamma (GEX) · Vic</h3><div class="faint" style="font-size:12px;margin-bottom:8px">Positive = dealers dampen moves (calmer tape). Negative = dealers amplify moves. Estimated from real option open interest (BTC/ETH live from Deribit, SPY/QQQ from CBOE). <b>Not used for trading</b> until the forward test passes.</div>
    <div style="display:flex;gap:12px;font-size:11.5px;margin-bottom:8px" class="muted"><span><i style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${GEX_CALL};vertical-align:-1px"></i> call gamma (dealers long)</span><span><i style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${GEX_PUT};vertical-align:-1px"></i> put gamma (dealers short)</span></div>`;
  h += S.map(x => `<div class="pod"><div class="row1"><span class="nm">${esc(x.sym)} <span class="mono faint">${fmtPx(x.spot)}</span></span><span class="tag ${x.regime === 'positive' ? 'active' : 'stopped'}">${x.regime === 'positive' ? '▲ positive gamma' : '▼ negative gamma'}</span></div>
      <div class="stat-grid"><div><b>GEX / 1% move</b><span class="mono">${bigMoney(x.gex)}</span></div><div><b>Gamma flip</b><span class="mono">${x.flip ? fmtPx(x.flip) : '—'}</span></div><div><b>Walls (put / call)</b><span class="mono">${x.put_wall ? fmtPx(x.put_wall) : '—'} / ${x.call_wall ? fmtPx(x.call_wall) : '—'}</span></div></div>
      <div style="margin-top:8px">${gexChart(x)}</div><div class="faint mono" style="font-size:10.5px">${x.legs} options · updated ${new Date(x.t * 1000).toLocaleTimeString()}</div></div>`).join('') || '<div class="muted">Vic is loading the option chains…</div>';
  h += `<div class="rlog ${T.verdict === 'SUPPORTED' ? 'pass' : T.verdict === 'NOT SUPPORTED' ? 'fail' : ''}"><b>Forward test:</b> do negative-gamma days move ≥1.3× more than positive-gamma days? <b>${esc(T.verdict || '')}</b>
    ${T.move_pos != null || T.move_neg != null ? `<br><span class="faint">Avg next-day move: positive ${T.move_pos == null ? '—' : (T.move_pos * 100).toFixed(2) + '%'} (n=${T.n_pos}) · negative ${T.move_neg == null ? '—' : (T.move_neg * 100).toFixed(2) + '%'} (n=${T.n_neg})</span>` : ''}
    <br><span class="faint">${T.pending || 0} observations waiting for their 24h result. One per market per day, no overlap.</span></div>`;
  if (G.error) h += `<div class="faint" style="font-size:11px">${esc(G.error)}</div>`;
  return h;
}
function wireGexHover() {
  const old = $('gexTip'); if (old) old.style.display = 'none';      // the pane re-renders every snapshot
  document.querySelectorAll('.gexsvg').forEach(svg => {
    const x = snap?.gex?.syms?.[svg.dataset.sym]; if (!x) return;
    svg.querySelectorAll('.gx').forEach(gEl => {
      const [k, c, p] = x.profile[+gEl.dataset.i];
      gEl.onmousemove = ev => { const tip = $('gexTip') || Object.assign(document.body.appendChild(document.createElement('div')), { id: 'gexTip' });
        Object.assign(tip.style, { position: 'fixed', zIndex: 30, pointerEvents: 'none', background: '#0b1020', border: '1px solid var(--border2)', borderRadius: '8px', padding: '6px 8px', fontSize: '12px', color: 'var(--text)', display: 'block', left: ev.clientX + 12 + 'px', top: ev.clientY + 12 + 'px' });
        tip.innerHTML = `<b>${esc(x.sym)} ${fmtPx(k)}</b><br><span style="color:var(--muted)">call gamma</span> ${bigMoney(c)}<br><span style="color:var(--muted)">put gamma</span> ${bigMoney(p)}`; };
      gEl.onmouseleave = () => { const t = $('gexTip'); if (t) t.style.display = 'none'; };
    });
  });
}
// ── Quant toolbox: Monte Carlo risk lab, robustness, crisis tests, factor X-ray (firm/toolbox.py) ──
const sgn = (v, d = 0) => (v >= 0 ? '+' : '−') + Math.abs(v * 100).toFixed(d) + '%';
const kellyTxt = k => k >= 0.2 ? '≥20%' : (k * 100).toFixed(k < 0.01 ? 2 : 1) + '%';
function mcChart(aid, d) {
  const C = d.curve || []; if (C.length < 3) return '';
  const W = 340, H = 128, L = 34, R = 10, T = 10, B = 20, lx = Math.log, x0 = lx(C[0][0]), x1 = lx(C[C.length - 1][0]);
  const X = v => L + (lx(v) - x0) / (x1 - x0) * (W - L - R), Y = p => T + (1 - p) * (H - T - B);
  const tol = 0.2 * (snap.settings.RISK_APPETITE ?? 0.5);
  const grid = [0, 0.5, 1].map(p => `<line x1="${L}" x2="${W - R}" y1="${Y(p)}" y2="${Y(p)}" stroke="var(--border)" stroke-width="1"/><text x="${L - 6}" y="${Y(p) + 3.5}" fill="var(--faint)" font-size="10" text-anchor="end">${p * 100}%</text>`).join('');
  const xt = [0.0025, 0.01, 0.05, 0.2].map(v => `<text x="${X(v)}" y="${H - 5}" fill="var(--faint)" font-size="10" text-anchor="middle">${v * 100}%</text>`).join('');
  const line = C.map((c, i) => `${i ? 'L' : 'M'}${X(c[0]).toFixed(1)},${Y(c[1]).toFixed(1)}`).join('');
  const hits = C.map((c, i) => { const a = i ? (X(C[i - 1][0]) + X(c[0])) / 2 : L, b = i < C.length - 1 ? (X(c[0]) + X(C[i + 1][0])) / 2 : W - R;
    return `<rect class="mcx" data-i="${i}" x="${a}" y="${T}" width="${b - a}" height="${H - T - B}" fill="transparent"/>`; }).join('');
  const px = X(Math.max(C[0][0], Math.min(C[C.length - 1][0], d.risk))), py = Y(d.p_ruin);
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Chance of a pod stop-out by risk per trade" class="mcsvg" data-aid="${esc(aid)}">${grid}${xt}
    <line x1="${L}" x2="${W - R}" y1="${Y(tol)}" y2="${Y(tol)}" stroke="var(--muted)" stroke-width="1" stroke-dasharray="4 3"/>
    <text x="${W - R}" y="${Y(tol) - 4}" fill="var(--muted)" font-size="10" text-anchor="end">CIO limit ${Math.round(tol * 100)}%</text>
    <path d="${line}" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
    <line x1="${px}" x2="${px}" y1="${T}" y2="${H - B}" stroke="var(--text)" stroke-width="1" stroke-dasharray="2 3" opacity="0.6"/>
    <circle cx="${px}" cy="${py}" r="5" fill="var(--accent)" stroke="var(--card)" stroke-width="2"/>
    <text x="${px + 7}" y="${Math.max(T + 10, py - 7)}" fill="var(--text)" font-size="10.5" font-weight="600">CIO ${(d.risk * 100).toFixed(1)}%</text>${hits}</svg>`;
}
const mcOpen = new Set();          // toolbox cards stay open across re-renders
function wireMcHover() {
  const old = $('mcTip'); if (old) old.style.display = 'none';
  document.querySelectorAll('details[data-mc]').forEach(el => el.ontoggle = () => el.open ? mcOpen.add(el.dataset.mc) : mcOpen.delete(el.dataset.mc));
  document.querySelectorAll('.mcsvg').forEach(svg => {
    const d = snap?.toolbox?.dials?.[svg.dataset.aid]; if (!d) return;
    svg.querySelectorAll('.mcx').forEach(r => {
      const [risk, ruin, med, p5] = d.curve[+r.dataset.i];
      r.onmousemove = ev => { const tip = $('mcTip') || Object.assign(document.body.appendChild(document.createElement('div')), { id: 'mcTip' });
        Object.assign(tip.style, { position: 'fixed', zIndex: 30, pointerEvents: 'none', background: '#0b1020', border: '1px solid var(--border2)', borderRadius: '8px', padding: '6px 8px', fontSize: '12px', color: 'var(--text)', display: 'block', left: ev.clientX + 12 + 'px', top: ev.clientY + 12 + 'px' });
        tip.innerHTML = `<b>${(risk * 100).toFixed(2).replace(/\.?0+$/, '')}% risk per trade</b><br><span style="color:var(--muted)">stop-out within a year</span> ${(ruin * 100).toFixed(1)}%<br><span style="color:var(--muted)">median year</span> ${sgn(med)}<br><span style="color:var(--muted)">bad year (1 in 20)</span> ${sgn(p5)}`; };
      r.onmouseleave = () => { const t = $('mcTip'); if (t) t.style.display = 'none'; };
    });
  });
}
function toolboxHtml() {
  const TB = snap.toolbox || {}, D = TB.dials || {}, P = TB.pods || {};
  let h = `<h3 style="margin:4px 0 4px">Quant toolbox</h3><div class="faint" style="font-size:12px;margin-bottom:8px">Six research tools on 10+ years of data, rerun every ${TB.every_h || 6}h or when a strategy or risk slider changes. The CIO sets each pod's risk per trade from them: a share of Kelly from the <b>Monte Carlo</b> (never past the stop-out limit), less if the edge is <b>fragile</b>, capped so the worst real <b>crisis</b> fits inside the pod's drawdown stop. Backtest edges are cut ${Math.round((TB.haircut ?? 0.5) * 100)}%; live trades take over as they pile up.${TB.running ? ' <b>Running now…</b>' : ''}</div>`;
  const ids = Object.keys(D).sort((a, b) => D[b].risk - D[a].risk);
  h += firmOverfitHtml();
  if (!ids.length) return h + `<div class="muted" style="font-size:12.5px;margin-bottom:12px">${TB.running ? 'Crunching thousands of simulated years…' : 'First run starts after the lab re-certifies the PMs.'}</div>`;
  h += ids.map(aid => { const d = D[aid], p = P[aid] || {}, rb = p.robust || {}, fx = p.factors, st = p.stress || [], dd = snap.settings.POD_DD_LIMIT;
    const rbc = rb.score >= 0.75 ? 'var(--green)' : rb.score >= 0.5 ? 'var(--amber)' : 'var(--red)';
    return `<details class="pod" style="margin-bottom:8px" data-mc="${esc(aid)}" ${mcOpen.has(aid) ? 'open' : ''}><summary style="cursor:pointer;list-style:none"><div class="row1"><span class="nm" style="color:${COLORS[aid] || '#fff'}">${esc(p.name || aid)}</span><span class="mono">${(d.risk * 100).toFixed(1)}% / trade</span></div>
        <div class="muted" style="font-size:12px;margin-top:2px">stop-out odds ${(d.p_ruin * 100).toFixed(0)}%/yr · median year ${sgn(d.ret_med)} · robust ${Math.round((rb.score ?? 0) * 100)}% · tap for the evidence</div></summary>
      <div style="font-size:12.5px;margin:8px 0 4px"><b>Why ${(d.risk * 100).toFixed(1)}%:</b> ${d.why.map(esc).join(' · ')}. Kelly ${kellyTxt(d.kelly)}.</div>
      <div class="faint" style="font-size:11.5px">Evidence: ${d.n_bt} backtest trades over ${p.years}y (PF ${p.pf}), average ${d.edge.toFixed(2)}R per trade after the haircut${d.n_live ? ` + ${d.n_live} live trades` : ', no live trades yet'} · ~${d.per_year} trades a year.</div>
      <div class="muted" style="font-size:12px;margin-top:10px"><b style="color:var(--text)">1 · Monte Carlo:</b> chance the pod hits its ${Math.round(dd * 100)}% drawdown stop within a year, by risk per trade (3,000 reshuffled years, losing streaks kept together)</div>
      ${mcChart(aid, d)}
      <div class="stat-grid"><div><b>Median year</b><span class="mono">${sgn(d.ret_med)}</span></div><div><b>Bad year (1 in 20)</b><span class="mono">${sgn(d.ret_p5)}</span></div><div><b>Typical worst DD</b><span class="mono">${sgn(d.dd_med)}</span></div></div>
      <div class="muted" style="font-size:12px;margin-top:10px"><b style="color:var(--text)">2 · Robustness:</b> every setting nudged ±15% and ±30%. A real edge still works next door; a curve-fit one doesn't.</div>
      ${gauge(`${rb.ok ?? 0} of ${rb.n ?? 0} nearby versions still profitable (PF ≥ 1.1)`, rb.score ?? 0, 1, Math.round((rb.score ?? 0) * 100) + '%', rbc)}
      ${rb.worst ? `<div class="faint" style="font-size:11.5px">Most sensitive: ${esc(rb.worst[0])} (PF ${rb.worst[1]} vs ${(+rb.base_pf).toFixed(2)})</div>` : ''}
      <div class="muted" style="font-size:12px;margin-top:10px"><b style="color:var(--text)">3 · Crisis test</b> at ${(d.risk * 100).toFixed(1)}% risk: trades closed during real crashes</div>
      <table style="font-size:12px;margin-top:4px"><tbody>${st.map(([n, v, k]) => `<tr><td class="t">${esc(n)}</td><td class="mono faint">${k} trade${k === 1 ? '' : 's'}</td><td class="mono ${cls(v)}">${sgn(v, 1)}</td></tr>`).join('') || '<tr><td class="t muted">No trades during the crisis windows.</td></tr>'}</tbody></table>
      <div class="muted" style="font-size:12px;margin-top:10px"><b style="color:var(--text)">4 · Factor X-ray:</b> how much of the weekly P&amp;L is just market exposure</div>
      ${fx ? `<div style="font-size:12.5px;margin-top:4px">${Object.entries(fx.betas).map(([s, b]) => `<span class="pill" style="margin:0 4px 4px 0;display:inline-block">${esc(s)} β <span class="mono">${b >= 0 ? '+' : ''}${b.toFixed(2)}</span></span>`).join('')}</div>
        <div class="faint" style="font-size:11.5px">Markets explain ${Math.round(fx.r2 * 100)}% of its moves; the rest is the strategy. Alpha t-stat <span class="mono">${fx.alpha_t.toFixed(1)}</span> ${fx.alpha_t >= 2 ? '(real skill signal)' : '(not proven yet: below 2)'} · ${fx.weeks} weeks.</div>` : '<div class="faint" style="font-size:11.5px">Not enough history.</div>'}
      ${overfitHtml(p)}
    </details>`; }).join('');
  return h;
}
// ── (spliced in after toolboxHtml) tools 5-6, backtest curve, incubator, margin, ops ──
function sparkCurve(curve, w = 340, h = 70) {        // the pod's backtest equity (one series, no legend needed)
  if (!curve || curve.length < 3) return '';
  const v = curve.map(c => c[1]), lo = Math.min(...v, 1), hi = Math.max(...v, 1), X = i => 4 + i / (v.length - 1) * (w - 8), Y = y => 6 + (1 - (y - lo) / (hi - lo || 1)) * (h - 18);
  const d = v.map((y, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(y).toFixed(1)}`).join('');
  const y0 = new Date(curve[0][0] * 1000).getFullYear(), y1 = new Date(curve.at(-1)[0] * 1000).getFullYear();
  return `<svg viewBox="0 0 ${w} ${h}" width="100%" role="img" aria-label="Backtest equity curve">
    <line x1="4" x2="${w - 4}" y1="${Y(1)}" y2="${Y(1)}" stroke="var(--border2)" stroke-dasharray="3 3"/>
    <path d="${d}" fill="none" stroke="var(--accent2)" stroke-width="2" stroke-linejoin="round"/>
    <text x="4" y="${h - 2}" fill="var(--faint)" font-size="10">${y0}</text><text x="${w - 4}" y="${h - 2}" fill="var(--faint)" font-size="10" text-anchor="end">${y1} · ${((v.at(-1) - 1) * 100).toFixed(0)}%</text></svg>`;
}
function overfitHtml(p) {
  const ds = p.dsr, sy = p.synth;
  let h = `<div class="muted" style="font-size:12px;margin-top:10px"><b style="color:var(--text)">5 · Overfitting check:</b> is the Sharpe real after all the ideas the lab tried?</div>`;
  h += ds ? gauge(`Deflated Sharpe: Sharpe ${ds.sr_ann.toFixed(2)} vs ${ds.sr0_ann.toFixed(2)} expected from luck (~${ds.n_trials} independent ideas)`, ds.dsr, 1, Math.round(ds.dsr * 100) + '% real',
    ds.dsr >= 0.9 ? 'var(--green)' : ds.dsr >= 0.5 ? 'var(--amber)' : 'var(--red)') : '<div class="faint" style="font-size:11.5px">Needs 24+ months of history.</div>';
  h += `<div class="muted" style="font-size:12px;margin-top:10px"><b style="color:var(--text)">6 · Alternate histories:</b> the same strategy on ${sy ? sy.k : 16} made-up decades (real data, reshuffled in 3-month blocks)</div>`;
  h += sy ? gauge(`Profitable in ${Math.round(sy.profitable * sy.k)} of ${sy.k} worlds · median PF ${sy.pf_med} · bad-luck PF ${sy.pf_p10}`, sy.profitable, 1, Math.round(sy.profitable * 100) + '%',
    sy.profitable >= 0.8 ? 'var(--green)' : sy.profitable >= 0.5 ? 'var(--amber)' : 'var(--red)') : '<div class="faint" style="font-size:11.5px">Runs once a day.</div>';
  if (p.curve) h += `<div class="muted" style="font-size:12px;margin-top:10px"><b style="color:var(--text)">Backtest equity</b> (10+ years, 0.5% of the fund at risk per trade)</div>${sparkCurve(p.curve)}`;
  return h;
}
function firmOverfitHtml() {
  const F = snap.toolbox?.firm || {};
  if (F.pbo == null) return '';
  const c = F.pbo <= 0.25 ? 'var(--green)' : F.pbo <= 0.5 ? 'var(--amber)' : 'var(--red)';
  return `<div class="pod" style="margin-bottom:10px"><div class="row1"><span class="nm">The lab's selection process</span><span class="mono" style="color:${c}">PBO ${Math.round(F.pbo * 100)}%</span></div>
    <div class="faint" style="font-size:11.5px;margin-top:4px">Probability of backtest overfitting over ${F.n_cols} ideas tested (${F.splits} train/test splits of ${F.months || '?'} months).
    ${F.pbo <= 0.25 ? 'Low: when the lab picks the best idea in-sample, it usually stays above median out of sample.' : F.pbo <= 0.5 ? 'Middling: some of what the lab picks is luck.' : 'High: the lab is mostly picking luck. Every pod gets less risk until this improves.'}
    The ${F.n_cols} ideas behave like ~${F.n_eff ?? '?'} independent bets.</div></div>`;
}
function incubatorHtml() {
  const I = snap.incubator; if (!I) return '';
  const R = I.rules || {}, items = (I.items || []).slice().reverse();
  const tag = s => s === 'graduated' ? 'active' : s === 'dropped' ? 'stopped' : 'paused';
  return `<h3 style="margin:16px 0 4px">Incubator · shadow book</h3><div class="faint" style="font-size:12px;margin-bottom:8px">Strategies that passed the lab while every desk was full. They paper-trade with no capital; only trades opened after they were admitted count. Graduate at ${R.grad_trades}+ forward trades with PF ${R.grad_pf}+ (then they take a free desk or replace the weakest hire). Dropped below PF ${R.drop_pf}. Juno runs it, in the greenhouse tower east of Careers.</div>` +
    (items.map(x => { const f = x.fwd || {}, prog = Math.min(1, (f.n || 0) / (R.grad_trades || 8));
      return `<div class="pod"><div class="row1"><span class="nm">${esc(x.name)}</span><span class="tag ${tag(x.status)}">${esc(x.status)}</span></div>
        <div class="muted" style="font-size:11.5px;margin-top:2px">${esc(x.desc || x.family)} · ${x.markets.length} markets · by ${esc(nameOf(x.by))} · backtest PF ${(+x.bt_pf).toFixed(2)} · ${x.days}d in</div>
        <div class="stat-grid"><div><b>Forward trades</b><span class="mono">${f.n || 0}</span></div><div><b>Forward PF</b><span class="mono ${f.n ? (f.pf >= (R.grad_pf || 1.3) ? 'up' : f.pf < 1 ? 'down' : '') : ''}">${f.n ? (+f.pf).toFixed(2) : '—'}</span></div><div><b>Forward P&amp;L</b><span class="mono ${cls(f.ret || 0)}">${f.n ? sgn(f.ret, 1) : '—'}</span></div></div>
        ${x.status === 'incubating' ? `<div class="bar"><i style="width:${prog * 100}%"></i></div><div class="faint" style="font-size:11px">${f.n || 0}/${R.grad_trades} trades toward graduation${f.last ? ' · last closed ' + esc(f.last) : ''}</div>` : `<div class="faint" style="font-size:11.5px;margin-top:4px">${esc(x.why || '')}</div>`}</div>`; }).join('')
      || '<div class="muted" style="font-size:12.5px">Empty. Passing strategies land here when every desk is taken.</div>');
}
function marginHtml(s) {
  const M = s.margin; if (!M) return '';
  const lev = s.equity ? M.long_notional / s.equity : 0;
  return `<h3 style="margin:14px 0 8px">Margin</h3>` + gauge(`Long holdings vs the ${M.max_gross.toFixed(2)}x limit`, lev, M.max_gross, `${lev.toFixed(2)}x of NAV`, lev > 1 ? 'var(--amber)' : 'var(--accent)') +
    `<div class="stat-grid" style="grid-template-columns:1fr 1fr 1fr"><div><b>Borrowed</b><span class="mono">${money(M.borrowed)}</span></div><div><b>Interest paid</b><span class="mono">${money(M.interest_paid)}</span></div><div><b>Rate</b><span class="mono">${(M.rate * 100).toFixed(1)}%/yr</span></div></div>
    <div class="faint" style="font-size:11.5px;margin-top:4px">${M.max_gross > 1 ? 'Margin is ON: pods can hold up to ' + M.max_gross.toFixed(2) + 'x the fund in stocks, ETFs and crypto; borrowed cash pays interest daily.' : 'Cash only (1.0x). Raise "Max gross exposure" at the CIO desk to allow margin (up to 2x).'} The per-market and per-group limits still apply.</div>`;
}
const fmtAge = s => s == null ? '—' : s < 90 ? s + 's' : s < 5400 ? Math.round(s / 60) + 'm' : (s / 3600).toFixed(1) + 'h';
function openOps() {
  modal('ops', 'Ops Center · is the city healthy?', '<div id="opsBody"></div>'); renderOps();
}
function renderOps() {
  const el = $('opsBody'); if (!el || !snap) return;
  const O = snap.ops || {}, bl = snap.broker_link || {}, ac = bl.account || {};
  const up = O.uptime || 0, upTxt = up > 86400 ? (up / 86400).toFixed(1) + ' days' : up > 3600 ? (up / 3600).toFixed(1) + ' h' : Math.round(up / 60) + ' min';
  const feeds = Object.entries(O.feeds || {});
  el.innerHTML = `<div class="stat-grid" style="grid-template-columns:repeat(4,1fr)"><div><b>Uptime</b><span class="mono">${upTxt}</span></div><div><b>Loop</b><span class="mono">${O.loop_avg == null ? '—' : O.loop_avg + 's avg'}</span></div>
      <div><b>Memory</b><span class="mono">${O.rss_mb == null ? '—' : O.rss_mb + ' MB'}</span></div><div><b>Load</b><span class="mono">${O.load ? O.load[0] + ' / ' + O.cpus + ' cpu' : '—'}</span></div></div>
    <div class="faint" style="font-size:12px;margin-top:4px">Host ${esc(O.host || '?')} · disk ${O.disk ? O.disk.free_gb + ' GB free' : '—'} · slowest loop ${O.loop_max ?? '—'}s</div>
    <h3 style="margin:14px 0 6px">Data feeds</h3><table><tbody>${feeds.map(([k, a]) => `<tr><td class="t">${a < ((O.stale_after || {})[k] || 900) ? '<span class="up">●</span>' : '<span class="down">●</span>'} ${esc(k)}</td><td class="mono">${fmtAge(a)} ago</td></tr>`).join('') || '<tr><td class="t muted">Waiting for the first loop…</td></tr>'}</tbody></table>
    <h3 style="margin:14px 0 6px">Broker (Alpaca ${bl.live ? '<span class="down">LIVE</span>' : 'paper'})</h3>
    <div class="muted" style="font-size:12.5px">${!bl.configured ? 'Not connected.' : bl.killed ? '<span class="down">Kill switch: ' + esc(bl.killed) + '</span>' : bl.error ? '<span class="down">' + esc(bl.error) + '</span>' : bl.enabled ? '<span class="up">Connected, mirroring the fund.</span>' : 'Off.'} ${ac.equity != null ? 'Equity ' + money(ac.equity) + ' · cash ' + money(ac.cash) : ''}</div>
    <h3 style="margin:14px 0 6px">Recent errors</h3>${(O.errors || []).slice().reverse().map(e => `<div class="rlog fail"><span class="faint mono">${new Date(e.t * 1000).toLocaleTimeString()}</span> ${esc(e.text)}</div>`).join('') || '<div class="up" style="font-size:12.5px">None since the last restart.</div>'}`;
}
// ── Jason's desk: trade alongside the AI PMs (paper). Rex sizes it under the fund's limits; Eddie fills and manages it ──
const myT = { sym: 'SPY', dir: 1, risk: 0.005, stop: 2, hold: 20, trail: true };
function openMyDesk() {
  const M = snap?.mydesk; if (!M) return;
  if (!M.markets.some(m => m.sym === myT.sym)) myT.sym = M.markets[0]?.sym || 'SPY';
  const CLS = { etf: 'ETFs', stock: 'Stocks', futures: 'Micro futures', crypto: 'Crypto' };
  const groups = [...new Set(M.markets.map(m => m.cls))];
  modal('mydesk', 'Your desk · trade alongside the AI PMs (paper)', `<div id="myStats"></div>
    <div class="pod" style="margin:12px 0;border-top:3px solid #facc15;padding:12px 14px">
      <h3 style="margin:0 0 8px">Trade ticket</h3>
      <div style="display:flex;align-items:center;gap:6px"><span class="muted" style="width:92px;font-size:12.5px">Market</span><select id="mySym" aria-label="Market" style="flex:1;max-width:260px;background:var(--bg2);color:var(--text);border:1px solid var(--border2);border-radius:8px;padding:6px">
        ${groups.map(gk => `<optgroup label="${esc(CLS[gk] || gk)}">${M.markets.filter(m => m.cls === gk).map(m => `<option value="${m.sym}" ${m.sym === myT.sym ? 'selected' : ''}>${m.sym}${m.open ? '' : ' (closed)'}</option>`).join('')}</optgroup>`).join('')}
      </select></div>
      <div id="myBtns"></div>
      <input id="myWhy" maxlength="160" autocomplete="off" placeholder="Your thesis in one line: why this trade, why now?" aria-label="Thesis"
        style="width:100%;box-sizing:border-box;margin-top:8px;background:var(--bg2);color:var(--text);border:1px solid var(--border2);border-radius:8px;padding:8px">
      <div id="myPrev" class="muted" style="font-size:12.5px;margin:8px 0"></div>
      <button class="btn on" id="mySend">Send to Rex</button> <span id="mySent" class="faint" style="font-size:12px"></span>
    </div>
    <div id="myLive"></div>
    <div class="faint" style="font-size:11.5px;margin-top:10px">Paper trading with the fund's capital and costs. Rex sizes it from your risk and stop, inside the same limits every PM has (fund risk budget, buying power, per-market and per-group caps, max positions), so he may cut it. Eddie runs the stop, the trailing stop and the time stop. Your trades never train the AI.</div>`);
  $('mySym').onchange = e => { myT.sym = e.target.value; myPreview(); };
  $('mySend').onclick = () => {
    send({ type: 'my_order', sym: myT.sym, dir: myT.dir, risk: myT.risk, stop: myT.stop, hold: myT.hold, trail: myT.trail, why: $('myWhy').value });
    $('mySent').textContent = 'Sent. Watch the feed: the CIO, Rex and Eddie take it from here.'; $('myWhy').value = '';
    if (agents.rex) act('rex', say('On it. Sizing your trade, Jason.', 2200));
  };
  myBtns(); renderMyDesk();
}
function myBtns() {
  const el = $('myBtns'), L = snap?.mydesk?.limits; if (!el || !L) return;
  const row = (label, key, opts, fmt) => `<div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin:7px 0"><span class="muted" style="width:92px;font-size:12.5px">${label}</span>${opts.map(v => `<button class="btn sm ${myT[key] === v ? 'on' : ''}" data-my="${key}|${v}">${fmt(v)}</button>`).join('')}</div>`;
  el.innerHTML = row('Direction', 'dir', [1, -1], v => v > 0 ? '▲ Long' : '▼ Short')
    + row('Risk', 'risk', L.risks, v => (v * 100).toFixed(2).replace(/0$/, '') + '% of NAV')
    + row('Stop', 'stop', L.stops, v => v + ' ATR')
    + row('Hold up to', 'hold', L.holds, v => v + ' days')
    + row('Trailing', 'trail', [true, false], v => v ? 'Trail the stop' : 'Fixed stop');
  el.querySelectorAll('[data-my]').forEach(b => b.onclick = () => { const [k, v] = b.dataset.my.split('|'); myT[k] = k === 'trail' ? v === 'true' : +v; myBtns(); myPreview(); });
  myPreview();
}
function myPreview() {
  const el = $('myPrev'), M = snap?.mydesk; if (!el || !M) return;
  const m = M.markets.find(x => x.sym === myT.sym); if (!m) { el.textContent = ''; return; }
  if (!m.atr_pct) { el.textContent = 'No daily history for this market yet.'; return; }
  const eq = snap.equity, riskUsd = eq * myT.risk, dist = myT.stop * m.atr_pct * m.px, qty = riskUsd / (dist * (m.pv || 1));
  const q = Math.floor(qty / m.step) * m.step, notion = q * m.px * (m.pv || 1), stopPx = m.px - myT.dir * dist;
  const warn = !m.open ? `<span class="down"> ${m.sym} is closed right now: Rex will veto it.</span>` : myT.dir < 0 && !m.shorts ? `<span class="down"> ${m.sym} can't be shorted.</span>` : '';
  el.innerHTML = `${myT.dir > 0 ? 'Buy' : 'Short'} <b>${q >= m.step ? +q.toPrecision(4) : 'less than 1'}</b> ${m.sym} @ ~${fmtPx(m.px)} ≈ <b>${money(notion)}</b> (${(notion / eq * 100).toFixed(1)}% of NAV).
    Stop ${fmtPx(stopPx)} (${myT.stop} × the daily ATR of ${(m.atr_pct * 100).toFixed(1)}%). If it's hit you lose about <b>${money(riskUsd)}</b> = 1R.${warn}`;
}
function renderMyDesk() {
  const M = snap?.mydesk, st = $('myStats'), lv = $('myLive'); if (!M || !st || !lv) return;
  const stat = (k, v, c = '') => `<div><b>${k}</b><span class="mono ${c}">${v}</span></div>`, tot = M.realized + M.upl;
  st.innerHTML = `<div class="stat-grid" style="grid-template-columns:repeat(5,1fr)">${stat('Your P&L', money(tot), cls(tot))}${stat('Realized', money(M.realized), cls(M.realized))}${stat('Open', money(M.upl), cls(M.upl))}
    ${stat('Trades', M.n ? `${M.n} · ${Math.round(M.wins / M.n * 100)}% won` : '—')}${stat('Avg R', M.avg_r == null ? '—' : (M.avg_r >= 0 ? '+' : '') + M.avg_r.toFixed(2) + 'R', M.avg_r == null ? '' : cls(M.avg_r))}</div>`;
  const pos = M.open.length ? `<table><thead><tr><th>Market</th><th>Side</th><th>Entry</th><th>Last</th><th>Stop</th><th>P&L</th><th>Days</th><th></th></tr></thead><tbody>${M.open.map(p => `<tr>
      <td class="t"><b>${esc(p.sym)}</b></td><td class="${p.side > 0 ? 'up' : 'down'}">${p.side > 0 ? 'LONG' : 'SHORT'} ${+p.qty.toPrecision(4)}</td><td>${fmtPx(p.entry)}</td><td>${fmtPx(p.last)}</td>
      <td>${fmtPx(p.stop)}${p.trail ? ' <span class="faint">trail</span>' : ''}</td><td class="${cls(p.upl)}">${money(p.upl)}${p.risk0 ? ` <span class="faint">${(p.upl / p.risk0).toFixed(1)}R</span>` : ''}</td><td>${p.days}/${p.hold ?? '—'}</td>
      <td style="text-align:right;white-space:nowrap">${p.pending ? '<span class="faint">closing at the open</span>' : `<button class="btn sm" data-mybe="${esc(p.key)}">Stop → breakeven</button> <button class="btn sm" data-myclose="${esc(p.key)}">Close</button>`}</td></tr>`).join('')}</tbody></table>`
    : '<div class="faint">No open trades. Pick a market above.</div>';
  const mx = Math.max(0.5, ...M.board.map(b => Math.abs(b[2])));
  const board = M.board.length ? M.board.map(([n, k, r]) => `<div class="gauge" style="margin:3px 0 7px"><div class="l"><span style="${n === 'You' ? 'color:#facc15;font-weight:700' : ''}">${esc(n)} <span class="faint">${k} trades</span></span><span class="mono" style="color:var(--text)">${r >= 0 ? '+' : ''}${r.toFixed(2)}R</span></div>
      <div class="bar" style="margin:2px 0"><i style="width:${Math.abs(r) / mx * 100}%;background:${n === 'You' ? '#facc15' : r < 0 ? 'var(--red)' : 'var(--green)'}"></i></div></div>`).join('')
    : '<div class="faint">Nobody has closed a trade with a recorded risk yet.</div>';
  const hist = M.trades.length ? M.trades.map(t => `<div class="rlog ${t.pnl >= 0 ? 'pass' : 'fail'}"><b>${esc(t.sym)}</b> ${t.side > 0 ? 'long' : 'short'} · <span class="mono ${cls(t.pnl)}">${money(t.pnl)}</span>${t.r == null ? '' : ` · ${t.r >= 0 ? '+' : ''}${t.r.toFixed(2)}R`} · ${esc(t.reason || '')}</div>`).join('') : '<div class="faint">No closed trades yet.</div>';
  lv.innerHTML = `<h3 style="margin:4px 0 6px">Your open trades (${M.open.length}/${M.limits.max_open})</h3>${pos}
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:12px"><div><h3 style="margin:0 0 6px">You vs the AI PMs · average R per trade</h3>${board}</div><div><h3 style="margin:0 0 6px">Your closed trades</h3>${hist}</div></div>`;
  lv.querySelectorAll('[data-myclose]').forEach(b => b.onclick = () => { send({ type: 'my_close', key: b.dataset.myclose }); b.disabled = true; });
  lv.querySelectorAll('[data-mybe]').forEach(b => b.onclick = () => { send({ type: 'my_breakeven', key: b.dataset.mybe }); b.disabled = true; });
  myPreview();
}
document.addEventListener('click', ev => { if (ev.target.closest && ev.target.closest('[data-mydesk]')) openMyDesk(); });

// ── the Strategy Builder (at the lab's backtest station): Jason's idea from the AI's lego blocks, through the lab's real gate ──
const bld = { name: '', rules: [{ block: 'trend', params: { n: 100 } }, { block: 'dip', params: { n: 20, x: 2 } }], direction: 'long', stop_atr: 2.5, trail_atr: 3.5, max_bars: 20, markets: null };
function fmtBlock(tpl, p) {           // the Python-style templates from firm/blocks.py: {n}, {x:.0%}, {x:.1f}
  return tpl.replace(/\{(\w+)(?::\.(\d)([%f]))?\}/g, (_, k, d, t) => { const v = p[k]; if (v == null) return '?'; return t === '%' ? (v * 100).toFixed(+d) + '%' : t === 'f' ? (+v).toFixed(+d) : String(v); });
}
function openBuilder() {
  const B = snap?.builder; if (!B) return;
  if (!bld.markets) bld.markets = [...B.universe];
  modal('builder', 'Strategy Builder · design it, the lab judges it', `<div class="muted" style="font-size:12.5px">Snap 1-${B.max_rules} rules together from the same lego kit Ava uses. A trade opens when <b>all</b> rules agree (shorts use each rule's mirror), then the stop, trailing stop and time limit run it. It's backtested on 10+ years of daily bars with real costs and judged by the lab's real gate.</div>
    <div style="display:flex;gap:8px;margin:10px 0;align-items:center"><input id="bName" maxlength="40" placeholder="Name your strategy" value="${esc(bld.name)}" aria-label="Strategy name"
      style="flex:1;background:var(--bg2);color:var(--text);border:1px solid var(--border2);border-radius:8px;padding:7px 9px"></div>
    <div id="bRules"></div><div id="bExits"></div><div id="bMk"></div>
    <div id="bDesc" class="pod" style="margin:10px 0;padding:10px 12px;font-size:13px"></div>
    <button class="btn on" id="bRun">Backtest it</button> <span class="faint" style="font-size:12px" id="bBar"></span>
    <div id="bRes" style="margin-top:12px"></div>`);
  $('bName').oninput = e => { bld.name = e.target.value; };
  $('bRun').onclick = () => { if (snap?.builder?.running) return; send({ type: 'build_test', name: bld.name, rules: bld.rules, direction: bld.direction, stop_atr: bld.stop_atr, trail_atr: bld.trail_atr, max_bars: bld.max_bars, markets: bld.markets });
    $('bRun').disabled = true; $('bRun').textContent = 'Ava is backtesting…'; if (agents.ava) act('ava', say('Running your idea through the machine, Jason.', 2600)); };
  bRulesUI(); bExitsUI(); bMarketsUI(); renderBuilder();
}
function slider(id, label, min, max, step, v, fmt) {
  return `<label style="display:flex;align-items:center;gap:8px;font-size:12.5px;margin:4px 0"><span class="muted" style="width:140px">${label}</span>
    <input type="range" id="${id}" min="${min}" max="${max}" step="${step}" value="${v}" style="flex:1"><b class="mono" style="width:64px;text-align:right" id="${id}v">${fmt(v)}</b></label>`;
}
const PNAME = { 'dip.x': 'z-score', 'rsi_extreme.x': 'RSI level', 'rsi_strong.x': 'RSI level', 'momentum.x': 'min return', 'gap.x': 'min gap', 'range_pos.x': 'bottom share',
  'calm.lo': 'min vol rank', 'calm.hi': 'max vol rank', 'ma_cross.fast': 'fast EMA (days)', 'ma_cross.slow': 'slow EMA (days)', 'pullback.trend': 'trend (days)', 'streak.n': 'days in a row' };
const pname = (b, k) => PNAME[b + '.' + k] || (k === 'n' ? 'days' : k);
const longText = t => t.replace(/(\w+)\/(\w+)/g, '$1').replace(/ \((mirror|up days|top) for shorts\)/g, '');
const PCT_PARAMS = new Set(['momentum.x', 'gap.x', 'range_pos.x', 'calm.lo', 'calm.hi']);
const pfmt = (b, k, v) => PCT_PARAMS.has(b + '.' + k) ? (v * 100).toFixed(v < 0.1 ? 1 : 0) + '%' : Number.isInteger(v) ? String(v) : (+v).toFixed(2);
function bRulesUI() {
  const el = $('bRules'), B = snap?.builder; if (!el || !B) return;
  const blocks = Object.entries(B.blocks);
  el.innerHTML = bld.rules.map((r, i) => { const spec = B.blocks[r.block];
    return `<div class="pod" style="margin:8px 0;padding:10px 12px;border-left:3px solid #a78bfa">
      <div style="display:flex;gap:8px;align-items:center"><b style="font-size:12.5px">Rule ${i + 1}</b>
        <select data-bb="${i}" aria-label="Rule ${i + 1} block" style="flex:1;background:var(--bg2);color:var(--text);border:1px solid var(--border2);border-radius:8px;padding:5px">
          ${blocks.map(([k, b]) => `<option value="${k}" ${k === r.block ? 'selected' : ''}>${esc(k.replace('_', ' '))}: ${esc(fmtBlock(b.desc, Object.fromEntries(Object.entries(b.params).map(([p, x]) => [p, x[2]]))))}</option>`).join('')}
        </select>${bld.rules.length > 1 ? `<button class="btn sm" data-bx="${i}" aria-label="Remove rule ${i + 1}">✕</button>` : ''}</div>
      ${Object.entries(spec.params).map(([p, [lo, hi, d]]) => { const v = r.params[p] ?? d, step = Number.isInteger(lo) && Number.isInteger(hi) && Number.isInteger(d) && hi > 2 ? 1 : (hi - lo) / 100;
        return slider(`bp${i}_${p}`, pname(r.block, p), lo, hi, step, v, x => pfmt(r.block, p, +x)); }).join('')}</div>`; }).join('')
    + (bld.rules.length < B.max_rules ? `<button class="btn sm" id="bAdd">+ Add a rule</button>` : '');
  el.querySelectorAll('[data-bb]').forEach(s => s.onchange = () => { const i = +s.dataset.bb, b = s.value;
    bld.rules[i] = { block: b, params: Object.fromEntries(Object.entries(B.blocks[b].params).map(([p, x]) => [p, x[2]])) }; bRulesUI(); bDesc(); });
  el.querySelectorAll('[data-bx]').forEach(b => b.onclick = () => { bld.rules.splice(+b.dataset.bx, 1); bRulesUI(); bDesc(); });
  bld.rules.forEach((r, i) => Object.keys(B.blocks[r.block].params).forEach(p => { const inp = $(`bp${i}_${p}`); if (!inp) return;
    inp.oninput = () => { r.params[p] = +inp.value; $(`bp${i}_${p}v`).textContent = pfmt(r.block, p, +inp.value); bDesc(); }; }));
  const add = $('bAdd'); if (add) add.onclick = () => { const used = new Set(bld.rules.map(r => r.block)), b = Object.keys(B.blocks).find(k => !used.has(k));
    bld.rules.push({ block: b, params: Object.fromEntries(Object.entries(B.blocks[b].params).map(([p, x]) => [p, x[2]])) }); bRulesUI(); bDesc(); };
  bDesc();
}
function bExitsUI() {
  const el = $('bExits'), R = snap?.builder?.risk; if (!el || !R) return;
  el.innerHTML = `<div class="pod" style="margin:8px 0;padding:10px 12px;border-left:3px solid #22d3ee"><div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap"><b style="font-size:12.5px;width:140px">Direction</b>
      ${[['long', 'Long only'], ['short', 'Short only'], ['both', 'Both']].map(([k, l]) => `<button class="btn sm ${bld.direction === k ? 'on' : ''}" data-bd="${k}">${l}</button>`).join('')}</div>
    ${slider('bStop', 'Stop (ATRs)', R.stop_atr[0], R.stop_atr[1], 0.25, bld.stop_atr, x => (+x).toFixed(2))}
    ${slider('bTrail', 'Trailing stop (ATRs)', R.trail_atr[0], R.trail_atr[1], 0.25, bld.trail_atr, x => (+x).toFixed(2))}
    ${slider('bHold', 'Max hold (days)', R.max_bars[0], R.max_bars[1], 1, bld.max_bars, x => x + 'd')}</div>`;
  el.querySelectorAll('[data-bd]').forEach(b => b.onclick = () => { bld.direction = b.dataset.bd; bExitsUI(); bDesc(); });
  for (const [id, k] of [['bStop', 'stop_atr'], ['bTrail', 'trail_atr'], ['bHold', 'max_bars']]) $(id).oninput = () => { bld[k] = +$(id).value; $(id + 'v').textContent = k === 'max_bars' ? $(id).value + 'd' : (+$(id).value).toFixed(2); bDesc(); };
}
function bMarketsUI() {
  const el = $('bMk'), U = snap?.builder?.universe; if (!el || !U) return;
  el.innerHTML = `<div style="display:flex;gap:5px;flex-wrap:wrap;align-items:center;margin:8px 0"><b style="font-size:12.5px;width:140px">Markets (${bld.markets.length})</b>
    <button class="btn sm" data-bm="all">All</button>${U.map(s => `<button class="btn sm ${bld.markets.includes(s) ? 'on' : ''}" data-bm="${s}" style="padding:2px 7px">${s}</button>`).join('')}</div>`;
  el.querySelectorAll('[data-bm]').forEach(b => b.onclick = () => { const s = b.dataset.bm;
    bld.markets = s === 'all' ? (bld.markets.length === U.length ? [] : [...U]) : bld.markets.includes(s) ? bld.markets.filter(x => x !== s) : [...bld.markets, s]; bMarketsUI(); });
}
function bDesc() {
  const el = $('bDesc'), B = snap?.builder; if (!el || !B) return;
  const rules = bld.rules.map(r => { const t = fmtBlock(B.blocks[r.block].desc, r.params); return bld.direction === 'long' ? longText(t) : t; });
  el.innerHTML = `<b>${bld.direction === 'short' ? 'Short' : bld.direction === 'both' ? 'Buy (or short the mirror)' : 'Buy'}</b> when ${rules.map(x => `<span style="color:#c4b5fd">${esc(x)}</span>`).join(' <b>AND</b> ')}.
    Stop ${bld.stop_atr.toFixed(2)} ATRs away, trailing ${bld.trail_atr.toFixed(2)} ATRs behind the best price, out after ${bld.max_bars} days at most.`;
}
function renderBuilder() {
  const el = $('bRes'), B = snap?.builder; if (!el || !B) return;
  const run = $('bRun'); if (run) { run.disabled = !!B.running; run.textContent = B.running ? 'Ava is backtesting…' : 'Backtest it'; }
  const bar = $('bBar'); if (bar) bar.textContent = `Pass bar: PF ≥ 1.2, 40+ trades, 3/4 periods profitable, max DD -25%, t-stat ≥ ${(1.5 + 0.4 * Math.log(1 + (B.n_tests || 0) + 1)).toFixed(2)} after ${B.n_tests || 0} ideas tested (rises with every test, yours included).`;
  const L = B.last;
  if (!L) { el.innerHTML = '<div class="faint">No backtest yet.</div>'; return; }
  const stat = (k, v, c = '') => `<div><b>${k}</b><span class="mono ${c}">${v}</span></div>`;
  const C = L.curve || [], W = 680, H = 130; let svg = '';
  if (C.length > 2) { const vs = C.map(c => c[1]), lo = Math.min(1, ...vs), hi = Math.max(1, ...vs), X = i => 4 + i / (C.length - 1) * (W - 8), Y = v => 6 + (1 - (v - lo) / (hi - lo || 1)) * (H - 12);
    svg = `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Backtest equity, monthly"><line x1="4" x2="${W - 4}" y1="${Y(1)}" y2="${Y(1)}" stroke="var(--border2)" stroke-dasharray="4 4"/>
      <path d="${vs.map((v, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join('')}" fill="none" stroke="${vs[vs.length - 1] >= 1 ? 'var(--green)' : 'var(--red)'}" stroke-width="2"/>
      <text x="6" y="${H - 4}" fill="var(--muted)" font-size="11">${esc(C[0][0])}</text><text x="${W - 6}" y="${H - 4}" fill="var(--muted)" font-size="11" text-anchor="end">${esc(C[C.length - 1][0])}</text></svg>`; }
  const per = Object.entries(L.per || {}).sort((a, b) => b[1].ret - a[1].ret);
  el.innerHTML = `<div class="rlog ${L.passed ? 'pass' : 'fail'}" style="font-size:13.5px"><b>${esc(L.name)}: ${L.passed ? 'PASSED' : 'FAILED'}</b> · ${esc(L.why)}</div>
    <div class="faint" style="font-size:12px;margin:4px 0 8px">${esc(L.params?.direction === 'long' ? longText(L.desc) : L.desc)} · ${L.markets.length} markets</div>
    <div class="stat-grid" style="grid-template-columns:repeat(4,1fr)">${stat('Trades', L.n)}${stat('Profit factor', (+L.pf).toFixed(2), L.pf >= 1.2 ? 'up' : 'down')}${stat('Win rate', Math.round(L.win * 100) + '%')}${stat('t-stat / needed', `${(+L.t_stat).toFixed(2)} / ${(+L.need_t).toFixed(2)}`, L.t_stat >= L.need_t ? 'up' : 'down')}
      ${stat('Per year (0.5% risk)', pct(L.cagr, 1), cls(L.cagr))}${stat('Max drawdown', pct(L.maxdd, 0), L.maxdd < -0.25 ? 'down' : '')}${stat('Recent period', L.recent.n ? 'PF ' + (+L.recent.pf).toFixed(2) : '—')}${stat('Periods', L.folds.map(f => f.n ? (+f.pf).toFixed(2) : '–').join(' / '))}</div>
    ${svg ? `<h3 style="margin:12px 0 4px">Equity (monthly, 0.5% risk per trade)</h3>${svg}` : ''}
    ${per.length ? `<h3 style="margin:12px 0 6px">By market</h3><div style="display:flex;flex-wrap:wrap;gap:6px">${per.map(([s, x]) => `<span class="mono" style="font-size:11.5px;padding:3px 7px;border-radius:6px;background:${x.ret >= 0 ? 'rgba(34,197,94,.15)' : 'rgba(244,63,94,.15)'}">${esc(s)} ${x.n}t ${x.pf == null ? '' : 'PF ' + x.pf}</span>`).join('')}</div>` : ''}
    ${L.passed ? (L.submitted ? '<div class="up" style="margin-top:10px">In the incubator: it paper-trades forward now. Juno will hire it as a PM if it proves itself.</div>'
      : `<button class="btn on" id="bSub" style="margin-top:10px">Send it to the incubator</button>`) : ''}
    ${(B.tests || []).length ? `<h3 style="margin:14px 0 6px">Your recent tests</h3>${B.tests.slice().reverse().map(t => `<div class="rlog ${t.passed ? 'pass' : 'fail'}">${esc(t.name)} · PF ${(+t.pf).toFixed(2)} · t=${(+t.t_stat).toFixed(2)}</div>`).join('')}` : ''}`;
  const sub = $('bSub'); if (sub) sub.onclick = () => { send({ type: 'build_submit' }); sub.disabled = true; sub.textContent = 'Sending…'; };
}
document.addEventListener('click', ev => { if (ev.target.closest && ev.target.closest('[data-builder]')) openBuilder(); });

// ── "While you were away": on the first visit after 2+ hours, what happened on the floor since ──
const SEEN_KEY = 'jb.lastSeen';
let awaySince = +(lsGet(SEEN_KEY) || 0), awayShown = false;
setInterval(() => { if (document.visibilityState === 'visible') lsSet(SEEN_KEY, String(Date.now() / 1000)); }, 60000);
addEventListener('pagehide', () => lsSet(SEEN_KEY, String(Date.now() / 1000)));
async function openAway(since = awaySince || Date.now() / 1000 - 86400) {
  let D;
  try { D = await (await fetch(`/api/digest?since=${since}`)).json(); } catch { return; }
  const hrs = D.hours >= 48 ? `${Math.round(D.hours / 24)} days` : `${Math.max(1, Math.round(D.hours))} hours`, chg = D.eq_now - D.eq_then;
  const stat = (k, v, c = '') => `<div><b>${k}</b><span class="mono ${c}">${v}</span></div>`;
  const ago = t => { const m = (Date.now() / 1000 - t) / 60; return m < 60 ? `${Math.round(m)}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`; };
  const ICON = { hire: '🎉', fire: '📦', upgrade: '⬆️', incubator: '🌱', letter: '✉️' };
  modal('away', `While you were away · ${hrs}`, `<div class="stat-grid" style="grid-template-columns:repeat(4,1fr)">
      ${stat('NAV', `${D.nav_then.toFixed(2)} → ${D.nav_now.toFixed(2)}`, cls(chg))}${stat('Change', `${money(chg)} (${pct(chg / (D.eq_then || 1))})`, cls(chg))}
      ${stat('Closed trades', `${D.n_trades} · ${money(D.realized)}`, cls(D.realized))}${stat('Lab', `${D.passed}/${D.tested} ideas passed`)}</div>
    ${D.by_pod.length ? `<h3 style="margin:12px 0 6px">P&L by pod (closed trades)</h3><div style="display:flex;gap:6px;flex-wrap:wrap">${D.by_pod.map(([n, v]) => `<span class="mono" style="font-size:12px;padding:3px 8px;border-radius:6px;background:${v >= 0 ? 'rgba(34,197,94,.15)' : 'rgba(244,63,94,.15)'}">${esc(n)} ${money(v)}</span>`).join('')}</div>` : ''}
    ${[D.best && D.best.pnl > 0 ? `Best trade: <b>${esc(D.best.pod)}</b> ${esc(D.best.sym)} <span class="up">${money(D.best.pnl)}</span>` : '',
       D.worst && D.worst.pnl < 0 ? `Worst: <b>${esc(D.worst.pod)}</b> ${esc(D.worst.sym)} <span class="down">${money(D.worst.pnl)}</span>` : ''].filter(Boolean).map(x => `<span style="margin-right:14px">${x}</span>`).join('').replace(/^(.+)$/, '<div style="margin-top:8px;font-size:13px">$1</div>')}
    ${D.opened.length ? `<h3 style="margin:12px 0 6px">New positions</h3><div style="font-size:13px">${D.opened.map(o => `${esc(o.pod)} <b class="${o.side > 0 ? 'up' : 'down'}">${o.side > 0 ? 'long' : 'short'}</b> ${esc(o.sym)}`).join(' · ')}</div>` : ''}
    ${D.notes.length ? `<h3 style="margin:12px 0 6px">Big moments</h3>${D.notes.slice().reverse().map(n => `<div class="rlog">${ICON[n.kind] || '•'} <b>${esc(n.name)}</b> ${esc(n.text)} <span class="faint">${ago(n.t)}</span></div>`).join('')}` : ''}
    ${D.research.length ? `<h3 style="margin:12px 0 6px">Research</h3>${D.research.slice().reverse().slice(0, 6).map(e => `<div class="rlog ${e.passed ? 'pass' : 'fail'}"><b>${esc(e.name)}</b> ${e.passed ? 'PASSED' : 'failed'} · ${esc(e.reason)}</div>`).join('')}` : ''}
    ${D.n_risk ? `<h3 style="margin:12px 0 6px">Rex flagged ${D.n_risk} risk item${D.n_risk > 1 ? 's' : ''}</h3>${D.risk.slice().reverse().slice(0, 4).map(r => `<div class="rlog fail">${esc(r.text)} <span class="faint">${ago(r.t)}</span></div>`).join('')}` : ''}
    ${!D.n_trades && !D.notes.length && !D.research.length && !D.opened.length ? '<div class="faint" style="margin-top:10px">A quiet stretch: no trades, no research, nothing for Rex to flag.</div>' : ''}
    <div style="display:flex;gap:6px;margin-top:12px"><button class="btn on" id="awayOk">Back to the floor</button><button class="btn" data-tear="1">Fund tear sheet</button></div>`);
  $('awayOk').onclick = closeModal;
}
function maybeAway() {
  if (awayShown) return; awayShown = true;
  const gone = Date.now() / 1000 - awaySince;
  lsSet(SEEN_KEY, String(Date.now() / 1000));
  if (!awaySince || gone < 2 * 3600 || /[?&](tour|open)=?/.test(location.search) || modalKind) return;
  setTimeout(() => { if (!modalKind && !tour) openAway(awaySince); }, 2500);
}
document.addEventListener('click', ev => { if (ev.target.closest && ev.target.closest('[data-away]')) openAway(); });

// ── options payoff: P&L at expiry and today (Black-Scholes at each leg's IV) across the underlying's price ──
const ncdf = x => { const t = 1 / (1 + 0.2316419 * Math.abs(x)), d = 0.3989423 * Math.exp(-x * x / 2), p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274)))); return x > 0 ? 1 - p : p; };
function bsPx(S, K, T, iv, kind) { if (T <= 0) return Math.max(0, kind === 'C' ? S - K : K - S); iv = Math.max(iv || 0.5, 1e-4);
  const d1 = (Math.log(S / K) + 0.5 * iv * iv * T) / (iv * Math.sqrt(T)), d2 = d1 - iv * Math.sqrt(T);
  return kind === 'C' ? S * ncdf(d1) - K * ncdf(d2) : K * ncdf(-d2) - S * ncdf(-d1); }
const optStructs = () => (snap?.positions || []).filter(p => p.option && (p.venue !== 'alpaca' || p.kind === 'iron condor') && p.legs?.every(l => l.strike && l.kind) && p.spot);
function structPnl(s, S, atExpiry, daysAhead = 0) {
  const T = atExpiry ? 0 : Math.max(0, (s.dte - daysAhead) / 365);
  const mult = s.venue === 'alpaca' ? 100 : 1;          // ETF option prices are per share, contracts are 100 shares
  return s.legs.reduce((a, l) => a + l.side * l.qty * (mult * bsPx(S, l.strike, T, l.iv, l.kind) - l.entry), 0) - (s.fees || 0);
}
function payoffCurve(s, lo, hi, n, atExpiry) { const out = []; for (let i = 0; i <= n; i++) { const S = s.spot * (lo + (hi - lo) * i / n); out.push([S, structPnl(s, S, atExpiry)]); } return out; }
function breakevens(s) { const P = payoffCurve(s, 0.5, 1.5, 800, true), out = []; for (let i = 1; i < P.length; i++) if ((P[i - 1][1] < 0) !== (P[i][1] < 0)) out.push(P[i - 1][0] + (P[i][0] - P[i - 1][0]) * (0 - P[i - 1][1]) / (P[i][1] - P[i - 1][1])); return out; }
let payPick = 0, payMove = 0;
function openPayoff() { achMark('payoff'); setTimeout(() => checkAch(true), 800); modal('payoff', "Opal's options book · payoff", '<div id="payBody"></div>'); renderPayoff(); }
function renderPayoff() {
  const el = $('payBody'); if (!el) return;
  const S = optStructs();
  if (!S.length) { el.innerHTML = '<div class="faint">Opal has no open option structures right now. She sells iron condors when implied volatility is rich versus realized (IV/RV above 1.2).</div>'; return; }
  payPick = Math.min(payPick, S.length - 1); const s = S[payPick], iv = s.legs.reduce((a, l) => a + (l.iv || 0), 0) / s.legs.length || 0.5;
  const P = payoffCurve(s, 0.7, 1.3, 160, true), N = payoffCurve(s, 0.7, 1.3, 160, false), be = breakevens(s);
  const all = P.concat(N).map(p => p[1]), lo = Math.min(...all), hi = Math.max(...all), W = 680, H = 230;
  const X = S0 => 40 + (S0 - P[0][0]) / (P.at(-1)[0] - P[0][0]) * (W - 50), Y = v => 10 + (1 - (v - lo) / (hi - lo || 1)) * (H - 36);
  const path = Q => Q.map((p, i) => `${i ? 'L' : 'M'}${X(p[0]).toFixed(1)},${Y(p[1]).toFixed(1)}`).join('');
  const Sm = s.spot * (1 + payMove / 100), T = s.dte / 365;
  // probability the underlying finishes between the breakevens (lognormal at the legs' average IV)
  const pBelow = K => ncdf((Math.log(K / s.spot) + 0.5 * iv * iv * T) / (iv * Math.sqrt(Math.max(T, 1e-6))));
  const pop = be.length === 2 ? pBelow(be[1]) - pBelow(be[0]) : be.length === 1 ? (structPnl(s, be[0] * 1.01, true) > 0 ? 1 - pBelow(be[0]) : pBelow(be[0])) : null;
  const maxP = Math.max(...payoffCurve(s, 0.3, 1.7, 600, true).map(p => p[1])), maxL = Math.min(...payoffCurve(s, 0.3, 1.7, 600, true).map(p => p[1]));
  const stat = (k, v, c = '') => `<div><b>${k}</b><span class="mono ${c}">${v}</span></div>`;
  el.innerHTML = `${S.length > 1 ? `<div style="display:flex;gap:6px;margin-bottom:8px">${S.map((x, i) => `<button class="btn sm ${i === payPick ? 'on' : ''}" data-pp="${i}">${esc(x.sym)}</button>`).join('')}</div>` : ''}
    <div class="muted" style="font-size:12.5px">${esc(s.sym)} · ${s.legs.map(l => `${l.side > 0 ? 'long' : 'short'} ${+l.qty.toPrecision(3)} ${l.kind === 'C' ? 'call' : 'put'} ${Math.round(l.strike).toLocaleString()}`).join(' · ')} · expires in ${s.dte.toFixed(1)} days</div>
    <div class="stat-grid" style="grid-template-columns:repeat(5,1fr);margin:10px 0">${stat('P&L now', money(s.upl), cls(s.upl))}${stat('Max profit', money(maxP), 'up')}${stat('Max loss', money(maxL), 'down')}
      ${stat('Breakevens', be.map(x => Math.round(x).toLocaleString()).join(' / ') || '—')}${stat('Chance of profit', pop == null ? '—' : Math.round(pop * 100) + '%')}</div>
    <svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Payoff chart">
      <line x1="40" x2="${W - 10}" y1="${Y(0)}" y2="${Y(0)}" stroke="var(--border2)"/>
      ${be.map(x => `<line x1="${X(x)}" x2="${X(x)}" y1="10" y2="${H - 26}" stroke="var(--border2)" stroke-dasharray="3 4"/>`).join('')}
      <path d="${path(N)}" fill="none" stroke="#a78bfa" stroke-width="2" stroke-dasharray="6 4"/>
      <path d="${path(P)}" fill="none" stroke="#2dd4bf" stroke-width="2.5"/>
      <line x1="${X(s.spot)}" x2="${X(s.spot)}" y1="10" y2="${H - 26}" stroke="#facc15" stroke-width="1.5"/>
      ${Sm !== s.spot ? `<circle cx="${X(Sm)}" cy="${Y(structPnl(s, Sm, false))}" r="5" fill="#f472b6"/>` : ''}
      <text x="${X(s.spot)}" y="${H - 10}" fill="#facc15" font-size="11" text-anchor="middle">now ${Math.round(s.spot).toLocaleString()}</text>
      <text x="40" y="${H - 10}" fill="var(--muted)" font-size="11">${Math.round(P[0][0]).toLocaleString()}</text><text x="${W - 10}" y="${H - 10}" fill="var(--muted)" font-size="11" text-anchor="end">${Math.round(P.at(-1)[0]).toLocaleString()}</text>
      <text x="44" y="${Y(maxP) + 12}" fill="var(--muted)" font-size="11">${money(maxP)}</text><text x="44" y="${Math.min(H - 30, Y(maxL) - 4)}" fill="var(--muted)" font-size="11">${money(maxL)}</text></svg>
    <div class="faint" style="font-size:11.5px"><span style="color:#2dd4bf">━</span> at expiry · <span style="color:#a78bfa">┅</span> today (Black-Scholes at each leg's IV) · <span style="color:#facc15">│</span> ${esc(s.under || '')} now</div>
    <label style="display:flex;align-items:center;gap:10px;margin-top:12px;font-size:13px"><span>What if ${esc(s.under || 'it')} moves</span><input type="range" id="payMv" min="-30" max="30" step="1" value="${payMove}" style="flex:1"><b class="mono" style="width:52px">${payMove > 0 ? '+' : ''}${payMove}%</b></label>
    <div class="mono" style="font-size:13px;margin-top:4px">→ ${Math.round(Sm).toLocaleString()}: today <b class="${cls(structPnl(s, Sm, false))}">${money(structPnl(s, Sm, false))}</b> · at expiry <b class="${cls(structPnl(s, Sm, true))}">${money(structPnl(s, Sm, true))}</b></div>
    <div class="faint" style="font-size:11.5px;margin-top:8px">An iron condor sells a call and a put spread around the price: it earns the credit if ${esc(s.under || 'the price')} stays between the breakevens until expiry, and the wings cap the loss. Opal closes at 50% of the credit or a loss of 1.5x it, and sells only when implied volatility is rich versus realized.</div>`;
  el.querySelectorAll('[data-pp]').forEach(b => b.onclick = () => { payPick = +b.dataset.pp; renderPayoff(); });
  $('payMv').oninput = e => { payMove = +e.target.value; renderPayoff(); const m = $('payMv'); if (m) m.focus(); };
}
document.addEventListener('click', ev => { if (ev.target.closest && ev.target.closest('[data-payoff]')) openPayoff(); });

// ── achievements: earned by doing things around the city; a toast + confetti when one unlocks ──
const achFlag = k => !!lsGet('jb.ach.' + k), achMark = k => lsSet('jb.ach.' + k, '1');
const achCount = k => +(lsGet('jb.achn.' + k) || 0), achBump = k => lsSet('jb.achn.' + k, String(achCount(k) + 1));
function ACH_LIST() { return [
  { id: 'desk1', ic: '🪙', n: 'First fill', d: 'Place a trade from your desk', ok: s => (s.mydesk?.n || 0) + (s.mydesk?.open?.length || 0) >= 1 },
  { id: 'deskwin', ic: '💰', n: 'In the money', d: 'Close a winning trade from your desk', ok: s => (s.mydesk?.wins || 0) >= 1 },
  { id: 'deskr', ic: '📐', n: 'Positive expectancy', d: 'Average +0.3R or better over 5+ desk trades', ok: s => (s.mydesk?.n || 0) >= 5 && (s.mydesk?.avg_r || 0) >= 0.3 },
  { id: 'build1', ic: '🧪', n: 'Lab rat', d: 'Backtest a strategy in the Strategy Builder', ok: s => !!s.builder?.last },
  { id: 'buildpass', ic: '🎓', n: 'Passed the gate', d: 'Design a strategy that passes the lab', ok: s => (s.builder?.tests || []).some(t => t.passed) || !!s.builder?.last?.passed },
  { id: 'hired', ic: '🏆', n: 'Founder-PM', d: 'A strategy you designed gets hired as a PM', ok: s => (s.roster || []).some(r => r.mentor === 'jason') },
  { id: 'calls', ic: '🤖', n: 'Beat the bots', d: 'Out-call Ava over 10+ graded market calls', ok: s => { const c = s.arena?.score; return !!c && c.jason?.n >= 10 && c.jason.rate > (c.ava?.rate || 0); } },
  { id: 'math30', ic: '🧮', n: 'Quick maths', d: 'Score 30+ in the Math Arena', ok: () => mathData().best >= 30 },
  { id: 'math40', ic: '⚡', n: 'Prop-firm ready', d: 'Score 40+ in the Math Arena', ok: () => mathData().best >= 40 },
  { id: 'mm', ic: '🎲', n: 'Market maker', d: 'Finish the Market Making Pit in profit', ok: () => (mmData().best ?? -1) > 0 },
  { id: 'mm15', ic: '🦈', n: 'Spread shark', d: 'Score +15 or better in the Market Making Pit', ok: () => (mmData().best ?? -1) >= 15 },
  { id: 'streak3', ic: '🔥', n: 'On a roll', d: 'Finish the daily rounds 3 days in a row', ok: () => roundsStreak() >= 3 },
  { id: 'streak7', ic: '🌋', n: 'Unstoppable', d: 'Finish the daily rounds 7 days in a row', ok: () => roundsStreak() >= 7 },
  { id: 'bell', ic: '🔔', n: 'Ding ding', d: 'Ring the opening bell', ok: () => achFlag('bell') },
  { id: 'ask10', ic: '💬', n: 'Walk the floor', d: 'Ask the team 10 questions in person', ok: () => achCount('ask') >= 10 },
  { id: 'stress', ic: '🧯', n: 'Fire drill', d: 'Run a stress test on the book', ok: () => achFlag('stress') },
  { id: 'tear', ic: '📄', n: 'Investor-ready', d: 'Open the fund tear sheet', ok: () => achFlag('tear') },
  { id: 'payoff', ic: '🦋', n: 'Greeks geek', d: "Study Opal's options payoff", ok: () => achFlag('payoff') },
  { id: 'nav101', ic: '📈', n: 'First percent', d: 'Fund NAV above 101', ok: s => s.nav >= 101 },
  { id: 'nav105', ic: '🚀', n: 'Five up', d: 'Fund NAV above 105', ok: s => s.nav >= 105 },
  { id: 'nav110', ic: '💎', n: 'Double digits', d: 'Fund NAV above 110', ok: s => s.nav >= 110 },
]; }
const ACH_N = 21;
function achUnlocked() { try { return Object.keys(JSON.parse(lsGet('jb.ach') || '{}')); } catch { return []; } }
let achQueue = [], achShowing = false, achLast = 0;
function checkAch(force = false) {
  if (!snap || (!force && performance.now() - achLast < 4000)) return; achLast = performance.now();
  let got; try { got = JSON.parse(lsGet('jb.ach') || '{}'); } catch { got = {}; }
  const fresh = ACH_LIST().filter(a => !got[a.id] && (() => { try { return a.ok(snap); } catch { return false; } })());
  if (!fresh.length) return;
  for (const a of fresh) got[a.id] = Date.now();
  lsSet('jb.ach', JSON.stringify(got)); trophyShelf.paint();
  achQueue.push(...fresh.slice(0, 4)); if (fresh.length > 4) achQueue.push({ ic: '✨', n: `+${fresh.length - 4} more`, d: 'Open the trophy case to see them all' });
  showAch();
}
function showAch() {
  if (achShowing || !achQueue.length) return; achShowing = true;
  const a = achQueue.shift(), el = document.createElement('div');
  el.className = 'achToast'; el.innerHTML = `<span class="ic">${a.ic}</span><div><div class="t">Achievement unlocked</div><div class="n">${esc(a.n)}</div><div class="d">${esc(a.d)}</div></div>`;
  document.body.appendChild(el); SFX.win?.(); if (walk.on) confetti(P.x, 2.6, P.z, 50);
  void el.offsetWidth; setTimeout(() => el.classList.add('on'), 30);           // reflow first so the slide-in always plays
  setTimeout(() => { el.classList.remove('on'); setTimeout(() => { el.remove(); achShowing = false; showAch(); }, 450); }, 3600);
}
function openTrophies() {
  let got; try { got = JSON.parse(lsGet('jb.ach') || '{}'); } catch { got = {}; }
  const L = ACH_LIST(), n = L.filter(a => got[a.id]).length;
  modal('trophies', `Trophy case · ${n}/${L.length}`, `<div class="bar" style="margin:4px 0 12px"><i style="width:${n / L.length * 100}%;background:#facc15"></i></div>
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:8px">${L.map(a => `<div class="pod" style="margin:0;padding:10px;${got[a.id] ? 'border-color:#facc15' : 'opacity:.55'}">
      <div style="font-size:24px">${got[a.id] ? a.ic : '🔒'}</div><div style="font-weight:700;margin-top:2px">${esc(a.n)}</div><div class="faint" style="font-size:11.5px">${esc(a.d)}</div>
      ${got[a.id] ? `<div class="faint" style="font-size:10.5px;margin-top:4px">${new Date(got[a.id]).toLocaleDateString()}</div>` : ''}</div>`).join('')}</div>`);
}
document.addEventListener('click', ev => { if (ev.target.closest && ev.target.closest('[data-trophies]')) openTrophies(); });

// ── floor announcements: Jason at the podium, with directives the floor actually follows ──
const ANN_TEMPLATES = ['Prioritize finding an edge', 'Protect capital this week', 'Press our best ideas', 'Cut losers fast, let winners run', 'All hands: huddle now'];
const annT = { text: '', stance: null, pause: null, sprint: false, huddle: false, priority: true, touched: {} };
function annDetect(t) {
  const s = t.toLowerCase(), out = {};
  if (/edge|research|strateg|alpha|new idea|backtest|innovat/.test(s)) out.sprint = true;
  if (/defens|careful|cautio|protect|reduce risk|risk.?off|de-?risk|preserve/.test(s)) out.stance = 'defensive';
  else if (/aggress|press|risk.?on|go big|lean in|push|best ideas/.test(s)) out.stance = 'press';
  if (/pause|halt|stop trading|freeze|no new (trades|positions)/.test(s)) out.pause = 'close';
  if (/huddle|all hands|meeting|gather/.test(s)) out.huddle = true;
  return out;
}
function openAnnounce() {
  modal('announce', '📣 Floor announcement', `<div class="muted" style="font-size:12.5px">Everyone on the trading floor stops and listens. The text becomes a standing priority for 7 days: it goes into Ava's research brief, the team's reflections and pitches, what agents tell you when you ask, and the CIO's morning plan. Directives below change behavior right away.</div>
    <div style="display:flex;gap:6px;flex-wrap:wrap;margin:10px 0">${ANN_TEMPLATES.map(x => `<button class="btn sm" data-annt="${esc(x)}">${esc(x)}</button>`).join('')}</div>
    <textarea id="annText" maxlength="280" rows="3" placeholder="Say something to the whole floor…" aria-label="Announcement" style="width:100%;box-sizing:border-box;background:var(--bg2);color:var(--text);border:1px solid var(--border2);border-radius:10px;padding:10px;font:500 14px Inter,sans-serif">${esc(annT.text)}</textarea>
    <div id="annDirs"></div>
    <div style="display:flex;gap:8px;align-items:center;margin-top:12px"><button class="btn on" id="annGo">📣 Announce</button><span class="faint" style="font-size:12px" id="annNote"></span></div>
    <div id="annHist"></div>`);
  const ta = $('annText');
  ta.oninput = () => { annT.text = ta.value; const d = annDetect(ta.value);
    for (const k of ['stance', 'pause', 'sprint', 'huddle']) if (!annT.touched[k]) annT[k] = d[k] ?? (k === 'sprint' || k === 'huddle' ? false : null);
    if (!annT.touched.priority) annT.priority = !((d.pause || d.huddle) && !d.sprint && !d.stance);     // a pause or a huddle call isn't a standing priority
    annDirs(); };
  document.querySelectorAll('[data-annt]').forEach(b => b.onclick = () => { ta.value = b.dataset.annt; ta.oninput(); ta.focus(); });
  $('annGo').onclick = () => {
    if (!annT.text.trim() && !annT.stance && !annT.pause && !annT.sprint && !annT.huddle) { $('annNote').textContent = 'Write something or pick a directive.'; return; }
    send({ type: 'announce', text: annT.text.trim(), stance: annT.stance, pause: annT.pause, sprint: annT.sprint, huddle: annT.huddle, priority: annT.priority });
    Object.assign(annT, { text: '', stance: null, pause: null, sprint: false, huddle: false, priority: true, touched: {} }); closeModal();
    if (walk.on) { const d = Math.hypot(P.x - PODIUM.x, P.z - PODIUM.z); if (d < 6) P.face = Math.PI; }
  };
  annDirs(); annHist();
}
function annDirs() {
  const el = $('annDirs'); if (!el) return;
  const chip = (k, v, label) => `<button class="btn sm ${String(annT[k]) === v ? 'on' : ''}" data-ad="${k}|${v}" aria-pressed="${String(annT[k]) === v}">${label}</button>`;
  el.innerHTML = `<div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-top:10px"><span class="muted" style="width:120px;font-size:12.5px">Risk stance today</span>
      ${chip('stance', 'defensive', '🛡 Defensive (0.5x)')}${chip('stance', 'normal', 'Normal')}${chip('stance', 'press', '🚀 Press (1.25x)')}${chip('stance', 'null', '—')}</div>
    <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-top:6px"><span class="muted" style="width:120px;font-size:12.5px">New entries</span>
      ${chip('pause', '1h', '⏸ Pause 1 hour')}${chip('pause', 'close', '⏸ Pause until close')}${chip('pause', 'resume', '▶ Resume')}${chip('pause', 'null', '—')}</div>
    <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-top:6px"><span class="muted" style="width:120px;font-size:12.5px">Also</span>
      ${chip('sprint', 'true', '🧪 Research sprint (24 h)')}${chip('huddle', 'true', '👥 Huddle now')}${chip('priority', 'true', '📌 Standing priority (7 days)')}</div>`;
  el.querySelectorAll('[data-ad]').forEach(b => b.onclick = () => { const [k, v] = b.dataset.ad.split('|'); annT.touched[k] = true;
    if (k === 'sprint' || k === 'huddle' || k === 'priority') annT[k] = !annT[k]; else annT[k] = v === 'null' ? null : v; annDirs(); });
}
function annHist() {
  const el = $('annHist'), C = snap?.cio; if (!el || !C) return;
  el.innerHTML = (C.priorities?.length ? `<h3 style="margin:14px 0 6px">Standing priorities</h3>${C.priorities.map(p => `<div class="rlog" style="display:flex;justify-content:space-between;gap:8px"><span>📌 ${esc(p.text)} <span class="faint">until ${new Date(p.until * 1000).toLocaleDateString()}</span></span><button class="btn sm" data-pdrop="${esc(p.id)}" aria-label="Remove">✕</button></div>`).join('')}` : '')
    + (C.announcements?.length ? `<h3 style="margin:14px 0 6px">Recent announcements</h3>${C.announcements.slice(0, 5).map(a => `<div class="rlog">“${esc(a.text || '(directives only)')}”${a.did?.length ? ` <span class="faint">→ ${esc(a.did.join('; '))}</span>` : ''} <span class="faint">${new Date(a.t * 1000).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}</span></div>`).join('')}` : '');
  el.querySelectorAll('[data-pdrop]').forEach(b => b.onclick = () => { send({ type: 'priority_drop', id: b.dataset.pdrop }); b.closest('.rlog').remove(); });
}
function announceFx(e) {                // the floor stops and turns to the podium
  const box = document.createElement('div'); box.className = 'annBanner';
  box.innerHTML = `<div class="who">📣 ${e.praise ? 'Shout-out from Jason' : 'Jason · floor announcement'}</div><div class="txt">${esc(e.text)}</div>${(e.did || []).length ? `<div class="dirs">${e.did.map(d => `<span>${esc(d)}</span>`).join('')}</div>` : ''}`;
  document.body.appendChild(box); void box.offsetWidth; setTimeout(() => box.classList.add('on'), 30);
  setTimeout(() => { box.classList.remove('on'); setTimeout(() => box.remove(), 600); }, 7500);
  beep([784, 988, 1175], 'sine', 0.06, 0.16);
  for (const a of Object.values(agents)) { if (a.hidden || a.leaving || !inFund(a)) continue;
    if (a.seated && !a.path.length) { a.swivelUntil = performance.now() + 8000; setTimeout(() => gest(a, 'nod', 1600), 1500 + Math.random() * 2500); }
    else if (!a.path.length) { a.face = Math.atan2(PODIUM.x - a.x, PODIUM.z - a.z); setTimeout(() => gest(a, 'nod', 1600), 1500 + Math.random() * 2500); } }
  if (e.praise && e.target && agents[e.target]) { const t = agents[e.target]; t.glowUntil = performance.now() + 6000; feel(t, 'happy', 12000); confetti(t.x, 2.4, t.z, 70);
    for (const b of Object.values(agents)) if (b.seated && inFund(b) && b !== t) setTimeout(() => gest(b, 'clap', 2400), 600 + Math.random() * 900); }
  if (walk.on && Math.hypot(P.x - PODIUM.x, P.z - PODIUM.z) < 8) pSay(e.text.length > 70 ? e.text.slice(0, 67) + '…' : e.text, 5000);
}

// ── team management: shout-outs, warnings, boosts, the lab, the bench ──
let fireArm = null;
function openManage() { modal('manage', '👥 Manage the team', `<div class="muted" style="font-size:12.5px">Your calls go through the CIO. A <b>warning</b> puts a PM on watch (half size on new trades for 5 days); a <b>boost</b> gives 1.25x on new trades for 5 days, still inside every limit; <b>send to lab</b> puts its strategy first in line for Ava.</div>
  <input id="teamNote" maxlength="160" placeholder="Optional note (shown with shout-outs and warnings)" aria-label="Note" style="width:100%;box-sizing:border-box;margin:10px 0;background:var(--bg2);color:var(--text);border:1px solid var(--border2);border-radius:8px;padding:7px 9px">
  <div id="teamBody"></div>`); renderManage(); }
function renderManage() {
  const el = $('teamBody'), C = snap?.cio; if (!el || !snap) return;
  if (el.contains(document.activeElement) && document.activeElement.tagName === 'BUTTON' && fireArm) return;
  el.innerHTML = (snap.roster || []).map(p => { const w = C?.watch?.[p.id], st = C?.star?.[p.id], b = C?.boost?.[p.id];
    const chips = [p.status !== 'active' ? `<span class="tchip">${esc(p.status)}</span>` : '', w ? `<span class="tchip" style="color:#fbbf24">on watch</span>` : '', st ? '<span class="tchip" style="color:#facc15">★ star</span>' : '', b ? '<span class="tchip" style="color:#a78bfa">boost 1.25x</span>' : ''].join('');
    return `<div class="pod" style="margin:8px 0;padding:10px 12px;border-left:3px solid ${COLORS[p.id] || '#888'}">
      <div style="display:flex;justify-content:space-between;gap:8px;align-items:center;flex-wrap:wrap"><div><b style="color:${COLORS[p.id] || '#fff'}">${esc(p.name)}</b> ${chips}
        <div class="faint" style="font-size:11.5px">${esc(p.desc || p.family)}</div></div>
        <div class="mono" style="font-size:12.5px;text-align:right"><span class="${cls(p.pnl)}">${money(p.pnl)}</span> · capital ${(p.alloc * 100).toFixed(0)}% · risk ${p.risk == null ? '—' : (p.risk * 100).toFixed(1) + '%'}</div></div>
      ${w ? `<div class="faint" style="font-size:11.5px;color:#fbbf24">Watch: ${esc(w.why)}</div>` : ''}
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px">
        <button class="btn sm" data-mg="${p.id}|shout">👏 Shout-out</button>
        ${w ? `<button class="btn sm" data-mg="${p.id}|unwatch">Clear watch</button>` : `<button class="btn sm" data-mg="${p.id}|warn">⚠ Warn</button>`}
        ${b ? `<button class="btn sm" data-mg="${p.id}|unboost">Remove boost</button>` : `<button class="btn sm" data-mg="${p.id}|boost">🚀 Boost</button>`}
        ${p.family !== 'options' ? `<button class="btn sm" data-mg="${p.id}|lab">🧪 Send to lab</button>` : ''}
        <button class="btn sm" data-bench="${p.id}|${p.status === 'benched' ? 0 : 1}">${p.status === 'benched' ? '▶ Unbench' : '⏸ Bench'}</button>
        ${p.founder ? '' : `<button class="btn sm" data-fire="${p.id}" style="${fireArm === p.id ? 'background:#7f1d1d;border-color:#ef4444' : ''}">${fireArm === p.id ? 'Confirm: fire?' : 'Fire'}</button>`}</div></div>`; }).join('');
  el.querySelectorAll('[data-mg]').forEach(x => x.onclick = () => { const [agent, action] = x.dataset.mg.split('|'); send({ type: 'manage', agent, action, note: $('teamNote')?.value || '' }); x.disabled = true; x.textContent = '✓ sent'; });
  el.querySelectorAll('[data-bench]').forEach(x => x.onclick = () => { const [agent, on] = x.dataset.bench.split('|'); send({ type: 'bench', agent, on: on === '1' }); x.disabled = true; });
  el.querySelectorAll('[data-fire]').forEach(x => x.onclick = () => { const id = x.dataset.fire; if (fireArm !== id) { fireArm = id; renderManage(); setTimeout(() => { if (fireArm === id) { fireArm = null; renderManage(); } }, 5000); return; }
    fireArm = null; send({ type: 'fire', agent: id }); x.disabled = true; x.textContent = 'fired'; });
}

// ── the CIO console (the CIO's desk): risk mode, the plan, every decision and whether it helped ──
function openCIO() { modal('cio', 'CIO console', '<div id="cioBody"></div>'); renderCIO(); }
function renderCIO() {
  const el = $('cioBody'), C = snap?.cio; if (!el || !C) return;
  const F = C.fund, S = C.scorecard, stat = (k, v, c = '') => `<div><b>${k}</b><span class="mono ${c}">${v}</span></div>`;
  const MODE = { normal: ['NORMAL', 'up'], defensive: ['DEFENSIVE', ''], preservation: ['PRESERVATION', 'down'] }[F.mode] || [F.mode, ''];
  const when = t => new Date(t * 1000).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
  const row = (k, b) => `<tr><td class="t">${k}</td><td>${b.n}</td><td class="${b.avg_r == null ? '' : cls(b.avg_r)}">${b.avg_r == null ? '—' : (b.avg_r >= 0 ? '+' : '') + b.avg_r.toFixed(2) + 'R'}</td><td class="${cls(b.pnl)}">${money(b.pnl)}</td></tr>`;
  const people = (o, label, col) => Object.values(o || {}).length ? `<div style="margin:4px 0"><b style="color:${col}">${label}:</b> ${Object.values(o).map(x => `${esc(x.name)}${x.why ? ` <span class="faint">(${esc(x.why.slice(0, 90))})</span>` : ''}`).join(' · ')}</div>` : '';
  el.innerHTML = `<div class="stat-grid" style="grid-template-columns:repeat(4,1fr)">${stat('Risk mode', MODE[0], MODE[1])}${stat('Drawdown', pct(F.dd))}${stat('Fund vol', F.vol == null ? 'needs 10 days' : `${(F.vol * 100).toFixed(0)}% (target ${(C.vol_target * 100).toFixed(0)}%)`)}${stat('New trades size at', F.mult.toFixed(2) + 'x', F.mult > 1.02 ? 'up' : F.mult < 0.98 ? 'down' : '')}
      ${stat('Your mandate', F.mandate ? `${F.mandate.stance} · until ${when(F.mandate.until)}` : 'none')}${stat('New entries', F.paused ? `paused · until ${when(F.pause_until)}` : 'open', F.paused ? 'down' : '')}${stat('Research sprint', C.sprint_until ? 'until ' + when(C.sprint_until) : 'off')}${stat('Lab next', C.lab_focus ? esc(C.lab_focus) : 'Ava picks')}</div>
    <div style="display:flex;gap:6px;flex-wrap:wrap;margin:12px 0"><button class="btn on" data-announce="1">📣 Floor announcement</button><button class="btn" data-team="1">👥 Manage the team</button><button class="btn" id="cioPlan">📝 Write today's plan</button><button class="btn" id="cioPolicy">⚙ Risk policy</button></div>
    ${C.plan ? `<h3 style="margin:12px 0 6px">Morning plan · ${esc(C.plan.day)}</h3>${C.plan.lines.map(l => `<div style="font-size:13px;margin:3px 0">• ${esc(l)}</div>`).join('')}` : ''}
    ${C.priorities?.length ? `<h3 style="margin:12px 0 6px">Your standing priorities</h3>${C.priorities.map(p => `<div style="font-size:13px">📌 ${esc(p.text)}</div>`).join('')}` : ''}
    ${people(C.watch, 'On watch (half size)', '#fbbf24')}${people(C.star, '★ Stars (1.15x)', '#facc15')}${people(C.boost, 'Your boosts (1.25x)', '#a78bfa')}
    ${people(C.beta, 'Beta, not alpha: entries do not beat random (half size)', '#94a3b8')}
    <h3 style="margin:14px 0 6px">Does the CIO add value?</h3>
    <div class="muted" style="font-size:12px;margin-bottom:6px">Every sizing call is graded when the trade closes. "Added" = the P&L the CIO's multipliers changed versus trading everything at full size.</div>
    <table><thead><tr><th>Sized</th><th>Trades</th><th>Avg R</th><th>P&L</th></tr></thead><tbody>${row('Cut (< 1x)', S.cut)}${row('Full (1x)', S.full)}${row('Boosted (> 1x)', S.boosted)}</tbody></table>
    <div class="mono" style="margin-top:6px;font-size:13px">CIO sizing added <b class="${cls(S.added)}">${money(S.added)}</b> over ${S.n} closed trades · ${S.passes} trades passed</div>
    <h3 style="margin:14px 0 6px">Recent decisions</h3>${(C.decisions || []).length ? C.decisions.map(d => `<div class="rlog ${d.verdict === 'PASS' ? 'fail' : 'pass'}" style="font-size:12.5px"><b>${esc(d.name)}</b> ${esc(d.sym)} ${d.side > 0 ? '▲' : d.side < 0 ? '▼' : ''} · ${d.verdict === 'PASS' ? '<b>PASS</b>' : `${d.mult.toFixed(2)}x`}
      ${d.why?.length ? `<span class="faint">· ${esc(d.why.join('; '))}</span>` : ''} ${d.out ? `· <span class="${cls(d.out.pnl)}">${money(d.out.pnl)}${d.out.r == null ? '' : ` (${d.out.r >= 0 ? '+' : ''}${d.out.r.toFixed(2)}R)`}</span>` : d.verdict === 'PASS' ? '' : '<span class="faint">· open</span>'} <span class="faint">${when(d.t)}</span></div>`).join('') : '<div class="faint">No decisions yet: they appear as PMs bring trades.</div>'}`;
  $('cioPlan').onclick = () => { send({ type: 'cio_plan' }); $('cioPlan').disabled = true; };
  $('cioPolicy').onclick = () => openSettings();
}
document.addEventListener('click', ev => { const t = ev.target.closest && ev.target.closest('[data-announce],[data-team],[data-cio]'); if (!t) return;
  t.dataset.announce ? openAnnounce() : t.dataset.team ? openManage() : openCIO(); });

// ── the Model Lab window: every model with its validation, the volatility models, and a model builder for Jason ──
let mlabFull = null, mlabTab = 'models', mlabPick = null, mlabTimer = null;
const mlBuild = { name: '', hypothesis: '', features: ['ret_63', 'ret_252', 'dist_ma200', 'vol_ratio'], horizon: 21, learner: 'ridge', style: 'timing', direction: 'both' };
async function loadMlab() { try { mlabFull = await (await fetch('/api/mlab')).json(); } catch { /* keep the last copy */ } renderMlab(); }
function openMlab(tab) { if (tab) mlabTab = tab; modal('mlab', 'Model Lab · Kai, ML quant research', '<div id="mlBody"><div class="faint">Loading models…</div></div>'); loadMlab();
  clearInterval(mlabTimer); mlabTimer = setInterval(() => { if (modalKind !== 'mlab') { clearInterval(mlabTimer); return; } loadMlab(); }, 20000); }
function mlSpark(pts, col = 'var(--green)', W = 640, H = 120, base = 1) {
  if (!pts || pts.length < 3) return '';
  const vs = pts.map(p => p[1]), lo = Math.min(base, ...vs), hi = Math.max(base, ...vs), X = i => 4 + i / (vs.length - 1) * (W - 8), Y = v => 6 + (1 - (v - lo) / (hi - lo || 1)) * (H - 20);
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Out-of-sample equity"><line x1="4" x2="${W - 4}" y1="${Y(base)}" y2="${Y(base)}" stroke="var(--border2)" stroke-dasharray="4 4"/>
    <path d="${vs.map((v, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join('')}" fill="none" stroke="${col}" stroke-width="2"/>
    <text x="6" y="${H - 3}" fill="var(--muted)" font-size="11">${esc(pts[0][0])}</text><text x="${W - 6}" y="${H - 3}" fill="var(--muted)" font-size="11" text-anchor="end">${esc(pts[pts.length - 1][0])}</text></svg>`;
}
const vp = x => x == null ? '—' : Math.round(x * 100) + '%';
function renderMlab() {
  const el = $('mlBody'), M = mlabFull; if (!el) return;
  if (!M) { el.innerHTML = '<div class="faint">Loading…</div>'; return; }
  const tabs = [['models', `Models (${M.n_tests} tested)`], ['vol', 'Volatility models'], ['build', 'Build a model']];
  const stat = (k, v, c = '') => `<div><b>${k}</b><span class="mono ${c}">${v}</span></div>`;
  let h = `<div style="display:flex;gap:6px;margin-bottom:10px">${tabs.map(([k, l]) => `<button class="btn sm ${mlabTab === k ? 'on' : ''}" data-mlt="${k}">${l}</button>`).join('')}</div>`;
  if (mlabTab === 'models') {
    h += `<div class="muted" style="font-size:12.5px">Each model: features → forecast → trading rule, retrained every quarter walk-forward with a purge gap. It must show out-of-sample skill (IC t ≥ ${M.need_t.toFixed(2)} after ${M.n_tests} models), beat randomly shifted forecasts, earn a Sharpe ≥ 0.4 after costs, beat buy-and-hold (alpha t ≥ 2), work in most years, pass a sealed 2-year holdout, and survive real stops and exits. ${M.running ? `<b>Kai is working: ${esc(M.status)}${M.current ? ` on “${esc(M.current.name)}”` : ''}.</b>` : `Next model in ${Math.ceil(M.next_in / 60)} min.`}</div>
      <table style="margin-top:10px;font-size:12.5px"><thead><tr><th>Model</th><th>By</th><th>Learner</th><th>Horizon</th><th>IC (t)</th><th>Holdout IC</th><th>Sharpe dev / hold</th><th></th></tr></thead><tbody>
      ${(M.models || []).map(m => `<tr data-mlp="${m.id}" style="cursor:pointer;${mlabPick === m.id ? 'background:var(--bg2)' : ''}"><td class="t"><b>${esc(m.name)}</b><div class="faint" style="font-size:11px">${esc(m.style === 'cross_section' ? 'cross-section' : 'timing')}</div></td><td class="t">${esc(nameOf(m.by))}</td><td class="t">${esc(m.learner)}</td><td>${m.horizon}d</td>
        <td class="${cls(m.ic)}">${(m.ic >= 0 ? '+' : '') + m.ic.toFixed(3)} (${m.ic_t.toFixed(1)})</td><td class="${cls(m.ic_hold)}">${(m.ic_hold >= 0 ? '+' : '') + m.ic_hold.toFixed(3)}</td><td>${m.sharpe.toFixed(2)} / ${m.sharpe_hold.toFixed(2)}</td>
        <td><span class="tchip" style="color:${m.passed ? '#22c55e' : '#f43f5e'}">${m.passed ? esc(m.status || 'pass') : 'fail'}</span></td></tr>`).join('') || '<tr><td class="t faint" colspan="8">No models yet: Kai starts a few minutes after a restart.</td></tr>'}</tbody></table>`;
    const m = (M.models || []).find(x => x.id === mlabPick) || (M.models || [])[0];
    if (m) {
      const imp = Object.entries(m.importance || {}).slice(0, 10), mx = Math.max(0.01, ...imp.map(x => x[1]));
      const yrs = Object.entries(m.ic_years || {}), ymx = Math.max(0.02, ...yrs.map(([, v]) => Math.abs(v)));
      const check = (ok, txt) => `<div style="font-size:12.5px;margin:2px 0">${ok ? '✅' : '❌'} ${txt}</div>`;
      h += `<div class="pod" style="margin-top:12px;padding:12px 14px"><div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap"><b style="font-size:15px">${esc(m.name)}</b><span class="faint" style="font-size:12px">by ${esc(nameOf(m.by))} · ${new Date(m.t * 1000).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span></div>
        <div class="muted" style="font-size:12.5px;margin:4px 0 8px">${esc(m.hypothesis || '')}</div>
        <div class="stat-grid" style="grid-template-columns:repeat(4,1fr)">${stat('IC dev (t)', `${(m.ic >= 0 ? '+' : '') + m.ic.toFixed(3)} (${m.ic_t.toFixed(2)})`, cls(m.ic))}${stat('Holdout IC', (m.ic_hold >= 0 ? '+' : '') + m.ic_hold.toFixed(3), cls(m.ic_hold))}${stat('Sharpe dev / hold', `${m.sharpe.toFixed(2)} / ${m.sharpe_hold.toFixed(2)}`)}${stat('Alpha vs hold (t)', `${pct(m.alpha, 1)} (${m.alpha_t.toFixed(1)})`, cls(m.alpha))}
          ${stat('Beta to buy-and-hold', m.beta.toFixed(2))}${stat('Turnover / costs', `${m.turnover.toFixed(0)}x / ${(m.cost_yr * 100).toFixed(2)}%/yr`)}${stat('Max drawdown (10% vol)', pct(m.maxdd, 0))}${stat('Null test p', m.perm_p.toFixed(2), m.perm_p <= 0.05 ? 'up' : 'down')}</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-top:10px"><div><h3 style="margin:0 0 6px">The gate</h3>
          ${check(m.ic > 0 && m.ic_t >= m.need_t, `IC significant (t ${m.ic_t.toFixed(2)} vs ${m.need_t.toFixed(2)})`)}${check(m.perm_p <= 0.05, `beats randomly shifted forecasts (p ${m.perm_p.toFixed(2)})`)}${check(m.sharpe >= 0.4, `Sharpe ≥ 0.4 after costs (${m.sharpe.toFixed(2)})`)}
          ${check(m.alpha_t >= 2, `alpha vs buy-and-hold (t ${m.alpha_t.toFixed(1)})`)}${check(m.pos_years >= 0.6, `IC positive in ≥ 60% of years (${Math.round(m.pos_years * 100)}%)`)}${check(m.ic_hold > 0 && m.sharpe_hold > 0, `sealed holdout from ${esc(m.holdout_from)}`)}
          ${m.trade_pf != null ? check(m.trade_pf >= 1.1, `survives stops, exits and costs (traded PF ${m.trade_pf.toFixed(2)})`) : ''}
          <div class="faint" style="font-size:11.5px;margin-top:6px">${esc(m.why)}</div></div>
          <div><h3 style="margin:0 0 6px">What drives the forecast</h3>${imp.map(([k, v]) => `<div class="gauge" style="margin:2px 0 6px"><div class="l"><span title="${esc(M.features?.[k] || '')}">${esc(k)} ${m.signs?.[k] > 0 ? '<span class="up">▲</span>' : m.signs?.[k] < 0 ? '<span class="down">▼</span>' : ''}</span><span class="mono" style="color:var(--text)">${Math.round(v * 100)}%</span></div><div class="bar" style="margin:1px 0"><i style="width:${v / mx * 100}%;background:#a3e635"></i></div></div>`).join('')}</div></div>
        <h3 style="margin:12px 0 4px">Out-of-sample equity (walk-forward, 10% vol, after costs)</h3>${mlSpark(M.curves?.[m.id], m.sharpe >= 0 ? 'var(--green)' : 'var(--red)')}
        <h3 style="margin:10px 0 4px">IC by year</h3><div style="display:flex;align-items:flex-end;gap:3px;height:70px">${yrs.map(([y, v]) => `<div title="${y}: ${v.toFixed(3)}" style="flex:1;display:flex;flex-direction:column;justify-content:flex-end;align-items:center;height:100%"><div style="width:100%;height:${Math.abs(v) / ymx * 50}px;background:${v >= 0 ? 'var(--green)' : 'var(--red)'};border-radius:3px"></div><span class="faint" style="font-size:9px">${String(y).slice(2)}</span></div>`).join('')}</div>
        <div class="faint" style="font-size:11.5px;margin-top:6px">Features: ${m.features.map(esc).join(', ')}</div></div>`;
    }
  } else if (mlabTab === 'vol') {
    h += `<div class="muted" style="font-size:12.5px">Option sellers earn the volatility risk premium: implied vol usually sits above the volatility that follows. Kai's HAR model forecasts next month's realized vol; Opal sells a 30-day iron condor only where the backtest (18 years of implied vol for ETFs, Deribit DVOL for crypto, priced with skew and 6% bid-ask costs, managed with her live rules) validated it. <b>Model</b> = sell when IV / forecast ≥ k. <b>Premium</b> = selling works but timing adds nothing. <b>None</b> = no edge: stand aside.</div>`;
    for (const [s, v] of Object.entries(M.vol || {})) {
      const row = (k, x) => x ? `<tr><td class="t">${k}</td><td>${x.dev.n}</td><td class="${cls(x.dev.avg)}">${(x.dev.avg >= 0 ? '+' : '') + x.dev.avg.toFixed(3)}R</td><td>${Math.round(x.dev.win * 100)}%</td><td>${x.dev.t.toFixed(1)}</td><td>${x.hold.n}</td><td class="${cls(x.hold.avg)}">${(x.hold.avg >= 0 ? '+' : '') + x.hold.avg.toFixed(3)}R</td><td>${x.hold.worst.toFixed(2)}</td></tr>` : '';
      const q = v.quality?.holdout || {}, tierC = v.tier === 'model' ? '#22c55e' : v.tier === 'premium' ? '#facc15' : '#64748b';
      const W = 640, H = 120, all = [...(v.iv_curve || []), ...(v.rv_curve || []), ...(v.curve || [])].map(p => p[1]), lo = Math.min(...all), hi = Math.max(...all);
      const path = (pts, col, dash = '') => pts?.length > 2 ? `<path d="${pts.map((p, i) => `${i ? 'L' : 'M'}${(4 + i / (pts.length - 1) * (W - 8)).toFixed(1)},${(6 + (1 - (p[1] - lo) / (hi - lo || 1)) * (H - 12)).toFixed(1)}`).join('')}" fill="none" stroke="${col}" stroke-width="2" ${dash}/>` : '';
      h += `<div class="pod" style="margin:10px 0;padding:12px 14px;border-left:3px solid ${tierC}"><div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap"><b style="font-size:15px">${esc(s)} <span class="tchip" style="color:${tierC}">${esc((v.tier || 'none').toUpperCase())}${v.tier === 'model' && v.k ? ` k=${v.k}` : ''}</span></b>
        <span class="mono" style="font-size:12.5px">IV ${vp(v.now?.iv)} · realized ${vp(v.now?.rv)} · forecast ${vp(v.now?.fc)} · ratio <b>${v.now?.ratio ? v.now.ratio.toFixed(2) + 'x' : '—'}</b></span></div>
        <svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Implied vs realized vs forecast vol">${path(v.iv_curve, '#f472b6')}${path(v.rv_curve, '#64748b')}${path(v.curve, '#a3e635', 'stroke-dasharray="5 4"')}</svg>
        <div class="faint" style="font-size:11px"><span style="color:#f472b6">━</span> implied vol · <span style="color:#64748b">━</span> realized (1 month) · <span style="color:#a3e635">┅</span> HAR forecast · last 12 months</div>
        <table style="font-size:12px;margin-top:6px"><thead><tr><th>Seller</th><th>Trades</th><th>Avg</th><th>Win</th><th>t</th><th>Holdout trades</th><th>Holdout avg</th><th>Worst</th></tr></thead><tbody>${row('Always sell', v.always)}${row('Naive (IV/RV ≥ 1.2)', v.naive)}${row('Model (IV/forecast ≥ k)', v.model)}</tbody></table>
        <div class="faint" style="font-size:11px;margin-top:4px">Forecast error (log vol, holdout): HAR ${q.har?.toFixed(3) ?? '—'} · last month's vol ${q.naive?.toFixed(3) ?? '—'} · implied vol ${q.iv?.toFixed(3) ?? '—'}. Average implied minus realized: ${q.iv_premium != null ? (q.iv_premium * 100).toFixed(1) + ' vol points' : '—'}.</div>
        ${snap?.voldesk?.last?.[s] ? `<div style="font-size:12px;margin-top:4px">Opal: ${esc(snap.voldesk.last[s])}</div>` : ''}</div>`;
    }
    h += `<div class="faint" style="font-size:12px">${esc(snap?.voldesk?.note || '')}</div>`;
  } else {
    const B = mlBuild;
    h += `<div class="muted" style="font-size:12.5px">Design a forecasting model from the same feature library Kai uses. It goes through the full gate, counts toward the multiple-testing bar, and if it passes it's hired (or incubated) as a PM credited to you.</div>
      <div style="display:flex;gap:8px;margin:10px 0;flex-wrap:wrap"><input id="mbName" maxlength="40" placeholder="Model name" value="${esc(B.name)}" style="flex:1;min-width:180px;background:var(--bg2);color:var(--text);border:1px solid var(--border2);border-radius:8px;padding:7px 9px">
        <input id="mbHyp" maxlength="200" placeholder="Hypothesis: why should this predict returns?" value="${esc(B.hypothesis)}" style="flex:2;min-width:240px;background:var(--bg2);color:var(--text);border:1px solid var(--border2);border-radius:8px;padding:7px 9px"></div>
      ${Object.entries(M.groups || {}).map(([g, fs]) => `<div style="margin:6px 0"><b style="font-size:12px;text-transform:uppercase;letter-spacing:.5px" class="muted">${esc(g.replace('_', ' '))}</b><div style="display:flex;gap:5px;flex-wrap:wrap;margin-top:4px">${fs.map(k => `<button class="btn sm ${B.features.includes(k) ? 'on' : ''}" data-mbf="${k}" title="${esc(M.features?.[k] || '')}">${esc(k)}</button>`).join('')}</div></div>`).join('')}
      <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-top:10px"><span class="muted" style="width:90px;font-size:12.5px">Horizon</span>${(M.horizons || [1, 5, 21]).map(x => `<button class="btn sm ${B.horizon === x ? 'on' : ''}" data-mbh="${x}">${x} day${x > 1 ? 's' : ''}</button>`).join('')}</div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-top:6px"><span class="muted" style="width:90px;font-size:12.5px">Learner</span>${Object.entries(M.learners || {}).map(([k, d]) => `<button class="btn sm ${B.learner === k ? 'on' : ''}" data-mbl="${k}" title="${esc(d)}">${esc(k)}</button>`).join('')}</div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-top:6px"><span class="muted" style="width:90px;font-size:12.5px">Style</span><button class="btn sm ${B.style === 'timing' ? 'on' : ''}" data-mbs="timing">Timing (each market)</button><button class="btn sm ${B.style === 'cross_section' ? 'on' : ''}" data-mbs="cross_section">Cross-section (rank markets)</button></div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-top:6px"><span class="muted" style="width:90px;font-size:12.5px">Trades</span>${['both', 'long', 'short'].map(d => `<button class="btn sm ${B.direction === d ? 'on' : ''}" data-mbd="${d}">${d === 'both' ? 'Long & short' : d + ' only'}</button>`).join('')}</div>
      <div style="margin-top:12px"><button class="btn on" id="mbRun" ${M.running ? 'disabled' : ''}>${M.running ? 'Kai is busy: try in a minute' : `Train & validate (${B.features.length} features)`}</button></div>`;
  }
  el.innerHTML = h;
  el.querySelectorAll('[data-mlt]').forEach(b => b.onclick = () => { mlabTab = b.dataset.mlt; renderMlab(); });
  el.querySelectorAll('[data-mlp]').forEach(r => r.onclick = () => { mlabPick = r.dataset.mlp; renderMlab(); });
  el.querySelectorAll('[data-mbf]').forEach(b => b.onclick = () => { const k = b.dataset.mbf; mlBuild.features = mlBuild.features.includes(k) ? mlBuild.features.filter(x => x !== k) : [...mlBuild.features, k].slice(0, 10); renderMlab(); });
  el.querySelectorAll('[data-mbh]').forEach(b => b.onclick = () => { mlBuild.horizon = +b.dataset.mbh; renderMlab(); });
  el.querySelectorAll('[data-mbl]').forEach(b => b.onclick = () => { mlBuild.learner = b.dataset.mbl; renderMlab(); });
  el.querySelectorAll('[data-mbs]').forEach(b => b.onclick = () => { mlBuild.style = b.dataset.mbs; renderMlab(); });
  el.querySelectorAll('[data-mbd]').forEach(b => b.onclick = () => { mlBuild.direction = b.dataset.mbd; renderMlab(); });
  const nm = $('mbName'), hy = $('mbHyp'); if (nm) nm.oninput = () => { mlBuild.name = nm.value; }; if (hy) hy.oninput = () => { mlBuild.hypothesis = hy.value; };
  const run = $('mbRun'); if (run) run.onclick = () => { if (mlBuild.features.length < 2) return; send({ type: 'model_test', ...mlBuild }); run.disabled = true; run.textContent = 'Sent to Kai: watch the feed';
    if (agents.kai) act('kai', say('Training your model now, Jason. Walk-forward, purged, holdout sealed.', 3000)); setTimeout(() => { mlabTab = 'models'; loadMlab(); }, 4000); };
}
document.addEventListener('click', ev => { if (ev.target.closest && ev.target.closest('[data-mlab]')) openMlab(); });

// ── your office: the founder's hub + the bookshelf ──
const READING = [
  ['Advances in Financial Machine Learning', 'Marcos López de Prado', 'Why most backtests lie: purging, embargoes, the deflated Sharpe, meta-labeling. The Model Lab is built on these ideas.'],
  ['Active Portfolio Management', 'Grinold & Kahn', 'The information coefficient, breadth and the fundamental law: how forecasting skill becomes returns.'],
  ['Options, Futures, and Other Derivatives', 'John C. Hull', 'The standard text behind Opal: Black-Scholes, the Greeks, volatility smiles.'],
  ['Expected Returns', 'Antti Ilmanen', 'Where returns come from: risk premia, carry, momentum, value, volatility selling.'],
  ['Trading and Exchanges', 'Larry Harris', 'Market microstructure: who you trade against and why costs matter.'],
  ['Quantitative Trading', 'Ernest P. Chan', 'A practical first book on building and testing systematic strategies.'],
  ['The Man Who Solved the Market', 'Gregory Zuckerman', 'Jim Simons and Renaissance: what a real quant firm looks like.'],
  ['Fooled by Randomness', 'Nassim Nicholas Taleb', "Luck vs skill: the reason Kai's gate is so strict."],
  ['Thinking, Fast and Slow', 'Daniel Kahneman', 'The behavioral biases many market anomalies come from.'],
];
function openBooks() { modal('books', '📚 The quant reading list', `<div class="muted" style="font-size:12.5px">The books behind the way this fund is built, best read in roughly this order.</div>
  ${READING.map(([t, a, w], i) => `<div class="pod" style="margin:8px 0;padding:10px 12px"><b>${i + 1}. ${esc(t)}</b> <span class="faint">· ${esc(a)}</span><div class="muted" style="font-size:12.5px;margin-top:3px">${esc(w)}</div></div>`).join('')}`); }
function openOffice() {
  const s = snap; if (!s) return;
  const M = s.mydesk, C2 = s.cio?.fund, stat = (k, v, c = '') => `<div><b>${k}</b><span class="mono ${c}">${v}</span></div>`;
  const tile = (attr, ic, label, sub) => `<button class="pod" ${attr} style="margin:0;padding:12px;text-align:left;cursor:pointer;background:var(--bg2);border:1px solid var(--border2);border-radius:12px;color:var(--text)"><div style="font-size:22px">${ic}</div><div style="font-weight:700;margin-top:4px">${label}</div><div class="faint" style="font-size:11.5px">${sub}</div></button>`;
  modal('office', 'Your office · JB Capital', `<div class="stat-grid" style="grid-template-columns:repeat(4,1fr)">${stat('NAV', s.nav.toFixed(2), cls(s.nav - 100))}${stat('Today', pct(s.day_ret), cls(s.day_ret))}${stat('CIO risk mode', (C2?.mode || '—').toUpperCase() + (C2 ? ` · ${C2.mult.toFixed(2)}x` : ''))}${stat('Your desk', M ? money(M.realized + M.upl) : '—', M ? cls(M.realized + M.upl) : '')}</div>
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:8px;margin-top:12px">
      ${tile('data-announce="1"', '📣', 'Floor announcement', 'Set priorities and directives')}${tile('data-team="1"', '👥', 'Manage the team', 'Shout-outs, warnings, boosts')}
      ${tile('data-cio="1"', '🧭', 'CIO console', 'Risk mode, decisions, scorecard')}${tile('data-mlab="1"', '🧠', 'Model Lab', 'Kai\'s models and the vol models')}
      ${tile('data-mydesk="1"', '🪙', 'Your trading desk', 'Trade alongside the PMs')}${tile('data-builder="1"', '🧪', 'Strategy Builder', 'Backtest your own rules')}
      ${tile('data-tear="1"', '📄', 'Fund tear sheet', 'What an investor sees')}${tile('data-stress="1"', '⚡', 'Stress test', 'Shock the live book')}
      ${tile('data-away="1"', '🕒', 'While you were away', 'What changed since your last visit')}${tile('data-trophies="1"', '🏆', 'Trophy case', 'Your achievements')}
      ${tile('data-riskrep="1"', '🛡', 'Risk report', 'VaR, expected shortfall, factors')}${tile('data-compliance="1"', '⚖', 'Compliance', 'Restricted list and the log')}
      ${tile('data-reports="1"', '📑', 'Reports', 'End-of-day reports, investor statement')}${tile('data-experiment="1"', '📈', 'Experiment update', 'Your two-weekly LinkedIn scoreboard')}${tile('data-books="1"', '📚', 'Reading list', 'The books behind the fund')}${tile('id="offPolicy"', '⚙', 'Risk policy', 'The fund-wide limits')}</div>`);
  $('offPolicy').onclick = () => openSettings();
}
document.addEventListener('click', ev => { const t = ev.target.closest && ev.target.closest('[data-books],[data-office]'); if (!t) return; t.dataset.books ? openBooks() : openOffice(); });

// ── compliance (Lena), the risk report (Rex), reports & the investor statement (Sam / ops), the front desk (Ari) ──
function openCompliance() { modal('compliance', 'Compliance · Lena', '<div id="cmpBody"></div>'); renderCompliance(true); }
function renderCompliance(full) {
  const el = $('cmpBody'), K = snap?.compliance; if (!el || !K) return;
  if (!full && el.contains(document.activeElement) && document.activeElement.tagName === 'INPUT') return;
  const stat = (k, v, c = '') => `<div><b>${k}</b><span class="mono ${c}">${v}</span></div>`;
  el.innerHTML = `<div class="muted" style="font-size:12.5px">Every order (the PMs', Opal's, Kai's models' and yours) goes through Lena before Rex sizes it.</div>
    <div class="stat-grid" style="grid-template-columns:repeat(4,1fr);margin:10px 0">${stat('Checked today', K.today.n)}${stat('Blocked', K.today.blocked, K.today.blocked ? 'down' : '')}${stat('Flagged', K.today.flagged)}${stat('Restricted names', K.restricted.length)}</div>
    <h3 style="margin:8px 0 6px">Restricted list</h3>
    ${K.restricted.map(r => `<div class="rlog fail" style="display:flex;justify-content:space-between;gap:8px"><span><b>${esc(r.sym)}</b> ${esc(r.why || '')} <span class="faint">since ${new Date(r.t * 1000).toLocaleDateString()}</span></span><button class="btn sm" data-unr="${esc(r.sym)}">Lift</button></div>`).join('') || '<div class="faint">Empty: everything in the universe is tradeable.</div>'}
    <div style="display:flex;gap:6px;margin-top:8px;flex-wrap:wrap"><input id="rsSym" maxlength="10" placeholder="Symbol (e.g. NVDA)" style="width:150px;background:var(--bg2);color:var(--text);border:1px solid var(--border2);border-radius:8px;padding:6px 8px">
      <input id="rsWhy" maxlength="100" placeholder="Reason" style="flex:1;min-width:160px;background:var(--bg2);color:var(--text);border:1px solid var(--border2);border-radius:8px;padding:6px 8px"><button class="btn on" id="rsAdd">Restrict</button></div>
    <h3 style="margin:14px 0 6px">Rules</h3>${K.rules.map(r => `<div style="font-size:12.5px">• ${esc(r)}</div>`).join('')}
    ${Object.keys(K.earnings || {}).length ? `<div style="font-size:12.5px;margin-top:4px">Earnings calendar: ${Object.entries(K.earnings).map(([s, d]) => `<b>${esc(s)}</b> ${esc(d)}`).join(' · ')}</div>` : ''}
    <h3 style="margin:14px 0 6px">Log</h3><table style="font-size:12px"><tbody>${(K.log || []).map(x => `<tr><td class="t faint">${new Date(x.t * 1000).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}</td><td class="t">${esc(x.name)}</td><td class="t"><b>${esc(x.sym)}</b> ${x.side > 0 ? '▲' : x.side < 0 ? '▼' : ''}</td>
      <td class="t" style="color:${x.result === 'BLOCK' ? '#f43f5e' : x.result === 'FLAG' ? '#fbbf24' : '#22c55e'}">${x.result}</td><td class="t faint">${esc(x.why || '')}</td></tr>`).join('') || '<tr><td class="t faint">No orders yet.</td></tr>'}</tbody></table>`;
  el.querySelectorAll('[data-unr]').forEach(b => b.onclick = () => { send({ type: 'restrict', sym: b.dataset.unr, on: false }); b.disabled = true; });
  $('rsAdd').onclick = () => { const s = $('rsSym').value.trim().toUpperCase(); if (!s) return; send({ type: 'restrict', sym: s, on: true, why: $('rsWhy').value.trim() }); $('rsSym').value = ''; $('rsWhy').value = ''; };
}
function openRiskReport() { modal('riskrep', 'Risk report · Rex', '<div id="rrBody"></div>'); renderRiskReport(); }
function renderRiskReport() {
  const el = $('rrBody'), R = snap?.riskrep?.last; if (!el) return;
  if (!R) { el.innerHTML = '<div class="faint">Rex is computing the first report (every 15 minutes).</div>'; return; }
  const stat = (k, v, c = '') => `<div><b>${k}</b><span class="mono ${c}">${v}</span></div>`, warn = snap.riskrep.warn;
  const H = R.hist || [], W = 640, Hh = 130, lo = Math.min(...H), hi = Math.max(...H), bins = 40, cnt = Array(bins).fill(0);
  for (const v of H) cnt[Math.min(bins - 1, Math.floor((v - lo) / ((hi - lo) || 1) * bins))]++;
  const mx = Math.max(...cnt, 1), bx = i => 6 + i * (W - 12) / bins, X = v => 6 + (v - lo) / ((hi - lo) || 1) * (W - 12);
  const fmx = Math.max(1, ...Object.values(R.factors).map(Math.abs));
  el.innerHTML = `<div class="muted" style="font-size:12.5px">Historical simulation: today's book replayed through each of the last ${R.days} trading days' real moves (options by delta). VaR = the loss exceeded on only 5% / 1% of those days; expected shortfall = the average of the worst 2.5%.</div>
    <div class="stat-grid" style="grid-template-columns:repeat(4,1fr);margin:10px 0">${stat('1-day VaR 95%', `${money(R.var95)} · ${(R.var95_pct * 100).toFixed(1) + '%'}`)}${stat('1-day VaR 99%', `${money(R.var99)} · ${(R.var99_pct * 100).toFixed(1) + '%'}`, R.var99_pct > warn ? 'down' : '')}${stat('Expected shortfall', `${money(R.es)} · ${(R.es_pct * 100).toFixed(1) + '%'}`)}${stat('Worst day replayed', `${money(R.worst.pnl)} (${esc(R.worst.date || '')})`, 'down')}
      ${stat('Gross exposure', money(R.gross))}${stat('Net exposure', money(R.net))}${stat('Best day replayed', money(R.best), 'up')}${stat('Rex limit', `99% VaR < ${Math.round(warn * 100)}% NAV`, R.var99_pct > warn ? 'down' : 'up')}</div>
    <h3 style="margin:10px 0 4px">Simulated daily P&L of today's book (last 250 days)</h3>
    <svg viewBox="0 0 ${W} ${Hh}" width="100%" role="img" aria-label="P&L histogram">${cnt.map((c, i) => `<rect x="${bx(i) + 1}" y="${Hh - 18 - c / mx * (Hh - 30)}" width="${(W - 12) / bins - 2}" height="${c / mx * (Hh - 30)}" rx="2" fill="${lo + (i + 0.5) * (hi - lo) / bins < 0 ? '#f43f5e' : '#22c55e'}" opacity=".8"/>`).join('')}
      ${[[-R.var95, '95%'], [-R.var99, '99%']].map(([v, l]) => v >= lo ? `<line x1="${X(v)}" x2="${X(v)}" y1="8" y2="${Hh - 18}" stroke="#fbbf24" stroke-dasharray="4 3"/><text x="${X(v) + 3}" y="16" fill="#fbbf24" font-size="11">VaR ${l}</text>` : '').join('')}
      <text x="6" y="${Hh - 4}" fill="var(--muted)" font-size="11">${money(lo)}</text><text x="${W - 6}" y="${Hh - 4}" fill="var(--muted)" font-size="11" text-anchor="end">${money(hi)}</text></svg>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:10px"><div><h3 style="margin:0 0 6px">Factor exposures ($ per 1% move)</h3>${Object.entries(R.factors).map(([k, v]) => `<div class="gauge" style="margin:3px 0 7px"><div class="l"><span>${esc(k)}</span><span class="mono" style="color:var(--text)">${v >= 0 ? '+' : ''}${money(v)}</span></div><div class="bar" style="margin:2px 0"><i style="width:${Math.abs(v) / fmx * 100}%;background:${v >= 0 ? 'var(--green)' : 'var(--red)'}"></i></div></div>`).join('')}</div>
      <div><h3 style="margin:0 0 6px">Standalone VaR by pod (95% / 99%)</h3>${(R.pods || []).map(([n, a, b]) => `<div style="font-size:12.5px;display:flex;justify-content:space-between;margin:4px 0"><span>${esc(n)}</span><span class="mono">${money(a)} / ${money(b)}</span></div>`).join('')}</div></div>`;
}
let repData = null;
async function openReports() { modal('reports', 'Reports · end-of-day & investor statement', '<div id="repBody"><div class="faint">Loading…</div></div>');
  try { repData = await (await fetch('/api/reports')).json(); } catch { repData = null; } renderReports(); }
function renderReports() {
  const el = $('repBody'), D = repData; if (!el || !D) return;
  const S = D.statement, stat = (k, v, c = '') => `<div><b>${k}</b><span class="mono ${c}">${v}</span></div>`;
  el.innerHTML = `<div style="margin-bottom:12px"><button class="btn on" data-experiment="1">📈 Experiment update (LinkedIn)</button></div><h3 style="margin:0 0 6px">Investor statement</h3><div class="muted" style="font-size:12.5px">${esc(S.terms)}. Paper trading: shadow accounting for what an investor would keep after fees.</div>
    <div class="stat-grid" style="grid-template-columns:repeat(4,1fr);margin:10px 0">${stat('Gross return', pct(S.gross_ret), cls(S.gross_ret))}${stat('Net return (after fees)', pct(S.net_ret), cls(S.net_ret))}${stat('Management fee accrued', money(S.mgmt))}${stat('Performance fee', money(S.perf))}
      ${stat('Gross equity', money(S.gross))}${stat('Net equity', money(S.net))}${stat('High-water mark (NAV)', S.hwm_nav.toFixed(2))}${stat('Starting capital', money(S.start))}</div>
    ${S.monthly.length ? `<div style="font-size:12.5px">Monthly net: ${S.monthly.map(([m, r]) => `<b>${esc(m)}</b> <span class="${cls(r)}">${pct(r, 2)}</span>`).join(' · ')}</div>` : '<div class="faint" style="font-size:12.5px">The first official NAV is struck at 4:15 pm New York time.</div>'}
    <h3 style="margin:14px 0 6px">End-of-day reports (Sam)</h3>
    ${(D.reports || []).map(r => `<div class="pod" style="margin:6px 0;padding:10px 12px"><div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:6px"><b>${esc(r.day)}</b><span class="mono ${cls(r.day_ret)}">NAV ${r.nav.toFixed(2)} (${pct(r.day_ret)})${r.net_nav ? ` · net ${r.net_nav.toFixed(2)}` : ''}</span></div>
      <div style="font-size:12.5px;margin-top:4px">${r.n_trades} trades closed (${money(r.realized)}) · ${r.positions} open · CIO ${esc((r.mode || '').toUpperCase())} ${r.mult ? r.mult.toFixed(2) + 'x' : ''}${r.var99_pct != null ? ` · 99% VaR ${pct(r.var99_pct, 1)}` : ''}</div>
      <div class="faint" style="font-size:12px;margin-top:2px">Pods: ${r.pods.map(([n, v]) => `${esc(n)} ${money(v)}`).join(' · ')}</div>
      ${r.best ? `<div class="faint" style="font-size:12px">Best: ${esc(r.best.pod)} ${esc(r.best.sym)} ${money(r.best.pnl)}${r.worst ? ` · worst: ${esc(r.worst.pod)} ${esc(r.worst.sym)} ${money(r.worst.pnl)}` : ''}</div>` : ''}
      <div class="faint" style="font-size:12px">Compliance: ${r.compliance.n} checks, ${r.compliance.blocked} blocked · Research: ${r.ideas.length} ideas (${r.ideas.filter(x => x.passed).length} passed), ${r.models.length} models (${r.models.filter(x => x.passed).length} passed)</div></div>`).join('') || '<div class="faint">The first report is written at 4:20 pm New York time.</div>'}
    <button class="btn" style="margin-top:8px" onclick="window.print()">Print / save as PDF</button>`;
}
function openFrontDesk() {
  if (agents.ari) act('ari', anim('wave', 1400), say(`Welcome back, Jason. NAV ${snap ? snap.nav.toFixed(2) : '—'}. Here's what happened.`, 3200));
  openAway();
}
document.addEventListener('click', ev => { const t = ev.target.closest && ev.target.closest('[data-compliance],[data-riskrep],[data-reports]'); if (!t) return;
  t.dataset.compliance ? openCompliance() : t.dataset.riskrep ? openRiskReport() : openReports(); });

// ── the experiment log: a two-weekly public update with the same scoreboard every time, from the live books ──
let expData = null;
async function openExperiment() { modal('experiment', '📈 Experiment update · the AI hedge fund experiment', '<div id="expBody"><div class="faint">Loading…</div></div>');
  try { expData = await (await fetch('/api/experiment')).json(); } catch { expData = null; } renderExperiment(); }
const spct = (v, d = 1) => v == null ? 'n/a' : `${v >= 0 ? '+' : ''}${(v * 100).toFixed(d)}%`;
function expPost(D) {
  const P = D.since_last || D.total, T = D.total, today = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const lines = [`The AI hedge fund experiment · Update #${D.n} (${P.start_day} → ${today})`, '',
    'Can a team of AI agents that work together find a real edge in the markets? Here is the honest scoreboard (paper money):', '',
    `• Paper NAV: ${P.nav_from.toFixed(2)} → ${P.nav_to.toFixed(2)} (${spct(P.ret)}) vs SPY ${spct(P.spy_ret)} over the same period`];
  if (D.since_last) lines.push(`• Since Day 0 (${T.start_day}): ${spct(T.ret)} vs SPY ${spct(T.spy_ret)}`);
  lines.push(`• Max drawdown: ${(P.maxdd * 100).toFixed(1)}%`, `• Research lab: ${P.lab_tested} strategies tested, ${P.lab_passed} passed`,
    `• Model Lab: ${P.models_tested} machine-learning models tested, ${P.models_passed} passed`,
    `• Trades: ${P.trades} closed${P.win == null ? '' : `, ${Math.round(P.win * 100)}% winners`}`, `• Risk policy: ${D.policy}`, '');
  if (D.moments.length) { lines.push('What happened:'); for (const m of D.moments.slice(0, 4)) lines.push(`→ ${m.who}: ${m.text.replace(/\s+/g, ' ').slice(0, 160)}`); lines.push(''); }
  if (D.changes.length) { lines.push('What I changed:'); for (const c of D.changes.slice(-4)) lines.push(`→ ${c.text.replace(/^Jason: /, '').slice(0, 150)}`); lines.push(''); }
  lines.push(`Lesson: ${D.lesson || '(write the one thing you learned)'}`, '',
    'Paper money only, not financial advice. Built with Claude Code as my pair programmer; I designed the system and the research.', '', '#quant #trading #ai #machinelearning');
  return lines.join('\n');
}
function renderExperiment() {
  const el = $('expBody'), D = expData; if (!el) return;
  if (!D) { el.innerHTML = '<div class="down">Could not load the experiment data.</div>'; return; }
  const T = D.total, L = D.since_last, row = (k, a, b) => `<tr><td class="t">${k}</td><td class="mono">${a}</td>${L ? `<td class="mono">${b}</td>` : ''}</tr>`;
  const due = D.due ? '<span class="up">An update is due.</span>' : `<span class="faint">Next update due ${new Date(D.next_due * 1000).toLocaleDateString()}.</span>`;
  el.innerHTML = `<div class="muted" style="font-size:12.5px">Day 0 is ${esc(T.start_day)}. Same scoreboard every time, good or bad, straight from the books, with SPY over the same period so a rising market isn't mistaken for skill. Update #${D.n}. ${due}</div>
    <table style="margin-top:10px;font-size:12.5px"><thead><tr><th>Metric</th><th>Since Day 0 (${T.days} days)</th>${L ? `<th>Since update #${D.n - 1} (${L.days} days)</th>` : ''}</tr></thead><tbody>
      ${row('Paper NAV', `${T.nav_from.toFixed(2)} → ${T.nav_to.toFixed(2)} (${spct(T.ret, 2)})`, L ? `${L.nav_from.toFixed(2)} → ${L.nav_to.toFixed(2)} (${spct(L.ret, 2)})` : '')}
      ${row('SPY, same period', spct(T.spy_ret, 2), L ? spct(L.spy_ret, 2) : '')}${row('Max drawdown', (T.maxdd * 100).toFixed(2) + '%', L ? (L.maxdd * 100).toFixed(2) + '%' : '')}
      ${row('Strategies tested / passed', `${T.lab_tested} / ${T.lab_passed}`, L ? `${L.lab_tested} / ${L.lab_passed}` : '')}${row('ML models tested / passed', `${T.models_tested} / ${T.models_passed}`, L ? `${L.models_tested} / ${L.models_passed}` : '')}
      ${row('Trades closed (win rate)', `${T.trades}${T.win == null ? '' : ` (${Math.round(T.win * 100)}%)`}`, L ? `${L.trades}${L.win == null ? '' : ` (${Math.round(L.win * 100)}%)`}` : '')}
      ${row('Realized P&L', money(T.realized), L ? money(L.realized) : '')}${row('1-day 99% VaR now', D.var99 == null ? 'n/a' : (D.var99 * 100).toFixed(1) + '%', '')}${row('Risk policy', esc(D.policy), '')}</tbody></table>
    <div style="font-size:12px;margin-top:6px" class="faint">P&L by pod since Day 0: ${T.pods.map(([n, v]) => `${esc(n)} ${money(v)}`).join(' · ')}${D.beta.length ? ` · Treated as beta (entries don't beat random): ${D.beta.map(esc).join(', ')}` : ''}</div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-top:10px"><div><h3 style="margin:0 0 6px">Notable moments</h3>${D.moments.map(m => `<div class="rlog" style="font-size:12px"><b>${esc(m.who)}</b> ${esc(m.text.slice(0, 180))}</div>`).join('') || '<div class="faint">None yet.</div>'}</div>
      <div><h3 style="margin:0 0 6px">What you changed</h3>${D.changes.map(c => `<div class="rlog" style="font-size:12px">${esc(c.text)} <span class="faint">${new Date(c.t * 1000).toLocaleDateString()}</span></div>`).join('') || '<div class="faint">No changes logged yet.</div>'}
        <div style="display:flex;gap:6px;margin-top:6px"><input id="expNote" maxlength="200" placeholder="Log a change (e.g. added the Model Lab)" style="flex:1;background:var(--bg2);color:var(--text);border:1px solid var(--border2);border-radius:8px;padding:6px 8px"><button class="btn sm" id="expNoteGo">Log</button></div></div></div>
    <h3 style="margin:14px 0 6px">Your post (edit it, it's yours)</h3>
    <textarea id="expPost" rows="16" style="width:100%;box-sizing:border-box;background:var(--bg2);color:var(--text);border:1px solid var(--border2);border-radius:10px;padding:10px;font:500 13px/1.45 Inter,sans-serif">${esc(expPost(D))}</textarea>
    <div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap;align-items:center"><button class="btn on" id="expCopy">Copy post</button><button class="btn" id="expSave">Save as update #${D.n}</button>
      <span class="faint" style="font-size:12px" id="expMsg">Saving freezes these numbers so the next update reports "since update #${D.n}". Attach a 20-30 s clip of the floor (Go to → ▶ City tour).</span></div>
    ${D.last ? `<div class="faint" style="font-size:12px;margin-top:8px">Last saved: update #${D.last.n} on ${esc(D.last.day)} (NAV ${D.last.nav.toFixed(2)}, ${spct(D.last.ret, 2)} vs SPY ${spct(D.last.spy_ret, 2)}).</div>` : ''}`;
  $('expCopy').onclick = async () => { try { await navigator.clipboard.writeText($('expPost').value); $('expMsg').textContent = 'Copied. Paste it into LinkedIn.'; } catch { $('expPost').select(); $('expMsg').textContent = 'Press Ctrl+C to copy.'; } };
  $('expSave').onclick = () => { send({ type: 'exp_save' }); $('expSave').disabled = true; $('expMsg').textContent = `Saved as update #${D.n}.`; };
  $('expNoteGo').onclick = () => { const t = $('expNote').value.trim(); if (!t) return; send({ type: 'exp_note', text: t }); $('expNote').value = ''; setTimeout(openExperiment, 600); };
}
document.addEventListener('click', ev => { if (ev.target.closest && ev.target.closest('[data-experiment]')) openExperiment(); });

// ── Rex's stress test: shock the live book and see what happens (stops holding vs gapping through) ──
const STRESS = [
  { n: 'Equity crash', d: 'US stocks −10%, intl −9%, crypto −15%, energy −6%, gold +3%, Treasuries +4%', s: { 'US stocks': -0.10, 'Intl stocks': -0.09, Crypto: -0.15, 'Energy & commodities': -0.06, Metals: 0.03, Bonds: 0.04 } },
  { n: 'Crypto winter', d: 'BTC, ETH, SOL −30%', s: { Crypto: -0.30 } },
  { n: 'Rate shock', d: 'Treasuries −6%, stocks −5%, gold −3%, crypto −8%', s: { Bonds: -0.06, 'US stocks': -0.05, 'Intl stocks': -0.05, Metals: -0.03, Crypto: -0.08 } },
  { n: 'Oil spike', d: 'Energy +15%, stocks −3%, Treasuries −1%', s: { 'Energy & commodities': 0.15, 'US stocks': -0.03, 'Intl stocks': -0.04, Bonds: -0.01 } },
  { n: 'Melt-up', d: 'Stocks +6%, crypto +12%', s: { 'US stocks': 0.06, 'Intl stocks': 0.05, Crypto: 0.12 } },
  { n: 'Custom', d: 'Set every asset group yourself', s: null },
];
const STRESS_GROUPS = ['US stocks', 'Intl stocks', 'Bonds', 'Metals', 'Energy & commodities', 'Crypto'];
let stressPick = 0, stressCustom = Object.fromEntries(STRESS_GROUPS.map(g => [g, 0]));
function stressRun(shock) {
  const pods = {}, rows = [];
  let gap = 0, stops = 0;
  for (const p of snap.positions || []) {
    const s = shock[p.group] || 0; if (!s) continue;
    let g, h;
    if (p.option) { g = h = (p.delta_usd || 0) * s; }
    else { g = p.side * p.qty * (p.pv || 1) * p.last * s; const stopPnl = p.side * p.qty * (p.pv || 1) * (p.stop - p.last); h = g < 0 ? Math.max(g, Math.min(0, stopPnl)) : g; }
    gap += g; stops += h; const k = p.pod_name || p.pod; pods[k] = (pods[k] || 0) + g; rows.push([p.sym, k, g, h]);
  }
  return { gap, stops, pods: Object.entries(pods).sort((a, b) => a[1] - b[1]), rows: rows.sort((a, b) => a[2] - b[2]) };
}
function openStress() { achMark('stress'); setTimeout(() => checkAch(true), 800); modal('stress', 'Stress test · what would one bad day do to the book right now?', '<div id="stressBody"></div>'); renderStress(); }
function renderStress() {
  const el = $('stressBody'); if (!el || !snap) return;
  const sc = STRESS[stressPick], shock = sc.s || stressCustom, R = stressRun(shock), eq = snap.equity;
  const kill = -0.03 * eq, bar = (v, max) => `<div class="bar" style="margin:3px 0"><i style="width:${Math.min(100, Math.abs(v) / max * 100)}%;background:${v < 0 ? 'var(--red)' : 'var(--green)'}"></i></div>`;
  const mx = Math.max(1, ...R.pods.map(x => Math.abs(x[1])));
  el.innerHTML = `<div style="display:flex;gap:6px;flex-wrap:wrap">${STRESS.map((x, i) => `<button class="btn sm ${i === stressPick ? 'on' : ''}" data-st="${i}">${esc(x.n)}</button>`).join('')}</div>
    <div class="muted" style="font-size:12.5px;margin:8px 0">${esc(sc.d)}</div>
    ${sc.s ? '' : STRESS_GROUPS.map(g => `<div class="srow"><span>${esc(g)}</span><input type="range" min="-0.3" max="0.3" step="0.01" value="${stressCustom[g]}" data-sg="${esc(g)}"><b class="mono">${sgn(stressCustom[g])}</b></div>`).join('')}
    <div class="stat-grid" style="grid-template-columns:1fr 1fr 1fr"><div><b>If stops hold</b><span class="mono ${cls(R.stops)}">${money(R.stops)} (${pct(R.stops / eq)})</span></div>
      <div><b>If prices gap through stops</b><span class="mono ${cls(R.gap)}">${money(R.gap)} (${pct(R.gap / eq)})</span></div>
      <div><b>3% kill switch</b><span class="mono ${R.gap < kill ? 'down' : 'up'}">${R.gap < kill ? 'WOULD FIRE' : 'safe'}</span></div></div>
    <h3 style="margin:14px 0 6px">By pod (gap case)</h3>${R.pods.map(([n, v]) => `<div class="gauge" style="margin:4px 0 8px"><div class="l"><span>${esc(n)}</span><span class="mono" style="color:var(--text)">${money(v)}</span></div>${bar(v, mx)}</div>`).join('') || '<div class="faint">Nothing in the book is exposed to this scenario.</div>'}
    <h3 style="margin:14px 0 6px">Biggest hits</h3><table><tbody>${R.rows.slice(0, 6).map(([s, n, g, h]) => `<tr><td class="t">${esc(s)} <span class="faint">${esc(n)}</span></td><td class="${cls(h)}">${money(h)} with stops</td><td class="${cls(g)}">${money(g)} gap</td></tr>`).join('') || '<tr><td class="t faint">—</td></tr>'}</tbody></table>
    <div class="faint" style="font-size:11.5px;margin-top:8px">A one-day shock applied to every open position by asset group (options by their dollar delta). Stops cap losses when prices trade through them; overnight gaps can jump straight past them. Not a forecast: a fire drill.</div>`;
  el.querySelectorAll('[data-st]').forEach(b => b.onclick = () => { stressPick = +b.dataset.st; renderStress();
    const r = stressRun(STRESS[stressPick].s || stressCustom); if (STRESS[stressPick].s && agents.rex) act('rex', say(`${STRESS[stressPick].n}: ${money(r.stops)} if stops hold, ${money(r.gap)} on a gap.`, 4200)); });
  el.querySelectorAll('[data-sg]').forEach(i => i.oninput = () => { stressCustom[i.dataset.sg] = +i.value; renderStress(); });
}

// ── the fund tear sheet: what an investor (or a recruiter) reads first ──
function openTear() { achMark('tear'); setTimeout(() => checkAch(true), 800); modal('tear', 'JB Capital · fund tear sheet', '<div id="tearBody"></div>'); renderTear(); }
function renderTear() {
  const el = $('tearBody'), T = snap?.tear; if (!el || !T) return;
  if (T.error) { el.innerHTML = `<div class="down">${esc(T.error)}</div>`; return; }
  const P = (v, d = 2) => v == null ? '—' : pct(v, d), N = (v, d = 2) => v == null ? '—' : (+v).toFixed(d);
  const stat = (k, v, c = '') => `<div><b>${k}</b><span class="mono ${c}">${v}</span></div>`;
  const curve = (snap.curve || []).map(c => c[1]), W = 680, H = 140;
  let spark = '';
  if (curve.length > 2) { const lo = Math.min(...curve, snap.start), hi = Math.max(...curve, snap.start), X = i => 4 + i / (curve.length - 1) * (W - 8), Y = v => 6 + (1 - (v - lo) / (hi - lo || 1)) * (H - 12);
    spark = `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Fund equity"><line x1="4" x2="${W - 4}" y1="${Y(snap.start)}" y2="${Y(snap.start)}" stroke="var(--border2)" stroke-dasharray="4 4"/>
      <path d="${curve.map((v, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join('')}" fill="none" stroke="${T.total >= 0 ? 'var(--green)' : 'var(--red)'}" stroke-width="2"/></svg>`; }
  const months = Object.entries(T.months || {}), years = [...new Set(months.map(([k]) => k.slice(0, 4)))];
  const MN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const cell = v => v == null ? '<td></td>' : `<td class="mono" style="text-align:center;background:${v >= 0 ? `rgba(34,197,94,${Math.min(0.75, 0.15 + Math.abs(v) * 12)})` : `rgba(244,63,94,${Math.min(0.75, 0.15 + Math.abs(v) * 12)})`}">${(v * 100).toFixed(1)}</td>`;
  const grid = `<table style="font-size:11.5px"><thead><tr><th></th>${MN.map(m => `<th style="text-align:center">${m}</th>`).join('')}<th style="text-align:center">Year</th></tr></thead><tbody>${years.map(y => {
    const ym = MN.map((_, i) => (T.months || {})[`${y}-${String(i + 1).padStart(2, '0')}`]); const yr = ym.filter(v => v != null).reduce((a, v) => a * (1 + v), 1) - 1;
    return `<tr><td class="t"><b>${y}</b></td>${ym.map(cell).join('')}${cell(yr)}</tr>`; }).join('')}</tbody></table>`;
  const attr = (title, rows) => { const mx = Math.max(1, ...rows.map(r => Math.abs(r[1])));
    return `<div><h3 style="margin:12px 0 6px">${title}</h3>${rows.slice(0, 8).map(([n, v]) => `<div class="gauge" style="margin:3px 0 7px"><div class="l"><span>${esc(n)}</span><span class="mono" style="color:var(--text)">${money(v)}</span></div><div class="bar" style="margin:2px 0"><i style="width:${Math.abs(v) / mx * 100}%;background:${v < 0 ? 'var(--red)' : 'var(--green)'}"></i></div></div>`).join('') || '<div class="faint">—</div>'}</div>`; };
  el.innerHTML = `<div class="muted" style="font-size:12.5px">An AI-run multi-strategy fund: ${snap.roster?.length || 0} portfolio managers, a CRO, a CIO and a research lab. Paper trading at live prices with realistic costs.</div>
    <div class="stat-grid" style="grid-template-columns:repeat(4,1fr);margin-top:10px">${stat('NAV / unit', N(T.nav))}${stat('Since inception', P(T.total), cls(T.total))}${stat('Days live', T.days)}${stat('Sharpe', T.sharpe == null ? 'after 20 days' : N(T.sharpe))}
      ${stat('Sortino', T.sortino == null ? '—' : N(T.sortino))}${stat('Volatility', T.vol == null ? '—' : P(T.vol, 1))}${stat('Max drawdown', P(T.maxdd), 'down')}${stat('Now off peak', P(T.curdd))}
      ${stat('Best day', P(T.best), cls(T.best))}${stat('Worst day', P(T.worst), cls(T.worst))}${stat('Up days', T.up_days == null ? '—' : Math.round(T.up_days * 100) + '%')}${stat('Beta / corr to SPY', T.beta_spy == null ? '—' : `${N(T.beta_spy)} / ${N(T.corr_spy)}`)}
      ${stat('Closed trades', T.trades)}${stat('Win rate', T.win_rate == null ? '—' : Math.round(T.win_rate * 100) + '%')}${stat('Profit factor', T.pf == null ? '—' : N(T.pf))}${stat('Fees + interest', money((T.fees || 0) + (T.interest || 0)))}</div>
    <h3 style="margin:14px 0 4px">Equity</h3>${spark}
    <h3 style="margin:14px 0 6px">Monthly returns (%)</h3>${grid}
    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:14px">${attr('By pod', T.by_pod)}${attr('By asset group', T.by_group)}${attr('By market', T.by_market)}</div>
    <div class="faint" style="font-size:11px;margin-top:10px">Paper trading only: simulated fills at live prices with commissions, spreads and slippage. Past results, real or simulated, say little about the future.</div>
    <button class="btn" style="margin-top:10px" onclick="window.print()">Print / save as PDF</button>`;
}
document.addEventListener('click', ev => { const t = ev.target.closest && ev.target.closest('[data-tear],[data-stress]'); if (!t) return; t.dataset.tear ? openTear() : openStress(); });

// ── Beat the Bots: call a market's direction; graded on the next daily close against Ava and the trend bot ──
function openArena() { modal('arena', 'Beat the Bots · market calls', '<div id="arenaBody"></div>'); renderArena(); }
function renderArena() {
  const el = $('arenaBody'), A = snap?.arena; if (!el || !A) return;
  const sc = A.score, open = Object.fromEntries((A.open || []).map(c => [c.sym, c]));
  const card = (n, s, col) => `<div><b style="color:${col}">${n}</b><span class="mono">${s.n ? `${s.hits}/${s.n} · ${Math.round(s.rate * 100)}%` : '—'}</span></div>`;
  el.innerHTML = `<div class="muted" style="font-size:12.5px">Will it <b>close</b> above or below where it trades <b>right now</b>? Graded by the next daily close (stocks 4 pm New York, crypto the UTC day). Ava and the trend bot call the same thing at the same moment.</div>
    <div class="stat-grid" style="grid-template-columns:1fr 1fr 1fr;margin:10px 0">${card('You', sc.jason, '#facc15')}${card('Ava (AI analyst)', sc.ava, '#22d3ee')}${card('Trend bot', sc.trend, '#a78bfa')}</div>
    <table><thead><tr><th>Market</th><th>Now</th><th>Today</th><th style="text-align:right">Your call</th></tr></thead><tbody>${Object.entries(A.markets).map(([s, m]) => { const o = open[s];
      return `<tr><td class="t"><b>${esc(s)}</b> <span class="faint">${esc(m.name || '')}</span></td><td>${m.px ? fmtPx(m.px) : '—'}</td><td class="${cls(m.chg || 0)}">${m.chg == null ? '—' : pct(m.chg)}</td>
        <td style="text-align:right">${o ? `<span class="faint">${o.dir > 0 ? '▲ above' : '▼ below'} ${fmtPx(o.px)} · open</span>` : `<button class="btn sm" data-call="${s}|1">▲ Up</button> <button class="btn sm" data-call="${s}|-1">▼ Down</button>`}</td></tr>`; }).join('')}</tbody></table>
    <h3 style="margin:14px 0 6px">Graded</h3>${(A.calls || []).filter(c => c.status === 'graded').slice(-8).reverse().map(c => { const ok = c.dir * c.ret > 0, mark = x => x ? (x * c.ret > 0 ? '✓' : '✗') : '·';
      return `<div class="rlog ${ok ? 'pass' : 'fail'}"><b>${esc(c.sym)}</b> ${c.dir > 0 ? '▲' : '▼'} from ${fmtPx(c.px)} → <span class="mono ${cls(c.ret)}">${pct(c.ret)}</span> on ${esc(c.day || '')} · you ${mark(c.dir)} · Ava ${mark(c.ava)} · trend ${mark(c.trend)}</div>`; }).join('') || '<div class="faint" style="font-size:12.5px">No graded calls yet. Make a call: Sam grades it at the next close.</div>'}`;
  el.querySelectorAll('[data-call]').forEach(b => b.onclick = () => { const [s, d] = b.dataset.call.split('|'); send({ type: 'arena_call', sym: s, dir: +d }); b.parentElement.innerHTML = '<span class="faint">sending…</span>'; });
}
document.addEventListener('click', ev => { if (ev.target.closest && ev.target.closest('[data-arena]')) openArena(); });

// ── Mental Math Arena: Zetamac-style (+ − × ÷), 120 seconds, the answer is accepted the moment you type it ──
const MATH_SECS = 120;
let mathGame = null;
const mathData = () => { try { return JSON.parse(lsGet('jb.math') || '') || { best: 0, runs: [] }; } catch { return { best: 0, runs: [] }; } };
function mathProblem() {
  const r = (a, b) => a + Math.floor(Math.random() * (b - a + 1)), k = Math.floor(Math.random() * 4);
  if (k === 0) { const a = r(2, 100), b = r(2, 100); return { q: `${a} + ${b}`, a: a + b }; }
  if (k === 1) { const a = r(2, 100), b = r(2, 100); return { q: `${a + b} − ${a}`, a: b }; }
  if (k === 2) { const a = r(2, 12), b = r(2, 100); return { q: `${a} × ${b}`, a: a * b }; }
  const a = r(2, 12), b = r(2, 100); return { q: `${a * b} ÷ ${a}`, a: b };
}
function mathCardHtml() {
  const m = mathData(), last = m.runs.at(-1);
  return `<div class="pod" style="margin-bottom:10px"><div class="row1"><span class="nm">🧮 Mental Math Arena</span><span class="mono">best ${m.best}</span></div>
    <div class="faint" style="font-size:11.5px;margin-top:2px">Zetamac-style: + − × ÷ for 120 seconds; type the answer, no Enter needed. Prop-firm interviews test exactly this.${last ? ` Last run: ${last.s}.` : ''} The cabinet is in the Study Hall.</div>
    <button class="btn sm" style="margin-top:8px" data-math="1">Play (120 s)</button></div>`;
}
function openMath() {
  const m = mathData();
  modal('math', 'Mental Math Arena · 120 seconds', `<div style="text-align:center">
    <div class="muted" style="font-size:12.5px">Addition and subtraction to 100, multiplication and division up to 12 × 100. Type the answer: it moves on by itself.</div>
    <div id="mathQ" class="mono" style="font-size:44px;font-weight:700;margin:22px 0 12px">Ready?</div>
    <input id="mathA" inputmode="numeric" autocomplete="off" aria-label="Your answer" style="font:600 28px 'JetBrains Mono',monospace;width:180px;text-align:center;background:var(--bg2);color:var(--text);border:1px solid var(--border2);border-radius:10px;padding:8px" disabled>
    <div style="display:flex;justify-content:center;gap:18px;margin-top:14px" class="mono"><span>⏱ <b id="mathT">${MATH_SECS}</b>s</span><span>Score <b id="mathS">0</b></span><span class="muted">Best ${m.best}</span></div>
    <button class="btn" id="mathGo" style="margin-top:14px">Start</button>
    <div id="mathHist" class="faint" style="font-size:11.5px;margin-top:12px">${m.runs.length ? 'Recent: ' + m.runs.slice(-8).map(r => r.s).join(' · ') : 'No runs yet.'}</div></div>`);
  $('mathGo').onclick = startMath;
}
function startMath() {
  if (mathGame?.timer) clearInterval(mathGame.timer);
  const inp = $('mathA'); inp.disabled = false; inp.value = ''; inp.focus(); $('mathGo').hidden = true;
  mathGame = { score: 0, end: performance.now() + MATH_SECS * 1000, cur: mathProblem() };
  $('mathQ').textContent = mathGame.cur.q; $('mathS').textContent = '0';
  inp.oninput = () => { if (inp.value.trim() !== '' && +inp.value === mathGame.cur.a) { mathGame.score++; $('mathS').textContent = mathGame.score; SFX.fill(); mathGame.cur = mathProblem(); $('mathQ').textContent = mathGame.cur.q; inp.value = ''; } };
  mathGame.timer = setInterval(() => {
    if (!$('mathA')) { clearInterval(mathGame.timer); mathGame = null; return; }              // closed early: the run doesn't count
    const left = Math.max(0, Math.ceil((mathGame.end - performance.now()) / 1000)); $('mathT').textContent = left;
    if (left <= 0) finishMath();
  }, 200);
}
function finishMath() {
  clearInterval(mathGame.timer); const s = mathGame.score; mathGame = null;
  const m = mathData(), pb = s > m.best; m.best = Math.max(m.best, s); m.runs.push({ t: Date.now(), s }); m.runs = m.runs.slice(-60); lsSet('jb.math', JSON.stringify(m));
  send({ type: 'math', score: s, best: m.best });
  $('mathA').disabled = true; $('mathQ').textContent = pb && s > 0 ? `${s} · NEW BEST!` : `${s}`; $('mathGo').hidden = false; $('mathGo').textContent = 'Play again';
  $('mathHist').textContent = 'Recent: ' + m.runs.slice(-8).map(r => r.s).join(' · ');
  if (pb && s > 0) { SFX.hire(); confetti(P.x, 2.6, P.z, 80); }
}
document.addEventListener('click', ev => { if (ev.target.closest && ev.target.closest('[data-math]')) openMath(); });
window.__jb.math = { end: () => { if (mathGame) mathGame.end = 0; } };          // headless test hook

// ── Market Making Pit: the classic prop-firm interview game. Quote a two-sided market on the sum of 4 hidden dice;
//    you see one more die each round, but Quinn (the bot) always sees one more than you and trades when your price is wrong ──
const MM_GAMES = 5, MM_DICE = 4;
let mm = null;
const mmData = () => { try { return JSON.parse(lsGet('jb.mm') || 'null') || { best: null, runs: [] }; } catch { return { best: null, runs: [] }; } };
const DIE = ['', '⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];
function mmCardHtml() {
  const d = mmData(), last = d.runs.at(-1);
  return `<div class="pod" style="margin-bottom:10px"><div class="row1"><span class="nm">🎲 Market Making Pit</span><span class="mono">best ${d.best == null ? '—' : money(d.best)}</span></div>
    <div class="faint" style="font-size:11.5px;margin-top:2px">Quote a bid and an ask on the sum of four dice against a bot that knows more than you. SIG / Jane Street-style.${last ? ` Last: ${money(last.s)}.` : ''}</div>
    <button class="btn sm" style="margin-top:8px" data-mm="1">Play (5 games)</button></div>`;
}
function openMM() {
  modal('mm', 'Market Making Pit · sum of four dice', `<div class="muted" style="font-size:12.5px">Four dice are rolled face down. Each round you see one more die and quote a <b>bid</b> (you buy at it) and an <b>ask</b> (you sell at it), 1 to 3 points apart.
    Quinn always sees <b>one die more than you</b>: if your ask is too low she buys from you, if your bid is too high she sells to you. Two customers also trade at your prices each round, more often when your market is tight:
    they know nothing, so on average they pay you the spread. After the last round the dice settle at their sum. Center on the expected value (each hidden die is worth 3.5) and pick a width that earns more from customers than Quinn takes.</div><div id="mmBody"></div>`);
  mmStart();
}
function mmStart() { mm = { game: 1, total: 0, hist: [] }; mmNewGame(); }
function mmNewGame() { mm.dice = Array.from({ length: MM_DICE }, () => 1 + Math.floor(Math.random() * 6)); mm.round = 0; mm.pos = 0; mm.cash = 0; mm.log = []; mm.done = false; mmRender(); }
function mmFair(k) { let s = 0; for (let i = 0; i < k; i++) s += mm.dice[i]; return s + 3.5 * (MM_DICE - k); }
function mmQuote() {
  const b = +$('mmBid').value, a = +$('mmAsk').value, w = a - b;
  if (!Number.isFinite(b) || !Number.isFinite(a) || $('mmBid').value === '' || $('mmAsk').value === '') return mmMsg('Enter both a bid and an ask.');
  if (w < 1 || w > 3) return mmMsg('Make it 1 to 3 points wide (ask minus bid).');
  const seen = mm.round, quinn = mmFair(Math.min(MM_DICE, seen + 1)), edge = 0.25;
  let what = 'Quinn passes: your market is fair to her.';
  if (quinn > a + edge) { mm.pos -= 1; mm.cash += a; what = `Quinn <b>buys</b> 1 from you at ${a} (she values it at ${quinn}). You're short.`; SFX.loss?.(); }
  else if (quinn < b - edge) { mm.pos += 1; mm.cash -= b; what = `Quinn <b>sells</b> 1 to you at ${b} (she values it at ${quinn}). You're long.`; SFX.loss?.(); }
  else SFX.fill?.();
  const pc = Math.min(0.9, Math.max(0.2, 1.15 - 0.3 * w)), cust = [];          // uninformed customers: they pay the spread, more often when it's tight
  for (let i = 0; i < 2; i++) if (Math.random() < pc) { if (Math.random() < 0.5) { mm.pos -= 1; mm.cash += a; cust.push(`buys at ${a}`); } else { mm.pos += 1; mm.cash -= b; cust.push(`sells at ${b}`); } }
  if (cust.length) what += ` Customers: ${cust.join(', ')}.`;
  mm.log.push(`Round ${seen + 1}: you quoted ${b} @ ${a} (fair for you: ${mmFair(seen)}). ${what}`);
  mm.round++;
  if (mm.round >= MM_DICE) { const v = mm.dice.reduce((x, y) => x + y, 0), pnl = mm.cash + mm.pos * v; mm.done = true; mm.total += pnl;
    mm.hist.push(pnl); mm.log.push(`<b>Settled at ${v}.</b> Position ${mm.pos > 0 ? '+' : ''}${mm.pos} → game P&L <b class="${pnl >= 0 ? 'up' : 'down'}">${pnl >= 0 ? '+' : ''}${pnl}</b>.`);
    if (pnl > 0) SFX.win?.(); }
  mmRender();
}
function mmMsg(t) { const el = $('mmMsg'); if (el) el.textContent = t; }
function mmRender() {
  const el = $('mmBody'); if (!el || !mm) return;
  const shown = mm.done ? MM_DICE : mm.round, fair = mmFair(shown);
  const dice = mm.dice.map((d, i) => `<span style="font-size:46px;line-height:1;${i < shown ? '' : 'opacity:.35'}" title="${i < shown ? d : 'hidden'}">${i < shown ? DIE[d] : '▢'}</span>`).join(' ');
  const over = mm.done && mm.game >= MM_GAMES;
  el.innerHTML = `<div style="display:flex;justify-content:space-between;align-items:center;margin:12px 0 4px"><b>Game ${mm.game}/${MM_GAMES}</b><span class="mono">Total <b class="${cls(mm.total)}">${mm.total >= 0 ? '+' : ''}${mm.total}</b> · position ${mm.pos > 0 ? '+' : ''}${mm.pos}</span></div>
    <div style="text-align:center;margin:8px 0 6px">${dice}</div>
    <div class="faint" style="text-align:center;font-size:12px">${mm.done ? `Sum: ${mm.dice.reduce((x, y) => x + y, 0)}` : `You see ${shown} of ${MM_DICE} dice · expected sum given what you see: <b>${fair}</b>`}</div>
    ${mm.done ? '' : `<div style="display:flex;gap:10px;justify-content:center;align-items:center;margin:12px 0">
      <label class="mono">Bid <input id="mmBid" type="number" step="0.5" inputmode="decimal" style="width:80px;font:600 20px 'JetBrains Mono',monospace;background:var(--bg2);color:var(--text);border:1px solid var(--border2);border-radius:8px;padding:4px 6px;text-align:center"></label>
      <label class="mono">Ask <input id="mmAsk" type="number" step="0.5" inputmode="decimal" style="width:80px;font:600 20px 'JetBrains Mono',monospace;background:var(--bg2);color:var(--text);border:1px solid var(--border2);border-radius:8px;padding:4px 6px;text-align:center"></label>
      <button class="btn on" id="mmGo">Quote</button></div><div id="mmMsg" class="down" style="text-align:center;font-size:12px;min-height:16px"></div>`}
    <div style="margin-top:6px">${mm.log.map(x => `<div class="rlog" style="font-size:12.5px">${x}</div>`).join('')}</div>
    ${mm.done ? (over ? `<div style="text-align:center;margin-top:12px"><div style="font-size:22px;font-weight:800" class="${cls(mm.total)}">Final: ${mm.total >= 0 ? '+' : ''}${mm.total}</div>
        <div class="faint" style="font-size:12px;margin:4px 0 10px">Games: ${mm.hist.map(x => (x >= 0 ? '+' : '') + x).join(' · ')}. Positive means you made markets the better-informed trader couldn't pick off.</div>
        <button class="btn on" id="mmAgain">Play again</button></div>`
      : `<div style="text-align:center;margin-top:10px"><button class="btn on" id="mmNext">Next game</button></div>`) : ''}`;
  const go = $('mmGo'); if (go) { go.onclick = mmQuote; for (const id of ['mmBid', 'mmAsk']) $(id).onkeydown = ev => { if (ev.key === 'Enter') mmQuote(); }; $('mmBid').focus(); }
  const nx = $('mmNext'); if (nx) nx.onclick = () => { mm.game++; mmNewGame(); };
  const ag = $('mmAgain'); if (ag) ag.onclick = mmStart;
  if (over && !mm.sent) { mm.sent = true; const d = mmData(), pb = d.best == null || mm.total > d.best; d.best = d.best == null ? mm.total : Math.max(d.best, mm.total);
    d.runs.push({ t: Date.now(), s: mm.total }); d.runs = d.runs.slice(-60); lsSet('jb.mm', JSON.stringify(d)); send({ type: 'mm', score: mm.total, best: d.best });
    if (pb && mm.total > 0) { SFX.hire?.(); confetti(P.x, 2.6, P.z, 80); } }
}
document.addEventListener('click', ev => { if (ev.target.closest && ev.target.closest('[data-mm]')) openMM(); });

// ── the city tour: a cinematic fly-through with captions (made for a screen recording) ──
let tour = null;
function tourSteps() {
  const V = a => a.isVector3 ? a.clone() : new THREE.Vector3(...a);
  return [
    [[0, 75, 330], [0, -45, -20], 'JB City', 'Seven AI-run towers on one sky-bridge row'],
    [[10, 31, 40], [0, 0.5, 1.5], 'JB Capital', () => 'An AI multi-strategy hedge fund, paper trading 24/7' + (snap ? ` · NAV ${snap.nav.toFixed(2)}` : '')],
    [[-4, 8.5, 3], [-4, 1, PM_Z], 'Portfolio managers', 'Each robot runs its own strategy pod; the CIO sizes them by evidence'],
    [[0, 6.5, -1], [0, 4, -FZ], 'The video wall', 'Markets, NAV, and every pod\'s capital and risk dial, live'],
    [[15.5, 10, -1], [23.5, 1, -11.5], 'The CIO', 'Risk per trade comes from a Monte Carlo of each pod\'s trades'],
    [[11, 9.5, 3], [21.5, 1, 12.5], 'Quant research lab', 'Robustness, crisis tests, overfitting checks, alternate market histories'],
    [INC_CAM[0], INC_CAM[1], 'The Incubator', 'New strategies earn a desk with a live paper record first'],
    [OPS_CAM[0], OPS_CAM[1], 'Ops Center', 'Servers, data feeds, the broker link and the kill switch'],
    [NEWS_CAM[0], NEWS_CAM[1], 'JB Newsroom', 'AI reporters read the market news every 10 minutes'],
    [STUDIO_CAM[0], STUDIO_CAM[1], 'JB Ventures', 'AI analysts scout and score business ideas'],
    [CAREER_CAM[0], CAREER_CAM[1], 'JB Careers', 'Follow-ups, programs and interview prep'],
    [STUDY_CAM[0], STUDY_CAM[1], 'JB Study Hall', 'Study plans, practice quizzes and a mental-math arena'],
    [CITYHALL_CAM[0], CITYHALL_CAM[1], 'City Hall', 'The whole city at a glance'],
    [[0, 60, 220], [0, 0, -10], 'JB City', 'Built by Jason Burmeister, with Claude'],
  ].map(([p, t, title, sub]) => ({ p: V(p), t: V(t), title, sub }));
}
function startTour() {
  if (tour) return stopTour();
  closeGo(); closeModal(); follow = false; setFollowBtn();
  tour = { steps: tourSteps(), i: -1, game: isGame(), walked: walk.on }; if (!tour.game) setGame(true);
  setWalk(false, false);                                             // the drone films the tour (after game mode, which may turn walking on)
  document.body.classList.add('touring'); nextTourStep();
}
function nextTourStep() {
  if (!tour) return;
  tour.i++; const s = tour.steps[tour.i];
  if (!s) return stopTour();
  tweenCam(s.p, s.t, tour.i ? 2400 : 1200);
  const cap = $('tourCap'); cap.classList.remove('on');
  setTimeout(() => { if (!tour) return; $('tourT').textContent = s.title; $('tourS').textContent = typeof s.sub === 'function' ? s.sub() : s.sub; cap.classList.add('on'); }, tour.i ? 900 : 300);
  tour.timer = setTimeout(nextTourStep, tour.i ? 5200 : 4200);
}
function stopTour() {
  if (!tour) return;
  clearTimeout(tour.timer); const wasGame = tour.game, walked = tour.walked; tour = null;
  document.body.classList.remove('touring'); $('tourCap').classList.remove('on');
  if (!wasGame) setGame(false);
  if (walked) setWalk(true, false);
}
$('bTour').onclick = () => { closeGo(); startTour(); };
addEventListener('keydown', ev => { if (tour && ev.key === 'Escape') stopTour(); }, true);
renderer.domElement.addEventListener('pointerdown', () => { if (tour) stopTour(); });
if (/[?&]tour\b/.test(location.search)) setTimeout(startTour, 4000);
function unlocksHtml() {
  return (snap.unlocks || []).map(u => `<div class="pod"><div class="row1"><span class="nm">🔒 ${esc(u.name)}</span><span class="tag ${u.earned ? 'active' : ''}">${u.earned ? 'EARNED: your call' : 'working for it'}</span></div>
    <div class="faint" style="font-size:12px;margin:4px 0">${esc(u.why)}</div>${u.bars.map(b => gauge(b.label, Math.max(0, Math.min(b.have, b.need)), b.need, `${b.key === 'pnl' ? money(b.have) : (+b.have).toFixed(b.key === 'pf' ? 2 : 0)} / ${b.key === 'pnl' ? '> $0' : b.need}`, b.ok ? 'var(--green)' : 'var(--accent)')).join('')}</div>`).join('');
}
function renderResearch() {
  const r = snap.research || {};
  if (!r.on) { $('research').innerHTML = toolboxHtml() + `<div id="incSec">${incubatorHtml()}</div>` + unlocksHtml() + '<div class="muted">The lab is closed: Ava has no AI brain connected.</div>'; wireMcHover(); return; }
  const log = (r.log || []).slice().reverse();
  $('research').innerHTML = toolboxHtml() + `<div id="incSec">${incubatorHtml()}</div>` + unlocksHtml() + `<div style="display:flex;justify-content:space-between;align-items:center;gap:8px"><div><b style="text-transform:capitalize">${esc(r.status)}</b><div class="muted" style="font-size:12px">next session in ${Math.ceil((r.next_in || 0) / 60)} min · sessions alternate: invent new PMs / retrain the weakest</div></div><button class="btn" id="rNow">Research now</button></div>
    ${r.current ? `<div class="pod" style="margin-top:10px"><div class="nm">${esc(r.current.name)}</div><div class="muted" style="font-size:12px">${esc(r.current.family)} · ${esc(r.current.desc)} · ${(r.current.markets || []).join(', ')}</div><div style="font-size:12.5px;margin-top:4px">${esc(r.current.hypothesis || '')}</div></div>` : ''}
    <div class="muted" style="font-size:12px;margin:10px 0">Bar (10+ years of daily data, real costs): PF ≥ 1.2, profitable in 3 of 4 periods, significance bar that rises with every idea tried (now t ≥ ${r.t_bar ?? '—'}), max DD 25%, still working recently, not a copy of an existing PM.</div>
    ${log.map(e => `<div class="rlog ${e.passed ? 'pass' : 'fail'}"><div style="display:flex;justify-content:space-between"><b>${esc(e.name)}</b><span class="mono ${e.passed ? 'up' : 'down'}">${e.tune ? (e.passed ? 'UPGRADE' : 'KEPT') : e.passed ? 'PASS' : 'FAIL'}</span></div>
      <div class="muted">${esc(e.family)}${e.tf === '1d' ? ' · daily' : ''} · ${e.markets.length > 6 ? e.markets.length + ' markets' : e.markets.join(', ')} · PF <span class="mono">${e.oos.pf.toFixed(2)}</span> · <span class="mono ${cls(e.oos.ret)}">${pct(e.oos.ret, 1)}${e.tf === '1d' ? '/yr' : ''}</span> · ${e.oos.n} trades</div>
      <div style="margin-top:3px">${esc(e.hypothesis)}</div><div class="faint" style="margin-top:2px">${esc(e.reason)}</div></div>`).join('') || '<div class="muted">No research yet. The first session starts ~90 seconds after launch.</div>'}`;
  $('rNow').onclick = () => send({ type: 'research_now' }); wireMcHover();
}
const VERD = { GREENLIT: 'up', WATCHLIST: '', KILLED: 'down' };
function renderVentures() {
  const st = snap.studio || {};
  if (!st.on) { $('ventures').innerHTML = '<div class="muted">The studio is closed: no AI brain connected.</div>'; return; }
  const P = (st.pipeline || []).slice().reverse();
  $('ventures').innerHTML = `<div style="display:flex;justify-content:space-between;align-items:center;gap:8px"><div><b style="text-transform:capitalize">${esc(st.status)}</b>
      <div class="muted" style="font-size:12px">Iris scouts · Theo researches on the web · Rosa scores. Next session in ${Math.ceil((st.next_in || 0) / 60)} min.</div></div>
      <button class="btn" id="vNow" ${st.status !== 'idle' ? 'disabled' : ''}>Studio session now</button></div>
    <div class="muted" style="font-size:12px;margin:10px 0">Score /100: demand 25 · founder fit 20 · speed to revenue 15 · competition gap 15 · defensibility 15 · AI leverage 10. Greenlit ≥ 70, watchlist ≥ 55.</div>
    ${st.current ? `<div class="pod"><div class="nm">${esc(st.current.name)} <span class="muted" style="font-weight:400">· in research</span></div><div style="font-size:12.5px">${esc(st.current.one_liner)}</div></div>` : ''}
    ${P.map(x => `<div class="rlog ${x.verdict === 'GREENLIT' ? 'pass' : x.verdict === 'KILLED' ? 'fail' : ''}" data-v="${x.id}" style="cursor:pointer"><div style="display:flex;justify-content:space-between"><b>${esc(x.name)}</b>
        <span class="mono ${VERD[x.verdict] ?? ''}" style="${x.verdict === 'WATCHLIST' ? 'color:#fbbf24' : ''}">${x.verdict ? `${x.verdict} · ${x.total}` : esc(x.stage)}</span></div>
        <div class="muted">${esc(x.category || '')} · ${esc(x.customer || '')}</div><div style="margin-top:3px">${esc(x.one_liner)}</div>
        ${x.memo ? `<div class="faint" style="margin-top:2px">${esc(x.memo)}</div>` : ''}</div>`).join('') || '<div class="muted">No ideas yet. The first studio session starts ~4 minutes after launch.</div>'}`;
  $('vNow').onclick = () => send({ type: 'studio_now' });
  document.querySelectorAll('[data-v]').forEach(el => el.onclick = () => openVenture(el.dataset.v));
}
async function openVenture(id) {
  const x = await (await fetch('/api/studio/' + id)).json(); if (!x || !x.id) return;
  const r = x.research || {}, li = a => (a || []).map(v => `<li>${esc(v)}</li>`).join('');
  const link = u => /^https?:\/\//.test(u) ? `<a href="${esc(u)}" target="_blank" rel="noopener" style="color:var(--accent)">${esc(u)}</a>` : esc(u);
  modal('venture', `${esc(x.name)} ${x.verdict ? `· <span class="${VERD[x.verdict] ?? ''}">${x.verdict} ${x.total}/100</span>` : ''}`, `
    <p style="margin-top:0"><b>${esc(x.one_liner)}</b></p>
    <p class="muted" style="font-size:12.5px">Customer: ${esc(x.customer)}<br>Problem: ${esc(x.problem)}<br>Why now: ${esc(x.why_now)}<br>Inspired by: ${esc(x.inspired_by)}</p>
    ${x.memo ? `<h4>Rosa's decision</h4><p>${esc(x.memo)}</p><p class="muted">Biggest risk: ${esc(x.biggest_risk || '')}</p>` : ''}
    ${x.scores ? `<div class="stat-grid" style="grid-template-columns:1fr 1fr 1fr">${Object.entries(x.scores).map(([k, v]) => `<div><b style="text-transform:capitalize">${k.replace(/_/g, ' ')}</b><span class="mono">${v}/10</span></div>`).join('')}</div>` : ''}
    ${x.next_steps?.length ? `<h4>Next steps</h4><ol>${li(x.next_steps)}</ol>` : ''}
    ${r.summary ? `<h4>Theo's research</h4><p>${esc(r.summary)}</p><h4>Evidence of the pain</h4><ul>${li(r.pain_evidence)}</ul>
    <h4>Competitors</h4><table><thead><tr><th>Name</th><th>Pricing</th><th>Weakness</th></tr></thead><tbody>${(r.competitors || []).map(c => `<tr><td class="t">${link(c.url) === esc(c.url) ? esc(c.name) : `<a href="${esc(c.url)}" target="_blank" rel="noopener" style="color:var(--accent)">${esc(c.name)}</a>`}</td><td class="t">${esc(c.pricing)}</td><td class="t">${esc(c.weakness)}</td></tr>`).join('')}</tbody></table>
    <p><b>Pricing:</b> ${esc(r.pricing_model)}</p><p><b>Market size:</b> ${esc(r.market_size)}</p><p><b>First 10 customers:</b> ${esc(r.first_customers)}</p><p><b>Build:</b> ${esc(r.build)}</p>
    <h4>Risks</h4><ul>${li(r.risks)}</ul><h4>Sources</h4><ul style="font-size:12px">${(r.sources || []).map(u => `<li>${link(u)}</li>`).join('')}</ul>` : ''}
    ${x.report ? `<p class="faint" style="font-size:12px">Saved report: claudeworkspace/${esc(x.report)}</p>` : ''}
    <p class="faint" style="font-size:11.5px">AI-generated research. Verify the facts before acting on them.</p>`);
}
const WTAG = { fund: 'JB Capital', studio: 'JB Ventures', news: 'JB Newsroom', career: 'JB Careers', study: 'JB Study Hall', jason: 'You' };
function renderStudy() {
  const s = snap.study; if (!s) return;
  const el = $('studyp'), keepTopic = $('qTopic')?.value || '', focused = document.activeElement?.id === 'qTopic', keep = el.scrollTop;
  const q = s.quiz, st = s.stats;
  const nextQ = q ? q.questions.findIndex(x => x.picked == null) : -1;
  const score = q ? q.questions.filter(x => x.picked != null && x.picked === x.answer).length : 0, answered = q ? q.questions.filter(x => x.picked != null).length : 0;
  const card = (x, i) => {
    const done = x.picked != null;
    return `<div class="rlog ${done ? (x.picked === x.answer ? 'pass' : 'fail') : ''}" style="margin-bottom:10px"><div class="faint mono" style="font-size:11px">QUESTION ${i + 1} OF ${q.questions.length}</div>
      <div style="margin:4px 0 8px;font-size:13.5px;line-height:1.45">${esc(x.q)}</div>
      ${x.choices.map((c, k) => `<button class="btn" data-qi="${i}" data-pick="${k}" ${done ? 'disabled' : ''} style="display:block;width:100%;text-align:left;margin:4px 0;${done && k === x.answer ? 'border-color:var(--green);color:var(--green)' : done && k === x.picked ? 'border-color:var(--red);color:var(--red)' : ''}">${'ABCD'[k]}. ${esc(c)}</button>`).join('')}
      ${done ? `<div style="margin-top:6px;font-size:12.5px">${x.picked === x.answer ? '<b class="up">Correct.</b>' : '<b class="down">Not quite.</b>'} ${esc(x.explain)}</div>` : ''}</div>`;
  };
  el.innerHTML = `<div class="muted" style="font-size:12px;margin-bottom:8px">Reads your classes + Canvas tasks from JB Terminal (read-only). Small blocks, quick wins first. Missed questions come back tomorrow (spaced repetition).</div>${mathCardHtml() + mmCardHtml()}
    <div class="stat-grid" style="margin-bottom:10px"><div><b>Streak</b><span class="mono">${st.streak} day${st.streak === 1 ? '' : 's'}</span></div><div><b>Answered</b><span class="mono">${st.answered}</span></div><div><b>Review due</b><span class="mono">${st.review_due} / ${st.deck}</span></div></div>
    ${(s.plan || []).length ? `<h4 style="margin:6px 0">Today's plan</h4>${s.plan.map((p, i) => `<div class="faint" style="margin:3px 0"><b style="color:var(--text)">${i + 1}. ${p.mins} min · ${esc(p.kind)}</b> — ${esc(p.task.course)}: ${esc(p.task.title)}</div>`).join('')}` : ''}
    <h4 style="margin:12px 0 6px">Practice</h4>
    <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px"><input id="qTopic" class="btn" style="flex:1 1 160px;min-width:0;text-align:left" maxlength="200" placeholder="Topic (blank = what's due next)"><button class="btn" id="qNew" ${s.busy ? 'disabled' : ''}>${s.busy ? 'Quinn is writing…' : st.review_due >= 3 ? 'Review round' : 'New round'}</button></div>
    ${q ? `<div class="faint" style="margin-bottom:6px"><b style="color:var(--text)">${esc(q.topic)}</b> · ${score}/${answered} right${nextQ < 0 ? ' · <b class="up">round done</b>' : ''}</div>${q.questions.map(card).join('')}` : `<div class="muted">${s.on ? 'Start a round whenever you want. No timer.' : 'New rounds need the AI brain; review rounds work without it.'}</div>`}
    <h4 style="margin:12px 0 6px">Due soon</h4>${s.tasks.filter(t => t.days <= 10).map(t => `<div class="faint" style="margin:3px 0">${t.days < 0 ? '<b class="down">late</b>' : t.days === 0 ? '<b class="up">today</b>' : `<b>${t.days}d</b>`} · ${esc(t.course)}: ${t.test ? '<b style="color:var(--text)">' + esc(t.title) + '</b>' : esc(t.title)}${t.extended ? ' <span class="tag">extended</span>' : ''}</div>`).join('') || '<div class="muted">Nothing due in the next 10 days.</div>'}
    ${Object.keys(st.by_course).length ? `<h4 style="margin:12px 0 6px">Accuracy by course</h4>${Object.entries(st.by_course).map(([c, v]) => gauge(c, v.ok, v.n, `${v.ok}/${v.n}`)).join('')}` : ''}
    ${s.error ? `<div class="down" style="font-size:12px">${esc(s.error)}</div>` : ''}`;
  el.scrollTop = keep;
  if (keepTopic) $('qTopic').value = keepTopic; if (focused) $('qTopic').focus();
  $('qNew').onclick = () => { send({ type: 'quiz_new', topic: $('qTopic').value.trim() }); $('qTopic').value = ''; };
  el.querySelectorAll('[data-pick]').forEach(b => b.onclick = () => { el.querySelectorAll(`[data-qi="${b.dataset.qi}"]`).forEach(x => x.disabled = true); send({ type: 'quiz_answer', i: +b.dataset.qi, pick: +b.dataset.pick }); });
}
function renderCareer() {
  const c = snap.career; if (!c) return;
  const keep = $('careerp').scrollTop;
  const prep = c.prep && c.prep.date >= new Date().toISOString().slice(0, 10) ? c.prep : null;
  $('careerp').innerHTML = `<div class="muted" style="font-size:12px;margin-bottom:8px">Reads your JB Terminal (read-only). Drew writes <b>drafts only</b>: copy them and send them yourself. ${c.error ? `<span class="down">${esc(c.error)}</span>` : ''}</div>
    ${prep ? `<div class="letter"><div class="faint mono" style="font-size:11px">PREP SHEET · ${esc(prep.title)} · ${esc(prep.date)}</div><h4 style="margin-top:4px">30-second pitch</h4><p>${esc(prep.pitch)}</p>
      ${prep.targets.map(t => `<p><b>${esc(t.org)}</b>: ${esc(t.what_they_do)}<br><span class="faint">${esc(t.angle)}</span><br>${t.questions.map(q => '• ' + esc(q)).join('<br>')}</p>`).join('')}
      <p class="faint">${prep.checklist.map(x => '☐ ' + esc(x)).join('<br>')}</p></div>` : ''}
    <h4 style="margin:10px 0 6px">Follow-ups due (${c.due.length})</h4>
    ${c.due.map(d => { const dr = c.drafts[d.id]; return `<div class="rlog ${dr?.message ? 'pass' : ''}"><div style="display:flex;justify-content:space-between;gap:6px"><b>${esc(d.name)}</b><span class="tag">${esc(d.status)}</span></div>
      <div class="faint">${esc(d.org)} · due ${esc(d.due)}${d.overdue > 0 ? ` · <span class="down">${d.overdue}d late</span>` : ''}</div>
      ${dr?.message ? `<div style="margin-top:6px;white-space:pre-wrap">${esc(dr.message)}</div><button class="btn sm" data-copy="${esc(d.id)}" style="margin-top:6px">Copy draft</button>` : `<div class="faint" style="margin-top:4px">${c.on ? 'Drew will draft this one soon.' : 'Turn the AI brain on for drafts.'}</div>`}</div>`; }).join('') || '<div class="muted">Nothing due.</div>'}
    <h4 style="margin:12px 0 6px">Coming up</h4>${c.events.map(e => `<div class="faint">${e.days === 0 ? '<b class="up">TODAY</b>' : `<b>${e.days}d</b>`} · ${esc(e.title)} <span class="mono">${esc(e.date)}</span></div>`).join('')}
    <h4 style="margin:12px 0 6px">Opportunities Maya found</h4>${c.opps.slice().reverse().map(o => `<div class="rlog"><b>${esc(o.name)}</b> <span class="faint">${esc(o.org)} · deadline ${esc(o.deadline)}</span><div class="faint">${esc(o.eligible)}</div>${/^https?:/.test(o.url) ? `<a href="${esc(o.url)}" target="_blank" rel="noopener noreferrer" class="faint">${esc(o.url)}</a>` : ''}</div>`).join('') || `<div class="muted">${c.on ? `Next scouting run in ${Math.ceil(c.next_scout_in / 3600)}h.` : 'Needs the AI brain.'}</div>`}
    ${c.firm_news.length ? `<h4 style="margin:12px 0 6px">Your firms in the news</h4>${c.firm_news.slice().reverse().map(x => `<div class="faint"><b>${esc(x.firm)}</b> · <a href="${esc(x.link)}" target="_blank" rel="noopener noreferrer" style="color:inherit">${esc(x.title)}</a></div>`).join('')}` : ''}`;
  $('careerp').scrollTop = keep;
  $('careerp').querySelectorAll('[data-copy]').forEach(b => b.onclick = () => { navigator.clipboard?.writeText(c.drafts[b.dataset.copy].message); b.textContent = 'Copied ✓'; });
}
function renderNews() {
  const n = snap.news || {}, b = n.brief;
  const tone = s => s.tone > 0.15 ? 'up' : s.tone < -0.15 ? 'down' : 'muted';
  $('newsp').innerHTML = `<div class="muted" style="font-size:12px;margin-bottom:8px">Real headlines from free RSS feeds, checked every 10 min. Nia's briefing goes out every hour: market news to the fund (Ava reads it), AI trends to JB Ventures. ${n.count || 0} stories in the archive.</div>
    ${b ? `<div class="letter"><div class="faint mono" style="font-size:11px">BRIEFING · ${new Date(b.t * 1000).toLocaleTimeString()}</div><h4 style="margin-top:4px">${esc(b.headline)}</h4>
      <p>${esc(b.market_brief)}</p>${(b.symbols || []).length ? `<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px">${b.symbols.map(s => `<span class="tag ${tone(s)}" title="${esc(s.why)}">${esc(s.sym)} ${s.tone > 0.15 ? '▲' : s.tone < -0.15 ? '▼' : '•'}</span>`).join('')}</div>` : ''}
      ${b.trends ? `<p class="faint">Trends → JB Ventures: ${esc(b.trends)}</p>` : ''}</div>` : `<div class="muted" style="margin-bottom:10px">First briefing in ${Math.ceil((n.next_brief_in || 0) / 60)} min.</div>`}
    ${(n.errors || []).length ? `<div class="faint" style="font-size:11px;margin-bottom:6px">Feed trouble: ${esc(n.errors.join(', '))}</div>` : ''}
    <div class="feed">${(n.headlines || []).map(x => `<div><span class="tm">${new Date(x.t * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span><span class="who" style="color:${DESK_COL[x.desk] || '#fff'}">${esc(x.source)}</span>
      <a href="${esc(x.link)}" target="_blank" rel="noopener noreferrer" style="color:${x.big ? '#fecaca' : 'inherit'};text-decoration:none">${esc(x.title)}</a>${x.tags.length ? ` <span class="faint mono" style="font-size:11px">${esc(x.tags.join(' '))}</span>` : ''}</div>`).join('') || '<div class="muted">Fetching the first headlines…</div>'}</div>`;
}
function renderWire() {
  const w = snap.wire || {}, P = (w.posts || []).slice().reverse();
  if (!$('wForm')) $('wire').innerHTML = `<div id="wForm" style="margin-bottom:12px">
      <div class="muted" style="font-size:12px;margin-bottom:6px">Send a message to a tower. The CIO answers questions about the fund; JB Ventures turns requests into researched ideas at its next meeting. (Your phone can send the same messages through OpenClaw.)</div>
      <div style="display:flex;gap:6px;flex-wrap:wrap"><select id="wTo" class="btn" style="flex:0 0 auto"><option value="fund">JB Capital (CIO)</option><option value="studio">JB Ventures (Rosa)</option><option value="news">JB Newsroom (Nia)</option><option value="career">JB Careers (Cole)</option><option value="study">JB Study Hall (Remy)</option></select>
      <input id="wText" class="btn" style="flex:1 1 160px;min-width:0;text-align:left" maxlength="600" placeholder="e.g. How did the fund do today?">
      <button class="btn" id="wSend">Send</button></div></div><div id="wList"></div>`,
    $('wSend').onclick = () => { const v = $('wText').value.trim(); if (!v) return; send({ type: 'wire', to: $('wTo').value, text: v }); $('wText').value = ''; },
    $('wText').onkeydown = ev => { if (ev.key === 'Enter') $('wSend').click(); };
  $('wList').innerHTML = P.map(p => `<div class="rlog ${p.status === 'done' ? 'pass' : ''}">
      <div style="display:flex;justify-content:space-between;gap:6px"><b>${esc(WTAG[p.frm] || p.frm)} → ${esc(WTAG[p.to] || p.to)}</b><span class="tag">${esc(p.topic)}</span></div>
      <div style="margin-top:3px">${esc(p.text)}</div>
      ${p.reply ? `<div style="margin-top:6px;color:#a7f3d0">↳ <b>${esc(nameOf(p.replied_by))}:</b> ${esc(p.reply)}</div>` : p.status !== 'done' ? `<div class="faint" style="margin-top:4px">${p.topic === 'request' ? 'waiting for an answer…' : 'delivered · read at the next meeting'}</div>` : ''}
      <div class="faint mono" style="font-size:11px;margin-top:4px">${new Date(p.t * 1000).toLocaleString()}</div></div>`).join('') || '<div class="muted">No messages yet.</div>';
}
function renderLetters() {
  const L = (snap.letters || []).slice().reverse();
  $('letters').innerHTML = `<div style="display:flex;justify-content:space-between;align-items:center;gap:8px"><span class="muted" style="font-size:12px">Written by the CIO (Claude) once a day.</span><button class="btn" id="lNow" ${snap.writing_letter || !snap.analyst_on ? 'disabled' : ''}>${snap.writing_letter ? 'Writing…' : 'Write letter now'}</button></div>` +
    (L.map(l => `<div class="letter" style="margin-top:10px"><div class="faint mono" style="font-size:11px">${new Date(l.t * 1000).toLocaleString()} · NAV ${(+l.nav).toFixed(2)}</div><h4>${esc(l.title)}</h4><p>${esc(l.body)}</p></div>`).join('') || '<div class="muted" style="margin-top:12px">No letters yet.</div>');
  $('lNow').onclick = () => send({ type: 'letter_now' });
}
const NOTES = { boss: 'Allocates capital across PM pods by earned trust, approves trades within limits and runs the team huddle.',
  rex: 'Sizes every trade, walks the floor checking positions, enforces the fund risk cap and shuts down pods that hit their drawdown limit.',
  eddie: 'Routes orders (stocks, futures, crypto, Deribit options) and manages stops and trailing stops.',
  dot: 'Runs the data pipeline: Coinbase (live), Yahoo (delayed), Deribit option chains.', vic: 'Tracks volatility regimes. Storm = half size; his read feeds Opal’s options trades.',
  sam: 'Grades every call one hour later (options by trade result). Trust and allocation come from results.',
  ava: 'Market briefs, investor-letter research, and the R&D lab: invents new PMs and retrains weak ones. Claude via your Max plan.' };
function openProfile(id) { openTab('pods'); profileId = id; renderProfile(id); }
function renderProfile(id) {
  const a = agents[id]; if (!a) { profileId = null; return renderPods(); }
  const pod = snap?.roster?.find(r => r.id === id);
  const status = a.leaving ? 'leaving' : a.path.length ? 'walking' : a.seated ? 'at desk' : 'away';
  let h = `<div style="display:flex;justify-content:space-between;align-items:center"><div><div style="font-size:16px;font-weight:700;color:${COLORS[id]}">${esc(a.name)} <span class="mono muted" style="font-size:12px">#${String(a.badge).padStart(2, '0')}</span></div><div class="muted">${esc(a.role)} · ${status}</div></div><button class="btn sm" id="backPods">All pods</button></div>`;
  if (pod) h += `<div style="margin-top:10px">${podCard(pod)}</div>` + (pod.bt ? `<div class="faint" style="font-size:12px">Backtest: ${esc(pod.bt)}</div>` : '');
  else { const st = snap?.agents?.[id]; h += `<div class="muted" style="margin-top:10px">${NOTES[id] || ''}</div>` + (st ? `<div class="mono" style="margin-top:6px;font-size:12px">calls ${st.n} · hit ${st.hit == null ? '—' : Math.round(st.hit * 100) + '%'} · trust ${(st.trust ?? 1).toFixed(2)}</div>` : ''); }
  if (a.said.length) h += `<h3 style="margin:14px 0 6px">Recently said</h3><div class="feed">` + a.said.slice(-4).reverse().map(x => `<div>“${esc(x)}”</div>`).join('') + '</div>';
  if (document.activeElement?.id === 'gcQ' && $('pods').contains(document.activeElement)) return;     // typing a question: don't redraw under it
  $('pods').innerHTML = h + (isGame() ? '' : askBox(a)); $('backPods').onclick = () => { profileId = null; renderPods(); };
  wirePodButtons($('pods')); if (!isGame()) wireAsk(a);
}
function logLine(e) {
  const box = $('feed'), d = document.createElement('div');
  const tm = e.t ? new Date(e.t * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
  d.innerHTML = `<span class="tm">${tm}</span><span class="who" style="color:${COLORS[e.agent] || '#fff'}">${esc(e.name || '')}</span>${esc(e.text)}`;
  box.appendChild(d); while (box.children.length > 200) box.firstChild.remove(); box.scrollTop = box.scrollHeight;
}
function showToast(text, onclick) {
  const t = document.createElement('div'); t.className = 'btn on'; t.textContent = text; Object.assign(t.style, { position: 'fixed', right: '24px', bottom: '24px', zIndex: 30 });
  t.onclick = () => { onclick(); t.remove(); }; document.body.appendChild(t); setTimeout(() => t.remove(), 9000);
}

// ── modals ────────────────────────────────────────────────
let modalKind = null;
function modal(kind, title, html) { modalKind = kind; $('win').innerHTML = `<div class="mh"><h2>${title}</h2><button class="btn sm" id="mClose">Close</button></div><div class="mb">${html}</div>`; $('modal').style.display = 'flex'; $('mClose').onclick = closeModal; }
function closeModal() { $('modal').style.display = 'none'; modalKind = null; }
$('modal').addEventListener('click', e => { if (e.target.id === 'modal') closeModal(); });
addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });
const SETTINGS = [
  { key: 'RISK_APPETITE', label: 'CIO risk appetite (share of Kelly)', min: 0.25, max: 1, step: 0.05, fmt: v => Math.round(v * 100) + '% · stop-out limit ' + Math.round(v * 20) + '%/yr' },
  { key: 'MAX_POD_RISK', label: 'CIO max risk per trade (any pod)', min: 0.01, max: 0.2, step: 0.005, fmt: v => (v * 100).toFixed(1) + '%' },
  { key: 'MAX_GROSS', label: 'Max gross exposure (margin)', min: 1, max: 2, step: 0.05, fmt: v => (+v).toFixed(2) + 'x NAV' },
  { key: 'RISK_PER_TRADE', label: 'Starting risk per trade (unproven pods)', min: 0.005, max: 0.05, step: 0.0025, fmt: v => (v * 100).toFixed(2) + '%' },
  { key: 'MAX_TOTAL_RISK', label: 'Fund risk cap (NAV)', min: 0.01, max: 0.2, step: 0.005, fmt: v => (v * 100).toFixed(1) + '%' },
  { key: 'POD_DD_LIMIT', label: 'Pod drawdown limit', min: 0.02, max: 0.25, step: 0.01, fmt: v => (v * 100).toFixed(0) + '%' },
  { key: 'MAX_POSITIONS', label: 'Max open positions', min: 1, max: 20, step: 1, fmt: v => String(Math.round(v)) },
  { key: 'MAX_SYM_NOTIONAL', label: 'Fund limit per market', min: 0.05, max: 0.5, step: 0.05, fmt: v => (v * 100).toFixed(0) + '%' },
  { key: 'MAX_GROUP_NOTIONAL', label: 'Fund limit per market group', min: 0.1, max: 1, step: 0.05, fmt: v => (v * 100).toFixed(0) + '%' },
];
function openSettings() { focusOn(23.5, 1, -11.5, 14); modal('settings', 'CIO desk · risk policy', '<div id="setBody"></div>'); renderSettings(true); }
function renderSettings(full) {
  const body = $('setBody'); if (!body) return;
  if (!full && body.contains(document.activeElement)) return;
  const cur = snap?.settings || {};
  const PRE = [['pod_shop', 'Pod shop (recommended)', 'How real multi-manager funds run: ~0.75% starting risk, 8% fund cap, 10% pod stop, no margin, 25%/50% concentration caps'],
    ['aggressive', 'Aggressive paper', 'More action for learning: 1.5% starting risk, 12% fund cap, 15% pod stop, 1.25x gross'], ['max', 'Max', 'Every slider at the top (the old setting)']];
  body.innerHTML = `<div class="muted" style="font-size:12.5px">Changes apply immediately and are announced on the floor.</div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:8px;margin:10px 0 14px">${PRE.map(([k, l, d]) => `<button class="pod" data-preset="${k}" style="margin:0;padding:10px;text-align:left;cursor:pointer;background:var(--bg2);border:1px solid ${k === 'pod_shop' ? '#22c55e' : 'var(--border2)'};border-radius:12px;color:var(--text)"><b>${l}</b><div class="faint" style="font-size:11.5px;margin-top:3px">${d}</div></button>`).join('')}</div>` +
    SETTINGS.map(s => `<div class="srow"><span>${s.label}</span><input type="range" min="${s.min}" max="${s.max}" step="${s.step}" value="${cur[s.key] ?? s.min}" data-k="${s.key}"><b class="mono" id="v_${s.key}">${s.fmt(cur[s.key] ?? s.min)}</b></div>`).join('') +
    `<h3 style="margin:16px 0 8px">Capital allocation</h3>` + (snap?.roster || []).map(p => `<div class="srow"><span style="color:${COLORS[p.id] || '#fff'}">${esc(p.name)} <span class="tag ${p.status}">${p.status}</span></span><div class="bar"><i style="width:${Math.min(100, p.alloc / 0.6 * 100)}%"></i></div><b class="mono">${(p.alloc * 100).toFixed(0)}%</b></div>`).join('');
  body.querySelectorAll('[data-preset]').forEach(b => b.onclick = () => { send({ type: 'preset', name: b.dataset.preset }); b.style.borderColor = '#facc15'; setTimeout(() => renderSettings(true), 1500); });
  body.querySelectorAll('input[type=range]').forEach(inp => { const s = SETTINGS.find(x => x.key === inp.dataset.k);
    inp.oninput = () => $('v_' + s.key).textContent = s.fmt(+inp.value); inp.onchange = () => send({ type: 'set', key: s.key, value: +inp.value }); });
}
async function openCharts(sym) {
  const syms = snap ? Object.keys(snap.markets) : [];
  sym ||= syms[0] || 'BTC';
  modal('charts', 'Markets · 15-minute candles', `<div class="symtabs">${syms.map(s => `<button class="btn sm ${s === sym ? 'on' : ''}" data-s="${s}">${s}</button>`).join('')}</div><div id="candles"></div><div id="chartInfo" class="muted" style="margin-top:8px;font-size:12.5px"></div>`);
  document.querySelectorAll('[data-s]').forEach(b => b.onclick = () => openCharts(b.dataset.s));
  const r = await fetch('/api/bars/' + sym).then(r => r.json()).catch(() => ({ bars: [] }));
  if (!window.LightweightCharts || !$('candles')) return;
  const chart = LightweightCharts.createChart($('candles'), { autoSize: true, layout: { background: { color: 'transparent' }, textColor: '#8692ab', fontFamily: 'Inter' },
    grid: { vertLines: { color: 'rgba(30,40,64,.5)' }, horzLines: { color: 'rgba(30,40,64,.5)' } }, timeScale: { timeVisible: true, borderColor: '#1e2840' }, rightPriceScale: { borderColor: '#1e2840' } });
  const cs = chart.addCandlestickSeries({ upColor: '#22c55e', downColor: '#f43f5e', borderVisible: false, wickUpColor: '#22c55e', wickDownColor: '#f43f5e' });
  cs.setData(r.bars.map(b => ({ time: b[0], open: b[1], high: b[2], low: b[3], close: b[4] })));
  for (const p of (snap?.positions || []).filter(p => p.sym === sym && !p.option)) { cs.createPriceLine({ price: p.entry, color: '#7c8cff', lineStyle: 2, title: `${p.pod_name} entry` }); cs.createPriceLine({ price: p.stop, color: '#f43f5e', lineStyle: 2, title: 'stop' }); }
  for (const p of (snap?.positions || []).filter(p => p.option && p.sym.startsWith(sym))) for (const l of p.legs.filter(l => l.side < 0)) { const k = +l.name.split('-')[2]; cs.createPriceLine({ price: k, color: '#2dd4bf', lineStyle: 1, title: `short ${l.name.split('-')[3]} ${k}` }); }
  chart.timeScale().fitContent();
  $('chartInfo').textContent = r.bars.length ? `${sym} · ${snap?.markets?.[sym]?.name || ''} · last ${fmtPx(r.bars.at(-1)[4])} · ${r.bars.length} bars` : 'No data yet.';
}
function openTrades() {
  focusOn(POI.exchange.x - 1, 1.5, 3.5, 10);
  const t = (snap?.trades || []).slice().reverse(), wins = t.filter(x => x.pnl > 0).length;
  modal('trades', 'Execution · trade blotter', `<div class="muted" style="font-size:12.5px">${t.length} closed trades · ${t.length ? Math.round(wins / t.length * 100) : 0}% winners · fees ${money(snap?.fees || 0)}</div>
    <table style="margin-top:8px"><thead><tr><th>Time</th><th>Pod</th><th>Instrument</th><th>Side</th><th>Entry</th><th>Exit</th><th>P&amp;L</th><th>Exit reason</th></tr></thead><tbody>${
    t.map(x => `<tr><td>${new Date(x.closed * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</td><td class="t" style="color:${COLORS[x.pod] || '#fff'}">${esc(nameOf(x.pod))}</td><td class="t">${esc(x.sym)}</td><td>${x.why === 'options' ? 'OPT' : x.side > 0 ? 'L' : 'S'}</td><td>${x.why === 'options' ? money(x.entry) : fmtPx(x.entry)}</td><td>${x.why === 'options' ? '—' : fmtPx(x.exit)}</td><td class="${cls(x.pnl)}">${money(x.pnl)}</td><td class="t muted">${esc(x.reason)}</td></tr>`).join('') || '<tr><td colspan="8" class="t muted">No closed trades yet.</td></tr>'}</tbody></table>`);
}

// ── demo (local only) ─────────────────────────────────────
function demo() {
  const T = (k, a, txt, extra = {}) => ({ kind: k, agent: a, name: nameOf(a), text: txt, t: Date.now() / 1000, ...extra });
  [[0, T('data', 'dot', 'DEMO · Market data refreshed. BTC breaking out.')],
   [3000, T('signal', 'mo', 'DEMO · BTC breakout at 86,200. I want to BUY.', { dir: 1, sym: 'BTC' })],
   [11000, T('decision', 'boss', 'DEMO · Mo: approved within your limits. Rex, size it.', { act: 'trade' })],
   [14500, T('risk', 'rex', 'DEMO · APPROVED 0.12 BTC for Mo. Risk $1,000.', { ok: true, target: 'mo' })],
   [17500, T('order', 'eddie', "DEMO · Working Mo's order: buy 0.12 BTC…")],
   [22000, T('fill', 'eddie', 'DEMO · FILLED 0.12 BTC', { sym: 'BTC' })],
   [24000, T('huddle', 'boss', 'DEMO · Huddle, everyone. NAV 100.41, today +0.41%. Best pod: Mo.')],
   [36000, T('meeting', 'rex', 'DEMO · Risk: 1 open position, $1,000 at risk (1.0% of NAV).')],
   [41000, T('meeting', 'opal', 'DEMO · Vol check: BTC IV 32% vs RV 25%. Condors look attractive.')],
   [54000, T('close', 'eddie', "DEMO · CLOSED Mo's BTC: +$412", { pnl: 412, pod: 'mo' })]].forEach(([ms, e]) => setTimeout(() => handle(e), ms));
}

// ── connection ────────────────────────────────────────────
let ws = null;
function send(msg) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); }
function connect() {
  ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
  ws.onopen = () => { $('conn').textContent = 'live'; $('liveDot').classList.add('on'); $('gDot').classList.add('on'); };
  ws.onclose = () => { $('conn').textContent = 'offline'; $('liveDot').classList.remove('on'); $('gDot').classList.remove('on'); setTimeout(connect, 3000); };
  ws.onmessage = m => { const msg = JSON.parse(m.data);
    if (msg.type === 'hello') { if (msg.snapshot) hud(msg.snapshot); msg.events.forEach(logLine); }
    else if (msg.type === 'event') handle(msg.event);
    else if (msg.type === 'snapshot') hud(msg.snapshot); };
}
Promise.all([document.fonts.load('600 20px Inter'), document.fonts.load("500 20px 'JetBrains Mono'")]).finally(() => {
  [heatTex, navTex, sbTex, tkTex, tvTex, tbTex, signTex, exTex, labTex, wbTex, jbSign, meetLabel, wireTex, newsTex, zipTex, careerTex, chalkTex, cityTex].forEach(t => t.redraw());
  connect(); if (location.search.includes('demo')) demo();
  const q = new URLSearchParams(location.search), o = q.get('open'), f = q.get('focus');   // test hooks: ?open=pods  ?focus=mo  ?city
  if (f) setTimeout(() => { const a = agents[f]; if (a) { selected = f; a.swivelUntil = performance.now() + 60000; tweenCam(new THREE.Vector3(a.x + 1.6, 2.4, a.z - 3.2), new THREE.Vector3(a.x, 1.1, a.z), 10); } }, 5000);
  if (q.has('celebrate')) setTimeout(() => { const a = agents[q.get('celebrate')]; if (a) tweenCam(new THREE.Vector3(a.x + 2.2, 3.4, a.z - 4.4), new THREE.Vector3(a.x, 1.3, a.z), 10); handle({ kind: 'close', agent: 'eddie', name: 'Eddie', text: 'TEST · CLOSED +$420', pnl: 420, pod: q.get('celebrate'), t: Date.now() / 1000 }); }, 5000);
  if (q.has('fireworks')) setInterval(() => launchFireworks(0, 0, 4), 3000);    // test hook: ?fireworks
  if (q.has('ventures')) setTimeout(() => { tweenCam(STUDIO_CAM[0].clone(), STUDIO_CAM[1].clone(), 10); openTab('ventures'); }, 1500);
  if (q.has('courier')) setTimeout(() => { handle({ kind: 'wire', agent: 'ava', name: 'Ava', frm: 'fund', to: 'studio', topic: 'market_brief', text: '[JB Capital -> JB Ventures] TEST brief', t: Date.now() / 1000 });
    tweenCam(WIRE_CAM[0].clone(), WIRE_CAM[1].clone(), 10); }, 3000);   // test hook: ?courier
  if (q.has('city')) setTimeout(() => tweenCam(CITY_CAM[0].clone(), CITY_CAM[1].clone(), 10), 1500);
  if (o) setTimeout(() => ({ settings: openSettings, charts: () => openCharts(), trades: openTrades, pods: () => openTab('pods'), team: () => openTab('team'), risk: () => openTab('riskp'), research: () => openTab('research'), letters: () => openTab('letters'), wire: openWire, news: openNews, career: openCareer, study: openStudy, cityhall: openCityHall })[o]?.(), 2500);
});
