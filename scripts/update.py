#!/usr/bin/env python3
"""Actualizador de datos de incendios-peru-en-vivo.

Descarga detecciones satelitales NASA FIRMS, reportes del COEN-INDECI y titulares
de prensa, y genera los JSON estáticos que consume el mapa. Solo usa la librería
estándar de Python + `pdftotext` (poppler-utils) para leer los PDF de INDECI.

Uso: python3 scripts/update.py
Variables de entorno opcionales:
  FIRMS_MAP_KEY            -> clave gratuita de FIRMS (https://firms.modaps.eosdis.nasa.gov/api/map_key/)
  INDECI_PAGES             -> páginas del listado de emergencias a revisar (por defecto 4)
  INCENDIOS_OUT            -> carpeta de salida (por defecto data/). Las referencias (data/ref) y los
                              incidentes curados siempre se leen de data/.
  INCENDIOS_INTERVALO_MIN  -> cada cuántos minutos corre el programador (solo informativo; 10)
  INCENDIOS_VERSION        -> versión publicada (se muestra en meta.json y health.json)

Archivos generados (en INCENDIOS_OUT):
  firms.json        focos de calor de 7 días        firms_24h.json  solo las últimas 24 h (carga rápida)
  indeci.json       últimos reportes COEN            incidentes.json incidentes fusionados + inferidos
  noticias.json     titulares                        meta.json       conteos, hora, estado de fuentes
  novedades.json    feed de novedades (diferencias entre corridas)
  historial.json    serie de conteos por corrida (7 días)
  health.json       salud del actualizador: duración, fallos seguidos por fuente, últimas corridas

Código de salida: 0 si entró algún dato fresco; 1 si todas las fuentes fallaron (meta.json no se toca).
"""
import csv, html, io, json, math, os, re, subprocess, sys, tempfile, time, unicodedata
import urllib.request, urllib.parse
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")                                   # referencias + curados (solo lectura)
OUT = os.path.abspath(os.environ.get("INCENDIOS_OUT") or DATA)      # salida
CACHE = os.path.join(OUT, "cache")
LIMA = timezone(timedelta(hours=-5))
UA = "Mozilla/5.0 (incendios-peru-en-vivo; +https://github.com/fastestShipper/incendios-peru-en-vivo) Python-urllib"
NOW = datetime.now(timezone.utc)
INTERVALO_MIN = int(os.environ.get("INCENDIOS_INTERVALO_MIN", "10"))
STATUS = {}   # estado de cada fuente para meta.json / health.json
TIMING = {}   # segundos por fuente
T0 = time.monotonic()


def version():
    v = os.environ.get("INCENDIOS_VERSION", "").strip()
    if v:
        return v
    try:
        with open(os.path.join(ROOT, "VERSION"), encoding="utf-8") as f:
            return f.read().strip() or "dev"
    except Exception:
        return "dev"


VERSION = version()


def log(*a):
    print(datetime.now(timezone.utc).strftime("%H:%M:%S"), *a, file=sys.stderr, flush=True)


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


def out(name):
    return os.path.join(OUT, name)


def km(lat1, lon1, lat2, lon2):
    p = math.pi / 180
    a = 0.5 - math.cos((lat2 - lat1) * p) / 2 + math.cos(lat1 * p) * math.cos(lat2 * p) * (1 - math.cos((lon2 - lon1) * p)) / 2
    return 12742 * math.asin(math.sqrt(a))


class timed:
    """Mide cuánto tarda una fuente (para health.json)."""
    def __init__(self, key):
        self.key = key

    def __enter__(self):
        self.t = time.monotonic()

    def __exit__(self, *a):
        TIMING[self.key] = round(time.monotonic() - self.t, 1)


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
REG = {"AMAZONAS": "Amazonas", "ANCASH": "Áncash", "APURIMAC": "Apurímac", "AREQUIPA": "Arequipa", "AYACUCHO": "Ayacucho",
       "CAJAMARCA": "Cajamarca", "CALLAO": "Callao", "CUSCO": "Cusco", "HUANCAVELICA": "Huancavelica", "HUANUCO": "Huánuco",
       "ICA": "Ica", "JUNIN": "Junín", "LA LIBERTAD": "La Libertad", "LAMBAYEQUE": "Lambayeque", "LIMA": "Lima", "LORETO": "Loreto",
       "MADRE DE DIOS": "Madre de Dios", "MOQUEGUA": "Moquegua", "PASCO": "Pasco", "PIURA": "Piura", "PUNO": "Puno",
       "SAN MARTIN": "San Martín", "TACNA": "Tacna", "TUMBES": "Tumbes", "UCAYALI": "Ucayali"}
EST_W = {"activo": "fuego activo", "en_control": "lo están controlando", "controlado": "controlado", "extinguido": "apagado",
         "sin_dato": "sin información del estado", "inferido": "posible fuego (satélite)", "alerta": "alerta de SERFOR, por confirmar"}
EST_RANK = {"extinguido": 0, "controlado": 1, "sin_dato": 2, "inferido": 2, "alerta": 2, "en_control": 3, "activo": 4}
# nombre de departamento como aparece en textos -> clave interna
DEP_RE = re.compile(r"\b(" + "|".join(sorted({re.escape(v) for v in REG.values()} | {re.escape(k.title()) for k in REG}, key=len, reverse=True)) + r")\b")


def dep_de_texto(t):
    m = DEP_RE.search(t or "")
    if not m:
        return None
    n = norm(m.group(1))
    return n if n in REG else None


def reg_name(r):
    return REG.get(r, (r or "").title())


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
FIRMS_CAMPOS = ["lat", "lon", "t_unix_utc", "satelite", "confianza", "frp_mw", "dia_noche", "departamento", "sensor"]


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


