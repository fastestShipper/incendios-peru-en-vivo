// Incendios forestales en Perú – mapa 3D en vivo (no oficial). three.js r170.
import * as THREE from "three";
import { OrbitControls } from "three/addons/OrbitControls.js";
import { CSS2DRenderer, CSS2DObject } from "three/addons/CSS2DRenderer.js";

const POLL_MS = 2 * 60 * 1000;
const MAX_HOTSPOTS = 6000;
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const safeUrl = (u) => (/^https?:\/\//i.test(u || "") ? u : "#");

// ------------------------------------------------------------ textos simples
const EST = {
  activo: { w: "Fuego activo", c: "#ff3b1f", d: "El fuego sigue encendido según el último reporte." },
  en_control: { w: "Lo están controlando", c: "#ff9d00", d: "Bomberos, brigadas o pobladores están trabajando para apagarlo." },
  controlado: { w: "Controlado", c: "#f5d000", d: "El fuego ya no avanza, pero todavía lo vigilan." },
  extinguido: { w: "Apagado", c: "#2fbf5b", d: "El último reporte dice que el fuego fue apagado." },
  sin_dato: { w: "Sin información del estado", c: "#9aa3ad", d: "No hay un reporte oficial reciente sobre su estado." },
  inferido: { w: "Posible fuego visto por satélite, sin confirmar", c: "#b77cff", d: "Un satélite de la NASA detectó calor aquí, pero ninguna autoridad lo ha confirmado. Puede ser una quema agrícola." },
};
const REG = { AMAZONAS: "Amazonas", ANCASH: "Áncash", APURIMAC: "Apurímac", AREQUIPA: "Arequipa", AYACUCHO: "Ayacucho", CAJAMARCA: "Cajamarca", CALLAO: "Callao", CUSCO: "Cusco", HUANCAVELICA: "Huancavelica", HUANUCO: "Huánuco", ICA: "Ica", JUNIN: "Junín", "LA LIBERTAD": "La Libertad", LAMBAYEQUE: "Lambayeque", LIMA: "Lima", LORETO: "Loreto", "MADRE DE DIOS": "Madre de Dios", MOQUEGUA: "Moquegua", PASCO: "Pasco", PIURA: "Piura", PUNO: "Puno", "SAN MARTIN": "San Martín", TACNA: "Tacna", TUMBES: "Tumbes", UCAYALI: "Ucayali" };
const regName = (r) => REG[r] || title(r);
function title(s) { return String(s || "").toLowerCase().replace(/(^|[\s(\-–])([a-záéíóúñ])/g, (m, a, b) => a + b.toUpperCase()); }
const fmtDay = new Intl.DateTimeFormat("es-PE", { timeZone: "America/Lima", weekday: "long", day: "numeric", month: "long" });
const fmtDT = new Intl.DateTimeFormat("es-PE", { timeZone: "America/Lima", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false });
function ago(iso) {
  if (!iso) return "";
  const m = Math.round((Date.now() - new Date(iso)) / 60000);
  if (m < 1) return "hace un momento";
  if (m < 60) return `hace ${m} minuto${m === 1 ? "" : "s"}`;
  const h = Math.round(m / 60);
  if (h < 36) return `hace ${h} hora${h === 1 ? "" : "s"}`;
  const d = Math.round(h / 24);
  return `hace ${d} día${d === 1 ? "" : "s"}`;
}
function when(iso) { // fecha legible; si la hora es 00:00 se muestra solo el día
  if (!iso) return null;
  const d = new Date(iso);
  const hm = new Intl.DateTimeFormat("es-PE", { timeZone: "America/Lima", hour: "2-digit", minute: "2-digit", hour12: false }).format(d);
  return hm === "00:00" ? fmtDay.format(d) : fmtDT.format(d);
}
function haNumber(s) { // primer número de un texto de hectáreas (para tamaño del marcador)
  if (!s) return null;
  const m = String(s).replace(/(\d)[\s.](?=\d{3}\b)/g, "$1").match(/\d+(?:[.,]\d+)?/);
  return m ? parseFloat(m[0].replace(",", ".")) : null;
}
function severity(i) {
  const w = { activo: 100, en_control: 70, sin_dato: 20, controlado: 10, extinguido: 0, inferido: 5 }[i.estado] ?? 0;
  const ha = haNumber(i.hectareas) || 0;
  const sat = (i.satelite && i.satelite.focos_24h) || i.focos_24h || 0;
  return w + Math.log10(ha + 1) * 20 + (i.fallecidos || 0) * 8 + Math.min(sat, 30) * 0.3;
}

// ------------------------------------------------------------ proyección
const LON0 = -75.0, LAT0 = -9.3, K = Math.cos((LAT0 * Math.PI) / 180), S = 10;
const TOP = 0.8; // altura de las regiones
const px = (lon) => (lon - LON0) * K * S;
const pz = (lat) => -(lat - LAT0) * S;
const ll2v = (lat, lon, y = TOP) => new THREE.Vector3(px(lon), y, pz(lat));

// ------------------------------------------------------------ WebGL
function hasWebGL() {
  try { const c = document.createElement("canvas"); return !!(window.WebGLRenderingContext && (c.getContext("webgl2") || c.getContext("webgl"))); } catch { return false; }
}
const GL = hasWebGL();
const host = $("#scene");
let renderer, labelRenderer, scene, camera, controls;
const regions = {}; // nombre -> {mesh, center, size, label}
const fireGroup = new THREE.Group();
let hotPoints = null;
let markers = []; // {pos: Vector3, item, kind, parts}
let hotData = []; // puntos visibles para la selección técnica

function glowTexture(inner = "rgba(255,255,255,1)", mid = "rgba(255,255,255,0.35)") {
  const c = document.createElement("canvas"); c.width = c.height = 128;
  const g = c.getContext("2d"); const r = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  r.addColorStop(0, inner); r.addColorStop(0.25, mid); r.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = r; g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}
function ringTexture() {
  const c = document.createElement("canvas"); c.width = c.height = 128; const g = c.getContext("2d");
  g.strokeStyle = "#fff"; g.lineWidth = 10; g.setLineDash([16, 10]); g.beginPath(); g.arc(64, 64, 52, 0, Math.PI * 2); g.stroke();
  g.fillStyle = "rgba(255,255,255,.18)"; g.beginPath(); g.arc(64, 64, 48, 0, Math.PI * 2); g.fill();
  g.setLineDash([]); g.fillStyle = "#fff"; g.font = "bold 56px system-ui"; g.textAlign = "center"; g.textBaseline = "middle"; g.fillText("?", 64, 68);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}
function dotTexture() {
  const c = document.createElement("canvas"); c.width = c.height = 64; const g = c.getContext("2d");
  g.fillStyle = "#fff"; g.beginPath(); g.arc(32, 32, 26, 0, Math.PI * 2); g.fill();
  g.lineWidth = 6; g.strokeStyle = "rgba(0,0,0,.35)"; g.stroke();
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}
const TEX = GL ? { glow: glowTexture(), core: glowTexture("rgba(255,255,255,1)", "rgba(255,255,255,.9)"), ring: ringTexture(), dot: dotTexture() } : {};

function initScene() {
  renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(innerWidth, innerHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  host.appendChild(renderer.domElement);
  labelRenderer = new CSS2DRenderer();
  labelRenderer.setSize(innerWidth, innerHeight);
  Object.assign(labelRenderer.domElement.style, { position: "fixed", inset: "0", pointerEvents: "none" });
  host.appendChild(labelRenderer.domElement);

  scene = new THREE.Scene();
  scene.background = new THREE.Color("#0d1726");
  scene.fog = new THREE.Fog("#0d1726", 900, 1600);
  camera = new THREE.PerspectiveCamera(38, innerWidth / innerHeight, 1, 4000);
  scene.add(new THREE.HemisphereLight("#ffffff", "#3a4a63", 1.6));
  const sun = new THREE.DirectionalLight("#fff3e0", 1.6); sun.position.set(-80, 160, 120); scene.add(sun);

  // mar
  const sea = new THREE.Mesh(new THREE.CircleGeometry(1400, 64), new THREE.MeshBasicMaterial({ color: "#0f1d31" }));
  sea.rotation.x = -Math.PI / 2; sea.position.y = -0.05; scene.add(sea);
  const grid = new THREE.PolarGridHelper(300, 12, 10, 64, "#1c3352", "#1c3352"); grid.position.y = -0.02; scene.add(grid);
  const seaDiv = document.createElement("div"); seaDiv.className = "sea-label"; seaDiv.textContent = "OCÉANO PACÍFICO";
  const seaL = new CSS2DObject(seaDiv); seaL.position.copy(ll2v(-12.5, -80.6, 0)); scene.add(seaL);
  scene.add(fireGroup);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true; controls.dampingFactor = 0.08;
  controls.minDistance = 18; controls.maxDistance = 780;
  controls.minPolarAngle = 0.05; controls.maxPolarAngle = 1.15;
  controls.screenSpacePanning = false;
  controls.touches = { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_ROTATE }; // 1 dedo mueve, 2 dedos acercan/giran
  controls.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE };
  controls.addEventListener("change", () => { // limitar el desplazamiento al Perú
    const t = controls.target, b = { x0: px(-82.5), x1: px(-67.5), z0: pz(0.5), z1: pz(-19) };
    const cx = THREE.MathUtils.clamp(t.x, b.x0, b.x1), cz = THREE.MathUtils.clamp(t.z, b.z0, b.z1);
    if (cx !== t.x || cz !== t.z) { const dx = cx - t.x, dz = cz - t.z; t.x += dx; t.z += dz; camera.position.x += dx; camera.position.z += dz; }
  });
  addEventListener("resize", onResize);
}

function onResize() {
  if (!renderer) return;
  camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight); labelRenderer.setSize(innerWidth, innerHeight);
}

// encuadre: calcula distancia y desplazamiento para que una zona quepa en el área libre (sin cabecera ni panel)
function freeRect() {
  const top = $("#legend").getBoundingClientRect().bottom + 6; // la ayuda puede tapar un poco, se cierra con un toque
  const mobile = innerWidth <= 820;
  const bottom = mobile ? $("#tools").getBoundingClientRect().top - 6 : innerHeight - 76;
  const right = mobile ? innerWidth : $("#panel").getBoundingClientRect().left - 12;
  return { top, bottom: Math.max(bottom, top + 120), left: 0, right };
}
function frame(center, h, w, polar = 0.55) {
  const r = freeRect();
  const tanH = Math.tan((camera.fov * Math.PI) / 360);
  const fH = (r.bottom - r.top) / innerHeight, fW = (r.right - r.left) / innerWidth;
  const dist = THREE.MathUtils.clamp(Math.max((h * Math.cos(polar) * 0.86 + 6) / (fH * 2 * tanH), w / (fW * 2 * tanH * camera.aspect)) * 1.06, 20, 760);
  const unit = (2 * dist * tanH) / innerHeight; // unidades de mundo por píxel en el objetivo
  const dx = ((r.left + r.right) / 2 - innerWidth / 2) * unit, dy = ((r.top + r.bottom) / 2 - innerHeight / 2) * unit;
  const t = center.clone(); t.x -= dx; t.z -= dy / Math.cos(polar);
  return { target: t, dist, polar };
}
function homeView() { return frame(ll2v(-9.2, -74.95, 0), 186, 130); }
function viewToPos(v) {
  const p = new THREE.Vector3().setFromSphericalCoords(v.dist, v.polar, 0);
  return v.target.clone().add(p);
}
let fly = null;
function flyTo(v, ms = 1200) {
  if (!camera) return;
  fly = { t0: performance.now(), ms, fromP: camera.position.clone(), fromT: controls.target.clone(), toP: viewToPos(v), toT: v.target.clone() };
}
function flyToRegion(name) {
  const r = regions[name];
  if (!r) return flyTo(homeView());
  flyTo(frame(r.center, Math.max(r.sz.z, 12), Math.max(r.sz.x, 12), 0.6));
}
function flyToItem(i) { flyTo(frame(ll2v(i.lat, i.lon, 0), 26, 26, 0.62), 1000); }

// ------------------------------------------------------------ regiones
function buildRegions(geo, hotRegions) {
  const lineMat = new THREE.LineBasicMaterial({ color: "#9fb2c8", transparent: true, opacity: 0.75 });
  for (const f of geo.features) {
    const name = f.properties.NOMBDEP;
    const g = f.geometry; const polys = g.type === "MultiPolygon" ? g.coordinates : [g.coordinates];
    const shapes = []; const pts = [];
    let best = null, bestA = 0;
    for (const poly of polys) {
      const ring = poly[0];
      const shape = new THREE.Shape(ring.map(([lon, lat]) => new THREE.Vector2(px(lon), -pz(lat))));
      shapes.push(shape);
      const a = Math.abs(THREE.ShapeUtils.area(shape.getPoints()));
      if (a > bestA) { bestA = a; best = ring; }
      for (let k = 0; k < ring.length - 1; k++) {
        pts.push(px(ring[k][0]), TOP + 0.03, pz(ring[k][1]), px(ring[k + 1][0]), TOP + 0.03, pz(ring[k + 1][1]));
      }
    }
    const geom = new THREE.ExtrudeGeometry(shapes, { depth: TOP, bevelEnabled: false });
    geom.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshStandardMaterial({ color: "#3a4759", roughness: 0.95, metalness: 0 });
    const mesh = new THREE.Mesh(geom, mat); mesh.userData.name = name; scene.add(mesh);
    const lg = new THREE.BufferGeometry(); lg.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
    scene.add(new THREE.LineSegments(lg, lineMat));
    // centro del polígono mayor (promedio de vértices, suficiente para etiquetas)
    let cx = 0, cy = 0; best.forEach(([lon, lat]) => { cx += lon; cy += lat; }); cx /= best.length; cy /= best.length;
    const box = new THREE.Box3().setFromObject(mesh); const sz = box.getSize(new THREE.Vector3());
    const center = ll2v(cy, cx, 0);
    let label = null;
    if (name !== "CALLAO") {
      const d = document.createElement("div"); d.className = "reg-label"; d.textContent = regName(name);
      label = new CSS2DObject(d); label.position.copy(ll2v(cy, cx, TOP + 0.6)); scene.add(label);
    }
    regions[name] = { mesh, center: box.getCenter(new THREE.Vector3()).setY(0), sz, size: Math.max(sz.x, sz.z), label };
  }
  tintRegions(hotRegions);
}
function tintRegions(hot) {
  for (const [name, r] of Object.entries(regions)) {
    const n = hot[name] || 0;
    r.mesh.material.color.set(n >= 3 ? "#6b3f37" : n >= 1 ? "#584440" : "#3a4759");
    if (r.label) r.label.element.classList.toggle("hot", n > 0);
  }
}

// ------------------------------------------------------------ marcadores
function clearFires() {
  for (const m of markers) for (const p of m.parts) { fireGroup.remove(p); p.geometry && p.geometry.dispose && p.geometry !== SPRITE_GEOM && p.geometry.dispose(); }
  markers = [];
}
const SPRITE_GEOM = null;
function sprite(tex, color, scale, opacity = 1, additive = true) {
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, color, transparent: true, opacity, depthWrite: false, depthTest: !additive, blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending }));
  s.scale.setScalar(scale); s.userData.base = scale; return s;
}
const colGeom = GL ? new THREE.CylinderGeometry(0.22, 0.55, 1, 16, 1, true).translate(0, 0.5, 0) : null;
function buildFires(items, inferred) {
  clearFires();
  for (const i of items) {
    const e = EST[i.estado] || EST.sin_dato;
    const col = new THREE.Color(e.c);
    const base = ll2v(i.lat, i.lon, TOP + 0.05);
    const parts = [];
    if (i.estado === "activo" || i.estado === "en_control") {
      const ha = haNumber(i.hectareas);
      const h = (i.estado === "activo" ? 3 : 2.2) + (ha ? Math.log10(ha + 1) * 2.2 : 0) + Math.min(((i.satelite && i.satelite.focos_24h) || 0), 50) * 0.04;
      const column = new THREE.Mesh(colGeom, new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.92, depthWrite: false, side: THREE.DoubleSide }));
      column.scale.set(1, h, 1); column.position.copy(base); column.userData.h = h;
      const top = sprite(TEX.core, col, 2.4); top.position.copy(base).add(new THREE.Vector3(0, h, 0));
      const halo = sprite(TEX.glow, col, i.estado === "activo" ? 9 : 7, 0.9); halo.position.copy(base).add(new THREE.Vector3(0, 0.2, 0));
      halo.userData.pulse = true; top.userData.flicker = true;
      parts.push(column, top, halo);
    } else if (i.estado === "extinguido") {
      const d = sprite(TEX.dot, col, 1.5, 0.95, false); d.position.copy(base).add(new THREE.Vector3(0, 0.6, 0)); parts.push(d);
    } else {
      const d = sprite(TEX.dot, col, 1.9, 1, false); d.position.copy(base).add(new THREE.Vector3(0, 0.7, 0));
      const halo = sprite(TEX.glow, col, 4, 0.5); halo.position.copy(base); parts.push(d, halo);
    }
    parts.forEach((p) => fireGroup.add(p));
    markers.push({ pos: base.clone().add(new THREE.Vector3(0, 1, 0)), item: i, kind: "inc", parts });
  }
  for (const c of inferred) {
    const base = ll2v(c.lat, c.lon, TOP + 0.4);
    const r = sprite(TEX.ring, new THREE.Color(EST.inferido.c), 2.6, 0.8, false); r.position.copy(base); r.userData.slow = true;
    fireGroup.add(r);
    markers.push({ pos: base, item: c, kind: "inf", parts: [r] });
  }
}

