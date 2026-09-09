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

### 1. Llave de football-data.org (gratis, obligatoria)

Regístrate en [football-data.org/client/register](https://www.football-data.org/client/register).
Su plan gratuito **incluye la Champions League y da la temporada en
curso**: calendario, marcadores en vivo, árbitro designado, sede y tabla.
Límite de 10 peticiones por minuto; nosotros gastamos 2 o 3 por corrida.

> **Por qué no API-Football.** Su plan gratuito solo da las temporadas
> 2022 a 2024 — devuelve literalmente *"Free plans do not have access to
> this season, try from 2022 to 2024"*. Sirve solo si contratas el plan
> Pro (19 USD/mes), y entonces añade lo único que football-data.org no
> tiene: remates, córners y tarjetas en vivo. El script lo usa solo si
> defines `API_FOOTBALL_KEY`; si no, sigue sin él.

### 1b. Cuotas (opcional pero recomendado)

Llave gratis en [the-odds-api.com](https://the-odds-api.com): 500
créditos al mes. Cada llamada gasta tantos créditos como regiones ×
mercados pidas, así que el script pide una región y un mercado —
**1 crédito por corrida**. Secreto `ODDS_API_KEY`.

Sin esto el tablero funciona igual, solo que las cuotas las escribes tú.
Y sin cuotas no hay cálculo de valor: el modelo te dice qué es probable,
pero no si conviene.

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

- *Secrets* → `FOOTBALL_DATA_KEY` = tu llave de football-data.org **(obligatoria)**
- *Secrets* → `ODDS_API_KEY` = tu llave de the-odds-api *(opcional)*
- *Secrets* → `API_FOOTBALL_KEY` = solo si contratas el plan Pro *(opcional)*

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
| **football-data.org** ✅ *en uso* | 10 pet./min | Calendario, marcadores en vivo, **árbitro**, sede y tabla — con la temporada en curso | Sin remates, córners ni tarjetas |
| **football-data.co.uk** ✅ *para el ajuste* | Sí, sin llave | Histórico con remates, córners, tarjetas y árbitro — la base del ajuste | Solo ligas domésticas, no Champions. Descarga manual |
| **The Odds API** ✅ *opcional* | 500 créditos/mes | Cuotas reales de varias casas, que es lo que convierte probabilidad en valor | Los créditos se multiplican por región × mercado |
| **API-Football** ❌ *gratis no sirve* | 100 pet./día | Lo tendría todo, incluidas estadísticas por partido | **El plan gratuito solo da 2022–2024.** Necesita Pro, 19 USD/mes |
| **StatsBomb Open Data** | Sí, en GitHub | Eventos con xG de verdad, partido a partido | Competiciones sueltas, no la Champions actual |
| **Understat** | Scraping | xG por partido y equipo | Sin API oficial |

Recomendación: **football-data.org para lo del día, the-odds-api para
las cuotas, football-data.co.uk para el ajuste histórico.** Las tres son
gratis y entre ellas cubren todo menos remates y córners en vivo, que
alimentan justo los mercados menos fiables del modelo.

---

## Competiciones

Se configuran en `scripts/competiciones.mjs`. Poner una en `activa: true`
basta para que el recolector la traiga en la siguiente corrida.

| Competición | Calendario y tabla | Cuotas | Estado |
|---|---|---|---|
| Champions League | gratis | sí | activa |
| LaLiga | gratis | sí | activa |
| Premier League | gratis | sí | activa |
| Serie A | gratis | sin cuotas | activa |
| Bundesliga | gratis | sin cuotas | activa |
| Ligue 1 | gratis | sin cuotas | activa |
| Eredivisie, Primeira, Brasileirão, Championship | gratis | — | listas, apagadas |
| **Liga MX** | **de paga** | gratis | **no disponible** |

### El problema con la Liga MX

El plan gratuito de football-data.org incluye 12 competiciones y la Liga
MX no está entre ellas: aparece con código `LMX` pero requiere el plan
**Standard, 49 €/mes**. Las *cuotas* sí están gratis en the-odds-api
(`soccer_mexico_ligamx`), pero sin calendario ni marcadores no hay modelo
que alimentar.

Tres salidas, de más barata a más cara:

1. **API-Football Pro, 19 USD/mes.** La opción sensata si quieres Liga MX.
   Cubre todo —calendario, en vivo, alineaciones, estadísticas por
   partido— y de paso desbloquea remates y córners reales, que es lo que
   hoy le falta al modelo. El código ya la soporta: define
   `API_FOOTBALL_KEY` y la usa.
2. **the-odds-api sola.** Su endpoint `/scores` da marcadores de Liga MX
   dentro del plan gratuito. Alcanza para resultados y cuotas, pero no
   para tabla ni árbitros, y consume del mismo presupuesto de 500
   créditos. Viable si solo quieres Liga MX y poco más.
3. **football-data.org Standard, 49 €/mes.** Más caro y aporta menos que
   la opción 1.

### El ajuste histórico de la Liga MX

Aparte del calendario, para que el modelo prediga Liga MX hacen falta
partidos suyos en el ajuste. `football-data.co.uk` publica México en su
sección de ligas extra (`MEX.csv`), pero **sin remates, córners ni
tarjetas** — solo marcadores y cuotas. Con eso el modelo de goles sí se
puede ajustar; los mercados de córners y tarjetas se quedarían con
valores a priori.

### Escalas por liga

Cada liga marca goles a su propio ritmo: la Bundesliga produce 1.64 por
equipo y la Serie A 1.25. Y la ventaja de local tampoco es igual —LaLiga
×1.155, Serie A ×1.036—. Por eso `fit-model.mjs` guarda dos juegos de
calificaciones: uno normalizado dentro de cada liga, para partidos
domésticos, y otro reescalado a nivel Champions, para cruces europeos.
Usar la escala equivocada mueve los goles esperados hasta un 11%.

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
