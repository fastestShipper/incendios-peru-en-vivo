#!/usr/bin/env python3
"""Actualizador de datos de incendios-peru-en-vivo.

Descarga detecciones satelitales NASA FIRMS, reportes del COEN-INDECI y titulares
de prensa, y genera los JSON estáticos que consume el mapa (carpeta data/).
Solo usa la librería estándar de Python + `pdftotext` (poppler-utils) para leer
los PDF de INDECI. Uso: python3 scripts/update.py
Variables de entorno opcionales:
  FIRMS_MAP_KEY  -> clave gratuita de FIRMS (https://firms.modaps.eosdis.nasa.gov/api/map_key/)
  INDECI_PAGES   -> páginas del listado de emergencias a revisar (por defecto 4)
"""
import csv, html, io, json, math, os, re, subprocess, sys, tempfile, time, unicodedata
import urllib.request, urllib.parse
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
CACHE = os.path.join(DATA, "cache")
LIMA = timezone(timedelta(hours=-5))
UA = "Mozilla/5.0 (incendios-peru-en-vivo; +https://github.com/) Python-urllib"
NOW = datetime.now(timezone.utc)
STATUS = {}  # estado de cada fuente para meta.json


def log(*a):
    print(*a, file=sys.stderr, flush=True)


def get(url, timeout=60, binary=False, tries=3):
    last = None
    for i in range(tries):
        try:
            url = urllib.parse.quote(url, safe=":/%?=&#+,;@~")
            req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept-Language": "es-PE,es;q=0.9"})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                b = r.read()
                return b if binary else b.decode("utf-8", errors="replace")
        except Exception as e:  # noqa
            last = e
            time.sleep(2 * (i + 1))
    raise last


def norm(s):
    s = unicodedata.normalize("NFD", (s or "").upper())
    s = "".join(c for c in s if unicodedata.category(c) != "Mn")
    return re.sub(r"\s+", " ", s.replace("Ñ", "N")).strip()


def load(path, default):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return default


def dump(path, obj, pretty=False):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        if pretty:
            json.dump(obj, f, ensure_ascii=False, indent=1)
        else:
            json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp, path)


def km(lat1, lon1, lat2, lon2):
    p = math.pi / 180
    a = 0.5 - math.cos((lat2 - lat1) * p) / 2 + math.cos(lat1 * p) * math.cos(lat2 * p) * (1 - math.cos((lon2 - lon1) * p)) / 2
    return 12742 * math.asin(math.sqrt(a))


# ----------------------------------------------------------------- geografía
DEPS = load(os.path.join(DATA, "ref", "departamentos.geojson"), {"features": []})
DIST = load(os.path.join(DATA, "ref", "distritos.json"), {})
DEP_POLYS = []  # (nombre, bbox, [rings])
for f in DEPS["features"]:
    g = f["geometry"]
    polys = g["coordinates"] if g["type"] == "MultiPolygon" else [g["coordinates"]]
    rings = [p[0] for p in polys]
    xs = [pt[0] for r in rings for pt in r]
    ys = [pt[1] for r in rings for pt in r]
    DEP_POLYS.append((f["properties"]["NOMBDEP"], (min(xs), min(ys), max(xs), max(ys)), rings))
PERU_BBOX = (-81.5, -18.5, -68.5, 0.1)


def in_ring(x, y, ring):
    inside = False
    j = len(ring) - 1
    for i in range(len(ring)):
        xi, yi = ring[i][0], ring[i][1]
        xj, yj = ring[j][0], ring[j][1]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi + 1e-15) + xi:
            inside = not inside
        j = i
    return inside


def departamento(lat, lon):
    if not (PERU_BBOX[0] <= lon <= PERU_BBOX[2] and PERU_BBOX[1] <= lat <= PERU_BBOX[3]):
        return None
    for name, bb, rings in DEP_POLYS:
        if bb[0] <= lon <= bb[2] and bb[1] <= lat <= bb[3]:
            for r in rings:
                if in_ring(lon, lat, r):
                    return name
    return None


