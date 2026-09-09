#!/usr/bin/env node
/**
 * Ajusta los parámetros del modelo sobre partidos reales.
 * Esto es lo que convierte el tablero de "opinión estructurada" en modelo.
 *
 *   node scripts/fit-model.mjs historico/*.csv
 *
 * Espera CSVs de football-data.co.uk (E0.csv, SP1.csv, D1.csv, I1.csv,
 * F1.csv, P1.csv, N1.csv, B1.csv ...). Descárgalos desde el navegador en
 * https://www.football-data.co.uk/data.php y déjalos en historico/.
 * Columnas que usa: Date, HomeTeam, AwayTeam, FTHG, FTAG, HS, AS, HST,
 * AST, HC, AC, HY, AY, HR, AR, Referee.
 *
 * Método: máxima verosimilitud Poisson por ajuste proporcional iterativo
 * con decaimiento temporal exponencial (media vida configurable). Es el
 * mismo esquema de Dixon-Coles (1997) sin el término de dependencia, que
 * se aplica después en el tablero.
 *
 * Salida: data/params.json — el tablero lo carga y sustituye mis valores
 * a priori.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MEDIA_VIDA_DIAS = Number(process.env.HALF_LIFE || 240); // ~1.5 temporadas
const ITERACIONES = 60;

const archivos = process.argv.slice(2);
if (!archivos.length) {
  console.error("Uso: node scripts/fit-model.mjs historico/*.csv");
  process.exit(1);
}

/* ---------- lectura ---------- */
function parseCSV(txt) {
  const lineas = txt.split(/\r?\n/).filter(l => l.trim());
  const cab = lineas[0].split(",").map(s => s.trim());
  return lineas.slice(1).map(l => {
    const c = l.split(",");
    const o = {};
    cab.forEach((k, i) => o[k] = (c[i] ?? "").trim());
    return o;
  });
}
function fecha(s) {
  // football-data usa dd/mm/yy o dd/mm/yyyy
  const [d, m, y] = (s || "").split("/");
  if (!d) return null;
  const año = y?.length === 2 ? 2000 + Number(y) : Number(y);
  return new Date(Date.UTC(año, Number(m) - 1, Number(d)));
}

/* De qué liga es cada archivo. football-data.co.uk usa estos códigos y
   nosotros los traducimos a los de football-data.org, que es lo que el
   tablero entiende.                                                     */
const LIGA_DE = { E0:"PL", E1:"ELC", SP1:"PD", D1:"BL1", I1:"SA", F1:"FL1",
                  N1:"DED", P1:"PPL", B1:"JPL", SC0:"SPL", T1:"TSL", G1:"GSL" };
const ligaDeArchivo = ruta => {
  const base = ruta.split(/[\\/]/).pop().replace(/\.csv$/i, "").replace(/\s*\(\d+\)$/, "").trim();
  return LIGA_DE[base] || base;
};

const partidos = [];
for (const f of archivos) {
  const LIGA = ligaDeArchivo(f);
  let filas;
  try { filas = parseCSV(readFileSync(f, "utf8")); }
  catch (e) { console.warn(`saltando ${f}: ${e.message}`); continue; }
  for (const r of filas) {
    const fe = fecha(r.Date);
    const gl = Number(r.FTHG), gv = Number(r.FTAG);
    if (!fe || !r.HomeTeam || !r.AwayTeam || !Number.isFinite(gl) || !Number.isFinite(gv)) continue;
    partidos.push({
      fecha: fe, local: r.HomeTeam, visita: r.AwayTeam, gl, gv,
      rl: Number(r.HS), rv: Number(r.AS),
      pl: Number(r.HST), pv: Number(r.AST),
      cl: Number(r.HC), cv: Number(r.AC),
      tl: Number(r.HY) + 2 * (Number(r.HR) || 0),
      tv: Number(r.AY) + 2 * (Number(r.AR) || 0),
      arbitro: r.Referee || null,
      liga: LIGA
    });
  }
}
if (!partidos.length) { console.error("Ningún partido legible."); process.exit(1); }
partidos.sort((a, b) => a.fecha - b.fecha);
const hoy = partidos[partidos.length - 1].fecha;
const LAMBDA = Math.log(2) / MEDIA_VIDA_DIAS;
for (const p of partidos) {
  const dias = (hoy - p.fecha) / 86400000;
  p.w = Math.exp(-LAMBDA * dias);   // peso: los partidos viejos pesan menos
}
console.log(`${partidos.length} partidos, de ${partidos[0].fecha.toISOString().slice(0,10)} a ${hoy.toISOString().slice(0,10)}`);
console.log(`Media vida ${MEDIA_VIDA_DIAS} días → el partido más antiguo pesa ${(partidos[0].w*100).toFixed(1)}%`);

