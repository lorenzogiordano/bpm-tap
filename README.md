# BPM Tap

Web app installabile (PWA) per misurare i BPM di una canzone battendo **sul retro dell'iPhone**, letto dall'accelerometro, oppure sullo schermo. Più tap fai, più il valore è preciso; quando smetti, la misura si salva da sola.

Nessuna dipendenza, nessun passaggio di build: sono file statici.

## Uso

1. Apri l'app e tocca **Attiva il sensore**. iOS chiede il permesso a ogni avvio, e solo dopo un tocco.
2. Tieni l'iPhone in mano e batti con un dito sul retro, a tempo con la canzone.
3. Il numero si affina a ogni tap. Accanto vedi il margine d'errore (±, al 95%) e il numero di tap validi. I decimali compaiono solo quando il margine scende sotto 1 BPM.
4. Smetti di battere: dopo circa 2,5 battiti di silenzio (tra 2 e 5 s) l'anello si riempie e la misura va nello storico, dove puoi scrivere il nome della canzone.

Se usi **Tocco posteriore** (Impostazioni › Accessibilità › Tocco), disattivalo: i doppi tap aprirebbero la sua azione.

- **÷2 / ×2** correggono il classico errore di metà o doppio tempo. Valgono anche sulla misura appena salvata.
- La modalità **Schermo** usa un'area grande dello schermo. Su computer funzionano anche Spazio o Invio, ed Esc per ricominciare.
- Il pannello **Sensore** (icona in alto a destra) mostra il segnale dal vivo e la soglia, e permette di regolare la sensibilità. **Esporta dati del sensore** salva gli ultimi 20 s di dati grezzi (JSON): servono per tarare il rilevamento su un iPhone reale.

## Installazione su iPhone

Il sensore funziona solo in **https**. Le strade più semplici:

