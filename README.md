# sicoes-descargas

Descarga masiva de documentos (DBC, especificaciones técnicas, TDR, planos, convocatorias,
enmiendas, formularios de identificado, etc.) de las **convocatorias del SICOES** (Bolivia),
a partir de la pestaña *Contrataciones → Convocatorias*.

Es el **paso 1** del proyecto: obtener los archivos crudos. La extracción estructurada
(texto + tablas del DBC) y el almacén analítico vienen en pasos posteriores.

---

## 1. Requisitos

- **Node.js 18 o superior** — comprobá con `node -v`.
  Si no lo tenés: https://nodejs.org (instalá la versión LTS).
- Conexión a internet (el script maneja un navegador Chromium headless).
- ~300 MB libres para el navegador de Playwright (se descarga una sola vez).

---

## 2. Instalación (una sola vez)

Abrí una terminal en la carpeta del proyecto:

```bash
cd C:\Users\oalco\sicoes-descargas
```

Instalá dependencias y el navegador:

```bash
npm install
```

> `npm install` ejecuta automáticamente `playwright install chromium`.
> Si esa parte falla (proxy, permisos), corré aparte:
> ```bash
> npx playwright install chromium
> ```

Extracción de texto opcional (`--extract`):

```bash
npm install mammoth pdf-parse
```

Verificá que todo está bien:

```bash
node descargar.mjs --help
```

---

## 3. Uso

Forma general:

```bash
node descargar.mjs [opciones]
```

### Ejemplos

**Un CUCE puntual, todos sus adjuntos** (bueno para probar):

```bash
node descargar.mjs --cuce 26-0046-26-1681319-2-1
```

**20 DBC de convocatorias ANPP vigentes**, en su propia carpeta:

```bash
node descargar.mjs --modalidad ANPP --solo-dbc --limit 20 --out ./anpp
```

**Solo el "Documento Base de Contratacion"** de Bienes y Obras publicados en un rango de fechas:

```bash
node descargar.mjs --tipo B,O --archivos "Documento Base" --desde 01/08/2026 --hasta 29/08/2026
```

**Ver qué traería, sin descargar nada:**

```bash
node descargar.mjs --modalidad ANPE --solo-dbc --limit 50 --dry-run
```

**Con extracción de texto** a `.txt` junto a cada archivo:

```bash
node descargar.mjs --cuce 26-1261-00-1684521-1-1 --extract
```

**Mostrando el navegador** (si el captcha empieza a fallar):

```bash
node descargar.mjs --modalidad ANPP --solo-dbc --limit 10 --headful --delay 8000
```

---

## 4. Opciones

| Opción | Descripción | Por defecto |
|---|---|---|
| `--estado <vigentes\|todos>` | `todos` incluye históricos (más lento, muchísimos registros) | `vigentes` |
| `--tipo <B,O,S,C>` | Bienes / Obras / Servicios Generales / Consultoría (filtro del servidor) | los 4 |
| `--modalidad <ANPE,ANPP,...>` | Filtra por modalidad **después** de traer el listado (`CM`, `ANPE`, `ANPP`, `LP`, …) | — |
| `--entidad "<texto>"` | Búsqueda por nombre de entidad (filtro del servidor) | — |
| `--objeto "<texto>"` | Búsqueda por objeto de contratación (filtro del servidor) | — |
| `--desde` / `--hasta <dd/mm/aaaa>` | Rango de fecha de publicación SICOES (filtro del servidor) | — |
| `--cuce <CUCE completo>` | Una sola convocatoria | — |
| `--solo-dbc` | Solo DBC / Especificaciones / TDR / Pliego / Convocatoria / Enmienda | off |
| `--archivos "<a,b>"` | Solo adjuntos cuya etiqueta contenga alguno de esos textos | — |
| `--limit <n>` | Máx. de convocatorias a procesar | sin tope |
| `--dry-run` | No descarga; solo lista | off |
| `--out <carpeta>` | Carpeta de salida | `./descargas` |
| `--delay <ms>` | Pausa entre descargas | `4000` |
| `--timeout <ms>` | Timeout por descarga | `90000` |
| `--extract` | Extrae texto a `.txt` (necesita `mammoth` y `pdf-parse`) | off |
| `--headful` | Muestra el navegador | off (headless) |
| `--force` | Re-descarga aunque figure en el manifiesto | off |
| `--help` | Ayuda | — |

---

## 5. Qué genera

Dentro de la carpeta de salida (`--out`):

| Archivo | Contenido |
|---|---|
| `<CUCE>__<Etiqueta>.<ext>` | Los documentos descargados. Ej.: `26-0046-26-1681319-2-1__Documento-Base-de-Contratacion.docx` |
| `<CUCE>__<Etiqueta>.txt` | Solo con `--extract`: texto plano del documento |
| `_listado.json` | Listado normalizado de convocatorias (CUCE, entidad, modalidad, tipo, objeto, fechas, `ficha_url`, adjuntos). **Este archivo alimenta la fase de base de datos.** |
| `_manifest.json` | Registro de cada archivo bajado (nombre, bytes, `sha256`, origen). Permite **reanudar**: si cortás y volvés a correr, salta lo ya descargado. |
| `_errores.json` | Errores por archivo (CUCE, etiqueta, id, mensaje). |
| `.perfil-navegador/` | Perfil de Chromium persistente (cookies de sesión). No lo borres entre corridas seguidas; para empezar 100% limpio, elimínalo. |