/* ---------- ajuste de ataque y defensa ---------- */
const equipos = [...new Set(partidos.flatMap(p => [p.local, p.visita]))].sort();
const att = {}, def = {};
equipos.forEach(t => { att[t] = 1; def[t] = 1; });

let W = 0, GL = 0, GV = 0;
for (const p of partidos) { W += p.w; GL += p.w * p.gl; GV += p.w * p.gv; }
const mediaLocal = GL / W, mediaVisita = GV / W;
const BASE = (mediaLocal + mediaVisita) / 2;
const HFA_H = mediaLocal / BASE, HFA_A = mediaVisita / BASE;
console.log(`Goles medios: ${mediaLocal.toFixed(3)} local / ${mediaVisita.toFixed(3)} visita`);
console.log(`Base ${BASE.toFixed(3)} · factor local ${HFA_H.toFixed(3)} · factor visita ${HFA_A.toFixed(3)}`);

for (let it = 0; it < ITERACIONES; it++) {
  const numA = {}, denA = {}, numD = {}, denD = {};
  equipos.forEach(t => { numA[t] = denA[t] = numD[t] = denD[t] = 0; });
  for (const p of partidos) {
    // ataque: goles marcados / goles que "debería" marcar contra esa defensa
    numA[p.local]  += p.w * p.gl;  denA[p.local]  += p.w * BASE * def[p.visita] * HFA_H;
    numA[p.visita] += p.w * p.gv;  denA[p.visita] += p.w * BASE * def[p.local]  * HFA_A;
    // defensa: goles recibidos / goles que "debería" recibir de ese ataque
    numD[p.visita] += p.w * p.gl;  denD[p.visita] += p.w * BASE * att[p.local]  * HFA_H;
    numD[p.local]  += p.w * p.gv;  denD[p.local]  += p.w * BASE * att[p.visita] * HFA_A;
  }
  for (const t of equipos) {
    if (denA[t] > 0) att[t] = numA[t] / denA[t];
    if (denD[t] > 0) def[t] = numD[t] / denD[t];
  }
  // normalizamos para que el equipo promedio siga valiendo 1.00
  const mA = equipos.reduce((s, t) => s + att[t], 0) / equipos.length;
  const mD = equipos.reduce((s, t) => s + def[t], 0) / equipos.length;
  equipos.forEach(t => { att[t] /= mA; def[t] /= mD; });
}

/* ---------- tasas de remates, córners y tarjetas ---------- */
const acc = {};
const nuevo = () => ({ w: 0, rf: 0, rc: 0, cf: 0, cc: 0, tf: 0 });
for (const t of equipos) acc[t] = nuevo();
for (const p of partidos) {
  const A = acc[p.local], B = acc[p.visita];
  A.w += p.w; B.w += p.w;
  const num = v => Number.isFinite(v) ? v : 0;
  A.rf += p.w * num(p.rl); A.rc += p.w * num(p.rv);
  B.rf += p.w * num(p.rv); B.rc += p.w * num(p.rl);
  A.cf += p.w * num(p.cl); A.cc += p.w * num(p.cv);
  B.cf += p.w * num(p.cv); B.cc += p.w * num(p.cl);
  A.tf += p.w * num(p.tl); B.tf += p.w * num(p.tv);
}
const tarjMedia = partidos.reduce((s, p) => s + p.w * ((p.tl || 0) + (p.tv || 0)), 0) / W;

/* ---------- árbitros ---------- */
const arb = {};
for (const p of partidos) {
  if (!p.arbitro) continue;
  arb[p.arbitro] ??= { w: 0, t: 0, n: 0 };
  arb[p.arbitro].w += p.w;
  arb[p.arbitro].t += p.w * ((p.tl || 0) + (p.tv || 0));
  arb[p.arbitro].n++;
}

