#!/usr/bin/env node
/**
 * Recolector de datos del Cuaderno de Champions.
 *
 * FUENTE PRINCIPAL: football-data.org
 *   Su plan gratuito SÍ incluye la Champions League y SÍ da la temporada
 *   en curso. Da calendario, marcadores en vivo, árbitro, sede y tabla.
 *   Límite: 10 peticiones por minuto. Nosotros gastamos 2 o 3.
 *   Llave gratis en football-data.org/client/register → secreto
 *   FOOTBALL_DATA_KEY.
 *
 * CUOTAS (opcional): the-odds-api.com
 *   500 créditos al mes gratis. Cada llamada gasta tantos créditos como
 *   regiones × mercados pidas, así que pedimos una región y un mercado:
 *   1 crédito por corrida. Llave en secreto ODDS_API_KEY.
 *
 * ESTADÍSTICAS POR PARTIDO (opcional, de paga): API-Football
 *   Remates, córners y tarjetas en vivo. Su plan gratuito NO sirve: solo
 *   da temporadas 2022 a 2024. Con el plan Pro (19 USD/mes) sí. Si algún
 *   día lo contratas, pon API_FOOTBALL_KEY y este script lo usa solo.
 *
 * Ningún fallo tumba el workflow: lo que se pudo traer se guarda, y lo
 * que falló queda explicado en data/diagnostico.json.
 */
import { writeFile, mkdir, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { cargarEquipos, modelo, picksDe, resolver, corto } from "./modelo.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA = join(ROOT, "data");
const FD_KEY = process.env.FOOTBALL_DATA_KEY;
const ODDS_KEY = process.env.ODDS_API_KEY;
const AF_KEY = process.env.API_FOOTBALL_KEY;
const FULL = process.argv.includes("--full");
const DEBUG = process.env.DEBUG_SHAPE === "1";

const diag = { fuentes: {}, avisos: [], errores: [] };
const nota = (donde, msg) => { diag.errores.push({ donde, error: msg }); console.error(`  ✗ ${donde} → ${msg}`); };
const aviso = m => { diag.avisos.push(m); console.warn(`  ⚠ ${m}`); };

async function pedir(url, headers, donde) {
  try {
    const r = await fetch(url, { headers });
    const txt = await r.text();
    let j; try { j = JSON.parse(txt); }
    catch { nota(donde, `respuesta no es JSON (HTTP ${r.status}): ${txt.slice(0, 160)}`); return null; }
    if (DEBUG) {
      await mkdir(DATA, { recursive: true });
      await writeFile(join(DATA, `_raw-${donde.replace(/\W/g, "_")}.json`), JSON.stringify(j, null, 1));
    }
    if (!r.ok || j.errorCode || j.message && !j.matches && !j.standings) {
      nota(donde, `HTTP ${r.status} ${j.message || j.error || JSON.stringify(j).slice(0, 160)}`);
      return null;
    }
    console.log(`  ✓ ${donde}`);
    return j;
  } catch (e) { nota(donde, e.message); return null; }
}

/* ═══════════ football-data.org ═══════════ */
const FD = "https://api.football-data.org/v4";
const fdHead = { "X-Auth-Token": FD_KEY || "" };
const hoyISO = () => new Date().toISOString().slice(0, 10);
const masDias = n => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

const EST = { SCHEDULED:"NS", TIMED:"NS", IN_PLAY:"LIVE", PAUSED:"HT", FINISHED:"FT",
              SUSPENDED:"SUSP", POSTPONED:"PST", CANCELLED:"CANC", AWARDED:"FT" };

function mapaPartido(m) {
  const arb = (m.referees || []).find(r => /REFEREE/i.test(r.type || "")) || (m.referees || [])[0];
  return {
    id: m.id,
    utc: m.utcDate,
    estado: EST[m.status] || m.status,
    minuto: m.minute ?? null,
    jornada: m.matchday ?? null,
    sede: m.venue || "",
    arbitro: arb?.name || null,
    local: m.homeTeam?.shortName || m.homeTeam?.name,
    visita: m.awayTeam?.shortName || m.awayTeam?.name,
    idLocal: m.homeTeam?.id, idVisita: m.awayTeam?.id,
    golesLocal: m.score?.fullTime?.home ?? null,
    golesVisita: m.score?.fullTime?.away ?? null
  };
}

async function partidos() {
  // los del día; si no hay, los de la próxima semana
  let j = await pedir(`${FD}/competitions/CL/matches?dateFrom=${hoyISO()}&dateTo=${hoyISO()}`, fdHead, "fd/partidos-hoy");
  let ms = j?.matches || [];
  if (!ms.length) {
    j = await pedir(`${FD}/competitions/CL/matches?dateFrom=${hoyISO()}&dateTo=${masDias(9)}`, fdHead, "fd/proximos");
    ms = (j?.matches || []).slice(0, 18);
    if (ms.length) console.log(`  sin partidos hoy → tomo los ${ms.length} próximos`);
  }
  return ms.map(mapaPartido);
}

async function tabla() {
  const j = await pedir(`${FD}/competitions/CL/standings`, fdHead, "fd/tabla");
  const bloque = (j?.standings || []).find(s => (s.type || "").toUpperCase() === "TOTAL") || (j?.standings || [])[0];
  return (bloque?.table || []).map(t => ({
    pos: t.position,
    equipo: t.team?.shortName || t.team?.name,
    escudo: t.team?.crest,
    pj: t.playedGames ?? 0, g: t.won ?? 0, e: t.draw ?? 0, p: t.lost ?? 0,
    gf: t.goalsFor ?? 0, gc: t.goalsAgainst ?? 0,
    pts: t.points ?? 0, forma: t.form || ""
  }));
}

/** Resultados recientes, para que el tablero muestre cómo van quedando. */
async function recientes() {
  const j = await pedir(`${FD}/competitions/CL/matches?dateFrom=${masDias(-8)}&dateTo=${masDias(-1)}&status=FINISHED`,
    fdHead, "fd/recientes");
  return (j?.matches || []).map(mapaPartido).slice(-24);
}

/* ═══════════ the-odds-api (cuotas) ═══════════ */
const norm = s => (s || "").toLowerCase()
  .normalize("NFD").replace(/[̀-ͯ]/g, "")
  .replace(/\b(fc|cf|sc|ac|afc|kv|sk|fk|club|de|the)\b/g, "")
  .replace(/[^a-z0-9]/g, "");

/* Emparejar clubes entre fuentes es más difícil de lo que parece:
   football-data dice "PAE AEK" y "Man City", the-odds-api dice
   "AEK Athens" y "Manchester City". Comparar la cadena completa falla en
   los dos casos. Comparamos por palabras: basta que una palabra
   significativa coincida (o sea prefijo de la otra) para dar por bueno
   el equipo.                                                          */
const GENERICAS = new Set(["fc","cf","sc","ac","afc","kv","sk","fk","club","pae",
  "de","del","the","and","calcio","futebol","football","futbol","cp","cd","ud","if","bk"]);
const palabras = s => (s || "").toLowerCase().normalize("NFD")
  .replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, " ")
  .split(" ").filter(w => w.length >= 3 && !GENERICAS.has(w));
