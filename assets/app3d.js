// Incendios forestales en Perú – mapa 3D en vivo (no oficial). three.js r170.
import * as THREE from "./vendor/three/three.module.min.js";
import { OrbitControls } from "./vendor/three/addons/OrbitControls.js";
import { CSS2DRenderer, CSS2DObject } from "./vendor/three/addons/CSS2DRenderer.js";

const POLL_MS = 60 * 1000;          // cada minuto se mira meta.json (2 KB); solo si cambió se baja lo demás
const MAX_HOTSPOTS = 6000;
const STALE_MIN = 45;               // a partir de aquí se avisa que los datos están atrasados
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const safeUrl = (u) => (/^https?:\/\//i.test(u || "") ? u : "#");
const BASE_TITLE = document.title;

// ------------------------------------------------------------ textos simples
const EST = {
  activo: { w: "Fuego activo", c: "#ff3b1f", d: "El fuego sigue encendido según el último reporte." },
  en_control: { w: "Lo están controlando", c: "#ff9d00", d: "Bomberos, brigadas o pobladores están trabajando para apagarlo." },
  controlado: { w: "Controlado", c: "#f5d000", d: "El fuego ya no avanza, pero todavía lo vigilan." },
  extinguido: { w: "Apagado", c: "#2fbf5b", d: "El último reporte dice que el fuego fue apagado." },
  sin_dato: { w: "Sin información del estado", c: "#9aa3ad", d: "No hay un reporte oficial reciente sobre su estado." },
  inferido: { w: "Posible fuego visto por satélite, sin confirmar", c: "#b77cff", d: "Un satélite de la NASA detectó calor aquí, pero ninguna autoridad lo ha confirmado. Puede ser una quema agrícola." },
};
const TIPO = {
  nuevo: { i: "🔥", w: "Nuevo incendio" }, estado: { i: "🔁", w: "Cambio de estado" }, reporte: { i: "📄", w: "Reporte INDECI" },
  victimas: { i: "🕯️", w: "Víctimas" }, dato: { i: "📏", w: "Cifra actualizada" }, satelite: { i: "🛰️", w: "Satélite" },
  noticia: { i: "📰", w: "Noticia" }, sistema: { i: "⚙️", w: "Sistema" },
};
const FILTROS = { "": null, incendios: ["nuevo", "estado", "reporte", "victimas", "dato"], noticia: ["noticia"], satelite: ["satelite"] };
const REG = { AMAZONAS: "Amazonas", ANCASH: "Áncash", APURIMAC: "Apurímac", AREQUIPA: "Arequipa", AYACUCHO: "Ayacucho", CAJAMARCA: "Cajamarca", CALLAO: "Callao", CUSCO: "Cusco", HUANCAVELICA: "Huancavelica", HUANUCO: "Huánuco", ICA: "Ica", JUNIN: "Junín", "LA LIBERTAD": "La Libertad", LAMBAYEQUE: "Lambayeque", LIMA: "Lima", LORETO: "Loreto", "MADRE DE DIOS": "Madre de Dios", MOQUEGUA: "Moquegua", PASCO: "Pasco", PIURA: "Piura", PUNO: "Puno", "SAN MARTIN": "San Martín", TACNA: "Tacna", TUMBES: "Tumbes", UCAYALI: "Ucayali" };
const regName = (r) => REG[r] || title(r);
function title(s) { return String(s || "").toLowerCase().replace(/(^|[\s(\-–])([a-záéíóúñ])/g, (m, a, b) => a + b.toUpperCase()); }
const fmtDay = new Intl.DateTimeFormat("es-PE", { timeZone: "America/Lima", weekday: "long", day: "numeric", month: "long" });
const fmtDT = new Intl.DateTimeFormat("es-PE", { timeZone: "America/Lima", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false });
const fmtHM = new Intl.DateTimeFormat("es-PE", { timeZone: "America/Lima", hour: "2-digit", minute: "2-digit", hour12: false });
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
function agoShort(iso) { return ago(iso).replace("hace ", "").replace(/ minutos?/, " min").replace(/ horas?/, " h").replace(/ días?/, " d").replace("un momento", "ahora"); }
function when(iso) { // fecha legible; si la hora es 00:00 se muestra solo el día
  if (!iso) return null;
  const d = new Date(iso);
  return fmtHM.format(d) === "00:00" ? fmtDay.format(d) : fmtDT.format(d);
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
  scene.background = new THREE.Color("#0b1524");
  scene.fog = new THREE.Fog("#0b1524", 900, 1600);
  camera = new THREE.PerspectiveCamera(38, innerWidth / innerHeight, 1, 4000);
  scene.add(new THREE.HemisphereLight("#ffffff", "#3a4a63", 1.6));
  const sun = new THREE.DirectionalLight("#fff3e0", 1.6); sun.position.set(-80, 160, 120); scene.add(sun);

  // mar
  const sea = new THREE.Mesh(new THREE.CircleGeometry(1400, 64), new THREE.MeshBasicMaterial({ color: "#0e1b2e" }));
  sea.rotation.x = -Math.PI / 2; sea.position.y = -0.05; scene.add(sea);
  const grid = new THREE.PolarGridHelper(300, 12, 10, 64, "#1a3050", "#1a3050"); grid.position.y = -0.02; scene.add(grid);
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
function buildRegions(geo) {
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
    const mat = new THREE.MeshStandardMaterial({ color: "#394659", roughness: 0.95, metalness: 0 });
    const mesh = new THREE.Mesh(geom, mat); mesh.userData.name = name; scene.add(mesh);
    const lg = new THREE.BufferGeometry(); lg.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
    scene.add(new THREE.LineSegments(lg, lineMat));
    // centro del polígono mayor (promedio de vértices, suficiente para etiquetas)
    let cx = 0, cy = 0; best.forEach(([lon, lat]) => { cx += lon; cy += lat; }); cx /= best.length; cy /= best.length;
    const box = new THREE.Box3().setFromObject(mesh); const sz = box.getSize(new THREE.Vector3());
    let label = null;
    if (name !== "CALLAO") {
      const d = document.createElement("div"); d.className = "reg-label"; d.textContent = regName(name);
      label = new CSS2DObject(d); label.position.copy(ll2v(cy, cx, TOP + 0.6)); scene.add(label);
    }
    regions[name] = { mesh, center: box.getCenter(new THREE.Vector3()).setY(0), sz, size: Math.max(sz.x, sz.z), label };
  }
}
const C_BASE = new THREE.Color("#394659"), C_HOT = new THREE.Color("#8a3b28");
function tintRegions(hotInc, dens) {
  // color por calor satelital en 24 h (relativo a la región con más puntos) + etiqueta resaltada si hay incendios reportados
  const maxK = Math.max(1, ...Object.values(dens));
  for (const [name, r] of Object.entries(regions)) {
    const n = hotInc[name] || 0, k = dens[name] || 0;
    let t = Math.pow(Math.log(k + 1) / Math.log(maxK + 1), 2.2) * 0.8;
    if (n >= 1) t = Math.max(t, 0.35);
    if (n >= 3) t = Math.max(t, 0.6);
    r.mesh.material.color.copy(C_BASE).lerp(C_HOT, t);
    if (r.label) r.label.element.classList.toggle("hot", n > 0);
  }
}

// ------------------------------------------------------------ marcadores
function clearFires() {
  for (const m of markers) for (const p of m.parts) { fireGroup.remove(p); if (p.isSprite) p.material.dispose(); else if (p.material) p.material.dispose(); }
  markers = [];
}
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
  if (!hours || !firms) return;
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
const D = { meta: null, firms24: null, firmsFull: null, inc: null, news: null, nov: null, geo: null, gen: null, novN: null, region: "", showAll: false, tab: "fuegos", filtro: "", offline: false, seenN: 0 };
try { D.seenN = +localStorage.getItem("nov-seen") || 0; } catch {}
async function j(path) { const r = await fetch(`${path}?t=${Date.now()}`, { cache: "no-store" }); if (!r.ok) throw new Error(path + " " + r.status); return r.json(); }
const techOn = () => $("#tech").open;
const winHours = () => +document.querySelector('input[name="win"]:checked').value;
async function loadFirms24() { // el servidor publica un archivo chico con 24 h; si no existe (hosting viejo), se usa el de 7 días
  const f = await j("data/firms_24h.json").catch(() => null);
  if (f && Array.isArray(f.puntos)) return f;
  const full = await j("data/firms.json"); D.firmsFull = full; return full;
}
async function firmsFor(hours) {
  if (hours <= 24 || !D.firms24) return D.firms24;
  if (!D.firmsFull) { $("#tech-stats").textContent = "Cargando 7 días de puntos de calor…"; D.firmsFull = await j("data/firms.json"); }
  return D.firmsFull;
}

async function load(first) {
  let meta;
  try { meta = await j("data/meta.json"); }
  catch (e) { D.offline = true; renderStatus(); if (first) throw e; return; }
  D.offline = false;
  if (!meta.generado) { if (first) throw new Error("todavía no hay datos"); return; }
  const dataChanged = meta.generado !== D.gen;
  const novChanged = first || meta.novedades_n !== D.novN;
  if (!dataChanged && !novChanged) { D.meta = meta; renderStatus(); return; }
  const [firms24, inc, news, nov] = await Promise.all([
    dataChanged ? loadFirms24() : D.firms24,
    dataChanged ? j("data/incidentes.json") : D.inc,
    dataChanged ? j("data/noticias.json").catch(() => ({ noticias: [] })) : D.news,
    novChanged ? j("data/novedades.json").catch(() => ({ items: [], ultimo_n: 0 })) : D.nov,
  ]);
  if (dataChanged) D.firmsFull = null;
  Object.assign(D, { meta, firms24, inc, news, nov, gen: meta.generado, novN: meta.novedades_n });
  if (first) {
    D.geo = await j("data/ref/departamentos.geojson");
    const sel = $("#region");
    D.geo.features.map((f) => f.properties.NOMBDEP).filter((n) => n !== "CALLAO").sort((a, b) => regName(a).localeCompare(regName(b), "es"))
      .forEach((n) => { const o = document.createElement("option"); o.value = n; o.textContent = regName(n); sel.appendChild(o); });
    const m = location.hash.match(/r=([^&]+)/);
    if (m) { const r = decodeURIComponent(m[1]).toUpperCase(); if (regions[r] || D.geo.features.some((f) => f.properties.NOMBDEP === r)) { D.region = r; sel.value = r; } }
  }
  if (dataChanged) {
    const burning = D.inc.incidentes.filter((i) => i.estado === "activo" || i.estado === "en_control");
    const hot = {}; burning.forEach((i) => { hot[i.departamento] = (hot[i.departamento] || 0) + 1; });
    const dens = {}; for (const p of (D.firms24 && D.firms24.puntos) || []) dens[p[7]] = (dens[p[7]] || 0) + 1;
    if (GL) {
      if (first) buildRegions(D.geo);
      tintRegions(hot, dens);
      buildFires(D.inc.incidentes, D.inc.inferidos || []);
      await refreshHot();
    }
    renderText();
  }
  if (novChanged) renderFeed(!first);
  renderStatus();
  if (first) {
    $("#loader").classList.add("off");
    if (GL) { const v = D.region ? null : homeView(); if (v) { camera.position.copy(viewToPos(v)); controls.target.copy(v.target); controls.update(); } else flyToRegion(D.region); }
  }
}
async function refreshHot() {
  if (!GL || !D.firms24) return;
  const hours = winHours();
  let firms = null;
  try { firms = await firmsFor(hours); } catch (e) { $("#tech-stats").textContent = "No se pudieron cargar los 7 días."; return; }
  const r = buildHotspots(firms, hours);
  const n24 = (D.meta.conteos || {}).focos_24h || 0;
  $("#tech-stats").textContent = r ? `Mostrando ${r.shown.toLocaleString("es-PE")} de ${r.total.toLocaleString("es-PE")} puntos de calor (máx. ${MAX_HOTSPOTS.toLocaleString("es-PE")}). En 24 h: ${n24.toLocaleString("es-PE")}.` : "Puntos de calor ocultos.";
}

function renderText() {
  const incs = D.inc.incidentes;
  const burning = incs.filter((i) => i.estado === "activo" || i.estado === "en_control");
  const regs = new Set(burning.map((i) => i.departamento));
  const nAct = burning.filter((i) => i.estado === "activo").length, nCtl = burning.length - nAct;
  $("#headline").innerHTML = burning.length
    ? `Ahora hay <b>${burning.length} incendio${burning.length === 1 ? "" : "s"} activo${burning.length === 1 ? "" : "s"}</b> en <b>${regs.size} regi${regs.size === 1 ? "ón" : "ones"}</b> del Perú`
    : "Ahora no hay incendios activos reportados en el Perú";
  const ro = D.meta.resumen_oficial || {};
  const sumFal = incs.reduce((s, i) => s + (i.fallecidos || 0), 0), offFal = ro.fallecidos_octubre || 0;
  const falTxt = offFal ? ` · ${offFal} fallecidos en octubre según COEN (<a href="${esc(safeUrl(ro.fuente_url))}" target="_blank" rel="noopener">fuente</a>)` + (sumFal > offFal ? `<span class="xtra"> y ${sumFal - offFal} más en reportes posteriores de INDECI</span>` : "") : (sumFal ? ` · ${sumFal} fallecidos reportados` : "");
  const inf = (D.inc.inferidos || []).length;
  $("#subline").innerHTML = `${nAct} con fuego activo · ${nCtl} los están controlando` + falTxt +
    (inf ? `<span class="xtra"><br>Además, los satélites ven ${inf} posibles fuegos sin confirmar.</span>` : "");
  const s = D.meta.fuentes || {};
  $("#sources-status").innerHTML = "<b>Estado de las fuentes:</b><br>" + Object.entries(s).map(([k, v]) => `${v.ok ? "✅" : "⚠️"} ${esc(k)}: ${esc(v.detalle)}`).join("<br>");
  renderList();
}

// ------------------------------------------------------------ estado del monitoreo (píldora, aviso, tarjeta)
function renderStatus() {
  const m = D.meta; const pill = $("#status-btn"), txt = $("#status-txt");
  if (!m) { if (D.offline) { pill.className = "status-pill bad"; txt.textContent = "Sin conexión"; } return; }
  const ageMin = (Date.now() - new Date(m.generado)) / 60000;
  const iv = m.intervalo_min || 10;
  const bad = Object.values(m.fuentes || {}).filter((s) => !s.ok).length;
  let cls = "ok", t;
  if (D.offline) { cls = "bad"; t = `Sin conexión · datos de ${ago(m.generado)}`; }
  else if (ageMin > STALE_MIN) { cls = "bad"; t = `Datos atrasados: ${ago(m.generado)}`; }
  else if (bad) { cls = "warn"; t = `${bad} fuente${bad > 1 ? "s" : ""} con problemas · datos ${ago(m.generado)}`; }
  else if (ageMin > iv * 1.8) { cls = "warn"; t = `Datos ${ago(m.generado)} · esperando la siguiente actualización`; }
  else { const next = Math.max(0, Math.round(iv - ageMin)); t = `Datos ${ago(m.generado)} · próxima en ~${next} min`; }
  pill.className = "status-pill " + cls; txt.textContent = t;
  const off = ageMin > STALE_MIN || D.offline;
  $("#live").classList.toggle("off", off);
  const st = $("#stale");
  if (ageMin > STALE_MIN && !D.offline) { st.hidden = false; st.textContent = `⚠️ Los datos tienen ${Math.round(ageMin)} minutos. El actualizador puede estar con problemas; seguimos mostrando lo último que llegó.`; }
  else if (D.offline) { st.hidden = false; st.textContent = "⚠️ Sin conexión. Se muestran los últimos datos recibidos; se reintenta cada minuto."; }
  else st.hidden = true;
}
setInterval(renderStatus, 30000);

async function openStatus() {
  const m = D.meta || {};
  showCard(`<h3 id="card-title">Estado del monitoreo</h3><div class="where">Cargando…</div>`);
  const [h, hist] = await Promise.all([j("data/health.json").catch(() => null), j("data/historial.json").catch(() => null)]);
  const iv = m.intervalo_min || (h && h.intervalo_min) || 10;
  const ageMin = m.generado ? (Date.now() - new Date(m.generado)) / 60000 : 999;
  const fuentes = (h && h.fuentes) || Object.fromEntries(Object.entries(m.fuentes || {}).map(([k, v]) => [k, { ...v }]));
  const nBad = Object.values(fuentes).filter((s) => !s.ok).length;
  const estado = D.offline ? ["#ff4d4f", "Sin conexión con el servidor"] : ageMin > STALE_MIN ? ["#ff4d4f", "Datos atrasados"] : nBad ? ["#ffb020", `${nBad} fuente${nBad > 1 ? "s" : ""} con problemas`] : ["#2fbf5b", "Todo en orden"];
  let html = `<h3 id="card-title">Estado del monitoreo</h3><div class="where">El servidor descarga las fuentes cada ${iv} minutos y esta página revisa cada minuto si hay datos nuevos.</div>
    <div class="status" style="background:${estado[0]}22"><i style="background:${estado[0]};color:${estado[0]}"></i><div>${estado[1]}<small>${m.generado ? `Última actualización ${esc(ago(m.generado))} (${esc(fmtDT.format(new Date(m.generado)))}, hora de Lima)` : "Todavía no hay datos"}</small></div></div>
    <div class="facts">
      <div class="fact"><div class="k">Próxima actualización</div><div class="v">${m.generado ? esc(fmtHM.format(new Date(new Date(m.generado).getTime() + iv * 60000))) + " aprox." : "—"}</div></div>
      <div class="fact"><div class="k">Duración de la última corrida</div><div class="v">${h && h.duracion_s != null ? esc(h.duracion_s) + " s" : (m.duracion_s != null ? esc(m.duracion_s) + " s" : "—")}</div></div>
      <div class="fact"><div class="k">Puntos de calor (24 h)</div><div class="v">${((m.conteos || {}).focos_24h || 0).toLocaleString("es-PE")}</div></div>
      <div class="fact"><div class="k">Incidentes seguidos</div><div class="v">${(m.conteos || {}).incidentes || 0}</div></div>
    </div>`;
  if (hist && hist.puntos && hist.puntos.length > 1) {
    html += `<div class="spark"><div class="k"><span>Puntos de calor en 24 h · últimas ${Math.min(48, Math.round((hist.puntos[hist.puntos.length - 1][0] - hist.puntos[0][0]) / 3600))} h</span><b id="sp1v"></b></div><canvas id="sp1" width="600" height="112"></canvas></div>
      <div class="spark"><div class="k"><span>Incendios activos o en control</span><b id="sp2v"></b></div><canvas id="sp2" width="600" height="112"></canvas></div>`;
  }
  html += `<b>Fuentes</b><ul class="src">` + Object.entries(fuentes).map(([k, v]) => `<li><span class="s">${v.ok ? "✅" : "⚠️"}</span><div><div>${esc(k)}${v.duracion_s != null ? ` <span class="d">· ${esc(v.duracion_s)} s</span>` : ""}</div><div class="d">${esc(v.detalle || "")}${!v.ok && v.fallos_seguidos ? ` · falla hace ${v.fallos_seguidos} corrida${v.fallos_seguidos > 1 ? "s" : ""}` : ""}${!v.ok && v.ultima_ok ? ` · última vez bien ${esc(ago(v.ultima_ok))}` : ""}</div></div></li>`).join("") + "</ul>";
  if (h && h.corridas && h.corridas.length) {
    const ok = h.corridas.filter((c) => c.ok).length;
    html += `<div class="where" style="margin:10px 0 2px;font-size:13.5px">Últimas ${h.corridas.length} corridas: ${ok} bien${h.corridas.length - ok ? `, ${h.corridas.length - ok} con error` : ""}${h.version ? ` · versión ${esc(h.version)}` : ""}</div><div class="runs">${h.corridas.map((c) => `<i class="${c.ok ? "" : "f"}" title="${esc(fmtDT.format(new Date(c.t)))} · ${esc(c.duracion_s)} s"></i>`).join("")}</div>`;
  }
  html += `<div class="card-actions"><a href="estado.html">Página de estado</a><a href="data/health.json" target="_blank" rel="noopener">health.json</a><a href="data/meta.json" target="_blank" rel="noopener">meta.json</a></div>`;
  showCard(html);
  if (hist && hist.puntos && hist.puntos.length > 1) {
    const cut = Date.now() / 1000 - 48 * 3600;
    const pts = hist.puntos.filter((p) => p[0] >= cut);
    sparkline($("#sp1"), pts.map((p) => p[1]), "#ff6a00"); $("#sp1v").textContent = (pts[pts.length - 1][1] || 0).toLocaleString("es-PE");
    sparkline($("#sp2"), pts.map((p) => p[2]), "#ff3b1f"); $("#sp2v").textContent = pts[pts.length - 1][2];
  }
}
function sparkline(c, vals, color) {
  if (!c || !vals.length) return;
  const g = c.getContext("2d"), W = c.width, H = c.height, pad = 8;
  const min = Math.min(...vals), max = Math.max(...vals), span = max - min || 1;
  const X = (k) => pad + (k / Math.max(vals.length - 1, 1)) * (W - pad * 2), Y = (v) => H - pad - ((v - min) / span) * (H - pad * 2);
  g.clearRect(0, 0, W, H);
  g.beginPath(); vals.forEach((v, k) => (k ? g.lineTo(X(k), Y(v)) : g.moveTo(X(k), Y(v))));
  g.lineTo(X(vals.length - 1), H); g.lineTo(X(0), H); g.closePath(); g.fillStyle = color + "33"; g.fill();
  g.beginPath(); vals.forEach((v, k) => (k ? g.lineTo(X(k), Y(v)) : g.moveTo(X(k), Y(v)))); g.strokeStyle = color; g.lineWidth = 3; g.lineJoin = "round"; g.stroke();
  g.fillStyle = color; g.beginPath(); g.arc(X(vals.length - 1), Y(vals[vals.length - 1]), 5, 0, Math.PI * 2); g.fill();
  g.fillStyle = "#5b6472"; g.font = "20px system-ui"; g.textBaseline = "top"; g.fillText(min.toLocaleString("es-PE"), pad, H - 26); g.textBaseline = "top"; g.fillText(max.toLocaleString("es-PE"), pad, 2);
}
$("#status-btn").addEventListener("click", openStatus);

// ------------------------------------------------------------ lista de incendios
function renderList() {
  const reg = D.region;
  let items = D.inc.incidentes.filter((i) => !reg || i.departamento === reg);
  let inf = (D.inc.inferidos || []).filter((c) => !reg || c.departamento === reg);
  if (!D.showAll) items = items.filter((i) => i.estado !== "extinguido");
  const all = [...items, ...(D.showAll || items.length < 3 ? inf : [])].sort((a, b) => severity(b) - severity(a));
  const shown = D.showAll ? all : all.slice(0, 8);
  $("#list-title").textContent = reg ? `Incendios en ${regName(reg)}` : (D.showAll ? "Todos los incendios" : "Incendios más graves ahora");
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

// ------------------------------------------------------------ feed de novedades
function findInc(id) { if (!D.inc || !id) return null; return D.inc.incidentes.find((i) => i.id === id) || (D.inc.inferidos || []).find((c) => c.id === id) || null; }
function renderFeed(notify) {
  const items = (D.nov && D.nov.items) || [];
  const ultimo = (D.nov && D.nov.ultimo_n) || 0;
  if (!D.seenN && ultimo) { D.seenN = ultimo; try { localStorage.setItem("nov-seen", String(ultimo)); } catch {} } // primera visita: nada se marca como nuevo
  const fresh = items.filter((e) => (e.n || 0) > D.seenN);
  const badge = $("#nov-badge");
  if (D.tab === "novedades") markSeen(); else { badge.hidden = !fresh.length; badge.textContent = fresh.length; }
  document.title = (fresh.length && D.tab !== "novedades" ? `(${fresh.length}) ` : "") + BASE_TITLE;
  if (notify && fresh.length && D.tab !== "novedades") toast(`🆕 ${fresh.length} novedad${fresh.length === 1 ? "" : "es"} · tocar para ver`, () => setTab("novedades"));
  $("#feed-upd").textContent = D.nov && D.nov.generado ? `al día ${agoShort(D.nov.generado)}` : "";
  const allow = FILTROS[D.filtro];
  const reg = D.region;
  const list = items.filter((e) => (!allow || allow.includes(e.tipo)) && (!reg || !e.region || e.region === reg || e.tipo === "noticia" || e.tipo === "sistema")).slice(0, 80);
  const ol = $("#feed"); ol.innerHTML = "";
  if (!list.length) { ol.innerHTML = `<li class="empty">Todavía no hay novedades${reg ? " de " + regName(reg) : ""} en este filtro. Se revisa cada 10 minutos.</li>`; return; }
  for (const e of list) {
    const tp = TIPO[e.tipo] || { i: "•", w: e.tipo };
    const inc = findInc(e.inc);
    const li = document.createElement("li");
    li.className = `${e.nivel || "medio"}${(e.n || 0) > D.seenN ? " fresh" : ""}${inc || e.url ? " go" : ""}`;
    const meta = [tp.w, e.region ? regName(e.region) : null, e.medio || null, agoShort(e.t)].filter(Boolean);
    const texto = e.tipo === "noticia" && e.url ? `<a href="${esc(safeUrl(e.url))}" target="_blank" rel="noopener">${esc(e.texto)}</a>` : esc(e.texto);
    li.innerHTML = `<div class="ic" aria-hidden="true">${tp.i}</div><div><div class="t">${texto}</div><div class="m"><b>${esc(meta[0])}</b>${meta.slice(1).map((x) => " · " + esc(x)).join("")}</div></div>`;
    if (inc) { li.tabIndex = 0; const go = () => { if (GL) flyToItem(inc); openCard(inc); }; li.addEventListener("click", go); li.addEventListener("keydown", (ev) => { if (ev.key === "Enter") go(); }); }
    else if (e.url && e.tipo !== "noticia") { li.tabIndex = 0; li.addEventListener("click", () => window.open(safeUrl(e.url), "_blank", "noopener")); }
    ol.appendChild(li);
  }
}
function markSeen() {
  const ultimo = (D.nov && D.nov.ultimo_n) || 0;
  if (ultimo > D.seenN) { D.seenN = ultimo; try { localStorage.setItem("nov-seen", String(ultimo)); } catch {} }
  $("#nov-badge").hidden = true; document.title = BASE_TITLE;
}
function setTab(name) {
  D.tab = name;
  document.querySelectorAll('.tabs [role="tab"]').forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === name)));
  $("#tab-fuegos").hidden = name !== "fuegos"; $("#tab-novedades").hidden = name !== "novedades";
  if (name === "novedades") { renderFeed(false); markSeen(); if (innerWidth <= 820) $("#panel").classList.add("open"); }
  $("#panel").scrollTop = 0;
}
document.querySelectorAll('.tabs [role="tab"]').forEach((b) => b.addEventListener("click", () => setTab(b.dataset.tab)));
$("#feed-filter").addEventListener("click", (e) => {
  const b = e.target.closest("button"); if (!b) return;
  D.filtro = b.dataset.f; document.querySelectorAll("#feed-filter button").forEach((x) => x.classList.toggle("on", x === b)); renderFeed(false);
});
let toastT = null;
function toast(msg, onClick) {
  const t = $("#toast"); t.textContent = msg; t.hidden = false; t.onclick = () => { t.hidden = true; if (onClick) onClick(); };
  clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, 7000);
}

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
  const hist = ((D.nov && D.nov.items) || []).filter((e2) => e2.inc === i.id).slice(0, 4);
  if (hist.length) h += `<b>Novedades de este incendio</b><ul class="news">${hist.map((e2) => `<li>${(TIPO[e2.tipo] || {}).i || "•"} ${esc(e2.texto)}<div class="m">${esc(ago(e2.t))}</div></li>`).join("")}</ul>`;
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
  h += `<div class="card-actions"><button type="button" id="card-share">↗ Compartir</button><a href="mapa-2d.html#${i.lat.toFixed(3)},${i.lon.toFixed(3)}">Ver en el mapa 2D</a></div>`;
  showCard(h);
  $("#card-share").addEventListener("click", () => share(`${shortName(i)} · ${e.w} · ${regName(i.departamento)}`, i.departamento));
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