// puntos de calor (capa sutil)
const hotMat = GL ? new THREE.ShaderMaterial({
  uniforms: { map: { value: TEX.glow }, scale: { value: innerHeight / 2 } },
  vertexShader: `attribute float size; attribute vec3 color; varying vec3 vC;
    void main(){ vC = color; vec4 mv = modelViewMatrix * vec4(position,1.0); gl_PointSize = clamp(size * 300.0 / -mv.z, 2.0, 28.0); gl_Position = projectionMatrix * mv; }`,
  fragmentShader: `uniform sampler2D map; varying vec3 vC; void main(){ vec4 t = texture2D(map, gl_PointCoord); gl_FragColor = vec4(vC, t.a * 0.55); }`,
  transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
}) : null;
function buildHotspots(firms, hours) {
  if (hotPoints) { scene.remove(hotPoints); hotPoints.geometry.dispose(); hotPoints = null; }
  hotData = [];
  if (!hours) return;
  const now = Date.now() / 1000;
  const pts = firms.puntos.filter((p) => now - p[2] <= hours * 3600);
  const sel = pts.slice(-MAX_HOTSPOTS); // los más recientes
  const pos = new Float32Array(sel.length * 3), colr = new Float32Array(sel.length * 3), size = new Float32Array(sel.length);
  const cNew = new THREE.Color("#ff6a00"), cOld = new THREE.Color("#8a4a1c");
  sel.forEach((p, k) => {
    const v = ll2v(p[0], p[1], TOP + 0.25);
    pos.set([v.x, v.y, v.z], k * 3);
    const age = (now - p[2]) / 3600;
    const c = cNew.clone().lerp(cOld, Math.min(age / Math.max(hours, 24), 1));
    colr.set([c.r, c.g, c.b], k * 3);
    size[k] = 0.9 + Math.min(Math.sqrt(Math.max(p[5], 0)) * 0.12, 1.4);
    hotData.push({ v, p });
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setAttribute("color", new THREE.BufferAttribute(colr, 3));
  g.setAttribute("size", new THREE.BufferAttribute(size, 1));
  hotPoints = new THREE.Points(g, hotMat); hotPoints.renderOrder = 1; scene.add(hotPoints);
  return { shown: sel.length, total: pts.length };
}

// ------------------------------------------------------------ animación
const clock = new THREE.Clock();
function animate() {
  requestAnimationFrame(animate);
  const t = clock.getElapsedTime();
  if (fly) {
    const k = Math.min((performance.now() - fly.t0) / fly.ms, 1), e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
    camera.position.lerpVectors(fly.fromP, fly.toP, e); controls.target.lerpVectors(fly.fromT, fly.toT, e);
    if (k >= 1) fly = null;
  }
  controls.update();
  // tamaño de los marcadores casi constante en pantalla
  const dist = camera.position.distanceTo(controls.target);
  const sc = THREE.MathUtils.clamp(dist / 140, 0.35, 1.6);
  for (const m of markers) for (const p of m.parts) {
    if (p.isSprite) {
      let f = 1;
      if (p.userData.pulse) f = 1 + 0.22 * Math.sin(t * 3 + m.pos.x);
      if (p.userData.flicker) f = 1 + 0.12 * Math.sin(t * 11 + m.pos.z) + 0.06 * Math.sin(t * 17);
      if (p.userData.slow) f = 1 + 0.1 * Math.sin(t * 1.6 + m.pos.x);
      p.scale.setScalar(p.userData.base * sc * f);
      if (p.userData.flicker && m.parts[0].userData.h) p.position.y = m.pos.y - 1 + m.parts[0].userData.h * Math.max(sc, 0.6);
    } else if (p.userData.h) {
      p.scale.set(Math.max(sc, 0.6), p.userData.h * Math.max(sc, 0.6), Math.max(sc, 0.6));
    }
  }
  if (hotMat) hotMat.uniforms.scale.value = innerHeight / 2;
  // etiquetas: ocultar las de regiones pequeñas cuando la vista está lejos
  const pxPerUnit = innerHeight / (2 * dist * Math.tan((camera.fov * Math.PI) / 360));
  for (const r of Object.values(regions)) if (r.label) { const sz = r.size * pxPerUnit; r.label.visible = sz > 62 || (sz > 40 && r.label.element.classList.contains("hot")); }
  renderer.render(scene, camera);
  labelRenderer.render(scene, camera);
}

// ------------------------------------------------------------ selección por toque
function screenOf(v) { const p = v.clone().project(camera); return { x: (p.x + 1) / 2 * innerWidth, y: (1 - p.y) / 2 * innerHeight, z: p.z }; }
function pick(x, y) {
  let best = null, bd = 34; // radio de toque generoso
  for (const m of markers) { const s = screenOf(m.pos); if (s.z > 1) continue; const d = Math.hypot(s.x - x, s.y - y) - (m.kind === "inc" && /activo|en_control/.test(m.item.estado) ? 8 : 0); if (d < bd) { bd = d; best = m; } }
  if (best) return best;
  if (techOn()) {
    let bh = null, bdh = 14;
    for (const h of hotData) { const s = screenOf(h.v); if (s.z > 1) continue; const d = Math.hypot(s.x - x, s.y - y); if (d < bdh) { bdh = d; bh = h; } }
    if (bh) return { kind: "hot", item: bh.p };
  }
  return null;
}
let down = null;
function bindPointer() {
  const el = renderer.domElement;
  el.addEventListener("pointerdown", (e) => { down = { x: e.clientX, y: e.clientY, t: Date.now() }; });
  el.addEventListener("pointerup", (e) => {
    if (!down) return; const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y); const dt = Date.now() - down.t; down = null;
    if (moved > 8 || dt > 600) return;
    const m = pick(e.clientX, e.clientY);
    if (m) { m.kind === "hot" ? openHot(m.item) : openCard(m.item); dismissHint(); }
  });
  el.addEventListener("pointermove", (e) => {
    if (e.pointerType !== "mouse") return;
    const m = pick(e.clientX, e.clientY); const tip = $("#tip");
    el.style.cursor = m ? "pointer" : "grab";
    if (m && m.kind !== "hot") { tip.hidden = false; tip.style.left = e.clientX + "px"; tip.style.top = e.clientY + "px"; tip.textContent = `${m.item.nombre} · ${(EST[m.item.estado] || EST.sin_dato).w}`; }
    else tip.hidden = true;
  });
}

// ------------------------------------------------------------ datos
const D = { meta: null, firms: null, inc: null, news: null, geo: null, gen: null, region: "", showAll: false };
async function j(path) { const r = await fetch(`${path}?t=${Date.now()}`, { cache: "no-store" }); if (!r.ok) throw new Error(path + " " + r.status); return r.json(); }
const techOn = () => $("#tech").open;
const winHours = () => +document.querySelector('input[name="win"]:checked').value;

async function load(first) {
  const meta = await j("data/meta.json");
  if (!first && meta.generado === D.gen) return;
  const [firms, inc, news] = await Promise.all([j("data/firms.json"), j("data/incidentes.json"), j("data/noticias.json").catch(() => ({ noticias: [] }))]);
  Object.assign(D, { meta, firms, inc, news, gen: meta.generado });
  if (first) {
    D.geo = await j("data/ref/departamentos.geojson");
    const sel = $("#region");
    D.geo.features.map((f) => f.properties.NOMBDEP).filter((n) => n !== "CALLAO").sort((a, b) => regName(a).localeCompare(regName(b), "es"))
      .forEach((n) => { const o = document.createElement("option"); o.value = n; o.textContent = regName(n); sel.appendChild(o); });
  }
  const burning = D.inc.incidentes.filter((i) => i.estado === "activo" || i.estado === "en_control");
  const hot = {}; burning.forEach((i) => { hot[i.departamento] = (hot[i.departamento] || 0) + 1; });
  if (GL) {
    if (first) buildRegions(D.geo, hot); else tintRegions(hot);
    buildFires(D.inc.incidentes, D.inc.inferidos || []);
    refreshHot();
  }
  renderText();
  if (first && GL) { const v = homeView(); camera.position.copy(viewToPos(v)); controls.target.copy(v.target); controls.update(); }
}
function refreshHot() {
  if (!GL || !D.firms) return;
  const r = buildHotspots(D.firms, winHours());
  const n24 = D.meta.conteos.focos_24h;
  $("#tech-stats").textContent = r ? `Mostrando ${r.shown.toLocaleString("es-PE")} de ${r.total.toLocaleString("es-PE")} puntos de calor (máx. ${MAX_HOTSPOTS.toLocaleString("es-PE")}). En 24 h: ${n24.toLocaleString("es-PE")}.` : "Puntos de calor ocultos.";
}

function renderText() {
  const incs = D.inc.incidentes;
  const burning = incs.filter((i) => i.estado === "activo" || i.estado === "en_control");
  const regs = new Set(burning.map((i) => i.departamento));
  const nAct = burning.filter((i) => i.estado === "activo").length, nCtl = burning.length - nAct;
  $("#headline").innerHTML = `Ahora hay <b>${burning.length} incendios activos</b> en <b>${regs.size} regiones</b> del Perú`;
  const ro = D.meta.resumen_oficial || {};
  const sumFal = incs.reduce((s, i) => s + (i.fallecidos || 0), 0), offFal = ro.fallecidos_octubre || 0;
  const falTxt = offFal ? ` · ${offFal} fallecidos en octubre según COEN (<a href="${esc(safeUrl(ro.fuente_url))}" target="_blank" rel="noopener">fuente</a>)` + (sumFal > offFal ? `<span class="xtra"> y ${sumFal - offFal} más en reportes posteriores de INDECI</span>` : "") : (sumFal ? ` · ${sumFal} fallecidos reportados` : "");
  const inf = (D.inc.inferidos || []).length;
  $("#subline").innerHTML = `${nAct} con fuego activo · ${nCtl} los están controlando` +
    falTxt +
    (inf ? `<span class="xtra"><br>Además, los satélites ven ${inf} posibles fuegos sin confirmar.</span>` : "");
  updAgo();
  const s = D.meta.fuentes || {};
  $("#sources-status").innerHTML = "<b>Estado de las fuentes:</b><br>" + Object.entries(s).map(([k, v]) => `${v.ok ? "✅" : "⚠️"} ${esc(k)}: ${esc(v.detalle)}`).join("<br>");
  renderList();
}
function updAgo() {
  if (!D.meta) return;
  const min = (Date.now() - new Date(D.meta.generado)) / 60000;
  const el = $("#updated");
  el.textContent = `Última actualización: ${ago(D.meta.generado)}` + (min > 90 ? " (los datos pueden estar atrasados)" : "");
  el.classList.toggle("old", min > 90);
}
setInterval(updAgo, 30000);

function renderList() {
  const reg = D.region;
  let items = D.inc.incidentes.filter((i) => !reg || i.departamento === reg);
  let inf = (D.inc.inferidos || []).filter((c) => !reg || c.departamento === reg);
  if (!D.showAll) items = items.filter((i) => i.estado !== "extinguido");
  const all = [...items, ...(D.showAll || items.length < 3 ? inf : [])].sort((a, b) => severity(b) - severity(a));
  const shown = D.showAll ? all : all.slice(0, 8);
  $("#list-title").textContent = reg ? `🔥 Incendios en ${regName(reg)}` : (D.showAll ? "🔥 Todos los incendios" : "🔥 Incendios más graves ahora");
  const ol = $("#list"); ol.innerHTML = "";
  if (!shown.length) ol.innerHTML = `<li style="cursor:default">No hay incendios reportados ${reg ? "en " + regName(reg) : ""} en este momento.</li>`;
  shown.forEach((i, k) => {
    const e = EST[i.estado] || EST.sin_dato;
    const li = document.createElement("li"); li.tabIndex = 0;
    const ha = i.hectareas ? ` · ${esc(shortHa(i.hectareas))}` : "";
    li.innerHTML = `<span class="rank">${k + 1}</span><span class="dot" style="background:${e.c};color:${e.c}"></span><div><div class="n">${esc(shortName(i))}</div><div class="s">${esc(e.w.replace(", sin confirmar", ""))}${ha} · ${esc(regName(i.departamento))}</div></div>`;
    const go = () => { if (GL) flyToItem(i); openCard(i); };
    li.addEventListener("click", go); li.addEventListener("keydown", (ev) => { if (ev.key === "Enter") go(); });
    ol.appendChild(li);
  });
  $("#show-all").textContent = D.showAll ? "Ver solo los más graves" : "Ver todos (también los apagados)";
}
function shortName(i) {
  if (i.estado === "inferido") return `Posible fuego en ${regName(i.departamento)}`;
  const m = String(i.nombre).match(/^(.+?) \((.+?)\) – (.+)$/); // "Salcabamba (Huancavelica) – Salcabamba"
  return m && m[1].toLowerCase() === m[3].toLowerCase() ? `${m[1]} (${m[2]})` : i.nombre;
}
function fdate(s) { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || ""); return m ? new Date(+m[1], +m[2] - 1, +m[3]).toLocaleDateString("es-PE", { day: "numeric", month: "long" }) : (s || ""); }
function shortHa(s) { const n = haNumber(s); if (n == null) return s; const gt = /^\s*>/.test(s) ? "más de " : ""; return `${gt}${n.toLocaleString("es-PE")} ha`; }