/* ---------- normalización por liga ----------
   El ajuste de arriba pone la media en 1.00 sobre TODOS los equipos de
   TODAS las ligas juntas. Para un partido de Champions eso está bien
   (equipos de ligas distintas se enfrentan), pero para un partido
   doméstico es incorrecto: si LaLiga entera es más goleadora que la
   Ligue 1, sus equipos quedan inflados y los goles esperados de un
   Madrid-Betis salen mal.

   Así que guardamos DOS juegos de calificaciones: uno normalizado dentro
   de cada liga, con la media de goles de esa liga, y otro reescalado a
   nivel Champions. El tablero usa el que corresponda a la competición.  */
const ligas = {};
for (const p of partidos) {
  const L = ligas[p.liga] ??= { w: 0, gl: 0, gv: 0, equipos: new Set() };
  L.w += p.w; L.gl += p.w * p.gl; L.gv += p.w * p.gv;
  L.equipos.add(p.local); L.equipos.add(p.visita);
}
const teamLiga = {};
for (const p of partidos) { teamLiga[p.local] = p.liga; teamLiga[p.visita] = p.liga; }

const infoLigas = {};
for (const [cod, L] of Object.entries(ligas)) {
  const eq = [...L.equipos].filter(t => att[t]);
  if (eq.length < 6) continue;
  const mLocal = L.gl / L.w, mVisita = L.gv / L.w;
  const base = (mLocal + mVisita) / 2;
  const mA = eq.reduce((s, t) => s + att[t], 0) / eq.length;
  const mD = eq.reduce((s, t) => s + def[t], 0) / eq.length;
  infoLigas[cod] = { base: +base.toFixed(3),
    hfaLocal: +(mLocal / base).toFixed(3), hfaVisita: +(mVisita / base).toFixed(3),
    equipos: eq.length, partidos: partidos.filter(p => p.liga === cod).length,
    escalaAtt: +mA.toFixed(4), escalaDef: +mD.toFixed(4) };
}
console.log("\nPor liga (1.00 = equipo medio DE ESA liga):");
for (const [c, v] of Object.entries(infoLigas))
  console.log(`  ${c.padEnd(5)} ${String(v.partidos).padStart(4)} partidos · ${v.equipos} equipos · ${v.base.toFixed(2)} goles/equipo · local ×${v.hfaLocal}`);

/* ---------- reescalado a nivel Champions ----------
   PASO CRÍTICO. El ajuste de arriba deja el promedio en 1.00 sobre los
   110 equipos de las cinco ligas domésticas. Pero el modelo del tablero
   define 1.00 como "equipo promedio DE LA FASE LIGA", que es mucho más
   fuerte: son los mejores de cada liga. Sin reescalar, el ataque de 2.11
   del Bayern (que es 2.11 veces el promedio de la Bundesliga) entraría
   como si fuera 2.11 veces el promedio de la Champions, e inflaría los
   goles esperados de forma absurda.

   Además hay equipos de la fase liga que no juegan en estas cinco ligas
   (Porto, Brujas, PSV, Galatasaray...). Esos conservan valores a priori
   que YA están en escala Champions. Reescalar es lo que hace que unos y
   otros sean comparables entre sí.                                    */
const EN_CHAMPIONS = ["Bayern Munich","Real Madrid","Man City","Liverpool","Arsenal","Barcelona",
  "Paris SG","Inter","Ath Madrid","Napoli","Dortmund","Man United","Leipzig","Aston Villa",
  "Roma","Villarreal","Lille","Betis","Lens","Como","Stuttgart","Juventus","Marseille","Monaco",
  "Atalanta","Leverkusen","Sociedad","Newcastle","Tottenham","Chelsea","Milan","Ath Bilbao"];
const enCL = EN_CHAMPIONS.filter(t => att[t] && acc[t] && acc[t].w >= 5);
let ESCALA_ATT = 1, ESCALA_DEF = 1;
if (enCL.length >= 8) {
  ESCALA_ATT = enCL.reduce((s, t) => s + att[t], 0) / enCL.length;
  ESCALA_DEF = enCL.reduce((s, t) => s + def[t], 0) / enCL.length;
  console.log(`\nReescalado a nivel Champions con ${enCL.length} equipos de referencia:`);
  console.log(`  ataque ÷${ESCALA_ATT.toFixed(3)} · defensa ÷${ESCALA_DEF.toFixed(3)}`);
} else {
  console.warn(`\n⚠ Solo ${enCL.length} equipos de referencia: NO reescalo.`);
  console.warn("  Los valores quedan en escala doméstica y NO son comparables con los a priori.");
}
// lo mismo con remates y córners: la referencia es el equipo de Champions
const refCL = t => acc[t] && acc[t].w >= 5;
const media = f => { const v = enCL.filter(refCL).map(f); return v.reduce((a, b) => a + b, 0) / v.length; };
const M_RF = enCL.length >= 8 ? media(t => acc[t].rf / acc[t].w) : null;
const M_CF = enCL.length >= 8 ? media(t => acc[t].cf / acc[t].w) : null;