def ubicar(dep, prov, dist):
    dep, prov, dist = norm(dep), norm(prov), norm(dist)
    if dep == "LIMA METROPOLITANA":
        dep = "LIMA"
    k = f"{dep}|{prov}|{dist}"
    if k in DIST:
        return DIST[k], "centroide del distrito"
    cands = [v for kk, v in DIST.items() if kk.startswith(dep + "|") and kk.endswith("|" + dist)]
    if len(cands) == 1:
        return cands[0], "centroide del distrito"
    cands = [v for kk, v in DIST.items() if kk.endswith("|" + dist)]
    if len(cands) == 1:
        return cands[0], "centroide del distrito"
    return None, None


# ----------------------------------------------------------------- 1. FIRMS
FIRMS_PUBLIC = {
    "VIIRS S-NPP": "https://firms.modaps.eosdis.nasa.gov/data/active_fire/suomi-npp-viirs-c2/csv/SUOMI_VIIRS_C2_South_America_7d.csv",
    "VIIRS NOAA-20": "https://firms.modaps.eosdis.nasa.gov/data/active_fire/noaa-20-viirs-c2/csv/J1_VIIRS_C2_South_America_7d.csv",
    "VIIRS NOAA-21": "https://firms.modaps.eosdis.nasa.gov/data/active_fire/noaa-21-viirs-c2/csv/J2_VIIRS_C2_South_America_7d.csv",
    "MODIS Terra/Aqua": "https://firms.modaps.eosdis.nasa.gov/data/active_fire/modis-c6.1/csv/MODIS_C6_1_South_America_7d.csv",
}
FIRMS_API_SOURCES = {
    "VIIRS S-NPP": "VIIRS_SNPP_NRT", "VIIRS NOAA-20": "VIIRS_NOAA20_NRT",
    "VIIRS NOAA-21": "VIIRS_NOAA21_NRT", "MODIS Terra/Aqua": "MODIS_NRT",
}
SAT_NAMES = {"N": "S-NPP", "N20": "NOAA-20", "N21": "NOAA-21", "T": "Terra", "A": "Aqua", "1": "NOAA-20", "J1": "NOAA-20", "J2": "NOAA-21"}


def firms_rows(name):
    key = os.environ.get("FIRMS_MAP_KEY", "").strip()
    if key:
        # API de área: hasta 5 días por consulta -> 2 consultas para cubrir 7 días.
        rows = []
        bbox = ",".join(str(x) for x in PERU_BBOX)
        try:
            for start in [(NOW - timedelta(days=6)).date(), (NOW - timedelta(days=1)).date()]:
                url = f"https://firms.modaps.eosdis.nasa.gov/api/area/csv/{key}/{FIRMS_API_SOURCES[name]}/{bbox}/5/{start}"
                txt = get(url, timeout=120)
                if not txt.startswith("latitude"):
                    raise RuntimeError(txt[:120])
                rows += list(csv.DictReader(io.StringIO(txt)))
            return rows, "API FIRMS (MAP_KEY)"
        except Exception as e:
            log("FIRMS API falló, uso feed público:", name, e)
    txt = get(FIRMS_PUBLIC[name], timeout=180)
    return list(csv.DictReader(io.StringIO(txt))), "feed público FIRMS 7d (Sudamérica)"