Para empezar de cero, borrá `_manifest.json` (o usá `--force`).

---

## 6. Cómo funciona (resumen técnico)

1. **Sesión + token** — abre `portal/index.php`, entra a *Convocatorias* vía `irLink(...)`;
   de ahí lee el `token` (input oculto) y el mapa de columnas `#colsConvocatoriasSimple`
   (las claves del JSON del listado están ofuscadas y **cambian en cada carga**).
2. **Listado** — `POST /portal/contrataciones/operacion.php` (DataTables). El servidor
   **siempre devuelve 10 filas**, así que el script itera `start = 0, 10, 20, …` hasta
   completar `recordsTotal`.
3. **Adjuntos** — de la columna *Archivos* extrae `descargarArchivo('<id_cifrado>::<hash>')`.
   El `id` es opaco: se usa tal cual.
4. **Descarga** — inyecta un enlace temporal y lo clickea (gesto real de usuario). El
   sitio resuelve un **Cloudflare Turnstile invisible** y envía el `POST` a
   `descargarArchivo.php`, que responde el archivo (`.docx` / `.pdf`). El script captura
   el evento `download` y lo guarda.
5. **Reintentos** — 3 por archivo, con recarga de página; si la sesión parece expirada,
   re-bootstrapea el token.

---

## 7. Problemas frecuentes

| Síntoma | Causa probable | Solución |
|---|---|---|
| `node: command not found` | Node no instalado o no en PATH | Instalá Node LTS y reabrí la terminal |
| Falla `playwright install` | Proxy / antivirus / permisos | `npx playwright install chromium` a mano; reintentar |
| Muchos `✗ ... turnstile=[... error-callback ["600010"]]` | Cloudflare detecta automatización | Ya mitigado (flag `--disable-blink-features=AutomationControlled` + perfil persistente). Si reaparece: subí `--delay`, bajá `--limit`, esperá un rato |
| `✗ ... sin descarga en 75s` esporádico | El reto tardó de más esa vez | Se reintenta solo; el manifiesto reanuda. Subí `--timeout 120000` si es frecuente |
| `respuesta HTML (posible sesión/captcha)` | Token caducado a mitad de corrida | Volvé a correr: el manifiesto reanuda donde quedó |
| El `.docx` "se ve raro" en Word | Los DBC traen tablas con celdas combinadas | Es normal; el texto está. La extracción limpia llega en el paso siguiente |
| `--extract` no hace nada | Falta `mammoth` / `pdf-parse` | `npm install mammoth pdf-parse` |
| CM sin DBC | Las Compras Menores no publican DBC | Traen *Declaración Jurada* y *Oferta del Proveedor Identificado* |

---

## 8. Automatización con GitHub Actions (Gratis)

El proyecto incluye un workflow para que el scraping corra **automáticamente cada día** en la nube de GitHub.

### Configuración (una sola vez)

1. **Crear cuenta de GitHub** (si no tenés): https://github.com/signup

2. **Crear repositorio:**
   - Andá a https://github.com/new
   - Nombre: `sicoes-descargas`\   - Público o privado (tu elección)\   - **NO** inicialices con README (ya lo tenés)

3. **Subir el código:**
   ```bash
   cd C:\Users\oalco\sicoes-descargas
   git remote add origin https://github.com/TU_USUARIO/sicoes-descargas.git
   git add .
   git commit -m "Initial commit"
   git branch -M main
   git push -u origin main
   ```

4. **Activar el workflow:**
   - Andá a tu repositorio → pestaña **Actions**
   - Aceptar "I understand my workflows"
   - El workflow se ejecutará automáticamente todos los días a las 6am

### Ejecución manual

Desde la pestaña **Actions** → **SICOES - Scraping Diario** → **Run workflow**:
- `limite`: número de convocatorias a procesar (default: 50)

### Notas importantes

- GitHub Actions es **gratis** para repos públicos (2000 min/mes)
- El workflow usa `xvfb` (monitor virtual) para que Turnstile funcione en headless
- Los archivos descargados se suben automáticamente al repositorio
- Si falla, revisa la pestaña **Actions** para ver el log

---

## 9. Buenas prácticas

- Es información **pública**, pero el portal está detrás de Cloudflare: mantené el
  `--delay` (≥ 4 s), no lances varias instancias en paralelo y evitá corridas gigantes
  en horario laboral.
- Para históricos (`--estado todos`) andá por tramos de fecha (`--desde/--hasta` mensual)
  en vez de una sola pasada.