def write_firms(firms):
    """Escribe firms.json (7 días) y firms_24h.json (carga inicial rápida del mapa)."""
    now_ts = NOW.timestamp()
    dump(out("firms.json"), firms)
    dump(out("firms_24h.json"), {"generado": firms["generado"], "campos": FIRMS_CAMPOS,
                                 "puntos": [p for p in firms["puntos"] if now_ts - p[2] <= 86400]})


def update_firms():
    pts, seen = [], set()
    cutoff = NOW - timedelta(days=7)
    for name in FIRMS_PUBLIC:
        key = f"FIRMS {name}"
        try:
            with timed(key):
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
            STATUS[key] = {"ok": True, "detalle": f"{n} detecciones en Perú (7 días) · {how}"}
            log("FIRMS", name, n, f"{TIMING.get(key)}s")
        except Exception as e:
            STATUS[key] = {"ok": False, "detalle": str(e)[:200]}
            log("FIRMS error", name, e)
    if not any(v["ok"] for k, v in STATUS.items() if k.startswith("FIRMS")):
        old = load(out("firms.json"), None)
        if old:
            log("FIRMS: todas las fuentes fallaron; se conservan datos anteriores")
            write_firms(old)
            return old
    pts.sort(key=lambda p: p[2])
    firms = {"generado": NOW.isoformat(), "campos": FIRMS_CAMPOS, "puntos": pts}
    write_firms(firms)
    return firms


# ----------------------------------------------------------------- 2. INDECI
INDECI_LIST = "https://portal.indeci.gob.pe/emergencias/"
TITLE_RE = re.compile(
    r"REPORTE\s+(COMPLEMENTARIO|PRELIMINAR)\s+N\.?\s*[°ºo]?\s*(\d+)\s*[–-]\s*(\d{1,2})/(\d{1,2})/(\d{4})\s*/\s*COEN\s*[–-]\s*INDECI\s*/\s*(\d{1,2}):(\d{2})\s*HORAS(?:\s*\(Reporte\s+N[°º.\s]*(\d+)\))?\s*INCENDIO\s+FORESTAL\s+EN\s+(?:EL|LOS)\s+DISTRITOS?\s+DE\s+(.+?)\s*[–-]\s*([A-ZÁÉÍÓÚÑ ]+)$",
    re.I,
)


def parse_listing(page_html):
    out_ = []
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
        out_.append({"titulo": t, "url": href, "tipo": tipo.lower(), "numero": int(num), "fecha": dt.isoformat(),
                     "reporte_n": int(repn) if repn else None, "distrito": dist.strip(), "departamento": dep.strip()})
    return out_


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
        return load(out("indeci.json"), {"reportes": []}).get("reportes", [])
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
    if fetched:
        STATUS["INDECI emergencias"]["detalle"] += f" · {fetched} PDF leídos"
    # limitar caché
    keep = {str(i["numero"]) for i in latest}
    cache = {k: v for k, v in cache.items() if k in keep}
    dump(os.path.join(CACHE, "indeci_reportes.json"), cache, pretty=True)
    dump(out("indeci.json"), {"generado": NOW.isoformat(), "fuente": INDECI_LIST, "reportes": latest}, pretty=True)
    return latest


# ----------------------------------------------------------------- 3. Noticias
NEWS_QUERIES = [
    'incendio forestal Perú when:3d',
    'incendios forestales Cusco OR Apurímac OR Ayacucho OR Junín OR Puno OR Pasco when:3d',
]
NEWS_KEYWORDS = ("incendi", "fuego", "quema", "llamas", "brigad", "hectáreas")


def update_news():
    seen, out_ = set(), []
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
                out_.append({"titulo": title, "medio": medio, "url": it.findtext("link"), "fecha": dt.isoformat()})
        except Exception as e:
            log("news error", e)
    STATUS["Google Noticias RSS"] = {"ok": ok, "detalle": f"{len(out_)} titulares"}
    # Andina (agencia estatal de noticias): su RSS general, filtrado por el tema
    try:
        with timed("Andina RSS"):
            root = ET.fromstring(get("https://andina.pe/agencia/rss.aspx", timeout=40))
        n_and = 0
        for it in root.iter("item"):
            title = (it.findtext("title") or "").strip()
            desc = re.sub(r"<[^>]+>", " ", it.findtext("description") or "")
            if not OFICIAL_RE.search(title + " " + desc):
                continue
            key = norm(title)[:80]
            if key in seen:
                continue
            seen.add(key)
            try:
                dt = datetime.strptime(it.findtext("pubDate"), "%a, %d %b %Y %H:%M:%S %z").astimezone(timezone.utc)
            except Exception:
                dt = NOW
            out_.append({"titulo": title, "medio": "Andina", "url": it.findtext("link"), "fecha": dt.isoformat()})
            n_and += 1
        STATUS["Andina RSS"] = {"ok": True, "detalle": f"{n_and} notas sobre incendios entre las últimas del día"}
        ok = True
    except Exception as e:
        STATUS["Andina RSS"] = {"ok": False, "detalle": str(e)[:200]}
        log("andina error", e)
    if not ok:
        return load(out("noticias.json"), {"noticias": []}).get("noticias", [])
    out_.sort(key=lambda x: x["fecha"], reverse=True)
    out_ = out_[:60]
    dump(out("noticias.json"), {"generado": NOW.isoformat(), "noticias": out_}, pretty=True)
    return out_