const casan = (x, y) =>
  x === y || (x.length >= 3 && y.startsWith(x)) || (y.length >= 3 && x.startsWith(y));

/* Exigimos que TODAS las palabras del nombre más corto encuentren pareja.
   Con "una palabra basta" se colaban falsos positivos caros: "Real Madrid"
   emparejaba con "Real Sociedad" y "Man City" con "Man United" — le
   pegaríamos las cuotas al partido equivocado y ni cuenta nos daríamos. */
function mismoEquipo(a, b) {
  const A = palabras(a), B = palabras(b);
  if (!A.length || !B.length) return false;
  const [corto, largo] = A.length <= B.length ? [A, B] : [B, A];
  const casadas = corto.filter(x => largo.some(y => casan(x, y))).length;
  return casadas === corto.length;
}

/* Presupuesto de creditos.
   the-odds-api da 500 creditos al mes. Corriendo cada 30 minutos serian
   ~1440 al mes: se agotarian en diez dias. Asi que pedimos cuotas solo
   cuando hay un partido cerca, y con un intervalo minimo entre llamadas.
   En dia de partidos son ~10 creditos; en dia muerto, cero.            */
function tocaPedirCuotas(ps, ultima) {
  const ahora = Date.now();
  const proximos = ps
    .filter(p => ["NS","TIMED","SCHEDULED"].includes(p.estado) && p.utc)
    .map(p => Date.parse(p.utc) - ahora)
    .filter(ms => ms > 0);
  if (!proximos.length) return { si: false, razon: "no hay partidos por jugar" };
  const faltan = Math.min(...proximos) / 3600e3;                 // horas
  if (faltan > 24) return { si: false, razon: `el proximo partido es en ${faltan.toFixed(0)} h` };
  const minutosDesde = ultima ? (ahora - Date.parse(ultima)) / 60000 : Infinity;
  const espera = faltan <= 3 ? 30 : 120;                          // minutos
  if (minutosDesde < espera)
    return { si: false, razon: `ultima consulta hace ${minutosDesde.toFixed(0)} min (espero ${espera})` };
  return { si: true, razon: `proximo partido en ${faltan.toFixed(1)} h` };
}

