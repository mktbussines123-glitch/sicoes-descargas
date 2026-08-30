#!/usr/bin/env node
/*
 * descargar.mjs — Descarga masiva de documentos de convocatorias del SICOES
 * -----------------------------------------------------------------------------
 * Flujo:
 *   1. Abre el portal y entra a "Convocatorias" (fija cookie de sesión + token).
 *   2. Consulta el listado vía POST /portal/contrataciones/operacion.php
 *      (resuelve internamente el tope de 10 filas por página).
 *   3. Por cada convocatoria, parsea los adjuntos (descargarArchivo('<id>')).
 *   4. Descarga cada archivo disparando el flujo real del sitio
 *      (Cloudflare Turnstile invisible incluido) y lo guarda con nombre legible.
 *   5. Escribe un manifiesto reanudable y un log de errores.
 *
 * Uso:   node descargar.mjs [opciones]
 *        node descargar.mjs --help
 * -----------------------------------------------------------------------------
 */

import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import process from 'node:process';

// ───────────────────────────── CLI ─────────────────────────────
const RAW = parseArgs(process.argv.slice(2));
if (RAW.help || RAW.h) { printHelp(); process.exit(0); }

const CFG = {
  out:            RAW.out            || './descargas',
  estado:        (RAW.estado         || 'vigentes').toLowerCase(),   // vigentes | todos
  modalidad:      csv(RAW.modalidad),                                // p.ej. ANPE,ANPP  (filtro tras el listado)
  tipos:          csv(RAW.tipo)      || ['B', 'O', 'S', 'C'],        // B=Bienes O=Obras S=Serv.Grales C=Consultoría
  entidad:        RAW.entidad        || '',                          // texto (server-side)
  objeto:         RAW.objeto         || '',                          // texto (server-side)
  desde:          RAW.desde          || '',                          // dd/mm/aaaa  (fecha publicación, server-side)
  hasta:          RAW.hasta          || '',                          // dd/mm/aaaa
  cuce:           RAW.cuce           || '',                          // un CUCE completo: 26-0046-26-1681319-2-1
  archivosFiltro: csv(RAW.archivos),                                 // etiquetas a incluir (substring, case-insensitive)
  soloDbc:        !!RAW['solo-dbc'],                                 // solo DBC / especificaciones / TDR / pliego / convocatoria / enmienda
  limit:          RAW.limit ? parseInt(RAW.limit, 10) : Infinity,    // máx. convocatorias a procesar
  delay:          RAW.delay ? parseInt(RAW.delay, 10) : 4000,        // ms entre descargas
  headless:       !!RAW.headless,                                    // por defecto el navegador es VISIBLE (Turnstile falla en headless)
  dryRun:         !!RAW['dry-run'],                                  // no descarga: solo lista lo que haría
  force:          !!RAW.force,                                       // vuelve a descargar aunque esté en el manifiesto
  extract:        !!RAW.extract,                                     // además, extrae texto a .txt (requiere mammoth / pdf-parse)
  timeoutDl:      RAW['timeout'] ? parseInt(RAW['timeout'], 10) : 75000,
};

const BASE = 'https://www.sicoes.gob.bo';
const DBC_LABELS = /(documento base|especificaci|t.rminos de referencia|pliego|convocatoria|enmienda)/i;

fs.mkdirSync(CFG.out, { recursive: true });
const manifestPath = path.join(CFG.out, '_manifest.json');
const erroresPath  = path.join(CFG.out, '_errores.json');
const listadoPath  = path.join(CFG.out, '_listado.json');
const manifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : {};
const errores  = [];

console.log('SICOES · descarga de documentos de convocatorias');
console.log('Datos públicos de contrataciones estatales. Usar con moderación (rate-limit activo).\n');