// ------------------------------------------------------------ compartir y enlace por región
function shareUrl(region) { return location.origin + location.pathname + (region ? "#r=" + encodeURIComponent(region) : ""); }
async function share(text, region) {
  const url = shareUrl(region ?? D.region);
  const full = `${text || $("#headline").textContent} · mapa en vivo (no oficial)`;
  if (navigator.share) { try { await navigator.share({ title: BASE_TITLE, text: full, url }); return; } catch (e) { if (e && e.name === "AbortError") return; } }
  try { await navigator.clipboard.writeText(url); toast("Enlace copiado ✓"); } catch { toast(url); }
}
$("#share").addEventListener("click", () => share());
function syncHash() { history.replaceState(null, "", D.region ? "#r=" + encodeURIComponent(D.region) : location.pathname + location.search); }

// ------------------------------------------------------------ controles de interfaz
$("#region").addEventListener("change", (e) => { D.region = e.target.value; syncHash(); renderList(); renderFeed(false); if (GL) (D.region ? flyToRegion(D.region) : flyTo(homeView())); if (innerWidth <= 820) $("#panel").classList.remove("open"); });
$("#reset").addEventListener("click", () => { D.region = ""; $("#region").value = ""; syncHash(); renderList(); renderFeed(false); if (GL) flyTo(homeView()); });
$("#show-all").addEventListener("click", () => { D.showAll = !D.showAll; renderList(); });
$("#grab").addEventListener("click", () => $("#panel").classList.toggle("open"));
document.querySelectorAll('input[name="win"]').forEach((r) => r.addEventListener("change", () => refreshHot()));
$("#tech").addEventListener("toggle", () => { if (techOn() && winHours() === 0) { document.querySelector('input[name="win"][value="24"]').checked = true; refreshHot(); } });
function dismissHint() { if ($("#hint").hidden) return; $("#hint").hidden = true; try { localStorage.setItem("hint-ok", "1"); } catch {} }
$("#hint-x").addEventListener("click", dismissHint);
$("#hint-t").textContent = matchMedia("(pointer: coarse)").matches ? "👆 Toca un fuego para ver qué pasa. Usa dos dedos para acercar." : "👆 Haz clic en un fuego para ver qué pasa. Usa la rueda del ratón para acercar.";
try { if (!localStorage.getItem("hint-ok")) $("#hint").hidden = false; } catch { $("#hint").hidden = false; }
addEventListener("hashchange", () => { const m = location.hash.match(/r=([^&]+)/); const r = m ? decodeURIComponent(m[1]).toUpperCase() : ""; if (r !== D.region && (r === "" || regions[r])) { D.region = r; $("#region").value = r; renderList(); renderFeed(false); if (GL) (r ? flyToRegion(r) : flyTo(homeView())); } });

// ------------------------------------------------------------ arranque
if (GL) {
  try {
    initScene();
    const v = homeView(); camera.position.copy(viewToPos(v)); controls.target.copy(v.target); controls.update();
    bindPointer(); animate();
  } catch (err) { console.error(err); showNoGL(); }
} else showNoGL();
function showNoGL() { $("#nogl").hidden = false; $("#tools #reset").hidden = true; $("#panel").classList.add("open"); }
load(true).catch((e) => { $("#loader").classList.add("off"); $("#headline").textContent = "No se pudieron cargar los datos. Intenta recargar la página."; $("#status-btn").className = "status-pill bad"; $("#status-txt").textContent = "Sin datos"; console.error(e); });
setInterval(() => load(false).catch(() => {}), POLL_MS);
document.addEventListener("visibilitychange", () => { if (!document.hidden) load(false).catch(() => {}); });
