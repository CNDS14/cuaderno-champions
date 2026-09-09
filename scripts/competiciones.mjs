/**
 * Qué competiciones sigue el tablero.
 *
 * `fd`   — código en football-data.org. Las 12 del plan gratuito son las
 *          únicas que dan calendario, marcadores y tabla sin pagar.
 * `odds` — sport_key de the-odds-api. Null = no pedimos cuotas de esa
 *          competición (el crédito es escaso y se prioriza).
 * `cuotas` — si gasta créditos. Ponlo en false para una liga que sigas
 *          solo para ver resultados.
 */
export const COMPS = [
  { fd:"CL",  nombre:"Champions League", pais:"Europa",       odds:"soccer_uefa_champs_league",   cuotas:true,  activa:true },
  { fd:"PD",  nombre:"LaLiga",           pais:"España",       odds:"soccer_spain_la_liga",        cuotas:true,  activa:true },
  { fd:"PL",  nombre:"Premier League",   pais:"Inglaterra",   odds:"soccer_epl",                  cuotas:true,  activa:true },
  { fd:"SA",  nombre:"Serie A",          pais:"Italia",       odds:"soccer_italy_serie_a",        cuotas:false, activa:true },
  { fd:"BL1", nombre:"Bundesliga",       pais:"Alemania",     odds:"soccer_germany_bundesliga",   cuotas:false, activa:true },
  { fd:"FL1", nombre:"Ligue 1",          pais:"Francia",      odds:"soccer_france_ligue_one",     cuotas:false, activa:true },
  { fd:"DED", nombre:"Eredivisie",       pais:"Países Bajos", odds:"soccer_netherlands_eredivisie", cuotas:false, activa:false },
  { fd:"PPL", nombre:"Primeira Liga",    pais:"Portugal",     odds:"soccer_portugal_primeira_liga", cuotas:false, activa:false },
  { fd:"BSA", nombre:"Brasileirão",      pais:"Brasil",       odds:"soccer_brazil_campeonato",    cuotas:false, activa:false },
  { fd:"ELC", nombre:"Championship",     pais:"Inglaterra",   odds:"soccer_efl_champ",            cuotas:false, activa:false },
  // Liga MX: football-data.org la tiene en LMX pero NO en el plan gratuito
  // (hace falta el Standard de 49 €/mes). Las cuotas sí están disponibles
  // gratis en the-odds-api. Ver el README para las tres salidas posibles.
  { fd:"LMX", nombre:"Liga MX",          pais:"México",       odds:"soccer_mexico_ligamx",        cuotas:true,  activa:false,
    nota:"El calendario y los resultados requieren plan de paga en football-data.org." }
];
export const ACTIVAS = COMPS.filter(c => c.activa);
export const porFd = c => COMPS.find(x => x.fd === c);