// ───────────────────────────── main ─────────────────────────────
// Contexto PERSISTENTE: guarda cookies (incl. cf_clearance de Cloudflare) entre
// corridas y entre descargas. Sin esto cada descarga enfrenta el reto de Turnstile
// desde cero y suele expirar. Config mínima a propósito (UA/flags raros -> Turnstile
// fingerprintea y se cuelga).
const userDataDir = RAW['perfil'] || path.join(CFG.out, '.perfil-navegador');
fs.mkdirSync(userDataDir, { recursive: true });
const context = await chromium.launchPersistentContext(userDataDir, {
  headless: CFG.headless,
  acceptDownloads: true,
  viewport: null,
  // Único flag necesario: pone navigator.webdriver = false. Sin esto, Cloudflare
  // Turnstile detecta automatización y falla con error 600010. NO agregar
  // --no-sandbox ni UA custom: eso vuelve a disparar la detección.
  args: ['--disable-blink-features=AutomationControlled'],
  ignoreDefaultArgs: ['--enable-automation'],
});
if (CFG.headless) console.log('⚠ Modo headless: el captcha de descargas suele fallar. Si ves timeouts, quitá --headless.\n');
const page = context.pages()[0] || await context.newPage();

let sesion = await retry(() => bootstrap(page), 3, 4000);
console.log(`✓ Sesión iniciada · token=${sesion.token.slice(0, 12)}… · columnas=${sesion.cols.length}`);

const filas = await listar(page, sesion);
fs.writeFileSync(listadoPath, JSON.stringify(filas, null, 2));
console.log(`✓ Listado: ${filas.length} convocatoria(s) tras filtros · guardado en ${listadoPath}\n`);

let nProc = 0, nFiles = 0, nSkip = 0, nErr = 0;
const objetivo = Math.min(filas.length, CFG.limit);

for (const f of filas) {
  if (nProc >= CFG.limit) break;
  nProc++;

  let archivos = f.archivos;
  if (CFG.soloDbc)        archivos = archivos.filter(a => DBC_LABELS.test(a.label));
  if (CFG.archivosFiltro) archivos = archivos.filter(a => CFG.archivosFiltro.some(x => a.label.toLowerCase().includes(x.toLowerCase())));

  console.log(`[${nProc}/${objetivo}] ${f.cuce}  ${f.modalidad}/${f.tipo}  —  ${f.entidad}`);
  console.log(`    ${f.objeto.slice(0, 100)}`);

  if (!archivos.length) { console.log('    (sin archivos que coincidan con el filtro)\n'); continue; }

  for (let i = 0; i < archivos.length; i++) {
    const a = archivos[i];
    const key = `${f.cuce}::${a.label}::${i}`;

    // Verificar si el archivo existe en disco (no solo en manifiesto)
    const fileExists = manifest[key] && fs.existsSync(path.join(CFG.out, manifest[key].file));
    if (!CFG.force && fileExists) { console.log(`    ⟳ ya estaba: ${manifest[key].file}`); nSkip++; continue; }
    if (CFG.dryRun)                  { console.log(`    · (dry-run) ${a.label}`);            continue; }

    try {
      const res = await descargar(page, sesion, a.id, f, a.label, i);
      manifest[key] = res;
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
      console.log(`    ✓ ${a.label} → ${res.file}  (${(res.bytes / 1024).toFixed(0)} KB)`);
      nFiles++;
      if (CFG.extract) {
        await extraer(path.join(CFG.out, res.file))
          .then(txt => txt && console.log(`      ↳ texto: ${txt}`))
          .catch(e => console.log(`      (extract falló: ${e.message})`));
      }
    } catch (e) {
      nErr++;
      errores.push({ cuce: f.cuce, label: a.label, id: a.id, error: String(e), ts: new Date().toISOString() });
      fs.writeFileSync(erroresPath, JSON.stringify(errores, null, 2));
      console.log(`    ✗ ${a.label}: ${e.message}`);
      if (/redirect|index\.php|Timeout|Target closed|Execution context/i.test(String(e))) {
        try { sesion = await retry(() => bootstrap(page), 3, 5000); console.log('    ↻ sesión renovada'); }
        catch { console.log('    ↻ no se pudo renovar la sesión'); }
      }
    }
    await sleep(CFG.delay);
  }
  console.log('');
}

console.log('──────────────── RESUMEN ────────────────');
console.log(`Convocatorias procesadas : ${nProc}`);
console.log(`Archivos descargados     : ${nFiles}`);
console.log(`Omitidos (ya estaban)    : ${nSkip}`);
console.log(`Errores                  : ${nErr}${nErr ? `  (ver ${erroresPath})` : ''}`);
console.log(`Carpeta de salida        : ${path.resolve(CFG.out)}`);
console.log(`Manifiesto (reanudable)  : ${manifestPath}`);