# ----------------------------------------------------------------- 3b. SERFOR (GEOSERFOR, ArcGIS REST público)
SERFOR_SVC = "https://geo.serfor.gob.pe/geoservicios/rest/services/Visor/Incendios_Forestales/MapServer"
SERFOR_VISOR = "https://geo.serfor.gob.pe/visor/"
SERFOR_EST = {1: "alerta", 2: "activo", 3: "controlado", 4: "extinguido"}
SERFOR_EST_W = {1: "Alertado", 2: "Confirmado", 3: "Controlado", 4: "Extinguido"}
SERFOR_DIAS = 14


def arcgis_query(layer, params, page=1000, max_pages=15):
    feats, off = [], 0
    for _ in range(max_pages):
        q = dict(params, f="json", resultOffset=off, resultRecordCount=page)
        d = json.loads(get(f"{SERFOR_SVC}/{layer}/query?" + urllib.parse.urlencode(q), timeout=90))
        if "error" in d:
            raise RuntimeError(str(d["error"])[:150])
        fs = d.get("features") or []
        feats += fs
        if not d.get("exceededTransferLimit") or not fs:
            break
        off += len(fs)
    return feats


def serfor_dominio(layer, campo):
    """Valores codificados de un campo (se guardan en caché un día)."""
    path = os.path.join(CACHE, f"serfor_dominio_{layer}_{campo}.json")
    c = load(path, None)
    if c and time.time() - c.get("t", 0) < 86400:
        return {int(k) if str(k).lstrip("-").isdigit() else k: v for k, v in c["v"].items()}
    d = json.loads(get(f"{SERFOR_SVC}/{layer}?f=json", timeout=60))
    v = {}
    for f in d.get("fields", []):
        if f["name"] == campo and f.get("domain"):
            v = {cv["code"]: cv["name"] for cv in f["domain"].get("codedValues", [])}
    dump(path, {"t": time.time(), "v": v})
    return v


def lima_dt(fecha_ms, hora):
    """FECHA de SERFOR es la medianoche de Lima del día; HORA está en hora de Lima."""
    if not fecha_ms:
        return None
    d = datetime.fromtimestamp(fecha_ms / 1000, timezone.utc).astimezone(LIMA)
    try:
        hh, mm = (int(x) for x in str(hora or "0:0").split(":")[:2])
    except ValueError:
        hh, mm = 0, 0
    return d.replace(hour=hh, minute=mm, second=0, microsecond=0)


def update_serfor():
    """Reportes de incendio forestal de la Unidad de Monitoreo Satelital de SERFOR (últimos 14 días),
    agrupados por código de reporte, y los focos de calor de 24 h clasificados por cobertura."""
    reps, focos = [], None
    desde = (NOW.astimezone(LIMA) - timedelta(days=SERFOR_DIAS)).strftime("%Y-%m-%d")
    try:
        with timed("SERFOR incendios forestales"):
            cat = serfor_dominio(1, "CATEG")
            feats = arcgis_query(1, {"where": f"FECHA >= DATE '{desde}'", "returnGeometry": "false",
                                     "outFields": "CODREP,ESTADO,TIPCOB,CATEG,NOMCATEG,NOMDEP,NOMPRO,NOMDIS,FECHA,HORA,SENSAT,LATITUD,LONGITUD,last_edited_date",
                                     "orderByFields": "OBJECTID"})
        groups = {}
        for f in feats:
            a = f["attributes"]
            cod = (a.get("CODREP") or "").strip()
            if not cod or a.get("LATITUD") is None:
                continue
            groups.setdefault(cod, []).append(a)
        for cod, pts in groups.items():
            def mc(k):
                vals = [str(p.get(k) or "").strip() for p in pts if str(p.get(k) or "").strip()]
                return max(set(vals), key=vals.count) if vals else ""
            last = max(pts, key=lambda p: (p.get("last_edited_date") or 0, p.get("ESTADO") or 0))
            est_n = last.get("ESTADO") or 1
            tiempos = [t for t in (lima_dt(p.get("FECHA"), p.get("HORA")) for p in pts) if t]
            cats = [p for p in pts if p.get("CATEG") in cat and isinstance(p.get("CATEG"), int) and p["CATEG"] <= 15]
            area = None
            if cats:
                c0 = max(cats, key=lambda p: [q.get("CATEG") for q in cats].count(p.get("CATEG")))
                area = f"{cat.get(c0['CATEG'])}" + (f": {str(c0.get('NOMCATEG') or '').strip().title()}" if str(c0.get("NOMCATEG") or "").strip() else "")
            reps.append({
                "codigo": cod, "estado_n": est_n, "estado": SERFOR_EST.get(est_n, "sin_dato"), "estado_w": SERFOR_EST_W.get(est_n, "?"),
                "lat": round(sum(p["LATITUD"] for p in pts) / len(pts), 4), "lon": round(sum(p["LONGITUD"] for p in pts) / len(pts), 4),
                "departamento": norm(mc("NOMDEP")), "provincia": norm(mc("NOMPRO")), "distrito": norm(mc("NOMDIS")),
                "lugar": mc("NOMCATEG").title() or None, "area": area,
                "puntos": len(pts), "cobertura": mc("TIPCOB") or None,
                "sensores": sorted({str(p.get("SENSAT") or "").strip() for p in pts} - {""}),
                "primera": min(tiempos).isoformat() if tiempos else None, "ultima": max(tiempos).isoformat() if tiempos else None,
            })
        reps.sort(key=lambda r: r["ultima"] or "", reverse=True)
        cnt = {}
        for r in reps:
            cnt[r["estado_w"]] = cnt.get(r["estado_w"], 0) + 1
        STATUS["SERFOR incendios forestales"] = {"ok": True, "detalle": f"{len(reps)} reportes en {SERFOR_DIAS} días (" + ", ".join(f"{v} {k.lower()}s" for k, v in sorted(cnt.items())) + ") · GEOSERFOR"}
        dump(os.path.join(CACHE, "serfor_reportes.json"), reps)
    except Exception as e:
        STATUS["SERFOR incendios forestales"] = {"ok": False, "detalle": str(e)[:200]}
        log("SERFOR incendios error", e)
        reps = load(os.path.join(CACHE, "serfor_reportes.json"), [])
    try:
        with timed("SERFOR focos por cobertura"):
            stats = json.dumps([{"statisticType": "count", "onStatisticField": "OBJECTID", "outStatisticFieldName": "n"}])
            feats = arcgis_query(0, {"where": "1=1", "outStatistics": stats, "groupByFieldsForStatistics": "NOMDEP,TIPCOB"})
        por = {}
        for f in feats:
            a = f["attributes"]
            k = "agricola" if "agr" in norm(a.get("TIPCOB") or "").lower() else "forestal"
            dep = norm(a.get("NOMDEP") or "")
            por.setdefault(dep, {"forestal": 0, "agricola": 0})[k] += int(a.get("n") or 0)
        focos = {"forestal": sum(v["forestal"] for v in por.values()), "agricola": sum(v["agricola"] for v in por.values()),
                 "por_region": por, "fuente": SERFOR_VISOR, "consultado": NOW.isoformat()}
        STATUS["SERFOR focos por cobertura"] = {"ok": True, "detalle": f"{focos['forestal']} focos en cobertura forestal y {focos['agricola']} en agrícola (últimas 24 h)"}
    except Exception as e:
        STATUS["SERFOR focos por cobertura"] = {"ok": False, "detalle": str(e)[:200]}
        log("SERFOR focos error", e)
    return reps, focos