async function cuotas(ps) {
  if (!ODDS_KEY) { aviso("Sin ODDS_API_KEY: no traigo cuotas. El tablero deja los campos vacíos para que las escribas."); return {}; }
  const u = new URL("https://api.the-odds-api.com/v4/sports/soccer_uefa_champs_league/odds");
  u.searchParams.set("apiKey", ODDS_KEY);
  u.searchParams.set("regions", "eu");        // una sola región = 1 crédito
  u.searchParams.set("markets", "h2h");       // un solo mercado
  u.searchParams.set("oddsFormat", "decimal");
  const j = await pedir(u, {}, "odds/h2h");
  if (!Array.isArray(j)) return {};

  // Solo partidos que NO han empezado. Las cuotas en vivo de un partido
  // que va 2-3 no se pueden comparar contra un modelo previo al saque:
  // el "valor" que saldria de ahi seria basura.
  const previos = ps.filter(p => ["NS","TIMED","SCHEDULED"].includes(p.estado));
  const enJuego = ps.length - previos.length;
  if (enJuego) aviso(`${enJuego} partido(s) ya empezaron: omito sus cuotas (serian en vivo y el modelo es previo).`);

  const out = {};
  for (const ev of j) {
    const t = Date.parse(ev.commence_time || 0);
    // Un nombre corto puede ser subcadena de varios ("Sporting" cabe en
    // Sporting CP y Sporting Gijon). Si hay más de un candidato, no
    // adivinamos: preferimos quedarnos sin cuota que ponersela al
    // partido equivocado.
    const cands = previos.filter(p => {
      const dt = Math.abs(Date.parse(p.utc || 0) - t);
      return dt < 6 * 3600e3 && mismoEquipo(p.local, ev.home_team) && mismoEquipo(p.visita, ev.away_team);
    });
    if (cands.length !== 1) {
      if (cands.length > 1)
        aviso(`"${ev.home_team} vs ${ev.away_team}" empareja con ${cands.length} partidos: lo omito por ambiguo.`);
      continue;
    }
    const fx = cands[0];
    const mejor = { H: 0, D: 0, A: 0 };
    for (const casa of ev.bookmakers || [])
      for (const mk of casa.markets || [])
        for (const o of mk.outcomes || []) {
          const k = o.name === ev.home_team ? "H" : o.name === ev.away_team ? "A" : "D";
          if (o.price > mejor[k]) mejor[k] = o.price;
        }
    if (mejor.H && mejor.D && mejor.A) out[fx.id] = [mejor.H, mejor.D, mejor.A];
  }
  const sin = previos.length - Object.keys(out).length;
  if (sin > 0) aviso(`${sin} partido(s) por jugar sin cuotas emparejadas (nombres distintos entre fuentes).`);
  return out;
}