await context.close();
process.exit(nErr && !nFiles ? 1 : 0);

// ───────────────────────────── funciones ─────────────────────────────

/** Abre el portal, entra a Convocatorias y devuelve { token, cols }. */
async function bootstrap(pg) {
  await pg.goto(`${BASE}/portal/index.php`, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await pg.evaluate(() => window.irLink && window.irLink('/portal/contrataciones/busqueda/convocatorias.php?tipo=convNacional'));
  await pg.waitForURL('**/convocatorias.php**', { timeout: 30000 });
  await pg.waitForSelector('input[name=token]', { state: 'attached', timeout: 30000 });
  await pg.waitForSelector('#formDescargaArchivoPortal', { state: 'attached', timeout: 30000 });
  const token = await pg.$eval('input[name=token]', el => el.value);
  const cols  = JSON.parse(await pg.$eval('#colsConvocatoriasSimple', el => el.value));
  return { token, cols };
}

/** Recorre el listado completo (10 filas por request) y devuelve filas normalizadas. */
async function listar(pg, sesion) {
  const { token, cols } = sesion;
  const tipos = CFG.tipos;

  const buildBody = (start) => new URLSearchParams({
    token,
    entidad: CFG.entidad,
    objetoContrato: CFG.objeto,
    publicacionDesde: CFG.desde,
    publicacionHasta: CFG.hasta,
    presentacionPropuestasDesde: '',
    presentacionPropuestasHasta: '',
    cuce1: '', cuce2: '', cuce3: '', cuce4: '', cuce5: '', cuce6: '',
    ...cuceParts(CFG.cuce),
    r1: CFG.estado === 'todos' ? '' : '11',
    subasta: '',
    bienes:      tipos.includes('B') ? 'B' : '',
    obras:       tipos.includes('O') ? 'O' : '',
    servicios:   tipos.includes('S') ? 'S' : '',
    consultoria: tipos.includes('C') ? 'C' : '',
    tipo: 'Simple',
    operacion: 'convNacional',
    autocorrector: '',
    nroRegistros: '10',
    draw: String(start / 10 + 1),
    start: String(start),
    length: '10',
    captcha: '',
  }).toString();

  const call = (start) => pg.evaluate((body) => new Promise((resolve, reject) => {
    window.jQuery.ajax({
      url: '/portal/contrataciones/operacion.php',
      method: 'POST',
      data: body,
      success: (d) => resolve(typeof d === 'string' ? JSON.parse(d) : d),
      error:   (x) => reject(new Error('ajax status ' + x.status)),
    });
  }), buildBody(start));

  const first = await call(0);
  const total = first.recordsTotal || 0;
  const rows  = [...(first.data || [])];

  const matched = () => CFG.modalidad
    ? rows.filter(r => CFG.modalidad.includes(r[cols[3]])).length
    : rows.length;

  for (let s = 10; s < total && matched() < CFG.limit; s += 10) {
    let j;
    try { j = await call(s); }
    catch { await sleep(1500); j = await call(s); }        // un reintento
    rows.push(...(j.data || []));
    process.stdout.write(`\r  leyendo listado… ${Math.min(s + 10, total)}/${total}`);
    await sleep(250);
  }
  process.stdout.write(`\r  leyendo listado… ${Math.min(rows.length, total)}/${total}\n`);

  const parsed = rows.map(r => ({
    cuce:              r[cols[0]],
    entidad:           r[cols[1]],
    tipo:              r[cols[2]],
    modalidad:         r[cols[3]],
    objeto:           (r[cols[4]] || '').replace(/\s+/g, ' ').trim(),
    subasta:           r[cols[5]],
    fecha_publicacion: r[cols[6]],
    fecha_presentacion:r[cols[7]],
    estado:            r[cols[8]],
    ficha_url:         (String(r[cols[11]] || '').match(/fichaProceso\.php\?cp=[^'"]+/) || [null])[0],
    archivos:          parseArchivos(r[cols[9]]),
  }));

  return CFG.modalidad
    ? parsed.filter(f => CFG.modalidad.includes(f.modalidad))
    : parsed;
}

/** Extrae [{ id, label }] de la celda HTML de "Archivos". */
function parseArchivos(html) {
  if (!html) return [];
  const out = [];
  const re = /descargarArchivo\('([^']+)'\)[^>]*>([^<]+)</g;
  let m;
  while ((m = re.exec(html))) out.push({ id: m[1], label: m[2].replace(/\s+/g, ' ').trim() });
  return out;
}

/** Dispara la descarga real de un archivo y lo guarda. Reintenta hasta 3 veces. */
async function descargar(pg, sesion, fileId, fila, label, idx) {
  if (!/convocatorias\.php/.test(pg.url())) {
    Object.assign(sesion, await bootstrap(pg));
  }

  for (let intento = 1; intento <= 3; intento++) {
    try {
      // Instrumenta Turnstile para diagnóstico y dispara la descarga.
      // (No hace falta gesto de usuario: llamar descargarArchivo() directo funciona.)
      await pg.evaluate((fid) => {
        window.__cf = [];
        if (!window.__cfHooked && window.turnstile && window.turnstile.render) {
          window.__cfHooked = true;
          const orig = window.turnstile.render.bind(window.turnstile);
          window.turnstile.render = (el, opts) => {
            window.__cf.push('render ' + (opts && opts.action));
            const cb = opts.callback, ecb = opts['error-callback'];
            opts.callback = (t) => { window.__cf.push('callback len=' + (t || '').length); cb && cb(t); };
            opts['error-callback'] = (...a) => { window.__cf.push('error-callback ' + JSON.stringify(a)); ecb && ecb(...a); };
            try { return orig(el, opts); } catch (e) { window.__cf.push('render threw ' + e.message); throw e; }
          };
        }
        const _alert = window.alert;
        window.alert = (m) => { window.__cf.push('alert ' + m); };
        setTimeout(() => { window.alert = _alert; }, 60000);
        window.descargarArchivo(fid);
      }, fileId);

      const [dl] = await Promise.all([
        pg.waitForEvent('download', { timeout: CFG.timeoutDl }).catch(async (e) => {
          const cf = await pg.evaluate(() => window.__cf || []).catch(() => []);
          throw new Error(`sin descarga en ${CFG.timeoutDl / 1000}s · turnstile=[${cf.join(' | ')}]`);
        }),
        Promise.resolve(),
      ]);

      const sugerido = dl.suggestedFilename() || 'archivo';
      const ext = (path.extname(sugerido) || '.bin').toLowerCase();
      const fname = `${fila.cuce}__${slug(label)}${idx ? '_' + idx : ''}${ext}`;
      const full = path.join(CFG.out, fname);
      await dl.saveAs(full);

      const buf = fs.readFileSync(full);
      // Detecta HTML de error disfrazado de archivo
      if (buf.length < 600 && /<html|<!doctype/i.test(buf.toString('utf8', 0, 200))) {
        fs.rmSync(full, { force: true });
        throw new Error('respuesta HTML (posible sesión/captcha) en vez de archivo');
      }

      return {
        file: fname,
        bytes: buf.length,
        sha256: crypto.createHash('sha256').update(buf).digest('hex'),
        original: sugerido,
        label,
        cuce: fila.cuce,
        modalidad: fila.modalidad,
        tipo: fila.tipo,
        entidad: fila.entidad,
        descargado: new Date().toISOString(),
      };
    } catch (e) {
      if (intento === 3) throw e;
      console.log(`      reintento ${intento}/2 (${e.message})`);
      await sleep(3000 * intento);
      // Re-bootstrap completo: recargar por sí solo deja la página sin el JS de descarga.
      Object.assign(sesion, await bootstrap(pg).catch(() => ({})));
      await pg.waitForFunction(() => typeof window.descargarArchivo === 'function', { timeout: 20000 }).catch(() => {});
    }
  }
}

/** Extrae texto plano de un .docx o .pdf a un archivo .txt hermano. Devuelve el nombre o null. */
async function extraer(file) {
  const ext = path.extname(file).toLowerCase();
  const outTxt = file.replace(/\.[^.]+$/, '') + '.txt';
  if (ext === '.docx') {
    const mammoth = await import('mammoth');
    const { value } = await mammoth.extractRawText({ path: file });
    fs.writeFileSync(outTxt, value, 'utf8');
  } else if (ext === '.pdf') {
    const pdf = (await import('pdf-parse/lib/pdf-parse.js')).default;
    const data = await pdf(fs.readFileSync(file));
    fs.writeFileSync(outTxt, data.text, 'utf8');
  } else {
    return null;
  }
  return path.basename(outTxt);
}

// ───────────────────────────── utilidades ─────────────────────────────
function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const next = argv[i + 1];
      o[k] = (next !== undefined && !next.startsWith('--')) ? (i++, next) : true;
    } else if (a.startsWith('-')) {
      o[a.slice(1)] = true;
    }
  }
  return o;
}
function csv(v) {
  return (v && typeof v === 'string') ? v.split(',').map(s => s.trim()).filter(Boolean) : null;
}
function cuceParts(c) {
  if (!c) return {};
  const p = c.split('-');
  if (p.length < 6) return {};
  return { cuce1: p[0], cuce2: p[1], cuce3: p[2], cuce4: p[3], cuce5: p[4], cuce6: p[5] };
}
function slug(s) {
  return String(s).normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 45) || 'archivo';
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
async function retry(fn, veces, esperaMs) {
  let last;
  for (let i = 1; i <= veces; i++) {
    try { return await fn(); }
    catch (e) { last = e; console.log(`  intento ${i}/${veces} falló: ${e.message}`); await sleep(esperaMs); }
  }
  throw last;
}

