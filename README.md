# 🔥 Incendios forestales en Perú – mapa en vivo

Mapa web **no oficial** que reúne en un solo lugar:

- **Focos de calor satelitales** de la NASA (FIRMS): VIIRS S-NPP, VIIRS NOAA-20, VIIRS NOAA-21 y MODIS (Terra/Aqua), de las últimas 6 h, 24 h, 48 h o 7 días.
- **Incidentes reportados** con su estado (activo/descontrolado, en control, controlado, extinguido o sin dato), hectáreas, víctimas y la fecha de la última actualización. Cada dato enlaza a su fuente (COEN-INDECI, COER, Agencia Andina, prensa).
- **Agrupaciones de focos inferidas por satélite**, siempre marcadas como *inferido por satélite* y nunca como confirmadas.
- **Últimas noticias** (Google Noticias) y contadores: focos, incidentes activos, regiones y fallecidos reportados.

**Interfaz 3D (three.js).** Muestra un Perú en relieve con sus regiones y nombres. Los incendios aparecen como columnas de fuego, y su altura crece con las hectáreas reportadas. Los puntos de calor satelitales forman una capa sutil. Arriba hay un titular en lenguaje simple ("Ahora hay N incendios activos en M regiones") y debajo una leyenda de 4 colores. También tiene un botón **Ver mi región**, la lista **Incendios más graves ahora** y tarjetas simples con lugar, estado, hectáreas, desde cuándo, qué hacer, teléfonos 116 y 115, y noticias. Los datos técnicos (FRP, sensor, confianza, todas las fuentes) están detrás de **Ver datos técnicos**. Si el dispositivo no tiene WebGL, se muestra la lista y un enlace al [mapa 2D clásico](mapa-2d.html) (Leaflet).

Se actualiza solo. GitHub Actions regenera los datos cada ~20 minutos y la página revisa cada 2 minutos si hay datos nuevos, sin que tengas que recargarla.

