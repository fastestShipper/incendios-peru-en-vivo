/* Incendios forestales en Perú – mapa en vivo (no oficial). Sin dependencias salvo Leaflet. */
(function () {
  "use strict";
  const POLL_MS = 60 * 1000; // revisa si hay datos nuevos cada minuto
  const ESTADOS = {
    activo: { t: "Activo / descontrolado", c: "#e5312b" },
    en_control: { t: "En control (combatiéndose)", c: "#ff9800" },
    controlado: { t: "Controlado", c: "#f2c94c" },
    extinguido: { t: "Extinguido", c: "#3fae5a" },
    sin_dato: { t: "Sin dato de estado", c: "#8a8f98" },
    alerta: { t: "Alerta de SERFOR (por confirmar)", c: "#7b4dff" },
    inferido: { t: "Inferido por satélite", c: "#a259ff" },
  };
  const ORDER = ["activo", "en_control", "alerta", "controlado", "sin_dato", "extinguido"];
  const fmtLima = new Intl.DateTimeFormat("es-PE", { timeZone: "America/Lima", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false });
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const title = (s) => String(s || "").toLowerCase().replace(/(^|\s|\()([a-záéíóúñ])/g, (m, a, b) => a + b.toUpperCase());
  const lima = (iso) => (iso ? fmtLima.format(new Date(iso)) + " (hora Lima)" : "sin dato");
  const ago = (ms) => { const m = Math.round(ms / 60000); if (m < 1) return "hace instantes"; if (m < 60) return `hace ${m} min`; const h = Math.floor(m / 60); if (h < 48) return `hace ${h} h ${m % 60} min`; return `hace ${Math.floor(h / 24)} días`; };
  const safeUrl = (u) => (/^https?:\/\//i.test(u || "") ? u : "#");

  // ---------------------------------------------------------------- mapa
  const map = L.map("map", { zoomControl: true, preferCanvas: true, worldCopyJump: false }).setView([-10.5, -75.2], 6);
  const yesterday = new Date(Date.now() - 864e5).toISOString().slice(0, 10);
  const gibs = (layer, date, fmt, lvl) => L.tileLayer(`https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/${layer}/default/${date}/GoogleMapsCompatible_Level${lvl}/{z}/{y}/{x}.${fmt}`,
    { maxNativeZoom: lvl, maxZoom: 18, attribution: 'Imágenes: <a href="https://earthdata.nasa.gov/gibs">NASA GIBS</a>' });
  const base = {
    "Mapa (OpenStreetMap)": L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' }),
    "Relieve (Esri)": L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}", { maxZoom: 19, attribution: "Tiles &copy; Esri" }),
    "Satélite (Esri)": L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", { maxZoom: 19, attribution: "Tiles &copy; Esri, Maxar, Earthstar Geographics" }),
    [`Satélite NASA VIIRS (${yesterday})`]: gibs("VIIRS_SNPP_CorrectedReflectance_TrueColor", yesterday, "jpg", 9),
    [`Satélite NASA MODIS Terra (${yesterday})`]: gibs("MODIS_Terra_CorrectedReflectance_TrueColor", yesterday, "jpg", 9),
  };
  base["Relieve (Esri)"].addTo(map);
  const deptLayer = L.layerGroup().addTo(map);
  const firmsLayer = L.layerGroup().addTo(map);
  const infLayer = L.layerGroup().addTo(map);
  const incLayer = L.layerGroup().addTo(map);
  const smoke = gibs("MODIS_Terra_Aerosol", yesterday, "png", 6); smoke.setOpacity(0.55);
  L.control.layers(base, {
    "Incidentes (fuentes citadas)": incLayer,
    "Focos de calor NASA FIRMS": firmsLayer,
    "Agrupaciones inferidas por satélite": infLayer,
    "Límites departamentales": deptLayer,
    [`Aerosoles/humo NASA (${yesterday})`]: smoke,
  }, { collapsed: true }).addTo(map);
  L.control.scale({ imperial: false }).addTo(map);

  const legend = L.control({ position: "bottomright" });
  legend.onAdd = () => {
    const d = L.DomUtil.create("div", "map-legend");
    d.innerHTML = '<div class="lg-h">Leyenda ▾</div><div class="lg-b"><b>Incidentes</b>'  + Object.entries(ESTADOS).map(([k, v]) => `<div><span class="sw" style="background:${v.c}${k === "inferido" ? ";border:2px dashed #6a2bd8;background:transparent" : ""}"></span>${v.t}</div>`).join("") +
      '<b>Focos satelitales (antigüedad)</b><div><span class="sw" style="background:#ff1a00"></span>&lt; 6 h</div><div><span class="sw" style="background:#ff7b00"></span>6–24 h</div><div><span class="sw" style="background:#ffd000"></span>24–48 h</div><div><span class="sw" style="background:#9b7a5b"></span>2–7 días</div></div>';
    d.querySelector(".lg-h").addEventListener("click", () => d.classList.toggle("open"));
    L.DomEvent.disableClickPropagation(d);
    return d;
  };
  legend.addTo(map);

  // ---------------------------------------------------------------- estado
  const S = { meta: null, firms: null, inc: null, news: null, generado: null };
  const ui = {
    region: document.getElementById("f-region"),
    estados: document.getElementById("f-estado"),
    win: () => +document.querySelector('input[name="win"]:checked').value,
    sensors: () => [...document.querySelectorAll("#f-sensor input:checked")].map((i) => i.value),
    inferidos: document.getElementById("f-inferidos"),
  };
  ORDER.forEach((k) => {
    const l = document.createElement("label");
    l.innerHTML = `<input type="checkbox" value="${k}" checked> <span class="dot" style="background:${ESTADOS[k].c}"></span>${ESTADOS[k].t}`;
    ui.estados.appendChild(l);
  });
  document.querySelectorAll("#panel input, #panel select").forEach((el) => el.addEventListener("change", render));
  document.getElementById("toggle").addEventListener("click", () => {
    const p = document.getElementById("panel"); p.classList.toggle("collapsed");
    setTimeout(() => map.invalidateSize(), 50);
  });

  async function j(path) {
    const r = await fetch(`${path}?t=${Date.now()}`, { cache: "no-store" });
    if (!r.ok) throw new Error(path + " " + r.status);
    return r.json();
  }

  async function loadAll(first) {
    const meta = await j("data/meta.json");
    if (!first && S.generado === meta.generado) return false;
    const [firms, inc, news] = await Promise.all([j("data/firms.json"), j("data/incidentes.json"), j("data/noticias.json").catch(() => ({ noticias: [] }))]);
    Object.assign(S, { meta, firms, inc, news, generado: meta.generado });
    if (first) {
      const deps = await j("data/ref/departamentos.geojson");
      L.geoJSON(deps, { style: { color: "#444", weight: 1, fill: false, opacity: 0.6 }, interactive: false }).addTo(deptLayer);
      const regs = [...new Set(deps.features.map((f) => f.properties.NOMBDEP))].sort();
      regs.forEach((r) => { const o = document.createElement("option"); o.value = r; o.textContent = title(r); ui.region.appendChild(o); });
    }
    render();
    return true;
  }

  function firmsColor(ageH) { return ageH < 6 ? "#ff1a00" : ageH < 24 ? "#ff7b00" : ageH < 48 ? "#ffd000" : "#9b7a5b"; }

  function incIcon(i) {
    const c = ESTADOS[i.estado] ? ESTADOS[i.estado].c : ESTADOS.sin_dato.c;
    const big = i.estado === "activo" ? 20 : i.estado === "en_control" ? 18 : 14;
    const pulse = i.satelite && i.satelite.focos_24h > 0 && i.estado !== "extinguido" ? " pulse" : "";
    return L.divIcon({ className: "", html: `<div class="inc-icon${pulse}" style="width:${big}px;height:${big}px;background:${c}"></div>`, iconSize: [big, big], iconAnchor: [big / 2, big / 2], popupAnchor: [0, -big / 2] });
  }

  function incPopup(i) {
    const e = ESTADOS[i.estado] || ESTADOS.sin_dato;
    const sd = '<i>sin dato</i>';
    const sat = i.satelite || {};
    const satTxt = sat.focos_24h > 0 ? `<b style="color:#c0390b">Actividad satelital reciente:</b> ${sat.focos_24h} focos en 24 h a ≤ ${sat.radio_km} km (último: ${lima(sat.ultimo)})`
      : sat.focos_48h > 0 ? `${sat.focos_48h} focos en 48 h a ≤ ${sat.radio_km} km (último: ${lima(sat.ultimo)})` : `Sin focos satelitales en 48 h a ≤ ${sat.radio_km || 15} km`;
    const fu = (i.fuentes || []).map((f) => `<li><a href="${esc(safeUrl(f.url))}" target="_blank" rel="noopener">${esc(f.medio)}</a>: ${esc(f.titulo)} <span class="pp-k">(${esc(f.fecha || "")})</span></li>`).join("");
    return `<h3>${esc(i.nombre)}</h3>
      <span class="badge" style="background:${e.c}">${e.t}</span>${i.estado_origen ? ' <span class="pp-k">(' + esc(i.estado_origen) + ")</span>" : ""}
      <div class="pp-row">${esc(i.estado_texto || "")}</div>
      <div class="pp-row"><span class="pp-k">Ubicación:</span> ${esc(title(i.distrito))}, ${esc(title(i.provincia))}, ${esc(title(i.departamento))} <span class="pp-k">(${esc(i.precision || "aprox.")})</span></div>
      <div class="pp-row"><span class="pp-k">Hectáreas:</span> ${i.hectareas ? esc(i.hectareas) : sd}</div>
      <div class="pp-row"><span class="pp-k">Fallecidos:</span> ${i.fallecidos != null ? esc(i.fallecidos) : sd} · <span class="pp-k">Heridos:</span> ${i.heridos != null ? esc(i.heridos) : sd}</div>
      ${i.notas ? `<div class="pp-row"><span class="pp-k">Notas:</span> ${esc(i.notas)}</div>` : ""}
      <div class="pp-row"><span class="pp-k">Estado al:</span> ${lima(i.fecha_estado)}</div>
      <div class="pp-row">${satTxt}</div>
      <div class="pp-row"><span class="pp-k">Fuentes:</span><ul>${fu}</ul></div>`;
  }

  function render() {
    if (!S.meta) return;
    const reg = ui.region.value;
    const est = new Set([...ui.estados.querySelectorAll("input:checked")].map((i) => i.value));
    const winH = ui.win();
    const sensors = new Set(ui.sensors());
    const now = Date.now() / 1000;

    // Focos FIRMS
    firmsLayer.clearLayers();
    let nF = 0; const fRegs = new Set();
    for (const p of S.firms.puntos) {
      const [lat, lon, t, sat, conf, frp, dn, dep, sensor] = p;
      const ageH = (now - t) / 3600;
      if (ageH > winH || !sensors.has(sensor) || (reg && dep !== reg)) continue;
      nF++; fRegs.add(dep);
      const m = L.circleMarker([lat, lon], { radius: Math.min(9, 2.5 + Math.sqrt(Math.max(frp, 0)) / 2), color: "#000", weight: 0.4, fillColor: firmsColor(ageH), fillOpacity: 0.85 });
      m.bindPopup(() => `<h3>Foco de calor satelital</h3>
        <div class="pp-row"><span class="pp-k">Detectado:</span> ${lima(new Date(t * 1000).toISOString())} (${ago((now - t) * 1000)})</div>
        <div class="pp-row"><span class="pp-k">Satélite / sensor:</span> ${esc(sat)} · ${esc(sensor)}</div>
        <div class="pp-row"><span class="pp-k">Confianza:</span> ${esc(conf)} · <span class="pp-k">FRP:</span> ${esc(frp)} MW · ${dn === "D" ? "día" : dn === "N" ? "noche" : esc(dn)}</div>
        <div class="pp-row"><span class="pp-k">Región:</span> ${esc(title(dep))} · ${lat.toFixed(4)}, ${lon.toFixed(4)}</div>
        <div class="pp-row small">Fuente: NASA FIRMS (NRT). Un foco indica calor anómalo; puede ser quema agrícola u otra fuente. <a href="https://firms.modaps.eosdis.nasa.gov/map/#d:24hrs;@${lon.toFixed(3)},${lat.toFixed(3)},11z" target="_blank" rel="noopener">Ver en FIRMS</a></div>`);
      m.addTo(firmsLayer);
    }

    // Incidentes
    incLayer.clearLayers();
    const list = S.inc.incidentes.filter((i) => est.has(i.estado) && (!reg || i.departamento === reg))
      .sort((a, b) => ORDER.indexOf(a.estado) - ORDER.indexOf(b.estado) || (b.fecha_estado || "").localeCompare(a.fecha_estado || ""));
    const markers = {};
    for (const i of list) {
      const m = L.marker([i.lat, i.lon], { icon: incIcon(i), zIndexOffset: i.estado === "activo" ? 1000 : 500, title: i.nombre }).bindPopup(() => incPopup(i), { maxWidth: 340 });
      m.addTo(incLayer); markers[i.id] = m;
    }
    infLayer.clearLayers();
    const infs = ui.inferidos.checked ? S.inc.inferidos.filter((c) => !reg || c.departamento === reg) : [];
    for (const c of infs) {
      L.circleMarker([c.lat, c.lon], { radius: Math.min(22, 8 + Math.sqrt(c.focos_24h) * 1.6), color: "#a259ff", weight: 2, dashArray: "4 4", fillColor: "#a259ff", fillOpacity: 0.12 })
        .bindPopup(`<h3>${esc(c.nombre)}</h3><span class="badge" style="background:#a259ff;color:#fff">Inferido por satélite</span>
          <div class="pp-row">${esc(c.estado_texto)}</div><div class="pp-row"><span class="pp-k">FRP máx.:</span> ${esc(c.frp_max)} MW · <span class="pp-k">Última detección:</span> ${lima(c.ultimo)}</div>
          <div class="pp-row small">Sin reporte oficial asociado en este mapa. Puede tratarse de quemas agrícolas. Verifica con <a href="https://portal.indeci.gob.pe/emergencias/" target="_blank" rel="noopener">INDECI</a>.</div>`)
        .addTo(infLayer);
    }

    // Lista lateral
    const ul = document.getElementById("incidents"); ul.innerHTML = "";
    document.getElementById("n-inc").textContent = `(${list.length})`;
    for (const i of list) {
      const e = ESTADOS[i.estado] || ESTADOS.sin_dato;
      const li = document.createElement("li");
      const sat = i.satelite && i.satelite.focos_24h > 0 ? `<div class="sat">🛰️ actividad satelital reciente: ${i.satelite.focos_24h} focos/24 h</div>` : "";
      li.innerHTML = `<span class="dot" style="background:${e.c}"></span><b>${esc(i.nombre)}</b><br><span class="small">${e.t} · ${lima(i.fecha_estado)}${i.origen === "indeci_auto" ? " · INDECI (auto)" : ""}</span>${sat}`;
      li.addEventListener("click", () => { map.setView([i.lat, i.lon], 10); markers[i.id].openPopup(); if (innerWidth < 760) document.getElementById("panel").classList.add("collapsed"); setTimeout(() => map.invalidateSize(), 60); });
      ul.appendChild(li);
    }

    // Noticias
    const nu = document.getElementById("news"); nu.innerHTML = "";
    (S.news.noticias || []).slice(0, 25).forEach((n) => {
      const li = document.createElement("li");
      li.innerHTML = `<a href="${esc(safeUrl(n.url))}" target="_blank" rel="noopener">${esc(n.titulo)}</a><div class="meta">${esc(n.medio)} · ${lima(n.fecha)}</div>`;
      nu.appendChild(li);
    });

    // Contadores
    const c = S.meta.conteos, ro = S.meta.resumen_oficial || {};
    const act = list.filter((i) => i.estado === "activo" || i.estado === "en_control");
    const regsAct = new Set(act.map((i) => i.departamento));
    const fal = list.reduce((s, i) => s + (i.fallecidos || 0), 0);
    document.getElementById("stats").innerHTML = `
      <div class="stat"><div class="v">${nF.toLocaleString("es-PE")}</div><div class="l">focos satelitales (${winH < 168 ? winH + " h" : "7 días"})</div><div class="s">en ${fRegs.size} regiones · NASA FIRMS</div></div>
      <div class="stat"><div class="v">${act.length}</div><div class="l">incidentes activos o en control</div><div class="s">de ${list.length} en el mapa</div></div>
      <div class="stat"><div class="v">${regsAct.size}</div><div class="l">regiones con incidentes activos</div><div class="s">${[...regsAct].map(title).join(", ") || "—"}</div></div>
      <div class="stat"><div class="v">${reg ? fal : (ro.fallecidos_octubre != null ? Math.max(ro.fallecidos_octubre, fal) : fal)}</div><div class="l">fallecidos reportados</div><div class="s">${reg ? "en incidentes del mapa" : "octubre; ver fuentes"}</div></div>
      <div class="stat wide"><div class="l"><b>Fallecidos:</b> ${esc(ro.fallecidos_texto || "")} ${ro.fuente_url ? `<a href="${esc(safeUrl(ro.fuente_url))}" target="_blank" rel="noopener">fuente</a>` : ""}. En los incidentes del mapa se suman ${fal}.<br><b>Hectáreas:</b> ${esc(ro.hectareas_texto || "sin dato")} ${ro.hectareas_fuente_url ? `<a href="${esc(safeUrl(ro.hectareas_fuente_url))}" target="_blank" rel="noopener">fuente</a>` : ""}</div></div>`;

    document.getElementById("upd").textContent = lima(S.meta.generado);
    tick();
    const st = S.meta.fuentes || {};
    document.getElementById("sources-status").innerHTML = "<b>Estado de las fuentes en la última actualización:</b><br>" +
      Object.entries(st).map(([k, v]) => `${v.ok ? "✅" : "⚠️"} ${esc(k)}: ${esc(v.detalle)}`).join("<br>");
  }

  function tick() { if (S.meta) document.getElementById("ago").textContent = "(" + ago(Date.now() - new Date(S.meta.generado)) + ")"; }
  setInterval(tick, 30000);

  // enlace al repo si estamos en GitHub Pages
  const m = location.hostname.match(/^([^.]+)\.github\.io$/);
  if (m) document.getElementById("repo-link").href = "https://github.com/fastestShipper/incendios-peru-en-vivo";

  // enlace directo a un punto: mapa-2d.html#lat,lon
  const hm = location.hash.match(/^#(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/);
  if (hm) map.setView([+hm[1], +hm[2]], 10);
  loadAll(true).catch((e) => { document.getElementById("upd").textContent = "error al cargar datos: " + e.message; });
  setInterval(() => loadAll(false).catch(() => {}), POLL_MS);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) loadAll(false).catch(() => {}); });
})();