function printHelp() {
  console.log(`
descargar.mjs — Descarga masiva de documentos de convocatorias del SICOES

USO
  node descargar.mjs [opciones]

FILTROS DEL LISTADO
  --estado <vigentes|todos>     Por defecto: vigentes
  --tipo <B,O,S,C>              Bienes / Obras / Servicios Generales / Consultoría (server-side). Por defecto: todos
  --modalidad <ANPE,ANPP,...>   Filtra por modalidad tras traer el listado (CM, ANPE, ANPP, LP, ...)
  --entidad "<texto>"          Búsqueda por nombre de entidad (server-side)
  --objeto "<texto>"           Búsqueda por objeto de contratación (server-side)
  --desde <dd/mm/aaaa>          Fecha de publicación SICOES, desde (server-side)
  --hasta <dd/mm/aaaa>          Fecha de publicación SICOES, hasta (server-side)
  --cuce <26-0046-26-1681319-2-1>  Un CUCE puntual

QUÉ DESCARGAR
  --solo-dbc                    Solo DBC / Especificaciones / TDR / Pliego / Convocatoria / Enmienda
  --archivos "<a,b>"           Solo adjuntos cuya etiqueta contenga alguno de estos textos
  --limit <n>                   Máx. de convocatorias a procesar
  --dry-run                     No descarga: solo muestra qué haría

SALIDA / EJECUCIÓN
  --out <carpeta>               Carpeta de salida (por defecto ./descargas)
  --delay <ms>                  Pausa entre descargas (por defecto 4000)
  --timeout <ms>                Timeout por descarga (por defecto 90000)
  --extract                     Extrae texto a .txt (necesita  npm i mammoth pdf-parse)
  --headless                    Oculta el navegador (NO recomendado: el Turnstile de descargas suele fallar)
  --force                       Vuelve a descargar aunque figure en el manifiesto
  --help                        Esta ayuda

EJEMPLOS
  # 20 DBC de convocatorias ANPP vigentes
  node descargar.mjs --modalidad ANPP --solo-dbc --limit 20 --out ./anpp

  # Un CUCE puntual, todos sus adjuntos, con extracción de texto
  node descargar.mjs --cuce 26-0046-26-1681319-2-1 --extract

  # Solo el "Documento Base de Contratacion" de Bienes y Obras publicados en agosto
  node descargar.mjs --tipo B,O --archivos "Documento Base" --desde 01/08/2026 --hasta 29/08/2026

  # Ver qué traería, sin descargar
  node descargar.mjs --modalidad ANPE --solo-dbc --limit 50 --dry-run

SALIDAS EN LA CARPETA
  <CUCE>__<Etiqueta>.<ext>     Los archivos descargados
  _listado.json                Listado normalizado de convocatorias (insumo para la fase de BD)
  _manifest.json               Registro de descargas (permite reanudar; borralo para empezar de cero)
  _errores.json                Errores por archivo
`);
}