# ----------------------------------------------------------------- 3c. Notas oficiales (gob.pe)
OFICIALES = [("indeci", "INDECI", None), ("serfor", "SERFOR", None), ("senamhi", "SENAMHI", None), ("minam", "MINAM", None),
             ("regioncusco", "Gobierno Regional de Cusco", "CUSCO"), ("regionapurimac", "Gobierno Regional de Apurímac", "APURIMAC"),
             ("regionayacucho", "Gobierno Regional de Ayacucho", "AYACUCHO"), ("regionpuno", "Gobierno Regional de Puno", "PUNO"),
             ("regionjunin", "Gobierno Regional de Junín", "JUNIN"), ("regionhuancavelica", "Gobierno Regional de Huancavelica", "HUANCAVELICA"),
             ("regionpasco", "Gobierno Regional de Pasco", "PASCO"), ("regionancash", "Gobierno Regional de Áncash", "ANCASH")]
_FUEGO_RE = re.compile(r"incendi|\bfuego|\bquemas?\b|focos? de calor|\bhumo\b", re.I)
_FORESTAL_RE = re.compile(r"forestal|\bquemas?\b|focos? de calor|pastizal|cobertura (vegetal|natural)|\bbosques?\b|\bmontes?\b|hect[aá]reas?|brigad|serfor|\bcerros?\b|santuario|parque nacional|reserva", re.I)


class _OficialRe:
    """Tema = fuego + algo forestal/rural (deja fuera incendios urbanos: locales, viviendas, fábricas)."""
    @staticmethod
    def search(t):
        return _FUEGO_RE.search(t or "") and _FORESTAL_RE.search(t or "")


OFICIAL_RE = _OficialRe()
OFICIAL_CADA_MIN = 19   # cada institución se consulta como máximo cada ~20 minutos


def parse_gobpe(page, slug, inst, dep_inst):
    items = []
    idx = [m.start() for m in re.finditer(r"card__mock", page)]
    for a, b in zip(idx, idx[1:] + [len(page)]):
        ch = page[a:b]
        t = re.search(r'data-ga-label="([^"]+)"', ch)
        h = re.search(r'href="(/institucion/[^"]+/noticias/\d+[^"]*)"', ch)
        d = re.search(r'datetime="([^"]+)"', ch)
        ds = re.search(r'class="z-10 relative">(.*?)</div>', ch, re.S)
        if not (t and h):
            continue
        titulo = html.unescape(t.group(1)).strip()
        resumen = html.unescape(re.sub(r"<[^>]+>", " ", ds.group(1))).strip() if ds else ""
        if not OFICIAL_RE.search(titulo + " " + resumen):
            continue
        try:
            fecha = datetime.strptime(d.group(1)[:16], "%Y-%m-%d %H:%M").replace(tzinfo=LIMA).astimezone(timezone.utc).isoformat() if d else None
        except ValueError:
            fecha = None
        items.append({"titulo": titulo, "resumen": re.sub(r"\s+", " ", resumen)[:280], "url": "https://www.gob.pe" + h.group(1),
                      "fecha": fecha, "institucion": inst, "slug": slug, "region": dep_inst or dep_de_texto(titulo + " " + resumen)})
    return items