- **GitHub Pages / Netlify / Cloudflare Pages / Vercel**: pubblica la cartella così com'è.
- **Tunnel temporaneo** dal Mac: `python3 -m http.server 8080`, poi `cloudflared tunnel --url http://localhost:8080` (non serve un account; l'indirizzo cambia a ogni avvio).

Poi in Safari: Condividi › **Aggiungi alla schermata Home** (su iOS 26 lascia attivo "Apri come web app").

## Come funziona

### Dai tap ai BPM ([tempo.js](tempo.js))

- **Regressione lineare** dei tempi dei tap rispetto all'indice del battito (t ≈ a + P·k). La pendenza P è il periodo e i BPM valgono 60000/P. È lo stimatore di [nayuki.io](https://www.nayuki.io/page/tap-to-measure-tempo-javascript) e [lindr0s/bpm-counter](https://github.com/lindr0s/bpm-counter). Con un errore casuale σ su ogni tap, il suo errore standard è σ·√(12/(n(n²−1))), cioè scala come **n^-1,5**. La media degli intervalli (all8.com, livejs/tap-tempo) si riduce invece a (ultimo − primo)/(n − 1) e scala come n^-1. Per questo la precisione cresce così in fretta.
- **Margine d'errore**: errore standard della pendenza × 1,96. Con pochi tap la varianza si combina con una stima a priori pari al 4% del battito. [Repp (2005)](https://link.springer.com/article/10.3758/BF03206433) riporta uno scarto dal battito del ~2% per i musicisti esperti e almeno del doppio per gli altri. I test verificano che il margine contenga il valore vero in oltre il 90% dei casi.
- **Robustezza** (un tap perso pesa più di un tap registrato qualche millisecondo fuori posto):
  - Ogni tap riceve l'indice di battito più vicino alla griglia prevista, quindi un battito saltato non falsa la stima (come [ArduinoTapTempo](https://github.com/dxinteractive/ArduinoTapTempo)). I battiti saltati si accettano quando la griglia è solida, cioè dopo 4 tap coerenti.
  - Con un solo intervallo alle spalle, un tap fuori griglia fa ripartire la misura dagli ultimi due tap. Se si perde il secondo tap, la misura si riallinea da sola invece di restare a metà tempo.
  - **Mai ×2 automatico a metà misura.** Un colpo falso a metà battito non deve raddoppiare il tempo: a misura avviata la griglia non si infittisce mai da sola. Si allarga solo se gli ultimi tap saltano con regolarità un battito sì e uno no, cosa che possono causare solo colpi mancanti, non colpi in più. Colpi scartati con passo di mezzo battito non valgono come cambio di tempo.
  - I colpi scartati contano come attività: mentre batti, la misura non scade.
  - I doppi tap e i tap fuori griglia vengono scartati. La tolleranza si adatta alla precisione della stima: è larga con pochi tap e stretta quando la stima è solida.
  - Se 3 tap consecutivi sono fuori griglia ma regolari tra loro, il tempo è cambiato e la misura riparte.
  - Il primo intervallo non conta se è troppo lungo, per evitare il bug "20 BPM al primo tap" segnalato nelle recensioni delle app.
- **Validità**: servono almeno 4 tap, come in [Mixxx](https://github.com/mixxxdj/mixxx/blob/main/src/engine/controls/bpmcontrol.cpp). La sessione si chiude dopo 2,5 battiti di silenzio, entro 2–5 s; le app esistenti usano 2–3 s.

### Dal sensore ai tap ([detector.js](detector.js))

- Su iPhone WebKit legge CoreMotion con un timer a 1/60 s (`kMotionUpdateInterval` in [WebCoreMotionManager.mm](https://github.com/WebKit/WebKit/blob/main/Source/WebCore/platform/ios/WebCoreMotionManager.mm)). I dati arrivano quindi a **60 Hz**, un campione ogni ~16,7 ms.
- Il "Tocco posteriore" di iOS usa gli stessi sensori (accelerometro e giroscopio), ma sui dati grezzi ad alta frequenza e con un riconoscitore di sistema. Le pagine web non ricevono né quei dati né il gesto, che comunque riconosce solo doppio e triplo tocco. Qui si lavora sui dati a 60 Hz.
- Pipeline euristica, sullo schema del ramo non-ML di Google Quick Tap ([Columbus](https://github.com/TheParasiteProject/packages_apps_ColumbusService), `TapRT.kt`) e di [Headtalk/Knock](https://github.com/Headtalk/Knock). A questa si aggiungono i controlli con cui gli accelerometri distinguono un colpo da un movimento (ADXL345 "DUR", ST "QUIET"):
  1. **jerk** (variazione dell'accelerazione tra due campioni) sui tre assi. Il punteggio è la componente **z**, perché il dito sul retro spinge il telefono lungo z;
  2. **soglia adattiva** = mediana + k·MAD del jerk nell'ultimo secondo e mezzo, con una **forza minima** assoluta. Entrambe dipendono dalla sensibilità: più è bassa, più forti devono essere i colpi;
  3. picco nei 3 campioni successivi, raffinato con **interpolazione parabolica**;
  4. il candidato conta solo se ha **la forma di un colpo**:
     - **quiete prima**: nei ~100 ms precedenti niente sopra il 35% del picco né chiaramente sopra il rumore. Uno scossone o uno spostamento cresce gradualmente;
     - **spinta e ritorno**: attorno al picco il jerk cambia segno entro due campioni, lo stesso schema che usa Quick Tap. Uno spostamento liscio, anche brusco, non torna indietro così in fretta;
     - **direzione**: almeno il 60% del jerk lungo z. Un colpo sul fianco viene ignorato;
     - **rotazione**: se il telefono ruota a più di 200 °/s, lo stai muovendo;
     - **forza**: dopo 3 colpi, un tocco sotto il 35% della forza tipica dei tuoi colpi viene scartato;
  5. **140 ms refrattari** contro gli "echi" del colpo. I datasheet ADXL345 e LIS3DH usano finestre di latenza di 20–100 ms per lo stesso motivo.
- Per 200 ms dopo un tocco sullo schermo i colpi vengono ignorati, come fa il "ScreenTouch gate" di Quick Tap.
- Il pannello Sensore mostra la forza di ogni colpo e il motivo di ogni scarto: linee arancioni per i colpi contati, grigie per quelli scartati.
- **Limiti noti.** A 60 Hz un colpo molto secco (< 15 ms) può cadere tra due campioni senza lasciare traccia. Con la forza minima di default, nel caso peggiore simulato se ne prende circa metà; alzando la sensibilità di più. I tap persi non spostano i BPM, perché la stima gestisce i battiti saltati. L'errore di temporizzazione dovuto al campionamento (4–8 ms) è inferiore allo scarto umano (15–25 ms a 120 BPM).
- Le soglie sono tarate su un segnale simulato. **Vanno verificate su un iPhone reale** con il pannello Sensore e l'export dei dati.

### Piattaforma iOS

| Aspetto | Comportamento |
|---|---|
| Permesso del sensore | `DeviceMotionEvent.requestPermission()` va chiamato da un `click` (non da `touchstart`/`pointerdown`), in https. WebKit tiene la decisione solo in memoria: va richiesta a ogni avvio. Un rifiuto resta valido finché l'app non viene chiusa del tutto. |
| Schermo acceso | Screen Wake Lock, anche nelle app installate sulla Home da [iOS 18.4](https://webkit.org/blog/16574/webkit-features-in-safari-18-4/). |
| Vibrazione | `navigator.vibrate` non esiste su iOS. Il trucco dello switch non funziona più se attivato dal codice da iOS 26.5. Il riscontro è quindi solo visivo. |
| Dati salvati | Le app sulla schermata Home sono escluse dalla cancellazione dopo 7 giorni di [ITP](https://webkit.org/tracking-prevention/). All'avvio l'app chiede anche `navigator.storage.persist()`. |
| Offline e aggiornamenti | Service worker "prima la rete" ([sw.js](sw.js)): online si usa sempre l'ultima versione, offline la copia salvata. |

## Test

```sh
npm test
```

Ci sono 28 test (Node, nessuna dipendenza):

- precisione che cresce come n^-1,5;
- regressione più precisa della media degli intervalli;
- copertura reale del margine al 95%;
- battiti saltati (anche il secondo tap), doppi tap, tap isolati, cambio di tempo, pausa;
- colpi falsi a metà battito: il tempo non raddoppia mai;
- rilevatore su un segnale a 60 Hz simulato:
  - colpi in istanti qualsiasi tra due campioni;
  - scossoni in ogni direzione, urti, colpi sul fianco, tocchi leggeri;
  - movimento lento della mano, caso peggiore, sensibilità;
- sessione completa a 60 BPM con tocchi leggeri e uno scossone in mezzo.

## Struttura

| File | Contenuto |
|---|---|
| [index.html](index.html), [styles.css](styles.css) | interfaccia |
| [app.js](app.js) | sessioni, sensore, storico, pannello del sensore |
| [tempo.js](tempo.js) | stima dei BPM (pura, testabile) |
| [detector.js](detector.js) | rilevamento dei tap dall'accelerometro (puro, testabile) |
| [sw.js](sw.js), [manifest.webmanifest](manifest.webmanifest), [icons/](icons/) | PWA |
| [test/](test/) | test |