> ⚠️ **Aviso.** Esta herramienta es informativa y **no es una fuente oficial**. En una emergencia sigue las indicaciones de [INDECI / COEN](https://portal.indeci.gob.pe/emergencias/), del Cuerpo General de Bomberos Voluntarios del Perú y de tu gobierno local.
>
> **Teléfonos de emergencia** (verificados en [gob.pe](https://www.gob.pe/547-telefonos-de-emergencia) el 9 oct 2026): Bomberos **116** · Defensa Civil **115** · Policía **105** · SAMU **106** (en las regiones que cubre). Vuelve a verificarlos antes de difundirlos.

![Captura del mapa](screenshot.png)

## Fuentes de datos

| Capa | Fuente | Cómo se obtiene |
|---|---|---|
| Focos de calor | [NASA FIRMS](https://firms.modaps.eosdis.nasa.gov/) (VIIRS 375 m, MODIS 1 km, datos casi en tiempo real) | CSV públicos de Sudamérica de 7 días (sin clave) o la API de área si configuras `FIRMS_MAP_KEY`. Se filtran solo los puntos dentro de Perú usando los límites departamentales. |
| Incidentes oficiales | [COEN-INDECI – Emergencias](https://portal.indeci.gob.pe/emergencias/) | Se lee el listado de reportes "INCENDIO FORESTAL EN EL DISTRITO DE …" y se abre el PDF del último reporte de cada distrito. Del PDF se extraen la frase de estado ("El incendio se encuentra ACTIVO/CONTROLADO/EXTINGUIDO"), la hora de actualización, la ubicación, las hectáreas de cobertura natural y las víctimas. |
| Incidentes curados | `data/incidentes_curados.json` | Están cargados a mano con cita textual y enlace: COEN-INDECI, COER Cusco, Agencia Andina, RPP, La República, Canal N, EFE/Forbes Perú, etc. Si INDECI publica un reporte **más reciente** para el mismo distrito, se usa su estado y se indica el origen. |
| Noticias | Google Noticias RSS (`incendio forestal Perú`, regiones afectadas) | Titulares de los últimos 3 días, con enlace. |
| Mapas base | OpenStreetMap, Esri (relieve y satélite), [NASA GIBS](https://www.earthdata.nasa.gov/engage/open-data-services-software/earthdata-developer-portal/gibs-api) (VIIRS/MODIS en color verdadero y aerosoles/humo del día anterior) | Teselas públicas |
| Límites y centroides | [juaneladio/peru-geojson](https://github.com/juaneladio/peru-geojson) (departamentos y distritos, INEI) | `data/ref/` |

### Reglas para no inventar datos

- Todo estado y toda cifra de un incidente proviene de una fuente citada en su ventana emergente. Si no hay dato, se muestra **"sin dato"**.
- Los estados que se leen automáticamente de los PDF de INDECI se marcan como *leído automáticamente* e incluyen la frase original entre comillas.
- **"Actividad satelital reciente"** significa que hubo al menos un foco FIRMS en las últimas 24 h a ≤ 15 km del punto del incidente. Es un indicio, no una confirmación de que el fuego siga activo.
- Las agrupaciones de 3 o más focos en 24 h que estén a más de 20 km de cualquier incidente conocido se muestran como **"inferido por satélite"**. Pueden ser quemas agrícolas.
- La ubicación de los incidentes es el **centroide del distrito**, salvo que se indique otra cosa. No es el frente de fuego.

## Frecuencia de actualización

- **Servidor:** el workflow `.github/workflows/actualizar.yml` corre cada 20 minutos (cron `*/20 * * * *`). GitHub puede retrasar las ejecuciones programadas en horas de alta demanda. También corre con cada push a `main` y a mano desde *Actions → Run workflow*.
- **Satélites:** FIRMS publica cada pasada unas 3 h después de la observación, como máximo. Cada satélite VIIRS/MODIS pasa sobre Perú unas 2 veces al día.
- **Navegador:** la página consulta `data/meta.json` cada 2 minutos y cuando vuelves a la pestaña. Si hay datos nuevos, redibuja el mapa sin recargar.

## Estructura

```
index.html               página principal: mapa 3D (three.js r170, incluido en assets/vendor, sin compilación)
assets/app3d.js          escena 3D, tarjetas, lista por gravedad, región y actualización automática
assets/style.css         estilos (primero para celulares)
mapa-2d.html             mapa 2D clásico (Leaflet), también sirve de respaldo sin WebGL
assets/app-2d.js, assets/style-2d.css
scripts/update.py        actualizador (Python estándar + pdftotext)
data/incidentes_curados.json   incidentes cargados a mano, con fuentes
data/firms.json          focos satelitales en Perú (7 días)      ← generado
data/indeci.json         últimos reportes COEN de incendio forestal ← generado
data/incidentes.json     incidentes fusionados + inferidos        ← generado
data/noticias.json       titulares                                ← generado
data/meta.json           conteos, hora de generación, estado de fuentes ← generado
data/ref/                límites departamentales y centroides distritales
```

## Correrlo localmente

```bash
sudo apt-get install poppler-utils   # pdftotext
python3 scripts/update.py            # descarga y genera data/*.json (~1–3 min)
python3 -m http.server 8000          # abre http://localhost:8000
```

## Agregar una clave de NASA FIRMS (opcional)

Sin clave se usan los CSV públicos de 7 días, que bastan. Con clave se consulta la API por área (solo el rectángulo de Perú):

1. Pide una MAP_KEY gratuita en <https://firms.modaps.eosdis.nasa.gov/api/map_key/>.
2. En GitHub ve a **Settings → Secrets and variables → Actions → New repository secret**, con nombre `FIRMS_MAP_KEY`.
3. Localmente: `FIRMS_MAP_KEY=tu_clave python3 scripts/update.py`.

Si la API falla, el script vuelve solo a los CSV públicos.

## Desplegar

**GitHub Pages (recomendado).** Ve a *Settings → Pages → Source: GitHub Actions*. El mismo workflow actualiza los datos y publica el sitio, y los datos que genera en cada ejecución **no** se suben al repositorio, para que no crezca con cada actualización (el repositorio solo trae una instantánea inicial del 9 de octubre de 2026). Entre ejecuciones se conservan con `actions/cache`.

**Otro hosting estático** (Vercel, Netlify, Cloudflare Pages): sirve la carpeta raíz tal cual y programa `python3 scripts/update.py` en un cron que vuelva a publicar.

## Agregar o corregir un incidente

Edita `data/incidentes_curados.json`. Los estados válidos son `activo`, `en_control`, `controlado`, `extinguido` y `sin_dato`. Usa `null` cuando no haya dato y agrega siempre al menos una fuente con `url`. Los nombres de departamento, provincia y distrito van en mayúsculas y sin tildes, como en `data/ref/distritos.json`.

## Limitaciones

- El mapa 3D usa los límites departamentales simplificados, sin relieve real del terreno. Para ver imágenes satelitales y relieve usa el mapa 2D.
- Para que vaya fluido en celulares se dibujan como máximo 6 000 puntos de calor, los más recientes.

- Los focos FIRMS tienen una resolución de 375 m a 1 km. Las nubes, el humo denso o la hora de la pasada pueden ocultar un incendio, y algunas quemas agrícolas o fuentes industriales aparecen como focos.
- La lectura automática de los PDF de INDECI depende de su formato. Si cambia, el estado queda en "sin dato", con el enlace al reporte.
- Las cifras de hectáreas y víctimas cambian entre fuentes y entre un reporte y otro. Por eso se muestran con su fuente y fecha, y nunca se suman fuentes distintas.
- Google Noticias puede cambiar o limitar su RSS.

## Licencia

Código bajo licencia MIT. Los datos pertenecen a sus respectivas fuentes: NASA FIRMS/GIBS (dominio público), INDECI (Estado peruano) y los medios citados.