def update_oficial():
    cache = load(os.path.join(CACHE, "oficial.json"), {})
    nuevas_consultas, fallos = 0, []
    with timed("Notas oficiales (gob.pe)"):
        for slug, inst, dep in OFICIALES:
            c = cache.get(slug) or {}
            if time.time() - c.get("t", 0) < OFICIAL_CADA_MIN * 60:
                continue
            try:
                page = get(f"https://www.gob.pe/institucion/{slug}/noticias", timeout=40, tries=2)
                cache[slug] = {"t": time.time(), "items": parse_gobpe(page, slug, inst, dep), "ok": True}
                nuevas_consultas += 1
            except Exception as e:
                cache[slug] = {"t": c.get("t", 0), "items": c.get("items", []), "ok": False, "error": str(e)[:120]}
                fallos.append(inst)
                log("gob.pe error", slug, e)
    dump(os.path.join(CACHE, "oficial.json"), cache)
    items, seen = [], set()
    cutoff = (NOW - timedelta(days=10)).isoformat()
    for slug, inst, dep in OFICIALES:
        for it in (cache.get(slug) or {}).get("items", []):
            if it["url"] in seen or (it.get("fecha") or "") < cutoff:
                continue
            seen.add(it["url"])
            items.append(it)
    items.sort(key=lambda x: x.get("fecha") or "", reverse=True)
    ok_n = sum(1 for s, _, _ in OFICIALES if (cache.get(s) or {}).get("ok"))
    STATUS["Notas oficiales (gob.pe)"] = {"ok": ok_n >= len(OFICIALES) // 2,
                                          "detalle": f"{len(items)} notas sobre incendios de {ok_n}/{len(OFICIALES)} instituciones (INDECI, SERFOR, SENAMHI, MINAM y 8 gobiernos regionales)"
                                          + (f" · fallaron: {', '.join(fallos)}" if fallos else "") + f" · {nuevas_consultas} consultadas en esta corrida"}
    dump(out("oficial.json"), {"generado": NOW.isoformat(), "instituciones": [{"slug": s, "nombre": n, "region": d, "url": f"https://www.gob.pe/institucion/{s}/noticias"} for s, n, d in OFICIALES],
                               "items": items[:80]}, pretty=True)
    return items


# ----------------------------------------------------------------- 3d. Clima cerca de cada incendio (Open-Meteo)
CLIMA_CADA_MIN = 29
DIRS = ["N", "NE", "E", "SE", "S", "SO", "O", "NO"]


