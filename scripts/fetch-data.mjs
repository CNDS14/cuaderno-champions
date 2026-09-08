#!/usr/bin/env node
/**
 * Trae los datos del día desde API-Football (api-sports.io) y los escribe
 * en data/*.json. Pensado para correr en GitHub Actions con la llave en
 * Secrets — nunca en el navegador, donde quedaría expuesta.
 *
 *   API_FOOTBALL_KEY=xxxx node scripts/fetch-data.mjs
 *
 * Presupuesto del plan gratuito: 100 peticiones al día. Una jornada
 * completa consume entre 12 y 18 con --full; el modo por defecto (sin
 * estadísticas por partido) usa 4.
 *
 * AVISO: los nombres de campo salen de la documentación de API-Football,
 * no de una llamada real verificada. La primera vez corre con
 * DEBUG_SHAPE=1 y revisa data/_raw-*.json antes de confiar en el mapeo.
 */
import { writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA = join(ROOT, "data");
const KEY = process.env.API_FOOTBALL_KEY;
const HOST = "https://v3.football.api-sports.io";
const LIGA_UCL = 2;               // id de Champions League en API-Football
const TEMPORADA = Number(process.env.SEASON || new Date().getFullYear());
const FULL = process.argv.includes("--full");
const DEBUG = process.env.DEBUG_SHAPE === "1";

if (!KEY) {
  console.error("Falta API_FOOTBALL_KEY. Consíguela gratis en dashboard.api-football.com");
  process.exit(1);
}

let gastadas = 0;
async function api(path, params = {}) {
  const url = new URL(HOST + path);
  for (const [k, v] of Object.entries(params)) if (v != null) url.searchParams.set(k, v);
  const r = await fetch(url, { headers: { "x-apisports-key": KEY } });
  gastadas++;
  if (!r.ok) throw new Error(`${path} -> HTTP ${r.status}`);
  const j = await r.json();
  if (j.errors && Object.keys(j.errors).length) {
    throw new Error(`${path} -> ${JSON.stringify(j.errors)}`);
  }
  if (DEBUG) {
    await mkdir(DATA, { recursive: true });
    await writeFile(join(DATA, `_raw-${path.replace(/\W/g, "_")}.json`),
      JSON.stringify(j, null, 1));
  }
  return j.response ?? [];
}

const hoyISO = () => new Date().toISOString().slice(0, 10);

/** Partidos de hoy. 1 petición. */
async function partidos() {
  const raw = await api("/fixtures", { league: LIGA_UCL, season: TEMPORADA, date: hoyISO() });
  return raw.map(f => ({
    id: f.fixture?.id,
    utc: f.fixture?.date,
    estado: f.fixture?.status?.short,        // NS | 1H | HT | 2H | FT ...
    minuto: f.fixture?.status?.elapsed ?? null,
    sede: [f.fixture?.venue?.name, f.fixture?.venue?.city].filter(Boolean).join(", "),
    arbitro: f.fixture?.referee || null,
    ronda: f.league?.round || null,
    local: f.teams?.home?.name,
    visita: f.teams?.away?.name,
    idLocal: f.teams?.home?.id,
    idVisita: f.teams?.away?.id,
    escudoLocal: f.teams?.home?.logo,
    escudoVisita: f.teams?.away?.logo,
    golesLocal: f.goals?.home ?? null,
    golesVisita: f.goals?.away ?? null
  }));
}

/** Tabla de la fase liga. 1 petición. */
async function tabla() {
  const raw = await api("/standings", { league: LIGA_UCL, season: TEMPORADA });
  const grupos = raw[0]?.league?.standings ?? [];
  return grupos.flat().map(t => ({
    pos: t.rank, equipo: t.team?.name, escudo: t.team?.logo,
    pj: t.all?.played ?? 0, g: t.all?.win ?? 0, e: t.all?.draw ?? 0, p: t.all?.lose ?? 0,
    gf: t.all?.goals?.for ?? 0, gc: t.all?.goals?.against ?? 0,
    pts: t.points ?? 0, forma: t.form || ""
  }));
}

/** Cuotas 1X2 previas. 1 petición por página; casi siempre basta una. */
async function cuotas() {
  const raw = await api("/odds", { league: LIGA_UCL, season: TEMPORADA, bet: 1 }); // bet 1 = Match Winner
  const out = {};
  for (const e of raw) {
    const id = e.fixture?.id;
    if (!id) continue;
    // nos quedamos con la MEJOR cuota disponible entre todas las casas:
    // esa es la que de verdad puedes tomar
    const mejor = { Home: 0, Draw: 0, Away: 0 };
    for (const casa of e.bookmakers ?? []) {
      for (const apuesta of casa.bets ?? []) {
        for (const v of apuesta.values ?? []) {
          const k = v.value;                       // "Home" | "Draw" | "Away"
          const o = parseFloat(v.odd);
          if (k in mejor && o > mejor[k]) mejor[k] = o;
        }
      }
    }
    if (mejor.Home && mejor.Draw && mejor.Away) out[id] = [mejor.Home, mejor.Draw, mejor.Away];
  }
  return out;
}

/** Estadísticas reales por partido: remates, córners, tarjetas. 1 petición POR PARTIDO. */
async function estadisticas(ids) {
  const out = {};
  for (const id of ids) {
    try {
      const raw = await api("/fixtures/statistics", { fixture: id });
      const lee = (equipo, tipo) =>
        equipo?.statistics?.find(s => s.type === tipo)?.value ?? null;
      out[id] = {
        remates:  [lee(raw[0], "Total Shots"), lee(raw[1], "Total Shots")],
        aPuerta:  [lee(raw[0], "Shots on Goal"), lee(raw[1], "Shots on Goal")],
        corners:  [lee(raw[0], "Corner Kicks"), lee(raw[1], "Corner Kicks")],
        amarillas:[lee(raw[0], "Yellow Cards"), lee(raw[1], "Yellow Cards")],
        rojas:    [lee(raw[0], "Red Cards"), lee(raw[1], "Red Cards")],
        posesion: [lee(raw[0], "Ball Possession"), lee(raw[1], "Ball Possession")]
      };
    } catch (e) { console.warn(`  sin estadísticas para ${id}: ${e.message}`); }
  }
  return out;
}

/** Historial entre los dos equipos. 1 petición por partido. */
async function historial(ps) {
  const out = {};
  for (const p of ps) {
    try {
      const raw = await api("/fixtures/headtohead", { h2h: `${p.idLocal}-${p.idVisita}`, last: 10 });
      let hw = 0, d = 0, aw = 0;
      const ult = [];
      for (const f of raw) {
        const gl = f.goals?.home, gv = f.goals?.away;
        if (gl == null || gv == null) continue;
        const localEsNuestroLocal = f.teams?.home?.id === p.idLocal;
        const a = localEsNuestroLocal ? gl : gv, b = localEsNuestroLocal ? gv : gl;
        if (a > b) hw++; else if (a === b) d++; else aw++;
        ult.push(`${f.teams?.home?.name} ${gl}-${gv} ${f.teams?.away?.name}`);
      }
      out[p.id] = { n: hw + d + aw, hw, d, aw, ultimos: ult.slice(0, 5) };
    } catch (e) { console.warn(`  sin historial para ${p.id}: ${e.message}`); }
  }
  return out;
}

async function main() {
  await mkdir(DATA, { recursive: true });
  console.log(`Temporada ${TEMPORADA} · ${hoyISO()} · modo ${FULL ? "completo" : "ligero"}`);

  const ps = await partidos();
  console.log(`  ${ps.length} partido(s) hoy`);

  const [tb, cu] = await Promise.all([
    tabla().catch(e => { console.warn("  tabla:", e.message); return []; }),
    ps.length ? cuotas().catch(e => { console.warn("  cuotas:", e.message); return {}; }) : {}
  ]);

  let stats = {}, h2h = {};
  if (FULL && ps.length) {
    const jugados = ps.filter(p => ["FT", "AET", "PEN", "1H", "2H", "HT"].includes(p.estado));
    stats = await estadisticas(jugados.map(p => p.id));
    h2h = await historial(ps.filter(p => p.idLocal && p.idVisita));
  }

  const meta = {
    actualizado: new Date().toISOString(),
    temporada: TEMPORADA,
    peticionesGastadas: gastadas,
    fuente: "API-Football (api-sports.io)",
    partidosHoy: ps.length
  };

  await Promise.all([
    writeFile(join(DATA, "fixtures.json"), JSON.stringify(ps, null, 1)),
    writeFile(join(DATA, "standings.json"), JSON.stringify(tb, null, 1)),
    writeFile(join(DATA, "odds.json"), JSON.stringify(cu, null, 1)),
    writeFile(join(DATA, "stats.json"), JSON.stringify(stats, null, 1)),
    writeFile(join(DATA, "h2h.json"), JSON.stringify(h2h, null, 1)),
    writeFile(join(DATA, "meta.json"), JSON.stringify(meta, null, 1))
  ]);
  console.log(`Listo. ${gastadas} petición(es) gastadas de las 100 del día.`);
}

main().catch(e => { console.error(e); process.exit(1); });
