# Cuaderno de Champions

Modelo estadístico y tablero para la fase liga de la Champions League.
Tres capas independientes: si una falla, las otras siguen funcionando.

```
data/*.json  ←  GitHub Actions (cada 10 min en jornada, diario el resto)  ←  API-Football
     ↓
index.html   →  modelo Dixon–Coles + binomial negativa  →  probabilidades, EV, Kelly
     ↑
Worker de Cloudflare (opcional)  →  marcadores al minuto
```

---

## Puesta en marcha (20 minutos)

### 1. Llave de API-Football

Regístrate gratis en [dashboard.api-football.com](https://dashboard.api-football.com).
El plan gratuito da **100 peticiones al día**, que alcanzan de sobra: una
jornada completa consume entre 12 y 18.

Cubre lo que necesitamos: calendario, marcadores en vivo, alineaciones,
árbitro designado, estadísticas por partido (remates, córners, tarjetas,
posesión), historial entre equipos, lesiones, tabla y cuotas previas y
en juego.

### 2. Subir el repo

```bash
cd cuaderno-champions
git init && git add . && git commit -m "primer commit"
gh repo create cuaderno-champions --public --source=. --push
# o crea el repo a mano en github.com y luego:
#   git remote add origin git@github.com:TU-USUARIO/cuaderno-champions.git
#   git push -u origin main
```

### 3. Guardar la llave y encender Pages

En el repo, **Settings → Secrets and variables → Actions**:

- pestaña *Secrets* → `API_FOOTBALL_KEY` = tu llave
- pestaña *Variables* → `SEASON` = `2026`

En **Settings → Pages**: fuente *Deploy from a branch*, rama `main`, carpeta `/ (root)`.

Queda publicado en `https://TU-USUARIO.github.io/cuaderno-champions/`.

### 4. Primera corrida

Pestaña **Actions → Actualizar datos → Run workflow**. Revisa que
`data/fixtures.json` no salga vacío.

> La primera vez conviene correrlo en local con `DEBUG_SHAPE=1` para ver
> la respuesta cruda y confirmar que los nombres de campo coinciden con
> lo que espera el script. Están tomados de la documentación de
> API-Football, no de una llamada verificada.
>
> ```bash
> DEBUG_SHAPE=1 API_FOOTBALL_KEY=xxxx node scripts/fetch-data.mjs
> cat data/_raw-_fixtures.json | head -60
> ```

---

## Marcadores al minuto (opcional)

GitHub Actions **no baja de 5 minutos** entre corridas y suele retrasarse
entre 5 y 30 en horas pico, así que no sirve para minuto a minuto. Para
eso está el Worker de Cloudflare: guarda la llave del lado del servidor
—en el HTML quedaría a la vista de cualquiera— y cachea las respuestas.

```bash
npm i -g wrangler
cd worker
wrangler secret put API_FOOTBALL_KEY
wrangler deploy
```

Copia la URL que imprime y ponla en `index.html`:

```js
const WORKER_URL = "https://cuaderno-champions-api.TU-USUARIO.workers.dev";
```

La página empieza a consultar marcadores cada 45 segundos. El plan
gratuito de Cloudflare da 100 000 peticiones al día; con el caché del
Worker, cien visitantes simultáneos gastan una sola llamada real.

Cuando tengas el dominio de Pages, cámbialo en `worker/wrangler.toml`
(`ORIGEN_PERMITIDO`) para que nadie más consuma tu cupo.

---

## Ajustar el modelo sobre datos reales

**Este es el paso que más cambia los resultados.** Sin él, los parámetros
son valores a priori: la estructura matemática es correcta, pero los
números son una opinión.

1. Descarga los CSV de [football-data.co.uk/data.php](https://www.football-data.co.uk/data.php).
   Trae, por temporada y liga, marcador, remates, remates a puerta,
   córners, tarjetas y **árbitro** — justo lo que el modelo necesita.
   Bájate las últimas tres temporadas de Inglaterra (E0), España (SP1),
   Alemania (D1), Italia (I1), Francia (F1), Portugal (P1), Países Bajos
   (N1) y Bélgica (B1).
2. Déjalos en `historico/`.
3. Corre el ajuste:

```bash
node scripts/fit-model.mjs historico/*.csv
```

Escribe `data/params.json`, y la página lo carga sola y sustituye mis
valores. La cabecera pasa de decir *"parámetros a priori"* a
*"ajustado sobre N partidos"*.

Método: máxima verosimilitud Poisson por ajuste proporcional iterativo
con decaimiento temporal exponencial. La media vida por defecto es de 240
días — un partido de hace ocho meses pesa la mitad que uno de esta
semana. Cámbiala con `HALF_LIFE=180 node scripts/fit-model.mjs ...`.

Limitación honesta: las ligas domésticas no son la Champions. Un ataque
de 1.30 en la Eredivisie no es un 1.30 europeo. Cuando haya suficientes
partidos de Champions en los datos, conviene añadir un factor de
corrección por liga.

---

## Fuentes de datos evaluadas

| Fuente | Gratis | Sirve para | Límite real |
|---|---|---|---|
| **API-Football** (api-sports.io) | 100 pet./día | Todo: calendario, en vivo, árbitro, estadísticas, alineaciones, lesiones, tabla, cuotas | El cupo diario; temporadas viejas restringidas |
| **football-data.co.uk** | Sí, sin llave | Histórico con remates, córners, tarjetas y árbitro — la base del ajuste | Solo ligas domésticas, no Champions. Descarga manual |
| **The Odds API** | 500 créditos/mes | Segunda fuente de cuotas para comparar precios entre casas | Los créditos se multiplican por región × mercado: se agotan en menos de 85 llamadas |
| **football-data.org** | 10 pet./min | Calendario y tabla, sencillo | Sin remates, córners ni tarjetas |
| **StatsBomb Open Data** | Sí, en GitHub | Eventos con xG de verdad, partido a partido | Competiciones sueltas, no la Champions actual |
| **Understat** | Scraping | xG por partido y equipo | Sin API oficial |

Recomendación: **API-Football para lo del día, football-data.co.uk para
el ajuste histórico.** Con esas dos alcanza; las demás son redundantes.

---

## Estructura

```
index.html                  tablero completo (modelo incluido, sin dependencias)
scripts/fetch-data.mjs      trae los datos del día → data/*.json
scripts/fit-model.mjs       ajusta parámetros sobre CSV históricos → data/params.json
worker/index.js             proxy de Cloudflare para marcadores en vivo
.github/workflows/update.yml  cron de actualización
data/                       JSON generados (los commitea el bot)
historico/                  tus CSV descargados (fuera de git)
```

---

## Lo que este proyecto no hace

- **No garantiza ganancias.** El margen de las casas ronda el 5–6%; hay
  que superarlo antes de ganar un peso. Lo normal es que la mayoría de
  las celdas salgan sin valor: eso significa que el mercado está bien
  puesto, no que el modelo falle.
- **No sabe si funciona hasta que hay registro.** Una ventaja del 3% no
  se distingue del azar en veinte apuestas. Anota cuota tomada y cuota de
  cierre: si superas al cierre de forma sostenida, el modelo sirve aunque
  vayas perdiendo; si no, no sirve aunque vayas ganando.
- **Los córners y las tarjetas son la parte más débil** mientras los
  parámetros no estén ajustados. Van etiquetados como *fiabilidad baja*
  dentro del tablero.