// ------------------------------------------------------------ tarjeta
function openCard(i) {
  const e = EST[i.estado] || EST.sin_dato;
  const nd = '<span class="nodata">Sin dato</span>';
  const isInf = i.estado === "inferido";
  const fuentes = (i.fuentes || []);
  const src0 = fuentes[0];
  let h = `<h3 id="card-title">${esc(shortName(i))}</h3>`;
  h += `<div class="where">${isInf ? "" : esc(title(i.distrito)) + ", " + esc(title(i.provincia)) + " · "}Región ${esc(regName(i.departamento))}</div>`;
  h += `<div class="status" style="background:${e.c}22"><i style="background:${e.c};color:${e.c}"></i><div>${esc(e.w)}<small>${esc(e.d)}</small></div></div>`;
  if (src0 && !isInf) h += `<div class="where">Según ${esc(src0.medio)} · dato ${esc(ago(i.fecha_estado))} (${esc(when(i.fecha_estado))})</div>`;
  if (isInf) {
    h += `<div class="facts"><div class="fact"><div class="k">Puntos de calor (24 h)</div><div class="v">${esc(i.focos_24h)}</div></div>
      <div class="fact"><div class="k">Última vez visto</div><div class="v">${esc(ago(i.ultimo))}</div></div></div>`;
  } else {
    h += `<div class="facts">
      <div class="fact"><div class="k">Hectáreas quemadas</div><div class="v">${i.hectareas ? esc(shortHa(i.hectareas)) : nd}</div></div>
      <div class="fact"><div class="k">Desde cuándo</div><div class="v">${i.inicio ? esc(when(i.inicio)) : nd}</div></div>
      ${i.fallecidos ? `<div class="fact wide"><div class="k">Personas fallecidas</div><div class="v">${esc(i.fallecidos)}</div></div>` : ""}
    </div>`;
    if (i.hectareas && shortHa(i.hectareas) !== i.hectareas) h += `<div class="where" style="font-size:13px">Detalle: ${esc(i.hectareas)}</div>`;
    const sat = i.satelite || {};
    if (sat.focos_24h > 0 && i.estado !== "extinguido") h += `<div class="sat-note">🛰️ Los satélites vieron calor cerca de aquí en las últimas 24 horas (${sat.focos_24h} puntos).</div>`;
    else if (sat.focos_24h > 0) h += `<div class="sat-note">🛰️ Ojo: aunque figura como apagado, los satélites vieron calor cerca en las últimas 24 horas.</div>`;
  }
  h += `<div class="todo"><b>¿Qué hacer?</b>Aléjate del fuego y del humo. No intentes apagarlo solo. No quemes pastos ni basura. Si ves fuego, avisa:<br>
    <a class="tel" href="tel:116">🚒 116 Bomberos</a><a class="tel alt" href="tel:115">🛟 115 Defensa Civil</a></div>`;
  const news = fuentes.filter((f) => !/\(PDF\)/.test(f.medio)).slice(0, 3);
  if (news.length) h += `<b>Noticias y reportes</b><ul class="news">${news.map((f) => `<li><a href="${esc(safeUrl(f.url))}" target="_blank" rel="noopener">${esc(f.titulo)}</a><div class="m">${esc(f.medio)} · ${esc(fdate(f.fecha))}</div></li>`).join("")}</ul>`;
  else if (isInf) h += `<p class="where">Todavía no hay noticias ni reportes oficiales sobre este punto. Revisa <a href="https://portal.indeci.gob.pe/emergencias/" target="_blank" rel="noopener">INDECI</a>.</p>`;
  if (techOn()) {
    const sat = i.satelite || {};
    h += `<div class="techinfo"><b>Datos técnicos</b><br>Texto de la fuente: ${esc(i.estado_texto)}<br>
      ${isInf ? `FRP máx.: ${esc(i.frp_max)} MW · último: ${esc(when(i.ultimo))}` : `Ubicación: ${esc(i.precision || "aprox.")} (${i.lat.toFixed(3)}, ${i.lon.toFixed(3)}) · Origen: ${esc(i.origen)}${i.estado_origen ? " / " + esc(i.estado_origen) : ""}<br>
      Satélite: ${sat.focos_24h || 0} focos 24 h, ${sat.focos_48h || 0} en 48 h a ≤ ${sat.radio_km || 15} km${sat.ultimo ? " · último " + esc(when(sat.ultimo)) : ""}<br>
      Heridos: ${i.heridos != null ? esc(i.heridos) : "sin dato"}${i.notas ? "<br>Notas: " + esc(i.notas) : ""}`}
      ${fuentes.length ? `<br>Todas las fuentes:<ul>${fuentes.map((f) => `<li><a href="${esc(safeUrl(f.url))}" target="_blank" rel="noopener">${esc(f.medio)}</a> – ${esc(f.titulo)}</li>`).join("")}</ul>` : ""}</div>`;
  }
  showCard(h);
}
function openHot(p) {
  const [lat, lon, t, sat, conf, frp, dn, dep, sensor] = p;
  showCard(`<h3 id="card-title">Punto de calor visto por satélite</h3><div class="where">Región ${esc(regName(dep))}</div>
    <div class="status" style="background:#ff6a0022"><i style="background:#ff6a00;color:#ff6a00"></i><div>Calor detectado ${esc(ago(new Date(t * 1000).toISOString()))}<small>No siempre es un incendio forestal: puede ser una quema agrícola u otra fuente de calor.</small></div></div>
    <div class="techinfo">Satélite: ${esc(sat)} · Sensor: ${esc(sensor)}<br>Fecha: ${esc(fmtDT.format(new Date(t * 1000)))} (hora Lima) · ${dn === "D" ? "día" : "noche"}<br>Confianza: ${esc(conf)} · Potencia (FRP): ${esc(frp)} MW<br>Coordenadas: ${lat.toFixed(4)}, ${lon.toFixed(4)}<br>
    Fuente: NASA FIRMS. <a href="https://firms.modaps.eosdis.nasa.gov/map/#d:24hrs;@${lon.toFixed(3)},${lat.toFixed(3)},11z" target="_blank" rel="noopener">Ver en FIRMS</a></div>`);
}
function showCard(html) { $("#card-body").innerHTML = html; $("#card-wrap").hidden = false; $("#card-x").focus(); }
function closeCard() { $("#card-wrap").hidden = true; }
$("#card-x").addEventListener("click", closeCard);
$("#card-wrap").addEventListener("click", (e) => { if (e.target.id === "card-wrap") closeCard(); });
addEventListener("keydown", (e) => { if (e.key === "Escape") closeCard(); });