def update_firms():
    pts, seen = [], set()
    cutoff = NOW - timedelta(days=7)
    for name in FIRMS_PUBLIC:
        try:
            rows, how = firms_rows(name)
            n = 0
            for r in rows:
                try:
                    lat, lon = float(r["latitude"]), float(r["longitude"])
                except Exception:
                    continue
                if not (PERU_BBOX[1] <= lat <= PERU_BBOX[3] and PERU_BBOX[0] <= lon <= PERU_BBOX[2]):
                    continue
                dep = departamento(lat, lon)
                if not dep:
                    continue
                t = r["acq_time"].zfill(4)
                dt = datetime.strptime(r["acq_date"] + t, "%Y-%m-%d%H%M").replace(tzinfo=timezone.utc)
                if dt < cutoff:
                    continue
                sat = SAT_NAMES.get(r.get("satellite", ""), r.get("satellite", ""))
                k = (round(lat, 4), round(lon, 4), int(dt.timestamp()), sat)
                if k in seen:
                    continue
                seen.add(k)
                conf = r.get("confidence", "")
                if conf in ("l", "n", "h"):
                    conf = {"l": "baja", "n": "nominal", "h": "alta"}[conf]
                elif conf in ("low", "nominal", "high"):
                    conf = {"low": "baja", "nominal": "nominal", "high": "alta"}[conf]
                else:  # MODIS 0-100
                    try:
                        c = int(conf)
                        conf = f"{c}%"
                    except Exception:
                        pass
                frp = float(r.get("frp") or 0)
                pts.append([round(lat, 4), round(lon, 4), int(dt.timestamp()), sat, conf, round(frp, 1), r.get("daynight", ""), dep, "MODIS" if "MODIS" in name else "VIIRS"])
                n += 1
            STATUS[f"FIRMS {name}"] = {"ok": True, "detalle": f"{n} detecciones en Perú (7 días) · {how}"}
            log("FIRMS", name, n)
        except Exception as e:
            STATUS[f"FIRMS {name}"] = {"ok": False, "detalle": str(e)[:200]}
            log("FIRMS error", name, e)
    if not any(v["ok"] for k, v in STATUS.items() if k.startswith("FIRMS")):
        old = load(os.path.join(DATA, "firms.json"), None)
        if old:
            log("FIRMS: todas las fuentes fallaron; se conservan datos anteriores")
            return old
    pts.sort(key=lambda p: p[2])
    out = {
        "generado": NOW.isoformat(),
        "campos": ["lat", "lon", "t_unix_utc", "satelite", "confianza", "frp_mw", "dia_noche", "departamento", "sensor"],
        "puntos": pts,
    }
    dump(os.path.join(DATA, "firms.json"), out)
    return out


# ----------------------------------------------------------------- 2. INDECI
INDECI_LIST = "https://portal.indeci.gob.pe/emergencias/"
TITLE_RE = re.compile(
    r"REPORTE\s+(COMPLEMENTARIO|PRELIMINAR)\s+N\.?\s*[°ºo]?\s*(\d+)\s*[–-]\s*(\d{1,2})/(\d{1,2})/(\d{4})\s*/\s*COEN\s*[–-]\s*INDECI\s*/\s*(\d{1,2}):(\d{2})\s*HORAS(?:\s*\(Reporte\s+N[°º.\s]*(\d+)\))?\s*INCENDIO\s+FORESTAL\s+EN\s+(?:EL|LOS)\s+DISTRITOS?\s+DE\s+(.+?)\s*[–-]\s*([A-ZÁÉÍÓÚÑ ]+)$",
    re.I,
)


def parse_listing(page_html):
    out = []
    for href, inner in re.findall(r'<a[^>]+href="(https://portal\.indeci\.gob\.pe/emergencias/[^"]+)"[^>]*>(.*?)</a>', page_html, re.S):
        t = re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", inner))).strip()
        if "INCENDIO FORESTAL" not in t.upper():
            continue
        m = TITLE_RE.search(t)
        if not m:
            continue
        tipo, num, d, mo, y, hh, mm, repn, dist, dep = m.groups()
        try:
            # INDECI usa d/m/aaaa; si el día > 12 no hay ambigüedad. Algunos títulos traen m/d por error.
            dt = datetime(int(y), int(mo), int(d), int(hh), int(mm), tzinfo=LIMA)
            if dt > NOW.astimezone(LIMA) + timedelta(days=1):
                dt = datetime(int(y), int(d), int(mo), int(hh), int(mm), tzinfo=LIMA)
        except ValueError:
            try:
                dt = datetime(int(y), int(d), int(mo), int(hh), int(mm), tzinfo=LIMA)
            except ValueError:
                continue
        out.append({"titulo": t, "url": href, "tipo": tipo.lower(), "numero": int(num), "fecha": dt.isoformat(),
                    "reporte_n": int(repn) if repn else None, "distrito": dist.strip(), "departamento": dep.strip()})
    return out


