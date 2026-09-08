/**
 * Proxy en Cloudflare Workers para API-Football.
 *
 * Para qué sirve: la página no puede llamar a la API directamente sin
 * meter tu llave en el HTML, donde cualquiera la ve y la gasta. Este
 * Worker guarda la llave del lado del servidor, solo deja pasar las rutas
 * que autorizamos y cachea las respuestas para no quemar el cupo diario.
 *
 * Plan gratuito de Cloudflare: 100 000 peticiones al día, 10 ms de CPU
 * por petición. Sobra de largo.
 *
 * Despliegue:
 *   npm i -g wrangler
 *   wrangler secret put API_FOOTBALL_KEY
 *   wrangler deploy
 */

const RUTAS_PERMITIDAS = new Set([
  "/fixtures",
  "/fixtures/statistics",
  "/fixtures/lineups",
  "/fixtures/events",
  "/fixtures/headtohead",
  "/standings",
  "/odds",
  "/injuries"
]);

// Cuánto cachear cada ruta. Los partidos en vivo cambian rápido; la
// tabla y el historial casi nunca. Cachear es lo que hace que el plan
// gratuito de 100 peticiones al día alcance para una jornada entera.
const CACHE_SEGUNDOS = {
  "/fixtures": 30,
  "/fixtures/statistics": 60,
  "/fixtures/events": 30,
  "/fixtures/lineups": 300,
  "/fixtures/headtohead": 86400,
  "/standings": 900,
  "/odds": 300,
  "/injuries": 3600
};

const cors = origen => ({
  "Access-Control-Allow-Origin": origen,
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400"
});

export default {
  async fetch(request, env, ctx) {
    // ORIGEN_PERMITIDO es tu dominio de GitHub Pages, p.ej.
    // https://adriancanudas.github.io — ponlo como variable en wrangler.toml
    const origen = env.ORIGEN_PERMITIDO || "*";

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors(origen) });
    }
    if (request.method !== "GET") {
      return new Response("Solo GET", { status: 405, headers: cors(origen) });
    }

    const url = new URL(request.url);
    const ruta = url.pathname.replace(/\/+$/, "") || "/fixtures";

    if (!RUTAS_PERMITIDAS.has(ruta)) {
      return Response.json(
        { error: "Ruta no permitida", permitidas: [...RUTAS_PERMITIDAS] },
        { status: 403, headers: cors(origen) }
      );
    }
    if (!env.API_FOOTBALL_KEY) {
      return Response.json(
        { error: "Falta el secreto API_FOOTBALL_KEY en el Worker" },
        { status: 500, headers: cors(origen) }
      );
    }

    const destino = new URL("https://v3.football.api-sports.io" + ruta);
    for (const [k, v] of url.searchParams) destino.searchParams.set(k, v);

    // caché de borde: varias visitas a la página comparten una sola
    // llamada real a la API
    const clave = new Request(destino.toString(), { method: "GET" });
    const cache = caches.default;
    let respuesta = await cache.match(clave);

    if (!respuesta) {
      const arriba = await fetch(destino, {
        headers: { "x-apisports-key": env.API_FOOTBALL_KEY }
      });
      const cuerpo = await arriba.text();
      const ttl = CACHE_SEGUNDOS[ruta] ?? 60;
      respuesta = new Response(cuerpo, {
        status: arriba.status,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": `public, max-age=${ttl}`,
          "X-Cuaderno-Cache": "MISS"
        }
      });
      if (arriba.ok) ctx.waitUntil(cache.put(clave, respuesta.clone()));
    } else {
      respuesta = new Response(respuesta.body, respuesta);
      respuesta.headers.set("X-Cuaderno-Cache", "HIT");
    }

    for (const [k, v] of Object.entries(cors(origen))) respuesta.headers.set(k, v);
    return respuesta;
  }
};