/* ---------- salida ---------- */
const teams = {};
for (const t of equipos) {
  const a = acc[t];
  if (a.w < 5) continue;                       // muy pocos partidos: no es señal
  // Los remates y córners se dejan en su escala absoluta (son conteos por
  // partido, no ratios), pero se corrigen por el nivel de oposición: un
  // equipo de Champions remata menos contra rivales de Champions.
  const kR = M_RF ? (12.9 / M_RF) : 1;   // 12.9 remates = referencia de fase liga
  const kC = M_CF ? (5.3 / M_CF) : 1;    // 5.3 córners  = referencia de fase liga
  teams[t] = [
    +(att[t] / ESCALA_ATT).toFixed(3), +(def[t] / ESCALA_DEF).toFixed(3),
    +((a.rf / a.w) * kR).toFixed(2), +((a.rc / a.w) * kR).toFixed(2),
    +((a.cf / a.w) * kC).toFixed(2), +((a.cc / a.w) * kC).toFixed(2),
    +((a.tf / a.w) / (tarjMedia / 2)).toFixed(3)   // indisciplina relativa
  ];
}
const refs = {};
for (const [r, v] of Object.entries(arb)) {
  if (v.n < 12) continue;                      // menos de 12 partidos es ruido
  refs[r] = [+(v.t / v.w).toFixed(2), 1, v.n];  // [tarjetas/partido, verificado, n]
}

// calificaciones en escala de su propia liga
const teamsDom = {};
for (const t of Object.keys(teams)) {
  const L = infoLigas[teamLiga[t]];
  if (!L) continue;
  const v = teams[t].slice();
  // deshacemos el reescalado a Champions y aplicamos el de su liga
  v[0] = +(att[t] / L.escalaAtt).toFixed(3);
  v[1] = +(def[t] / L.escalaDef).toFixed(3);
  teamsDom[t] = v;
}

const out = {
  ajustadoEl: new Date().toISOString(),
  partidos: partidos.length,
  desde: partidos[0].fecha.toISOString().slice(0, 10),
  hasta: hoy.toISOString().slice(0, 10),
  mediaVidaDias: MEDIA_VIDA_DIAS,
  base: +BASE.toFixed(3), hfaLocal: +HFA_H.toFixed(3), hfaVisita: +HFA_A.toFixed(3),
  tarjetasMedia: +tarjMedia.toFixed(2),
  ligas: infoLigas, teamLiga, teamsDom,
  teams, refs
};
mkdirSync(join(ROOT, "data"), { recursive: true });
writeFileSync(join(ROOT, "data", "params.json"), JSON.stringify(out, null, 1));

console.log(`\n${Object.keys(teams).length} equipos y ${Object.keys(refs).length} árbitros ajustados.`);
const orden = Object.entries(teams).sort((a, b) => b[1][0] - a[1][0]);
console.log("\nMejores ataques (escala Champions, 1.00 = equipo medio de fase liga):");
console.log("  " + orden.slice(0, 8).map(([t, v]) => `${t} ${v[0]}`).join(" · "));
console.log("Mejores defensas:");
console.log("  " + Object.entries(teams).sort((a, b) => a[1][1] - b[1][1])
  .slice(0, 8).map(([t, v]) => `${t} ${v[1]}`).join(" · "));
const ordArb = Object.entries(refs).sort((a, b) => b[1][0] - a[1][0]);
if (ordArb.length) {
  console.log("\nÁrbitros más severos: " + ordArb.slice(0, 4).map(([r, v]) => `${r} ${v[0]}`).join(" · "));
  console.log("Más permisivos:       " + ordArb.slice(-4).map(([r, v]) => `${r} ${v[0]}`).join(" · "));
}
console.log("\nEscrito en data/params.json");