/* ═══════════ API-Football (solo si hay plan de paga) ═══════════ */
async function estadisticas(ps) {
  if (!AF_KEY) return {};
  const out = {};
  for (const p of ps) {
    const u = new URL("https://v3.football.api-sports.io/fixtures");
    u.searchParams.set("date", (p.utc || "").slice(0, 10));
    u.searchParams.set("league", "2");
    const j = await pedir(u, { "x-apisports-key": AF_KEY }, `af/fixtures-${p.id}`);
    const errs = j?.errors;
    if (errs && Object.keys(errs).length) { aviso(`API-Football: ${JSON.stringify(errs)}`); return out; }
    // emparejamos por nombre y pedimos estadísticas de ese fixture
    const cand = (j?.response || []).find(f =>
      norm(f.teams?.home?.name).includes(norm(p.local).slice(0, 6)));
    if (!cand) continue;
    const s = await pedir(
      `https://v3.football.api-sports.io/fixtures/statistics?fixture=${cand.fixture.id}`,
      { "x-apisports-key": AF_KEY }, `af/stats-${cand.fixture.id}`);
    const r = s?.response || [];
    if (r.length < 2) continue;
    const lee = (eq, t) => eq?.statistics?.find(x => x.type === t)?.value ?? null;
    out[p.id] = {
      remates:   [lee(r[0], "Total Shots"),     lee(r[1], "Total Shots")],
      aPuerta:   [lee(r[0], "Shots on Goal"),   lee(r[1], "Shots on Goal")],
      corners:   [lee(r[0], "Corner Kicks"),    lee(r[1], "Corner Kicks")],
      amarillas: [lee(r[0], "Yellow Cards"),    lee(r[1], "Yellow Cards")],
      rojas:     [lee(r[0], "Red Cards"),       lee(r[1], "Red Cards")]
    };
  }
  return out;
}


/* ═══════════ picks del modelo (apuestas de papel) ═══════════
   El modelo deja su pronostico ANTES de cada partido y no lo vuelve a
   tocar. Es lo que hace que el registro valga: un pronostico que se
   puede editar despues del resultado no prueba nada. Cada entrada se
   escribe una sola vez y luego solo se le añade el marcador final.   */
const EMPEZADOS = ["LIVE","HT","FT","AET","PEN","1H","2H"];

async function picksDelModelo(ps, rec) {
  const ARCH = join(DATA, "picks-modelo.json");
  let previos = [];
  try { previos = JSON.parse(await readFile(ARCH, "utf8")); } catch (e) {}
  if (!Array.isArray(previos)) previos = [];

  const { eq, ajustados, info } = cargarEquipos();
  const yaTiene = new Set(previos.map(x => String(x.fixId)));
  let nuevos = 0, sinCalificar = 0;

  for (const p of ps) {
    if (EMPEZADOS.includes(p.estado)) continue;      // tarde para pronosticar
    if (yaTiene.has(String(p.id))) continue;         // ya se comprometio
    const h = corto(p.local), a = corto(p.visita);
    const md = modelo(eq, h, a);
    if (!md) { aviso(`Sin calificacion para ${h} o ${a}: no registro picks de ese partido.`); continue; }
    const sello = new Date().toISOString();
    for (const pk of picksDe(md, h, a)) {
      previos.push({ fixId: p.id, partido: `${h} vs ${a}`, utc: p.utc,
        grupo: pk.grupo, etiqueta: pk.etiqueta, k: pk.k, p: pk.p,
        registradoEl: sello, gl: null, gv: null, ok: null });
      nuevos++;
    }
  }

  // liquidacion: buscamos el marcador final entre los de hoy y los recientes
  const finales = new Map();
  for (const f of [...ps, ...rec])
    if (["FT","AET","PEN"].includes(f.estado) && f.golesLocal != null)
      finales.set(String(f.id), [f.golesLocal, f.golesVisita]);
  for (const x of previos) {
    if (x.ok !== null && x.ok !== undefined) continue;
    const m = finales.get(String(x.fixId));
    if (!m) { sinCalificar++; continue; }
    x.gl = m[0]; x.gv = m[1];
    x.ok = resolver(x.k, m[0], m[1]);
  }

  previos.sort((a, b) => String(b.utc || "").localeCompare(String(a.utc || "")));
  if (previos.length > 3000) previos.length = 3000;
  await writeFile(ARCH, JSON.stringify(previos, null, 1));

  const califs = previos.filter(x => x.ok === true || x.ok === false);
  const aciertos = califs.filter(x => x.ok).length;
  const brier = califs.length
    ? califs.reduce((s, x) => s + Math.pow(x.p - (x.ok ? 1 : 0), 2), 0) / califs.length : null;
  console.log(`  picks del modelo: ${nuevos} nuevos · ${califs.length} calificados` +
    (califs.length ? ` · ${aciertos} aciertos (${(aciertos / califs.length * 100).toFixed(0)}%) · Brier ${brier.toFixed(3)}` : ""));
  return { total: previos.length, nuevos, calificados: califs.length, aciertos,
    brier: brier === null ? null : +brier.toFixed(4), equiposAjustados: ajustados, ajuste: info };
}

