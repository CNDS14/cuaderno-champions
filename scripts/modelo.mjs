/**
 * Núcleo del modelo, compartido entre el tablero y el recolector.
 *
 * Las calificaciones a priori viven en index.html (constante T0) y este
 * módulo las LEE DE AHÍ en vez de tener su propia copia. Es deliberado:
 * dos copias de los mismos números se desincronizan sin que nadie lo
 * note, y entonces los picks que registra el bot dejan de ser los que
 * muestra la página. Una sola fuente, aunque el camino sea raro.
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function bloque(html, re, nombre) {
  const m = html.match(re);
  if (!m) throw new Error(`No pude extraer ${nombre} de index.html — cambió el formato.`);
  return m[0];
}
const HTML = readFileSync(join(ROOT, "index.html"), "utf8");
const src = [
  bloque(HTML, /const T0=\{[\s\S]*?\n\};/, "T0"),
  bloque(HTML, /const ALIAS=\{[\s\S]*?\};/, "ALIAS"),
  bloque(HTML, /const _GEN=[\s\S]*?return r\|\|n;\n\}/, "el resolvedor de nombres")
].join("\n");
const { T0, corto } = new Function(src + "; return {T0, corto};")();
export { T0, corto };

/* Parámetros ajustados, si existen: sustituyen a los a priori.
   Devolvemos DOS escalas. `eq` está en nivel Champions (para partidos
   entre equipos de ligas distintas) y `eqDom` en nivel de cada liga
   (para partidos domésticos). Usar la escala equivocada desplaza los
   goles esperados alrededor de un 10%, que en cuotas es muchísimo.   */
export function cargarEquipos() {
  const eq = JSON.parse(JSON.stringify(T0));
  const eqDom = {};
  let ajustados = 0, info = null, ligas = {}, teamLiga = {};
  try {
    const P = JSON.parse(readFileSync(join(ROOT, "data", "params.json"), "utf8"));
    info = { partidos: P.partidos, desde: P.desde, hasta: P.hasta };
    ligas = P.ligas || {};
    for (const [n, v] of Object.entries(P.teams || {})) {
      const k = corto(n);
      if (eq[k]) { eq[k] = v; ajustados++; }
    }
    for (const [n, v] of Object.entries(P.teamsDom || {})) eqDom[corto(n)] = v;
    for (const [n, L] of Object.entries(P.teamLiga || {})) teamLiga[corto(n)] = L;
  } catch (e) { /* sin ajuste: seguimos con los a priori */ }
  return { eq, eqDom, ligas, teamLiga, ajustados, info };
}

/* ---------- Dixon-Coles ---------- */
const MAXG = 11, RHO = -0.03;
/* Referencia de la fase liga de Champions. Para las ligas domésticas
   usamos su propia media de goles y su propia ventaja de local, que el
   ajuste calcula: la Bundesliga produce 1.64 goles por equipo y la
   Serie A 1.25, y tratarlas igual sería un error de 30%.             */
export const REF_CL = { base: 1.45, hfaLocal: 1.12, hfaVisita: 0.90 };
const fc = [1]; for (let i = 1; i < 40; i++) fc[i] = fc[i - 1] * i;
const pois = (k, l) => Math.exp(-l) * Math.pow(l, k) / fc[k];
const tau = (x, y, lh, la) =>
  x === 0 && y === 0 ? 1 - lh * la * RHO :
  x === 0 && y === 1 ? 1 + lh * RHO :
  x === 1 && y === 0 ? 1 + la * RHO :
  x === 1 && y === 1 ? 1 - RHO : 1;

