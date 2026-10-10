// Página de estado del monitoreo (sin dependencias). Lee meta.json, health.json, historial.json y novedades.json.
(() => {
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const safeUrl = (u) => (/^https?:\/\//i.test(u || "") ? u : "#");
  const fmtDT = new Intl.DateTimeFormat("es-PE", { timeZone: "America/Lima", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false });
  const fmtHM = new Intl.DateTimeFormat("es-PE", { timeZone: "America/Lima", hour: "2-digit", minute: "2-digit", hour12: false });
  const STALE_MIN = 45;
  const TIPO = { nuevo: "🔥", estado: "🔁", reporte: "📄", victimas: "🕯️", dato: "📏", satelite: "🛰️", noticia: "📰", sistema: "⚙️" };
  const REG = { AMAZONAS: "Amazonas", ANCASH: "Áncash", APURIMAC: "Apurímac", AREQUIPA: "Arequipa", AYACUCHO: "Ayacucho", CAJAMARCA: "Cajamarca", CALLAO: "Callao", CUSCO: "Cusco", HUANCAVELICA: "Huancavelica", HUANUCO: "Huánuco", ICA: "Ica", JUNIN: "Junín", "LA LIBERTAD": "La Libertad", LAMBAYEQUE: "Lambayeque", LIMA: "Lima", LORETO: "Loreto", "MADRE DE DIOS": "Madre de Dios", MOQUEGUA: "Moquegua", PASCO: "Pasco", PIURA: "Piura", PUNO: "Puno", "SAN MARTIN": "San Martín", TACNA: "Tacna", TUMBES: "Tumbes", UCAYALI: "Ucayali" };
  function ago(iso) {
    if (!iso) return "—";
    const m = Math.round((Date.now() - new Date(iso)) / 60000);
    if (m < 1) return "hace un momento";
    if (m < 60) return `hace ${m} min`;
    const h = Math.round(m / 60);
    if (h < 36) return `hace ${h} h`;
    return `hace ${Math.round(h / 24)} d`;
  }
  async function j(path) { const r = await fetch(`${path}?t=${Date.now()}`, { cache: "no-store" }); if (!r.ok) throw new Error(path + " " + r.status); return r.json(); }

  function chart(c, pts) {
    if (!c || pts.length < 2) return;
    const g = c.getContext("2d"), W = c.width, H = c.height, L = 70, R = 60, T = 16, B = 40;
    g.clearRect(0, 0, W, H);
    const xs = pts.map((p) => p[0]), x0 = xs[0], x1 = xs[xs.length - 1];
    const X = (t) => L + ((t - x0) / Math.max(x1 - x0, 1)) * (W - L - R);
    const series = [[1, "#ff6a00", "left"], [2, "#ff3b1f", "right"]];
    g.strokeStyle = "#223450"; g.lineWidth = 1; g.font = "15px system-ui"; g.fillStyle = "#9fb0c6"; g.textBaseline = "middle";
    for (const [idx, color, side] of series) {
      const vals = pts.map((p) => p[idx] || 0); const max = Math.max(...vals, 1);
      const Y = (v) => T + (1 - v / max) * (H - T - B);
      for (let k = 0; k <= 2; k++) { const v = Math.round((max * k) / 2), y = Y(v); if (side === "left") { g.beginPath(); g.moveTo(L, y); g.lineTo(W - R, y); g.stroke(); g.textAlign = "right"; g.fillText(v.toLocaleString("es-PE"), L - 8, y); } else { g.textAlign = "left"; g.fillText(String(v), W - R + 8, y); } }
      g.beginPath(); vals.forEach((v, k) => (k ? g.lineTo(X(pts[k][0]), Y(v)) : g.moveTo(X(pts[k][0]), Y(v))));
      g.strokeStyle = color; g.lineWidth = 3; g.lineJoin = "round"; g.stroke();
      g.strokeStyle = "#223450"; g.lineWidth = 1;
    }
    // marcas de tiempo
    g.textAlign = "center"; g.textBaseline = "top"; g.fillStyle = "#9fb0c6";
    const n = Math.min(6, pts.length - 1);
    for (let k = 0; k <= n; k++) { const t = x0 + ((x1 - x0) * k) / n; g.fillText(fmtDT.format(new Date(t * 1000)), X(t), H - B + 10); }
  }

  async function refresh() {
    const [meta, health, hist, nov] = await Promise.all([j("data/meta.json").catch(() => ({})), j("data/health.json").catch(() => ({})), j("data/historial.json").catch(() => ({})), j("data/novedades.json").catch(() => ({}))]);
    const iv = meta.intervalo_min || health.intervalo_min || 10; $("#iv").textContent = iv;
    const ageMin = meta.generado ? (Date.now() - new Date(meta.generado)) / 60000 : 1e9;
    const fuentes = health.fuentes || meta.fuentes || {};
    const nBad = Object.values(fuentes).filter((s) => !s.ok).length;
    const hero = $("#hero");
    let cls = "ok", big = "Todo en orden", sub = "";
    if (!meta.generado) { cls = "bad"; big = "Sin datos todavía"; sub = "El actualizador aún no ha publicado nada."; }
    else if (ageMin > STALE_MIN) { cls = "bad"; big = `Datos atrasados ${Math.round(ageMin)} min`; sub = "El actualizador no publica desde " + fmtDT.format(new Date(meta.generado)) + " (hora de Lima)."; }
    else if (health.ok === false) { cls = "warn"; big = "La última corrida falló"; sub = `Se conservan los datos de ${ago(meta.generado)}.`; }
    else if (nBad) { cls = "warn"; big = `${nBad} fuente${nBad > 1 ? "s" : ""} con problemas`; sub = `Datos ${ago(meta.generado)}; las demás fuentes siguen entrando.`; }
    else sub = `Última actualización ${ago(meta.generado)} (${fmtDT.format(new Date(meta.generado))}, hora de Lima).`;
    hero.className = "hero " + cls; $("#estado").textContent = big; $("#estado-sub").textContent = sub;
    const c = meta.conteos || {};
    const facts = [
      ["Próxima actualización", meta.generado ? fmtHM.format(new Date(new Date(meta.generado).getTime() + iv * 60000)) + " <small>aprox.</small>" : "—"],
      ["Duración de la última corrida", health.duracion_s != null ? `${esc(health.duracion_s)} <small>s</small>` : "—"],
      ["Fallos seguidos", esc(health.fallos_seguidos ?? 0)],
      ["Puntos de calor (24 h)", (c.focos_24h || 0).toLocaleString("es-PE")],
      ["Incendios activos o en control", esc(c.incidentes_activos ?? 0)],
      ["Regiones con fuego", esc((c.regiones_activas || []).length)],
      ["Incidentes seguidos", esc(c.incidentes ?? 0)],
      ["Versión", esc(health.version || meta.version || "—")],
    ];
    $("#facts").innerHTML = facts.map(([k, v]) => `<div class="fact"><div class="k">${esc(k)}</div><div class="v">${v}</div></div>`).join("");
    const pts = hist.puntos || [];
    chart($("#chart"), pts);
    $("#chart-note").textContent = pts.length > 1 ? `${pts.length} corridas registradas desde ${fmtDT.format(new Date(pts[0][0] * 1000))}.` : "Todavía no hay suficiente historial para graficar.";
    $("#src").innerHTML = Object.entries(fuentes).map(([k, v]) => `<li><span class="s">${v.ok ? "✅" : "⚠️"}</span><div><div>${esc(k)}${v.duracion_s != null ? ` <span class="d">· ${esc(v.duracion_s)} s</span>` : ""}</div><div class="d">${esc(v.detalle || "")}${!v.ok && v.fallos_seguidos ? ` · falla hace ${v.fallos_seguidos} corrida${v.fallos_seguidos > 1 ? "s" : ""}` : ""}${!v.ok && v.ultima_ok ? ` · última vez bien ${esc(ago(v.ultima_ok))}` : ""}</div></div></li>`).join("") || "<li class='muted'>Sin información de fuentes.</li>";
    const runs = (health.corridas || []).slice().reverse();
    $("#runs").innerHTML = runs.slice().reverse().map((r) => `<i class="${r.ok ? "" : "f"}" title="${esc(fmtDT.format(new Date(r.t)))}"></i>`).join("");
    $("#runs-table tbody").innerHTML = runs.slice(0, 24).map((r) => `<tr><td>${esc(fmtDT.format(new Date(r.t)))}</td><td>${esc(r.duracion_s)} s</td><td>${esc(r.fuentes_ok)}/${esc(r.fuentes_total)}</td><td>${(r.focos_24h || 0).toLocaleString("es-PE")}</td><td>${esc(r.activos ?? "")}</td><td>${r.ok ? "" : '<span class="f">error</span>'}</td></tr>`).join("");
    const items = (nov.items || []).slice(0, 25);
    $("#feed").innerHTML = items.map((e) => `<li><div class="ic">${TIPO[e.tipo] || "•"}</div><div><div>${e.url ? `<a href="${esc(safeUrl(e.url))}" target="_blank" rel="noopener">${esc(e.texto)}</a>` : esc(e.texto)}</div><div class="m">${[e.region ? REG[e.region] || e.region : null, e.medio, ago(e.t)].filter(Boolean).map(esc).join(" · ")}</div></div></li>`).join("") || "<li class='muted'>Sin novedades todavía.</li>";
  }
  refresh().catch((e) => { $("#estado").textContent = "No se pudo leer el estado"; $("#estado-sub").textContent = e.message; $("#hero").className = "hero bad"; });
  setInterval(() => refresh().catch(() => {}), 60000);
})();