/* ═══════════ principal ═══════════ */
async function main() {
  await mkdir(DATA, { recursive: true });
  console.log(`${hoyISO()} · modo ${FULL ? "completo" : "ligero"}`);

  if (!FD_KEY) {
    console.error("✗ Falta FOOTBALL_DATA_KEY — es la fuente principal y es gratis.");
    console.error("  Regístrate en football-data.org/client/register");
    console.error("  Luego: repo → Settings → Secrets and variables → Actions → New repository secret");
    diag.errores.push({ donde: "config", error: "FOOTBALL_DATA_KEY ausente" });
    await writeFile(join(DATA, "diagnostico.json"), JSON.stringify(diag, null, 1));
    process.exit(1);
  }

  const ps = await partidos();
  console.log(`${ps.length} partido(s)`);
  const tb = await tabla();
  // Siempre, no solo en modo completo: el cuaderno necesita los
  // marcadores finales para calificar los pronosticos de dias previos.
  const rec = await recientes();
  // ¿gastamos un credito de cuotas en esta corrida?
  let metaPrev = {};
  try { metaPrev = JSON.parse(await readFile(join(DATA, "meta.json"), "utf8")); } catch (e) {}
  let cuotasPrev = {};
  try { cuotasPrev = JSON.parse(await readFile(join(DATA, "odds.json"), "utf8")); } catch (e) {}
  const decision = tocaPedirCuotas(ps, metaPrev.ultimaConsultaCuotas);
  let cu = cuotasPrev, ultimaCuota = metaPrev.ultimaConsultaCuotas || null;
  if (ODDS_KEY && decision.si) {
    cu = await cuotas(ps);
    ultimaCuota = new Date().toISOString();
    console.log(`  cuotas pedidas (${decision.razon})`);
  } else {
    console.log(`  cuotas: no pido (${decision.razon}) — conservo las ${Object.keys(cuotasPrev).length} que ya tenia`);
  }
  const stats = FULL && AF_KEY ? await estadisticas(ps.filter(p => p.estado === "FT")) : {};
  const picks = await picksDelModelo(ps, rec).catch(e => { nota("picks-modelo", e.message); return null; });

  diag.fuentes = {
    calendarioYTabla: "football-data.org (gratis, temporada en curso)",
    cuotas: ODDS_KEY ? "the-odds-api.com" : "sin configurar",
    estadisticas: AF_KEY ? "API-Football" : "sin configurar (requiere plan de paga)"
  };

  const meta = {
    actualizado: new Date().toISOString(),
    fuente: "football-data.org" + (ODDS_KEY ? " + the-odds-api" : ""),
    partidos: ps.length, equiposEnTabla: tb.length,
    partidosConCuotas: Object.keys(cu).length,
    resultadosRecientes: rec.length,
    ultimaConsultaCuotas: ultimaCuota,
    picksModelo: picks
  };

  await Promise.all([
    writeFile(join(DATA, "fixtures.json"),   JSON.stringify(ps, null, 1)),
    writeFile(join(DATA, "standings.json"),  JSON.stringify(tb, null, 1)),
    writeFile(join(DATA, "odds.json"),       JSON.stringify(cu, null, 1)),
    writeFile(join(DATA, "stats.json"),      JSON.stringify(stats, null, 1)),
    writeFile(join(DATA, "recientes.json"),  JSON.stringify(rec, null, 1)),
    writeFile(join(DATA, "meta.json"),       JSON.stringify(meta, null, 1)),
    writeFile(join(DATA, "diagnostico.json"),JSON.stringify(diag, null, 1))
  ]);

  console.log(`\n${ps.length} partidos · ${tb.length} en tabla · ${Object.keys(cu).length} con cuotas · ${rec.length} resultados recientes`);
  if (diag.avisos.length)  { console.log("\nAvisos:");  diag.avisos.forEach(a => console.log("  ⚠ " + a)); }
  if (diag.errores.length) { console.log("\nFallos (detalle en data/diagnostico.json):");
                             diag.errores.forEach(e => console.log(`  ✗ ${e.donde} → ${e.error}`)); }
}

main().catch(async e => {
  console.error("Error inesperado:", e);
  try {
    await mkdir(DATA, { recursive: true });
    diag.errores.push({ donde: "main", error: String(e?.stack || e) });
    await writeFile(join(DATA, "diagnostico.json"), JSON.stringify(diag, null, 1));
  } catch {}
  process.exit(1);
});