def pdf_text(url):
    b = get(url, timeout=90, binary=True)
    with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as f:
        f.write(b)
        p = f.name
    try:
        return subprocess.run(["pdftotext", "-layout", p, "-"], capture_output=True, text=True, timeout=60).stdout
    finally:
        os.unlink(p)


def col_value(lines, header_pat, row_pat, tol=10):
    """Busca el valor numérico de una fila (p. ej. 'DIST. X') alineado bajo una cabecera de columna."""
    hpos = None
    for ln in lines:
        m = re.search(header_pat, ln)
        if m:
            hpos = (m.start() + m.end()) / 2
    if hpos is None:
        return None
    for ln in lines:
        if re.search(row_pat, ln):
            for m in re.finditer(r"(?<![\w.,])(\d+(?:[.,]\d+)?)(?![\w.,])", ln):
                c = (m.start() + m.end()) / 2
                if abs(c - hpos) <= tol:
                    return m.group(1).replace(",", ".")
    return None


def corta(t):
    """Recorta un fragmento a su primera oración."""
    t = re.split(r"(?<=\.)\s|\s[-•✓]\s", (t or "").strip())[0]
    return t.strip()


def parse_pdf(txt):
    info = {}
    flat = re.sub(r"\s+", " ", txt)
    m = re.search(r"(?:incendio(?: forestal)?|evento|emergencia)\s+se\s+encuentra\s+(?:totalmente\s+)?(ACTIVO|CONTROLADO|EXTINGUIDO|EN CONTROL|LIQUIDADO|SOFOCADO)", flat, re.I)
    if not m:
        m = re.search(r"(?:incendio(?: forestal)?)\s+(?:fue|ha sido)\s+(controlado|extinguido|sofocado|liquidado)", flat, re.I)
    if m:
        w = m.group(1).lower()
        info["estado"] = {"activo": "activo", "controlado": "controlado", "extinguido": "extinguido", "liquidado": "extinguido",
                          "sofocado": "extinguido", "en control": "en_control"}.get(w, "sin_dato")
        info["estado_texto"] = corta(flat[m.start():m.start() + 200])
    m = re.search(r"Actualizado al (\d{1,2}) de (\w+) de (\d{4}),? a las (\d{1,2}):(\d{2})", flat)
    meses = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"]
    if m and m.group(2).lower() in meses:
        info["actualizado"] = datetime(int(m.group(3)), meses.index(m.group(2).lower()) + 1, int(m.group(1)), int(m.group(4)), int(m.group(5)), tzinfo=LIMA).isoformat()
    h = flat.find("HECHOS")
    m = re.search(r"(\d{1,2})/(\d{1,2})/(\d{4})\s+(?:(\d{1,2}):(\d{2}))?", flat[h:h + 600]) if h >= 0 else None
    if m:
        try:
            info["inicio"] = datetime(int(m.group(3)), int(m.group(2)), int(m.group(1)), int(m.group(4) or 0), int(m.group(5) or 0), tzinfo=LIMA).isoformat()
        except ValueError:
            pass
    lines = txt.splitlines()
    for i, ln in enumerate(lines):
        if re.search(r"DEPARTAMENTO\s+PROVINCIA\s+DISTRITO", ln):
            for nxt in lines[i + 1:i + 4]:
                parts = [p.strip() for p in re.split(r"\s{2,}", nxt.strip()) if p.strip()]
                if len(parts) >= 3:
                    info["ubicacion"] = {"departamento": parts[0], "provincia": parts[1], "distrito": parts[2],
                                         "sector": parts[3] if len(parts) > 3 and not parts[3].isdigit() else None}
                    break
            break
    ha = col_value(lines, r"\(ha\)", r"^\s*DIST\.")
    if ha:
        info["hectareas"] = f"{ha} ha de cobertura natural (tabla de daños INDECI)"
    fal = col_value(lines, r"FALLECID[AO]S?", r"^\s*DIST\.")
    if fal:
        info["fallecidos"] = int(float(fal))
    les = col_value(lines, r"LESIONAD[AO]S?", r"^\s*DIST\.")
    if les:
        info["heridos"] = int(float(les))
    return info