// ------------------------------------------------------------ controles de interfaz
$("#region").addEventListener("change", (e) => { D.region = e.target.value; renderList(); if (GL) (D.region ? flyToRegion(D.region) : flyTo(homeView())); $("#panel").classList.remove("open"); });
$("#reset").addEventListener("click", () => { D.region = ""; $("#region").value = ""; renderList(); if (GL) flyTo(homeView()); });
$("#show-all").addEventListener("click", () => { D.showAll = !D.showAll; renderList(); });
$("#grab").addEventListener("click", () => $("#panel").classList.toggle("open"));
document.querySelectorAll('input[name="win"]').forEach((r) => r.addEventListener("change", refreshHot));
$("#tech").addEventListener("toggle", () => { if (techOn() && winHours() === 0) { document.querySelector('input[name="win"][value="24"]').checked = true; refreshHot(); } });
function dismissHint() { if ($("#hint").hidden) return; $("#hint").hidden = true; try { localStorage.setItem("hint-ok", "1"); } catch {} }
$("#hint-x").addEventListener("click", dismissHint);
$("#hint-t").textContent = matchMedia("(pointer: coarse)").matches ? "👆 Toca un fuego para ver qué pasa. Usa dos dedos para acercar." : "👆 Haz clic en un fuego para ver qué pasa. Usa la rueda del ratón para acercar.";
try { if (!localStorage.getItem("hint-ok")) $("#hint").hidden = false; } catch { $("#hint").hidden = false; }

// ------------------------------------------------------------ arranque
if (GL) {
  try {
    initScene();
    const v = homeView(); camera.position.copy(viewToPos(v)); controls.target.copy(v.target); controls.update();
    bindPointer(); animate();
  } catch (err) { console.error(err); showNoGL(); }
} else showNoGL();
function showNoGL() { $("#nogl").hidden = false; $("#tools #reset").hidden = true; $("#panel").classList.add("open"); }
load(true).catch((e) => { $("#headline").textContent = "No se pudieron cargar los datos. Intenta recargar la página."; console.error(e); });
setInterval(() => load(false).catch(() => {}), POLL_MS);
document.addEventListener("visibilitychange", () => { if (!document.hidden) load(false).catch(() => {}); });