export function modelo(eq, local, visita, ref = REF_CL) {
  const H = eq[local], A = eq[visita];
  if (!H || !A) return null;
  const lh = ref.base * H[0] * A[1] * ref.hfaLocal;
  const la = ref.base * A[0] * H[1] * ref.hfaVisita;
  const g = []; let s = 0;
  for (let i = 0; i < MAXG; i++) { g[i] = [];
    for (let j = 0; j < MAXG; j++) { const v = pois(i, lh) * pois(j, la) * tau(i, j, lh, la); g[i][j] = v; s += v; } }
  for (let i = 0; i < MAXG; i++) for (let j = 0; j < MAXG; j++) g[i][j] /= s;
  const sum = f => { let t = 0; for (let i = 0; i < MAXG; i++) for (let j = 0; j < MAXG; j++) if (f(i, j)) t += g[i][j]; return t; };
  const pH = sum((i, j) => i > j), pD = sum((i, j) => i === j), pA = 1 - pH - pD;
  return { lh, la, pH, pD, pA,
    o15: sum((i, j) => i + j > 1), o25: sum((i, j) => i + j > 2), o35: sum((i, j) => i + j > 3),
    btts: sum((i, j) => i > 0 && j > 0), hcs: sum((i, j) => j === 0), acs: sum((i, j) => i === 0) };
}

/* Un pick por grupo de mercado: el más probable de cada uno. Es una
   apuesta de papel, y se registra ANTES del saque sin volver a tocarse. */
/* Elige la escala correcta segun la competicion del partido. */
export function modeloPara(datos, comp, local, visita) {
  const { eq, eqDom, ligas } = datos;
  if (comp && comp !== "CL" && ligas[comp] && eqDom[local] && eqDom[visita])
    return modelo(eqDom, local, visita, ligas[comp]);
  return modelo(eq, local, visita, REF_CL);
}

export function picksDe(md, local, visita) {
  const grupos = [
    ["Resultado", [[`${local} gana`, md.pH, "1X2::H"], ["Empate", md.pD, "1X2::D"], [`${visita} gana`, md.pA, "1X2::A"]]],
    ["Doble oportunidad", [[`${local} o empate`, md.pH + md.pD, "DO::1X"],
      [`Empate o ${visita}`, md.pD + md.pA, "DO::X2"], ["Cualquiera gana", md.pH + md.pA, "DO::12"]]],
    ["Total de goles", [["Más de 1.5", md.o15, "OU::O|1.5"], ["Menos de 1.5", 1 - md.o15, "OU::U|1.5"],
      ["Más de 2.5", md.o25, "OU::O|2.5"], ["Menos de 2.5", 1 - md.o25, "OU::U|2.5"],
      ["Más de 3.5", md.o35, "OU::O|3.5"], ["Menos de 3.5", 1 - md.o35, "OU::U|3.5"]]],
    ["Ambos anotan", [["Ambos anotan — Sí", md.btts, "AA::S"], ["Ambos anotan — No", 1 - md.btts, "AA::N"]]],
    // Incluimos las negaciones: sin ellas, el pick de este grupo podia
    // quedar por debajo del 50% y "predecir" algo que el propio modelo
    // espera que falle dos de cada tres veces.
    ["Portería a cero", [[`${local} deja el cero`, md.hcs, "PA::L"],
      [`${local} recibe gol`, 1 - md.hcs, "PA::NL"],
      [`${visita} deja el cero`, md.acs, "PA::V"],
      [`${visita} recibe gol`, 1 - md.acs, "PA::NV"]]]
  ];
  return grupos.map(([g, ops]) => {
    const [etiqueta, p, k] = ops.slice().sort((a, b) => b[1] - a[1])[0];
    return { grupo: g, etiqueta, k, p: +p.toFixed(4) };
  });
}

/* ---------- liquidación ---------- */
const REGLAS = {
  "1X2": (g, a, s) => s === "H" ? g > a : s === "D" ? g === a : a > g,
  "DO":  (g, a, s) => s === "1X" ? g >= a : s === "X2" ? a >= g : g !== a,
  "OU":  (g, a, s) => { const [d, l] = s.split("|"); const t = g + a; return d === "O" ? t > +l : t < +l; },
  "AA":  (g, a, s) => s === "S" ? (g > 0 && a > 0) : !(g > 0 && a > 0),
  "PA":  (g, a, s) => s === "L" ? a === 0 : s === "V" ? g === 0 : s === "NL" ? a > 0 : g > 0
};
export function resolver(k, gl, gv) {
  const [mk, sel] = k.split("::");
  const f = REGLAS[mk];
  if (!f || gl == null || gv == null) return null;
  return f(gl, gv, sel);
}