def update_indeci():
    cache = load(os.path.join(CACHE, "indeci_reportes.json"), {})
    items = []
    pages = int(os.environ.get("INDECI_PAGES", "4"))
    try:
        for p in range(1, pages + 1):
            url = INDECI_LIST if p == 1 else f"{INDECI_LIST}page/{p}/"
            items += parse_listing(get(url, timeout=60))
        STATUS["INDECI emergencias"] = {"ok": True, "detalle": f"{len(items)} reportes de incendio forestal en {pages} páginas"}
    except Exception as e:
        STATUS["INDECI emergencias"] = {"ok": len(items) > 0, "detalle": f"error parcial: {str(e)[:150]}"}
        log("INDECI listing error", e)
    if not items:
        return load(os.path.join(DATA, "indeci.json"), {"reportes": []}).get("reportes", [])
    # último reporte por (departamento, distrito)
    groups = {}
    for it in items:
        k = (norm(it["departamento"]), norm(it["distrito"]))
        if k not in groups or it["numero"] > groups[k]["numero"]:
            groups[k] = it
    latest = sorted(groups.values(), key=lambda x: x["numero"], reverse=True)
    fetched = 0
    for it in latest:
        key = str(it["numero"])
        if key in cache and cache[key].get("v") == 2:
            it.update(cache[key])
            continue
        if fetched >= 40:
            continue
        try:
            page = get(it["url"], timeout=60)
            pdfs = [u for u in re.findall(r'href="([^"]+\.pdf)"', page) if "uploads" in u]
            info = {"pdf": pdfs[0] if pdfs else None, "v": 2}
            if pdfs:
                info.update(parse_pdf(pdf_text(pdfs[0])))
            cache[key] = info
            it.update(info)
            fetched += 1
        except Exception as e:
            log("INDECI report error", it["url"], e)
    # limitar caché
    keep = {str(i["numero"]) for i in latest}
    cache = {k: v for k, v in cache.items() if k in keep}
    dump(os.path.join(CACHE, "indeci_reportes.json"), cache, pretty=True)
    dump(os.path.join(DATA, "indeci.json"), {"generado": NOW.isoformat(), "fuente": INDECI_LIST, "reportes": latest}, pretty=True)
    return latest


# ----------------------------------------------------------------- 3. Noticias
NEWS_QUERIES = [
    'incendio forestal Perú when:3d',
    'incendios forestales Cusco OR Apurímac OR Ayacucho OR Junín OR Puno OR Pasco when:3d',
]
NEWS_KEYWORDS = ("incendi", "fuego", "quema", "llamas", "brigad", "hectáreas")


def update_news():
    seen, out = set(), []
    ok = False
    for q in NEWS_QUERIES:
        url = "https://news.google.com/rss/search?" + urllib.parse.urlencode({"q": q, "hl": "es-419", "gl": "PE", "ceid": "PE:es-419"})
        try:
            root = ET.fromstring(get(url, timeout=40))
            ok = True
            for it in root.iter("item"):
                title = (it.findtext("title") or "").strip()
                src = it.find("source")
                medio = src.text.strip() if src is not None and src.text else ""
                if medio and title.endswith(" - " + medio):
                    title = title[: -len(" - " + medio)]
                if not any(k in title.lower() for k in NEWS_KEYWORDS):
                    continue
                key = norm(title)[:80]
                if key in seen:
                    continue
                seen.add(key)
                try:
                    dt = datetime.strptime(it.findtext("pubDate"), "%a, %d %b %Y %H:%M:%S %Z").replace(tzinfo=timezone.utc)
                except Exception:
                    dt = NOW
                if medio.lower() == "facebook":
                    continue
                out.append({"titulo": title, "medio": medio, "url": it.findtext("link"), "fecha": dt.isoformat()})
        except Exception as e:
            log("news error", e)
    STATUS["Google Noticias RSS"] = {"ok": ok, "detalle": f"{len(out)} titulares"}
    if not ok:
        return load(os.path.join(DATA, "noticias.json"), {"noticias": []}).get("noticias", [])
    out.sort(key=lambda x: x["fecha"], reverse=True)
    out = out[:60]
    dump(os.path.join(DATA, "noticias.json"), {"generado": NOW.isoformat(), "noticias": out}, pretty=True)
    return out


