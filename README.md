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
  - Ogni tap riceve l'indice di battito più vicino alla griglia prevista, quindi un battito saltato non falsa la stima (come [ArduinoTapTempo](https://github.com/dxinteractive/ArduinoTapTempo)). Un battito saltato si accetta già dal terzo tap; più di uno di fila quando la griglia è solida.
  - Se si perde il secondo tap, la griglia nascerebbe a metà tempo. Quando due tap scartati cadono esattamente a metà tra due battiti, la griglia si dimezza e quei tap vengono recuperati.
  - I doppi tap e i tap fuori griglia vengono scartati. La tolleranza si adatta alla precisione della stima: è larga con pochi tap e stretta quando la stima è solida.
  - Se 3 tap consecutivi sono fuori griglia ma regolari tra loro, il tempo è cambiato e la misura riparte.
  - Il primo intervallo non conta se è troppo lungo, per evitare il bug "20 BPM al primo tap" segnalato nelle recensioni delle app.
- **Validità**: servono almeno 4 tap, come in [Mixxx](https://github.com/mixxxdj/mixxx/blob/main/src/engine/controls/bpmcontrol.cpp). La sessione si chiude dopo 2,5 battiti di silenzio, entro 2–5 s; le app esistenti usano 2–3 s.

### Dal sensore ai tap ([detector.js](detector.js))

- Su iPhone WebKit legge CoreMotion con un timer a 1/60 s (`kMotionUpdateInterval` in [WebCoreMotionManager.mm](https://github.com/WebKit/WebKit/blob/main/Source/WebCore/platform/ios/WebCoreMotionManager.mm)). I dati arrivano quindi a **60 Hz**, un campione ogni ~16,7 ms.
- Pipeline euristica, sullo schema del ramo non-ML di Google Quick Tap ([Columbus](https://github.com/TheParasiteProject/packages_apps_ColumbusService), `TapRT.kt`) e di [Headtalk/Knock](https://github.com/Headtalk/Knock) per iOS:
  1. asse **z** dell'accelerazione;
  2. **derivata prima** (jerk), che vale ~0 a telefono fermo e toglie anche la gravità;
  3. **soglia adattiva** = mediana + k·MAD del jerk nell'ultimo secondo e mezzo, con un minimo assoluto. Entrambi dipendono dalla sensibilità;
  4. picco nei 3 campioni successivi, poi **140 ms refrattari** contro gli "echi" del colpo. I datasheet ADXL345 e LIS3DH usano finestre di latenza di 20–100 ms per lo stesso motivo;
  5. istante del tap raffinato con **interpolazione parabolica**;
  6. **battito atteso**: dal terzo tap l'app comunica al rilevatore dove cadrà il prossimo battito. In quella finestra la soglia scende al 55% e un colpo debole viene preso lo stesso. I campioni della finestra non entrano nella stima del rumore, così un tap non visto non alza la soglia e non fa perdere i successivi. Un tap "aiutato" non ne può armare un altro: se smetti di battere, la sessione non va avanti da sola.
- Per 200 ms dopo un tocco sullo schermo i colpi del sensore vengono ignorati, come fa il "ScreenTouch gate" di Quick Tap.
- **Limiti noti.** A 60 Hz un colpo molto secco (< 15 ms) può cadere tra due campioni senza lasciare traccia. Nelle simulazioni con previsione del battito:

  | Scenario | Tap presi | Errore medio |
  |---|---|---|
  | Tap normali | 100% | 0,1 BPM |
  | Tap deboli | 97% | 0,1 BPM |
  | Caso peggiore | ~85% | 0,1 BPM |

  I tap persi non spostano i BPM perché la stima gestisce i battiti saltati. L'errore di temporizzazione dovuto al campionamento (4–8 ms) è inferiore allo scarto umano (15–25 ms a 120 BPM).
- Le soglie sono tarate su un segnale simulato. **Vanno verificate su un iPhone reale** con il pannello Sensore e l'export dei dati.

### Piattaforma iOS

| Aspetto | Comportamento |
|---|---|
| Permesso del sensore | `DeviceMotionEvent.requestPermission()` va chiamato da un `click` (non da `touchstart`/`pointerdown`), in https. WebKit tiene la decisione solo in memoria: va richiesta a ogni avvio. Un rifiuto resta valido finché l'app non viene chiusa del tutto. |
| Schermo acceso | Screen Wake Lock, anche nelle app installate sulla Home da [iOS 18.4](https://webkit.org/blog/16574/webkit-features-in-safari-18-4/). |
| Vibrazione | `navigator.vibrate` non esiste su iOS. Il trucco dello switch non funziona più se attivato dal codice da iOS 26.5. Il riscontro è quindi solo visivo. |
| Dati salvati | Le app sulla schermata Home sono escluse dalla cancellazione dopo 7 giorni di [ITP](https://webkit.org/tracking-prevention/). All'avvio l'app chiede anche `navigator.storage.persist()`. |
| Offline | Service worker con precache ([sw.js](sw.js)). Aumenta `VERSION` a ogni rilascio. |

## Test

```sh
npm test
```

Ci sono 23 test (Node, nessuna dipendenza):

- precisione che cresce come n^-1,5;
- regressione più precisa della media degli intervalli;
- copertura reale del margine al 95%;
- battiti saltati (anche il secondo tap), doppi tap, tap isolati, cambio di tempo, pausa;
- rilevatore su un segnale a 60 Hz simulato: tap in istanti qualsiasi tra due campioni, movimento lento della mano, caso peggiore, sensibilità, soglia abbassata vicino al battito atteso;
- catena completa dal sensore ai BPM, con tap deboli e previsione del battito.

## Struttura

| File | Contenuto |
|---|---|
| [index.html](index.html), [styles.css](styles.css) | interfaccia |
| [app.js](app.js) | sessioni, sensore, storico, pannello del sensore |
| [tempo.js](tempo.js) | stima dei BPM (pura, testabile) |
| [detector.js](detector.js) | rilevamento dei tap dall'accelerometro (puro, testabile) |
| [sw.js](sw.js), [manifest.webmanifest](manifest.webmanifest), [icons/](icons/) | PWA |
| [test/](test/) | test |