def update_clima(incs):
    """Temperatura, humedad, viento y días sin lluvia en los incendios activos (una consulta para todos)."""
    burning = [i for i in incs if i["estado"] in ("activo", "en_control", "alerta")]
    keys = sorted({(round(i["lat"], 1), round(i["lon"], 1)) for i in burning})[:80]
    cache = load(os.path.join(CACHE, "clima.json"), {"t": 0, "v": {}})
    falta = [k for k in keys if f"{k[0]},{k[1]}" not in cache["v"]]
    if keys and (time.time() - cache.get("t", 0) >= CLIMA_CADA_MIN * 60 or falta):
        try:
            with timed("Open-Meteo (clima)"):
                q = {"latitude": ",".join(str(k[0]) for k in keys), "longitude": ",".join(str(k[1]) for k in keys),
                     "current": "temperature_2m,relative_humidity_2m,wind_speed_10m,wind_gusts_10m,wind_direction_10m,precipitation",
                     "daily": "precipitation_sum", "past_days": 14, "forecast_days": 1, "timezone": "America/Lima"}
                d = json.loads(get("https://api.open-meteo.com/v1/forecast?" + urllib.parse.urlencode(q), timeout=60))
            d = d if isinstance(d, list) else [d]
            v = {}
            for k, r in zip(keys, d):
                cu = r.get("current") or {}
                pr = (r.get("daily") or {}).get("precipitation_sum") or []
                seco = 0
                for x in reversed(pr):
                    if x is None or x >= 1:
                        break
                    seco += 1
                wd = cu.get("wind_direction_10m")
                v[f"{k[0]},{k[1]}"] = {"temp": cu.get("temperature_2m"), "humedad": cu.get("relative_humidity_2m"),
                                        "viento": cu.get("wind_speed_10m"), "rafagas": cu.get("wind_gusts_10m"),
                                        "viene_del": DIRS[int(((wd + 22.5) % 360) // 45)] if wd is not None else None,
                                        "dias_sin_lluvia": seco, "hora": cu.get("time")}
            cache = {"t": time.time(), "v": v}
            dump(os.path.join(CACHE, "clima.json"), cache)
            STATUS["Open-Meteo (clima)"] = {"ok": True, "detalle": f"humedad, viento y lluvia en {len(v)} puntos con fuego"}
        except Exception as e:
            STATUS["Open-Meteo (clima)"] = {"ok": False, "detalle": str(e)[:200]}
            log("open-meteo error", e)
    elif keys:
        STATUS["Open-Meteo (clima)"] = {"ok": True, "detalle": f"en caché, de hace {int((time.time() - cache.get('t', 0)) / 60)} min · {len(cache['v'])} puntos"}
    for i in burning:
        c = cache["v"].get(f"{round(i['lat'], 1)},{round(i['lon'], 1)}")
        if c:
            i["clima"] = c


# ----------------------------------------------------------------- 4. Fusión
def serfor_estado(r):
    """Estado efectivo de un reporte: «Confirmado» sin detecciones en 48 h ni estado posterior no se muestra como fuego activo."""
    est = r["estado"]
    texto = f"SERFOR (reporte {r['codigo']}): «{r['estado_w']}». Información de su Unidad de Monitoreo Satelital."
    if est == "activo" and r.get("ultima") and NOW - datetime.fromisoformat(r["ultima"]) > timedelta(hours=48):
        est = "sin_dato"
        texto += " La última detección satelital fue hace más de 48 horas y no figura como controlado ni extinguido."
    return est, texto


def merge_serfor(incs, reps):
    """Asocia cada reporte de SERFOR a un incidente (mismo distrito o a ≤ 10 km) o crea uno nuevo."""
    for r in reps:
        est, texto = serfor_estado(r)
        fuente = {"medio": "SERFOR – monitoreo satelital", "titulo": f"Reporte {r['codigo']}: {r['estado_w'].lower()}",
                  "url": SERFOR_VISOR, "fecha": (r.get("ultima") or "")[:10]}
        cands = [i for i in incs if i.get("origen") != "satelite" and
                 ((i["departamento"] == r["departamento"] and norm(i.get("distrito")) == r["distrito"]) or km(i["lat"], i["lon"], r["lat"], r["lon"]) <= 10)]
        if cands:
            inc = min(cands, key=lambda i: km(i["lat"], i["lon"], r["lat"], r["lon"]))
            inc.setdefault("serfor", []).append(r)
            if not any(f.get("medio", "").startswith("SERFOR") for f in inc["fuentes"]):
                inc["fuentes"].append(fuente)
            if inc["estado"] == "sin_dato" and est not in ("alerta", "sin_dato"):
                inc["estado"] = est
                inc["estado_texto"] = texto
                inc["fecha_estado"] = r.get("ultima") or inc.get("fecha_estado")
                inc["estado_origen"] = "SERFOR"
            continue
        inc = {
            "id": "serfor-" + r["codigo"],
            "nombre": f"{r['distrito'].title()} ({r['departamento'].title()})" + (f" – {r['lugar']}" if r.get("lugar") and norm(r["lugar"]) != r["distrito"] else ""),
            "departamento": r["departamento"], "provincia": r["provincia"], "distrito": r["distrito"],
            "estado": est, "estado_texto": texto, "estado_origen": "SERFOR",
            "hectareas": None, "fallecidos": None, "heridos": None,
            "inicio": r.get("primera"), "fecha_estado": r.get("ultima") or NOW.isoformat(),
            "lat": r["lat"], "lon": r["lon"], "precision": "promedio de las detecciones de SERFOR",
            "origen": "serfor", "fuentes": [fuente], "serfor": [r],
        }
        incs.append(inc)


def build_incidents(firms, indeci, serfor=()):
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
    merge_serfor(incs, serfor)
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


# ----------------------------------------------------------------- 5. Novedades (feed)
def ha_corta(s):
    m = re.search(r"\d+(?:[.,]\d+)?", str(s or "").replace(" ", ""))
    if not m:
        return s
    gt = "más de " if str(s).strip().startswith(">") else ""
    n = m.group(0).replace(",", ".")
    try:
        n = f"{float(n):,.0f}".replace(",", " ") if float(n) >= 1000 else n
    except ValueError:
        pass
    return f"{gt}{n} ha"


def src_url(i):
    for f in i.get("fuentes") or []:
        if f.get("url"):
            return f["url"]
    return None


def nombre_corto(i):
    m = re.match(r"^(.+?) \((.+?)\) – (.+)$", str(i.get("nombre", "")))
    if m and m.group(1).lower() == m.group(3).lower():
        return f"{m.group(1)} ({m.group(2)})"
    return i.get("nombre", "")


def build_novedades(prev_inc, incs, clusters, prev_news, news, prev_oficial=None, oficial=()):
    """Eventos nuevos entre la corrida anterior y esta. Cada uno lleva tipo, texto, región, nivel y enlace."""
    ev = []

    def add(tipo, texto, region=None, inc=None, url=None, nivel="medio", t=None, medio=None):
        ev.append({"t": t or NOW.isoformat(), "tipo": tipo, "texto": texto, "region": region, "inc": inc,
                   "url": url, "nivel": nivel, "medio": medio})

    if prev_inc is None:
        # primera corrida: no hay con qué comparar; se siembran solo las últimas noticias
        for n in news[:10]:
            add("noticia", n["titulo"], url=n.get("url"), nivel="bajo", t=n.get("fecha"), medio=n.get("medio"))
        add("sistema", "Empieza el monitoreo automático: datos cada 10 minutos.", nivel="bajo")
        return ev
    pi = {i["id"]: i for i in prev_inc.get("incidentes", [])}
    pk = {(i["departamento"], i.get("distrito")): i for i in prev_inc.get("incidentes", [])}
    # SERFOR: la primera vez que entra no se anuncia reporte por reporte
    prev_cod = {r["codigo"]: r for i in prev_inc.get("incidentes", []) for r in i.get("serfor") or []}
    serfor_nuevo = not prev_cod and any(i.get("serfor") for i in incs)
    if serfor_nuevo:
        n_rep = sum(len(i.get("serfor") or []) for i in incs)
        add("sistema", f"Ahora también seguimos los reportes de incendio de SERFOR: {n_rep} en los últimos {SERFOR_DIAS} días, con su estado oficial.", nivel="bajo", url=SERFOR_VISOR)
    for i in incs:
        p = pi.get(i["id"]) or pk.get((i["departamento"], i.get("distrito")))
        nom, reg, est = nombre_corto(i), i["departamento"], i.get("estado", "sin_dato")
        if not p:
            if i.get("origen") == "serfor":
                if serfor_nuevo:
                    continue
                txt = (f"SERFOR emitió una alerta de incendio en {nom} (por confirmar)" if est == "alerta"
                       else f"SERFOR reporta un incendio en {nom} · {EST_W.get(est, est)}")
                add("serfor", txt, reg, i["id"], SERFOR_VISOR, "alto" if est in ("activo", "en_control") else "medio")
            else:
                add("nuevo", f"Nuevo incendio reportado: {nom} · {EST_W.get(est, est)}", reg, i["id"], src_url(i),
                    "alto" if est in ("activo", "en_control") else "medio")
            continue
        if not serfor_nuevo:
            for r in i.get("serfor") or []:
                q = prev_cod.get(r["codigo"])
                if q is None and i.get("origen") != "serfor":
                    add("serfor", f"SERFOR registró el reporte {r['codigo']} en {nom}: {r['estado_w'].lower()}", reg, i["id"], SERFOR_VISOR, "medio")
                elif q is not None and q.get("estado_n") != r.get("estado_n"):
                    worse = (q.get("estado_n") == 1 and r.get("estado_n") == 2) or (r.get("estado_n") or 0) < (q.get("estado_n") or 0)
                    add("serfor", f"SERFOR: {nom} pasó de «{q.get('estado_w')}» a «{r['estado_w']}» (reporte {r['codigo']})", reg, i["id"], SERFOR_VISOR,
                        "alto" if worse else "bajo")
        pe = p.get("estado", "sin_dato")
        primera_lectura = pe == "sin_dato" and est != "sin_dato"
        if pe != est:
            worse = EST_RANK.get(est, 2) > EST_RANK.get(pe, 2)
            if primera_lectura:
                add("estado", f"Ya se leyó el reporte de INDECI: {nom} está «{EST_W.get(est, est)}»", reg, i["id"], src_url(i),
                    "alto" if est in ("activo", "en_control") else "bajo")
            else:
                add("estado", f"{nom}: pasó de «{EST_W.get(pe, pe)}» a «{EST_W.get(est, est)}»", reg, i["id"], src_url(i),
                    "alto" if worse else "bajo")
        prev_urls = {f.get("url") for f in p.get("fuentes") or []}
        nuevos = [f for f in i.get("fuentes") or [] if f.get("url") not in prev_urls and str(f.get("medio", "")).startswith("INDECI") and "(PDF)" not in f.get("medio", "")]
        for f in nuevos[:1]:
            add("reporte", f"INDECI publicó un nuevo reporte sobre {nom}", reg, i["id"], f.get("url"), "medio")
        if (i.get("fallecidos") or 0) > (p.get("fallecidos") or 0):
            add("victimas", f"{nom}: se reportan {i['fallecidos']} personas fallecidas", reg, i["id"], src_url(i), "alto")
        if i.get("hectareas") and i.get("hectareas") != p.get("hectareas") and not (primera_lectura and not p.get("hectareas")):
            add("dato", f"{nom}: ahora se reportan {ha_corta(i['hectareas'])} afectadas", reg, i["id"], src_url(i), "bajo")
    prev_inf = prev_inc.get("inferidos") or []
    for c in clusters:
        if c["focos_24h"] < 5:
            continue
        if any(km(c["lat"], c["lon"], q["lat"], q["lon"]) <= 6 for q in prev_inf):
            continue
        add("satelite", f"Los satélites ven una nueva agrupación de calor en {reg_name(c['departamento'])} ({c['focos_24h']} puntos en 24 h), sin confirmar",
            c["departamento"], c["id"], f"https://firms.modaps.eosdis.nasa.gov/map/#d:24hrs;@{c['lon']:.3f},{c['lat']:.3f},10z", "medio")
    seen = {norm(n.get("titulo", ""))[:80] for n in (prev_news or [])}
    nuevas = [n for n in news if norm(n.get("titulo", ""))[:80] not in seen]
    for n in nuevas[:15]:
        add("noticia", n["titulo"], url=n.get("url"), nivel="bajo", t=n.get("fecha"), medio=n.get("medio"))
    # notas oficiales (gob.pe): la primera vez solo las de las últimas 48 h
    if prev_oficial is None:
        cand = [o for o in oficial if (o.get("fecha") or "") >= (NOW - timedelta(hours=48)).isoformat()][:6]
    else:
        cand = [o for o in oficial if o["url"] not in prev_oficial][:10]
    for o in cand:
        add("oficial", o["titulo"], o.get("region"), None, o["url"], "medio", t=o.get("fecha"), medio=o.get("institucion"))
    return ev


def write_novedades(nuevos):
    prev = load(out("novedades.json"), {"ultimo_n": 0, "items": []})
    n = int(prev.get("ultimo_n") or 0)
    items = list(prev.get("items") or [])
    # evita repetir el mismo evento (p. ej. jitter en la lectura de un PDF) dentro de 6 h
    cutoff6 = (NOW - timedelta(hours=6)).isoformat()
    recientes = {(e["tipo"], e["texto"]) for e in items if (e.get("t") or "") >= cutoff6 or e.get("tipo") == "noticia"}
    added = 0
    for e in nuevos:
        if (e["tipo"], e["texto"]) in recientes:
            continue
        n += 1
        e["n"] = n
        items.append(e)
        added += 1
    cutoff = (NOW - timedelta(days=7)).isoformat()
    items = [e for e in items if (e.get("t") or "") >= cutoff]
    items.sort(key=lambda e: (e.get("t") or "", e.get("n") or 0), reverse=True)
    items = items[:400]
    dump(out("novedades.json"), {"generado": NOW.isoformat(), "ultimo_n": n, "items": items}, pretty=True)
    return n, added


# ----------------------------------------------------------------- 6. Salud e historial
def write_health(ok_run, conteos):
    prev = load(out("health.json"), {})
    pf = prev.get("fuentes") or {}
    fuentes = {}
    for k, v in STATUS.items():
        q = pf.get(k) or {}
        fuentes[k] = {"ok": v["ok"], "detalle": v["detalle"], "duracion_s": TIMING.get(k),
                      "fallos_seguidos": 0 if v["ok"] else int(q.get("fallos_seguidos") or 0) + 1,
                      "ultima_ok": NOW.isoformat() if v["ok"] else q.get("ultima_ok")}
    dur = round(time.monotonic() - T0, 1)
    n_ok = sum(1 for v in STATUS.values() if v["ok"])
    corridas = list(prev.get("corridas") or [])[-143:]
    corridas.append({"t": NOW.isoformat(), "duracion_s": dur, "ok": ok_run, "fuentes_ok": n_ok, "fuentes_total": len(STATUS),
                     "focos_24h": conteos.get("focos_24h"), "activos": conteos.get("incidentes_activos")})
    health = {
        "generado": NOW.isoformat(), "ok": ok_run, "duracion_s": dur, "intervalo_min": INTERVALO_MIN, "version": VERSION,
        "fallos_seguidos": 0 if ok_run else int(prev.get("fallos_seguidos") or 0) + 1,
        "ultima_ok": NOW.isoformat() if ok_run else prev.get("ultima_ok"),
        "fuentes": fuentes, "corridas": corridas,
    }
    dump(out("health.json"), health, pretty=True)
    return health


def write_historial(conteos):
    h = load(out("historial.json"), {"campos": [], "puntos": []})
    pts = list(h.get("puntos") or [])
    pts.append([int(NOW.timestamp()), conteos["focos_24h"], conteos["incidentes_activos"], len(conteos["regiones_activas"]),
                conteos["agrupaciones_satelitales"], conteos["fallecidos_reportados"]])
    cutoff = int((NOW - timedelta(days=7)).timestamp())
    pts = [p for p in pts if p[0] >= cutoff]
    dump(out("historial.json"), {"generado": NOW.isoformat(), "intervalo_min": INTERVALO_MIN,
                                 "campos": ["t_unix", "focos_24h", "incidentes_activos", "regiones_activas", "inferidos", "fallecidos_reportados"],
                                 "puntos": pts})


def lock():
    """Evita dos corridas a la vez (POSIX). En Windows no hace nada."""
    try:
        import fcntl
    except ImportError:
        return None
    os.makedirs(OUT, exist_ok=True)
    f = open(os.path.join(OUT, ".update.lock"), "w")
    try:
        fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        log("ya hay una corrida en marcha; salgo")
        sys.exit(0)
    return f


# ----------------------------------------------------------------- main
def main():
    _lk = lock()
    os.makedirs(CACHE, exist_ok=True)
    log(f"inicio · versión {VERSION} · salida {OUT}")
    prev_inc = load(out("incidentes.json"), None)
    prev_news = (load(out("noticias.json"), {}) or {}).get("noticias")
    firms = update_firms()
    with timed("INDECI emergencias"):
        indeci = update_indeci()
    with timed("Google Noticias RSS"):
        news = update_news()
    prev_of = load(out("oficial.json"), None)
    prev_oficial = {o["url"] for o in prev_of.get("items", [])} if prev_of else None
    serfor, serfor_focos = update_serfor()
    oficial = update_oficial()
    incs, clusters, resumen = build_incidents(firms, indeci, serfor)
    update_clima(incs)
    now_ts = NOW.timestamp()
    f24 = [p for p in firms["puntos"] if now_ts - p[2] <= 86400]
    activos = [i for i in incs if i["estado"] in ("activo", "en_control")]
    conteos = {
        "focos_24h": len(f24),
        "focos_7d": len(firms["puntos"]),
        "incidentes": len(incs),
        "incidentes_activos": len(activos),
        "regiones_activas": sorted({i["departamento"] for i in activos}),
        "fallecidos_reportados": sum(i.get("fallecidos") or 0 for i in incs),
        "agrupaciones_satelitales": len(clusters),
        "incidentes_por_estado": {e: sum(1 for i in incs if i["estado"] == e) for e in ("activo", "en_control", "controlado", "extinguido", "sin_dato", "alerta")},
        "serfor_reportes": len(serfor),
        "serfor_por_estado": {w: sum(1 for r in serfor if r["estado_w"] == w) for w in SERFOR_EST_W.values()},
        "notas_oficiales": len(oficial),
    }
    firms_ok = any(v["ok"] for k, v in STATUS.items() if k.startswith("FIRMS"))
    indeci_ok = STATUS.get("INDECI emergencias", {}).get("ok", False)
    serfor_ok = STATUS.get("SERFOR incendios forestales", {}).get("ok", False)
    fresh = firms_ok or indeci_ok or serfor_ok
    ultimo_n, added = write_novedades(build_novedades(prev_inc, incs, clusters, prev_news, news, prev_oficial, oficial))
    if fresh:
        dump(out("incidentes.json"), {"generado": NOW.isoformat(), "incidentes": incs, "inferidos": clusters}, pretty=True)
        write_historial(conteos)
        meta = {
            "generado": NOW.isoformat(),
            "generado_lima": NOW.astimezone(LIMA).strftime("%d/%m/%Y %H:%M"),
            "intervalo_min": INTERVALO_MIN,
            "proxima_estimada": (NOW + timedelta(minutes=INTERVALO_MIN)).isoformat(),
            "duracion_s": round(time.monotonic() - T0, 1),
            "version": VERSION,
            "novedades_n": ultimo_n,
            "conteos": conteos,
            "resumen_oficial": resumen,
            "serfor_focos": serfor_focos,
            "fuentes": STATUS,
        }
        dump(out("meta.json"), meta, pretty=True)
    else:
        log("ninguna fuente respondió: meta.json se conserva para que se note el atraso")
    health = write_health(fresh, conteos)
    log(json.dumps({**conteos, "novedades_nuevas": added, "duracion_s": health["duracion_s"], "ok": fresh}, ensure_ascii=False))
    return 0 if fresh else 1


if __name__ == "__main__":
    sys.exit(main())