# ----------------------------------------------------------------- 4. Fusión
def build_incidents(firms, indeci):
    cur = load(os.path.join(DATA, "incidentes_curados.json"), {"incidentes": []})
    incs = []
    for c in cur["incidentes"]:
        inc = dict(c)
        if "lat" not in inc:
            ll, how = ubicar(c["departamento"], c["provincia"], c["distrito"])
            if not ll:
                log("sin ubicación:", c["id"])
                continue
            inc["lat"], inc["lon"], inc["precision"] = ll[0], ll[1], how
        inc["origen"] = "curado"
        incs.append(inc)
    by_key = {(norm(i["departamento"]), norm(i["distrito"])): i for i in incs}
    for r in indeci:
        u = r.get("ubicacion") or {}
        dep = u.get("departamento") or r["departamento"]
        dist = u.get("distrito") or r["distrito"]
        prov = u.get("provincia") or ""
        k = (norm(dep), norm(dist))
        fuente = {"medio": "INDECI – COEN", "titulo": r["titulo"], "url": r["url"], "fecha": r["fecha"][:10]}
        if r.get("pdf"):
            fuente_pdf = {"medio": "INDECI – COEN (PDF)", "titulo": f"Reporte N.º {r['numero']} (PDF)", "url": r["pdf"], "fecha": r["fecha"][:10]}
        else:
            fuente_pdf = None
        rep_time = r.get("actualizado") or r["fecha"]
        if k in by_key:
            inc = by_key[k]
            if not any(f["url"] == r["url"] for f in inc["fuentes"]):
                inc["fuentes"] = [fuente] + ([fuente_pdf] if fuente_pdf else []) + inc["fuentes"]
            if r.get("estado") and rep_time > inc.get("fecha_estado", ""):
                inc["estado"] = r["estado"]
                inc["estado_texto"] = f"INDECI (reporte N.º {r['numero']}, leído automáticamente): «{corta(r.get('estado_texto', ''))}»"
                inc["fecha_estado"] = rep_time
                inc["estado_origen"] = "INDECI automático"
            for fld in ("hectareas", "fallecidos", "heridos", "inicio"):
                if r.get(fld) is not None and inc.get(fld) is None:
                    inc[fld] = r[fld]
            continue
        ll, how = ubicar(dep, prov, dist)
        if not ll:
            continue
        sector = u.get("sector")
        inc = {
            "id": "indeci-" + str(r["numero"]),
            "nombre": f"{dist.title()} ({dep.title()})" + (f" – {sector.title()}" if sector and norm(sector) != norm(dist) else ""),
            "departamento": norm(dep), "provincia": norm(prov), "distrito": norm(dist),
            "estado": r.get("estado") or "sin_dato",
            "estado_texto": (f"INDECI (reporte N.º {r['numero']}, leído automáticamente): «{corta(r['estado_texto'])}»" if r.get("estado_texto")
                             else "Reportado por COEN-INDECI; el estado no pudo leerse automáticamente: revisa el reporte."),
            "hectareas": r.get("hectareas"), "fallecidos": r.get("fallecidos"), "heridos": r.get("heridos"),
            "inicio": r.get("inicio"),
            "fecha_estado": rep_time, "lat": ll[0], "lon": ll[1], "precision": how,
            "origen": "indeci_auto", "fuentes": [fuente] + ([fuente_pdf] if fuente_pdf else []),
        }
        incs.append(inc)
        by_key[k] = inc
    # actividad satelital reciente cerca de cada incidente
    now_ts = NOW.timestamp()
    recent = [p for p in firms["puntos"] if now_ts - p[2] <= 48 * 3600]
    for inc in incs:
        n24 = n48 = 0
        last = None
        for p in recent:
            if abs(p[0] - inc["lat"]) > 0.2 or abs(p[1] - inc["lon"]) > 0.2:
                continue
            if km(inc["lat"], inc["lon"], p[0], p[1]) <= 15:
                n48 += 1
                if now_ts - p[2] <= 24 * 3600:
                    n24 += 1
                last = max(last or 0, p[2])
        inc["satelite"] = {"focos_24h": n24, "focos_48h": n48, "ultimo": datetime.fromtimestamp(last, timezone.utc).isoformat() if last else None,
                           "radio_km": 15}
    # agrupaciones solo-satelitales (inferidas)
    pts24 = [p for p in recent if now_ts - p[2] <= 24 * 3600]
    grid = {}
    for i, p in enumerate(pts24):
        grid.setdefault((int(p[0] // 0.03), int(p[1] // 0.03)), []).append(i)
    used, clusters = set(), []
    for i in range(len(pts24)):
        if i in used:
            continue
        stack, members = [i], []
        used.add(i)
        while stack:
            j = stack.pop()
            pj = pts24[j]
            members.append(pj)
            gy, gx = int(pj[0] // 0.03), int(pj[1] // 0.03)
            for dy in (-1, 0, 1):
                for dx in (-1, 0, 1):
                    for k2 in grid.get((gy + dy, gx + dx), []):
                        if k2 not in used and km(pts24[k2][0], pts24[k2][1], pj[0], pj[1]) <= 3:
                            used.add(k2)
                            stack.append(k2)
        if len(members) < 3:
            continue
        lat = sum(m[0] for m in members) / len(members)
        lon = sum(m[1] for m in members) / len(members)
        if any(km(lat, lon, inc["lat"], inc["lon"]) <= 20 for inc in incs):
            continue
        clusters.append({
            "id": f"sat-{round(lat, 2)}_{round(lon, 2)}",
            "nombre": f"Agrupación de focos – {members[0][7].title()}",
            "departamento": members[0][7], "lat": round(lat, 4), "lon": round(lon, 4),
            "estado": "inferido",
            "estado_texto": f"Inferido por satélite: {len(members)} detecciones en 24 h en un radio de ~3 km. No confirmado por autoridades.",
            "focos_24h": len(members), "frp_max": max(m[5] for m in members),
            "ultimo": datetime.fromtimestamp(max(m[2] for m in members), timezone.utc).isoformat(),
            "origen": "satelite",
        })
    clusters.sort(key=lambda c: c["focos_24h"], reverse=True)
    return incs, clusters[:80], cur.get("resumen_oficial", {})


def main():
    os.makedirs(CACHE, exist_ok=True)
    firms = update_firms()
    indeci = update_indeci()
    news = update_news()
    incs, clusters, resumen = build_incidents(firms, indeci)
    now_ts = NOW.timestamp()
    f24 = [p for p in firms["puntos"] if now_ts - p[2] <= 86400]
    activos = [i for i in incs if i["estado"] in ("activo", "en_control")]
    meta = {
        "generado": NOW.isoformat(),
        "generado_lima": NOW.astimezone(LIMA).strftime("%d/%m/%Y %H:%M"),
        "conteos": {
            "focos_24h": len(f24),
            "focos_7d": len(firms["puntos"]),
            "incidentes": len(incs),
            "incidentes_activos": len(activos),
            "regiones_activas": sorted({i["departamento"] for i in activos}),
            "fallecidos_reportados": sum(i.get("fallecidos") or 0 for i in incs),
            "agrupaciones_satelitales": len(clusters),
        },
        "resumen_oficial": resumen,
        "fuentes": STATUS,
    }
    dump(os.path.join(DATA, "incidentes.json"), {"generado": NOW.isoformat(), "incidentes": incs, "inferidos": clusters}, pretty=True)
    dump(os.path.join(DATA, "meta.json"), meta, pretty=True)
    log(json.dumps(meta["conteos"], ensure_ascii=False))


if __name__ == "__main__":
    main()
