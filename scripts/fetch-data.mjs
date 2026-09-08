#!/usr/bin/env node
/**
 * Trae los datos del día desde API-Football (api-sports.io) y los escribe
 * en data/*.json. Corre en GitHub Actions con la llave en Secrets —
 * nunca en el navegador, donde quedaría expuesta.
 *
 *   API_FOOTBALL_KEY=xxxx node scripts/fetch-data.mjs [--full]
 *
 * Filosofía de errores: este script casi nunca debe fallar. Si un
 * endpoint no responde, lo anota en data/diagnostico.json y sigue con
 * los demás. Solo se cae si falta la llave, porque sin eso no hay nada
 * que hacer. Un tablero con datos parciales sirve; uno que no se
 * actualiza porque un endpoint tosió, no.
 */
import { writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA = join(ROOT, "data");
const KEY = process.env.API_FOOTBALL_KEY;
const HOST = "https://v3.football.api-sports.io";
const LIGA_UCL = 2;
const FULL = process.argv.includes("--full");
const DEBUG = process.env.DEBUG_SHAPE === "1";

if (!KEY) {
  console.error("✗ Falta API_FOOTBALL_KEY.");
  console.error("  En el repo: Settings → Secrets and variables → Actions → New repository secret");
  process.exit(1);
}

const diag = { llamadas: [], avisos: [], errores: [] };
let gastadas = 0;

async function api(path, params = {}) {
  const url = new URL(HOST + path);
  for (const [k, v] of Object.entries(params)) if (v != null) url.searchParams.set(k, v);
  const etiqueta = `${path}?${url.searchParams}`;
  try {
    const r = await fetch(url, { headers: { "x-apisports-key": KEY } });
    gastadas++;
    const texto = await r.text();
    let j;
    try { j = JSON.parse(texto); }
    catch { throw new Error(`respuesta no es JSON (HTTP ${r.status}): ${texto.slice(0, 200)}`); }

    if (DEBUG) {
      await mkdir(DATA, { recursive: true });
      await writeFile(join(DATA, `_raw-${path.replace(/\W/g, "_")}.json`), JSON.stringify(j, null, 1));
    }
    // API-Football devuelve 200 con "errors" poblado cuando algo falla:
    // llave inválida, plan insuficiente, temporada no permitida...
    const errs = j.errors;
    const hayErr = errs && (Array.isArray(errs) ? errs.length : Object.keys(errs).length);
    if (hayErr) {
      const msg = JSON.stringify(errs);
      diag.errores.push({ endpoint: etiqueta, error: msg });
      console.error(`  ✗ ${path} → ${msg}`);
      return [];
    }
    const res = j.response ?? [];
    diag.llamadas.push({ endpoint: etiqueta, resultados: Array.isArray(res) ? res.length : 1 });
    console.log(`  ✓ ${path} → ${Array.isArray(res) ? res.length : 1} resultado(s)`);
    return res;
  } catch (e) {
    diag.errores.push({ endpoint: etiqueta, error: e.message });
    console.error(`  ✗ ${path} → ${e.message}`);
    return [];
  }
}

/** Estado de la cuenta: plan, cupo usado. Cuesta 1 petición y ahorra horas. */
async function estadoCuenta() {
  const r = await api("/status");
  const s = Array.isArray(r) ? r[0] : r;
  if (!s || !s.account) { diag.avisos.push("No se pudo leer /status: revisa que la llave sea válida."); return null; }
  const info = {
    plan: s.subscription?.plan,
    activo: s.subscription?.active,
    expira: s.subscription?.end,
    usadasHoy: s.requests?.current,
    limiteDia: s.requests?.limit_day
  };
  console.log(`Cuenta: plan ${info.plan} · ${info.usadasHoy}/${info.limiteDia} peticiones hoy`);
  return info;
}

/** Qué temporadas permite el plan para esta liga. Evita adivinar. */
async function temporadaUtil(preferida) {
  const ligas = await api("/leagues", { id: LIGA_UCL });
  const l = ligas[0];
  const disponibles = (l?.seasons ?? []).map(s => s.year).sort((a, b) => b - a);
  if (!disponibles.length) {
    diag.avisos.push("No se pudo listar temporadas; uso la preferida sin verificar.");
    return preferida;
  }
  if (disponibles.includes(preferida)) return preferida;
  const alterna = disponibles[0];
  diag.avisos.push(`La temporada ${preferida} no está disponible en tu plan. Disponibles: ${disponibles.slice(0,6).join(", ")}. Uso ${alterna}.`);
  console.warn(`  ⚠ temporada ${preferida} no disponible → uso ${alterna}`);
  return alterna;
}

const hoyISO = () => new Date().toISOString().slice(0, 10);

const mapaPartido = f => ({
  id: f.fixture?.id,
  utc: f.fixture?.date,
  estado: f.fixture?.status?.short,
  minuto: f.fixture?.status?.elapsed ?? null,
  sede: [f.fixture?.venue?.name, f.fixture?.venue?.city].filter(Boolean).join(", "),
  arbitro: f.fixture?.referee || null,
  ronda: f.league?.round || null,
  local: f.teams?.home?.name, visita: f.teams?.away?.name,
  idLocal: f.teams?.home?.id, idVisita: f.teams?.away?.id,
  golesLocal: f.goals?.home ?? null, golesVisita: f.goals?.away ?? null
});

/** Partidos de hoy; si no hay, los próximos que vengan. */
async function partidos(temporada) {
  let raw = await api("/fixtures", { league: LIGA_UCL, season: temporada, date: hoyISO() });
  if (!raw.length) {
    console.log("  sin partidos hoy → busco los próximos");
    raw = await api("/fixtures", { league: LIGA_UCL, season: temporada, next: 12 });
  }
  return raw.map(mapaPartido);
}

async function tabla(temporada) {
  const raw = await api("/standings", { league: LIGA_UCL, season: temporada });
  const grupos = raw[0]?.league?.standings ?? [];
  return grupos.flat().map(t => ({
    pos: t.rank, equipo: t.team?.name, escudo: t.team?.logo,
    pj: t.all?.played ?? 0, g: t.all?.win ?? 0, e: t.all?.draw ?? 0, p: t.all?.lose ?? 0,
    gf: t.all?.goals?.for ?? 0, gc: t.all?.goals?.against ?? 0,
    pts: t.points ?? 0, forma: t.form || ""
  }));
}

/** Cuotas 1X2: nos quedamos con la MEJOR de cada casa, que es la que puedes tomar. */
async function cuotas(temporada) {
  const raw = await api("/odds", { league: LIGA_UCL, season: temporada, bet: 1 });
  const out = {};
  for (const e of raw) {
    const id = e.fixture?.id; if (!id) continue;
    const mejor = { Home: 0, Draw: 0, Away: 0 };
    for (const casa of e.bookmakers ?? [])
      for (const ap of casa.bets ?? [])
        for (const v of ap.values ?? []) {
          const k = v.value, o = parseFloat(v.odd);
          if (k in mejor && o > mejor[k]) mejor[k] = o;
        }
    if (mejor.Home && mejor.Draw && mejor.Away) out[id] = [mejor.Home, mejor.Draw, mejor.Away];
  }
  return out;
}

async function estadisticas(ids) {
  const out = {};
  for (const id of ids) {
    const raw = await api("/fixtures/statistics", { fixture: id });
    if (!raw.length) continue;
    const lee = (eq, tipo) => eq?.statistics?.find(s => s.type === tipo)?.value ?? null;
    out[id] = {
      remates:   [lee(raw[0], "Total Shots"),   lee(raw[1], "Total Shots")],
      aPuerta:   [lee(raw[0], "Shots on Goal"), lee(raw[1], "Shots on Goal")],
      corners:   [lee(raw[0], "Corner Kicks"),  lee(raw[1], "Corner Kicks")],
      amarillas: [lee(raw[0], "Yellow Cards"),  lee(raw[1], "Yellow Cards")],
      rojas:     [lee(raw[0], "Red Cards"),     lee(raw[1], "Red Cards")],
      posesion:  [lee(raw[0], "Ball Possession"), lee(raw[1], "Ball Possession")]
    };
  }
  return out;
}

async function historial(ps) {
  const out = {};
  for (const p of ps) {
    const raw = await api("/fixtures/headtohead", { h2h: `${p.idLocal}-${p.idVisita}`, last: 10 });
    let hw = 0, d = 0, aw = 0; const ult = [];
    for (const f of raw) {
      const gl = f.goals?.home, gv = f.goals?.away;
      if (gl == null || gv == null) continue;
      const mismoLocal = f.teams?.home?.id === p.idLocal;
      const a = mismoLocal ? gl : gv, b = mismoLocal ? gv : gl;
      if (a > b) hw++; else if (a === b) d++; else aw++;
      ult.push(`${f.teams?.home?.name} ${gl}-${gv} ${f.teams?.away?.name}`);
    }
    if (hw + d + aw) out[p.id] = { n: hw + d + aw, hw, d, aw, ultimos: ult.slice(0, 5) };
  }
  return out;
}

async function main() {
  await mkdir(DATA, { recursive: true });
  console.log(`${hoyISO()} · modo ${FULL ? "completo" : "ligero"}`);

  const cuenta = await estadoCuenta();
  const pedida = Number(process.env.SEASON || new Date().getFullYear());
  const temporada = await temporadaUtil(pedida);
  console.log(`Temporada en uso: ${temporada}`);

  const ps = await partidos(temporada);
  console.log(`${ps.length} partido(s)`);

  const tb = await tabla(temporada);
  const cu = ps.length ? await cuotas(temporada) : {};

  let stats = {}, h2h = {};
  if (FULL && ps.length) {
    const jugados = ps.filter(p => ["FT","AET","PEN","1H","2H","HT"].includes(p.estado));
    if (jugados.length) stats = await estadisticas(jugados.map(p => p.id));
    h2h = await historial(ps.filter(p => p.idLocal && p.idVisita).slice(0, 12));
  }

  const meta = {
    actualizado: new Date().toISOString(),
    temporadaPedida: pedida, temporadaUsada: temporada,
    peticionesGastadas: gastadas,
    cuenta, fuente: "API-Football (api-sports.io)",
    partidos: ps.length, equiposEnTabla: tb.length,
    partidosConCuotas: Object.keys(cu).length
  };

  await Promise.all([
    writeFile(join(DATA, "fixtures.json"),  JSON.stringify(ps, null, 1)),
    writeFile(join(DATA, "standings.json"), JSON.stringify(tb, null, 1)),
    writeFile(join(DATA, "odds.json"),      JSON.stringify(cu, null, 1)),
    writeFile(join(DATA, "stats.json"),     JSON.stringify(stats, null, 1)),
    writeFile(join(DATA, "h2h.json"),       JSON.stringify(h2h, null, 1)),
    writeFile(join(DATA, "meta.json"),      JSON.stringify(meta, null, 1)),
    writeFile(join(DATA, "diagnostico.json"), JSON.stringify(diag, null, 1))
  ]);

  console.log(`\nResumen: ${ps.length} partidos · ${tb.length} en tabla · ${Object.keys(cu).length} con cuotas`);
  console.log(`${gastadas} petición(es) gastadas.`);
  if (diag.avisos.length) { console.log("\nAvisos:"); diag.avisos.forEach(a => console.log("  ⚠ " + a)); }
  if (diag.errores.length) {
    console.log(`\n${diag.errores.length} endpoint(s) fallaron — detalle en data/diagnostico.json:`);
    diag.errores.forEach(e => console.log(`  ✗ ${e.endpoint} → ${e.error}`));
  }
  // No fallamos el job: los datos parciales que sí llegaron ya sirven,
  // y el diagnóstico queda commiteado para poder leerlo.
}

main().catch(async e => {
  console.error("Error inesperado:", e);
  try {
    await mkdir(DATA, { recursive: true });
    diag.errores.push({ endpoint: "main", error: String(e?.stack || e) });
    await writeFile(join(DATA, "diagnostico.json"), JSON.stringify(diag, null, 1));
  } catch {}
  process.exit(1);
});
