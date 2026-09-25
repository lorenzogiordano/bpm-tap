# BPM Tap

Web app installabile (PWA) per misurare i BPM di una canzone battendo **sul retro dell'iPhone**, letto dall'accelerometro, oppure sullo schermo. Più tap fai, più il valore è preciso; quando smetti, la misura si salva da sola.

La modalità **Ascolta** ricava BPM, **tonalità** e **accordi** direttamente dalla canzone, dal microfono. Sui **MacBook** si può bussare sulla scocca, letta dal sensore di movimento interno. Ogni BPM trovato si può **ascoltare** con un metronomo.

Nessuna dipendenza, nessun passaggio di build: sono file statici.

## Uso

1. Apri l'app e tocca **Attiva il sensore**. iOS chiede il permesso a ogni avvio, e solo dopo un tocco.
2. Tieni l'iPhone in mano e batti con un dito sul retro, a tempo con la canzone.
3. Il numero si affina a ogni tap. Accanto vedi il margine d'errore (±, al 95%) e il numero di tap validi. I decimali compaiono solo quando il margine scende sotto 1 BPM.
4. Smetti di battere: dopo circa 2,5 battiti di silenzio (tra 2 e 5 s) l'anello si riempie e la misura va nello storico, dove puoi scrivere il nome della canzone.

Se usi **Tocco posteriore** (Impostazioni › Accessibilità › Tocco), disattivalo: i doppi tap aprirebbero la sua azione.

- **÷2 / ×2** correggono il classico errore di metà o doppio tempo. Valgono anche sulla misura appena salvata.
- **▶ Senti i BPM** fa partire un metronomo al valore trovato, sulla misura appena fatta e su ogni misura salvata. Lo ascolti sopra la canzone e capisci subito se il valore è giusto o va dimezzato o raddoppiato; il metronomo segue ÷2 e ×2 al volo. Su iPhone si sente anche con l'interruttore del silenzio attivo.
- La modalità **Schermo** usa un'area grande dello schermo.
- Il pannello **Sensore** (icona in alto a destra) mostra il segnale dal vivo e la soglia, e permette di regolare la sensibilità. **Esporta dati del sensore** salva gli ultimi 20 s di dati grezzi (JSON): servono per tarare il rilevamento su un iPhone reale.

### Modalità Ascolta

1. Fai suonare la canzone da **un altro dispositivo** (cassa, computer, radio). Quando l'app accende il microfono, iOS mette in pausa la musica che suona sullo stesso iPhone. Scollega le cuffie Bluetooth, altrimenti il microfono diventa il loro.
2. **Tieni il telefono vicino alla cassa**, a 30–50 cm. È la cosa che conta di più: nelle prove la tonalità giusta sale dal 60% al 67% dei brani su GTZAN e dal 53% al 58% su GiantSteps (vedi sotto).
3. Tocca **Inizia ad ascoltare**. Se puoi, lascia **3 secondi di silenzio**: l'app misura il rumore della stanza, aspetta che parta la canzone (così quello che c'era prima non entra nell'analisi) e ti avvisa se il rumore copre la musica. Se la canzone sta già suonando, tocca **La canzone è già partita**.
4. BPM e tonalità compaiono dopo pochi secondi e si affinano ascoltando. Accanto alla tonalità c'è quanto è affidabile:
   - **sicura**: giusta circa 9 volte su 10;
   - **probabile**: circa 2 volte su 3;
   - **incerta**: con l'alternativa più vicina.
5. Dopo circa 20 s compaiono gli **accordi** principali della canzone: solo quelli che occupano almeno il 10% del tempo ascoltato. Toccane uno per sentirlo (a ascolto fermo).
6. Tocca **Ferma e salva**. Poi puoi **verificare a orecchio**: l'app suona la cadenza I–IV–V–I (i–iv–V–i in minore) della tonalità trovata e dell'alternativa, e tu tieni quella che "torna a casa" con la canzone. Tra le prime due la tonalità giusta c'è in circa 3 casi su 4.

### Sul computer

Con mouse o trackpad e una finestra larga, l'interfaccia passa a due colonne: a sinistra il quadrante grande e i comandi, a destra le misure salvate. Si usa soprattutto con la tastiera:

| Tasto | Azione |
|---|---|
| Spazio (o Invio) | un tap; in modalità Ascolta avvia o ferma l'ascolto |
| A | ascolta una canzone |
| M | metronomo sì/no |
| ↓ / ↑ | ÷2 / ×2 |
| Esc | nuova misura |

Su Windows e Linux la modalità Retro non c'è: i browser dei computer non danno accesso a sensori di movimento.

### Bussa sul MacBook

I MacBook con chip M2 o successivo (e M1 Pro o M1 Max) hanno un sensore di movimento interno (accelerometro e giroscopio) che nessun browser può leggere. Lo legge un piccolo programma, [mac/bpm-knock.py](mac/bpm-knock.py): usa solo la libreria standard di Python, non chiede la password e non installa nulla.

1. Scarica `bpm-knock.py` (il link è nel foglio della modalità **Bussa**) e avvialo nel Terminale: `python3 ~/Downloads/bpm-knock.py`.
2. Si apre da solo `http://localhost:8765`, l'app collegata al sensore. Funziona in Safari, Chrome e Firefox.
3. Bussa con le nocche vicino al trackpad, a tempo con la canzone. La canzone può suonare anche dagli altoparlanti del Mac: non muovono il sensore (verificato a volume massimo).
4. Per chiudere: Ctrl+C nel Terminale.

Il programma passa i dati del sensore solo alle pagine dell'app: dalle vibrazioni si potrebbe perfino intuire cosa si scrive sulla tastiera.

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

### Dall'audio a BPM e tonalità (modalità Ascolta)

Il microfono si apre senza cancellazione dell'eco, riduzione del rumore e controllo automatico del volume, che deformerebbero la musica. Un AudioWorklet passa i campioni a un Worker ([audio/listen-worker.js](audio/listen-worker.js)), che li porta a 22050 Hz e fa tutta l'analisi fuori dal thread dell'interfaccia.

**Tempo** ([audio/rhythm.js](audio/rhythm.js), [audio/tempo-choice.js](audio/tempo-choice.js))

1. Curva degli attacchi: flusso spettrale su 40 bande mel in scala logaritmica, più tre curve per bande (basso, medio, acuto).
2. Autocorrelazione generalizzata con compressione 0,5 (Percival & Tzanetakis 2014) su finestre di 8 s, rafforzata con le armoniche del periodo.
3. Candidati: i picchi migliori e i loro multipli (×2, ½, 3/2, 2/3, ×3, ⅓). Un modello lineare sceglie tra loro in base a 21 indizi (forza del periodo e dei suoi multipli, per banda; densità degli attacchi; posizione rispetto ai 120 BPM). È allenato su GTZAN e GiantSteps Tempo, audio pulito e ripreso in una stanza simulata.
4. Battiti con la programmazione dinamica di Ellis (2007), poi la stessa regressione dei tap: da qui il margine ±.

Risultati in validazione incrociata (tempo giusto entro il 4%; tra parentesi contando anche metà, doppio e triplo):

| | GTZAN | GiantSteps Tempo |
|---|---|---|
| audio pulito | 71% (92%) | 82% (93%) |
| dal microfono, stanza simulata | 70% (90%) | 80% (92%) |
| preferenza fissa per i 120 BPM (partenza) | 68% (91%) | — |

**Tonalità** ([audio/skey.js](audio/skey.js), [audio/onnx-lite.js](audio/onnx-lite.js), [audio/key-features.js](audio/key-features.js))

1. [S-KEY](https://github.com/deezer/skey) (Kong et al., ICASSP 2025, Deezer, licenza MIT) è una rete che stima la tonalità ed è stata allenata senza etichette. Gira nel telefono con un piccolo interprete ONNX in JavaScript, scritto per questa app: verificato contro onnxruntime, differenza massima circa 1e-6. Il grafo pesa 405 KB ([licenza](audio/SKEY-LICENSE)) e l'analisi di 30 s di audio richiede circa 2 s su un Mac.
2. Non si usa la risposta finale di S-KEY, ma i suoi **strati interni** (blocchi 4, 5 e 6): per ogni canale, un profilo sulle 12 note, mediato sulle ottave e nel tempo. Un modello lineare legge questi profili con gli stessi pesi per tutte le 12 toniche (trasporre la canzone sposta solo la risposta). È allenato su GTZAN, GiantSteps Key, GiantSteps MTG Key e FMAK, audio pulito e da stanza simulata: 16 556 esempi.
3. S-KEY guarda gli ultimi 30 s e si ripete ogni 8 s. Nei primi 30 s vale l'ultimo passaggio, che vede tutto l'ascoltato. Dopo, ogni passaggio aggiunge ai profili solo i secondi nuovi. Così i profili restano la media su tutto l'ascolto, come nell'allenamento, e il costo non cresce. In una prova in scala (finestre da 10 s su brani da 30 s, dal microfono) questo dà 58,8% su GTZAN e 52,3% su GiantSteps, contro 59,5% e 52,6% di S-KEY su tutto l'audio. Tenere solo l'ultima finestra darebbe 52,4% e 46,9%.

Prova "a raccolta esclusa": il modello è allenato senza la raccolta su cui viene provato, quindi non ha mai visto né quei brani né quello stile di annotazione. I brani sono estratti da 30 s.

| Tonalità esatta (MIREX pesato) | GTZAN | GiantSteps Key |
|---|---|---|
| audio pulito | **70%** (77%) | **63%** (70%) |
| dal microfono, stanza simulata | **60%** (69%) | **53%** (62%) |
| dal microfono, telefono vicino alla cassa | **67%** (74%) | **58%** (66%) |
| giusta tra le prime due (microfono) | 76% | 68% |
| S-KEY da solo, pulito / microfono | 66% / 50% | 60% / 48% |
| profili classici (Krumhansl, Temperley…), pulito | 54–61% | 48–50% |
| [Essentia](https://essentia.upf.edu/) KeyExtractor (profilo bgate, 200 brani), pulito | 59% | 55% |

Il punteggio MIREX dà mezzo punto alla quinta, 0,3 alla relativa e 0,2 alla parallela. Il margine d'errore di ogni cifra è di circa ±3–4 punti (95%).

Quanto è affidabile la risposta (dal microfono, brani mai visti): con probabilità ≥ 0,8 è giusta nell'82–95% dei casi (13–16% dei brani); tra 0,5 e 0,8 circa 2 volte su 3; sotto 0,5 una volta su 3 o su 2. Da qui "sicura", "probabile" e "incerta".

**Accordi** ([audio/chords.js](audio/chords.js))

Lo schema è quello di Chordino (Mauch & Dixon 2010), riscritto dal metodo pubblicato, con in più la tonalità:

1. Cromagramma NNLS di basso e acuti (lo stesso della tonalità, con un frame ogni 93 ms), mediato tra un battito e l'altro, compresso con la radice quadrata. Al battito si aggiunge il contesto: la media degli acuti del battito prima e di quello dopo.
2. Un modello lineare dà un punteggio ai 24 accordi maggiori e minori, con gli stessi pesi per tutte le 12 fondamentali, e a "nessun accordo" (energia e piattezza del cromagramma).
3. La tonalità stimata da S-KEY aggiunge una preferenza imparata dai dati: quanto è frequente ogni accordo in ogni grado della scala maggiore o minore.
4. Un modello di Markov nascosto (HMM), con le transizioni contate sui dati e invarianti per trasposizione, dà a ogni battito la probabilità di ogni accordo (avanti-indietro).
5. La quota di tempo di ogni accordo su tutto l'ascoltato decide cosa mostrare: dopo 20 s, gli accordi con almeno il 10%.

Allenamento su due raccolte con audio e accordi annotati, entrambe CC BY 4.0: canzoni pop è impossibile trovarne libere.
- [AAM](https://zenodo.org/records/5794629): 397 canzoni sintetiche di 2 minuti, multi-strumento, con accordi esatti.
- [GuitarSet](https://zenodo.org/records/3371780): 180 accompagnamenti di chitarra, registrati con un microfono, in 5 stili.

Prova onesta in 5 gruppi. Ogni gruppo lascia fuori canzoni AAM e interi giri di accordi GuitarSet: ogni giro è suonato da 6 chitarristi, quindi lasciare fuori solo un chitarrista avrebbe fatto "ricordare" il giro al modello. La tonalità usata è quella stimata dall'app.

| | Accordo per battito | Accordi mostrati giusti | Accordi principali (≥10%) trovati |
|---|---|---|---|
| GuitarSet (chitarra vera, 30 s), pulito | 67% | 86% | 68% |
| GuitarSet, dal microfono | 64% | 86% | 68% |
| AAM (canzoni intere), pulito | 91% | 99% | 91% |
| AAM, dal microfono | 80% | 97% | 82% |

Per confronto, Chordino fa il 67–78% per battito sui dati di prova di MIREX, con audio pulito. Anche due annotatori umani concordano solo sul 73% dei battiti ([Koops et al. 2019](https://github.com/chordify/CASD)). Sulle soglie di tempo ci sono risultati coerenti: calcolati sulle uscite ufficiali MIREX, gli accordi che occupano il 10–20% o più del brano sono davvero nella canzone nel 90–97% dei casi.

La tonalità conta. Con la tonalità stimata, i brani con tutti gli accordi mostrati giusti passano dal 63–65% all'80% (GuitarSet). La precisione per battito invece non cambia.

Limiti. Solo accordi maggiori e minori: le settime restano sulla triade, i diminuiti non si riconoscono. Mancano prove su canzoni pop vere registrate con un telefono, perché non esistono dati liberi di questo tipo.

**Cosa non ha aiutato** (misurato, poi tolto):

- **Pulire il rumore** col profilo del silenzio iniziale (sottrazione spettrale), o senza silenzio (statistiche dei minimi, Martin 2001), anche spegnendo del tutto le righe del ronzio elettrico: da 0,5 a 2,5 punti in meno sulla tonalità, niente sul tempo, con ogni tipo di rumore. S-KEY regge già il rumore costante e il filtro aggiunge artefatti. Il silenzio iniziale serve quindi a capire quando parte la canzone e a stimare quanto la musica supera il rumore (sotto 10 dB compare l'avviso di avvicinarsi).
- **Cromagrammi** (NNLS di Mauch & Dixon, accordi, basso) accanto a S-KEY: meno di un punto.
- **Media semplice dei passaggi** di S-KEY: 1–4 punti in meno dell'ultimo passaggio nei primi 30 s.

La perdita dal microfono viene soprattutto dall'eco della stanza e dalle casse piccole, che tolgono i bassi; il rumore pesa meno. Per questo avvicinarsi alla cassa recupera tra metà e il 70% della differenza.

**Limiti.** Le prove usano estratti da 30 s e una stanza simulata, non registrazioni con un iPhone vero. Brani con cambi di tonalità, modali o senza un centro tonale chiaro non hanno una risposta giusta sola. Per questo c'è la verifica a orecchio.

### Dal sensore del MacBook ai colpi ([knock.js](knock.js), [mac/bpm-knock.py](mac/bpm-knock.py))

- **Il sensore.** È un accelerometro e giroscopio MEMS (ritenuto un Bosch BMI286) gestito dal Sensor Processing Unit di Apple ed esposto come dispositivo HID `AppleSPUHIDDevice` (pagina 0xFF00, uso 3). Lo hanno reso noto [olvvier/apple-silicon-accelerometer](https://github.com/olvvier/apple-silicon-accelerometer) (licenza MIT) e [taigrr/spank](https://github.com/taigrr/spank), il progetto "schiaffeggia il MacBook" da cui è nata l'app [SlapMac](https://slapmac.com/). Si accende impostando alcune proprietà del driver (`SensorPropertyReportingState`, `SensorPropertyPowerState`, `ReportInterval`), poi manda resoconti di 22 byte: x, y, z interi a 32 bit dal byte 6, in 1/65536 g.
- **Il programma.** Legge il sensore con `ctypes` (IOKit e CoreFoundation) in un thread con il suo run loop, a circa 794 campioni al secondo con i tempi dell'hardware. Serve l'app su `localhost:8765` e manda i campioni come Server-Sent Events ogni 15 ms. La pagina porta i tempi del sensore sull'orologio del browser, usando lo scarto minimo tra arrivo e campione degli ultimi 5 s.
- **Perché serve.** Chrome ha tolto nel 2024 il supporto al vecchio sensore dei Mac Intel ([commit](https://github.com/chromium/chromium/commit/351828bd24)). WebKit ha i sensori di movimento solo su iOS e Firefox cerca solo quello vecchio. Una pagina https non può parlare con `ws://localhost` in Safari ([bug 171934](https://bugs.webkit.org/show_bug.cgi?id=171934)): per questo il programma serve anche l'app, dalla stessa origine.
- **Com'è fatto un colpo.** Registrato su un MacBook Pro M3 Max: un colpo di nocche è un'oscillazione smorzata a circa 41 Hz (il Mac rimbalza sui piedini), con il primo semiciclo tra 0,02 e 0,2 g, spenta in circa 150 ms. A riposo il fondo sta sotto 0,006 g. Gli altoparlanti, anche a volume massimo, non si vedono.
- **Rilevamento.**
  1. Passa-alto a 10 Hz sui tre assi, poi il modulo.
  2. Soglia: il massimo tra una forza minima (0,022 g a sensibilità 5) e 6 volte il rumore di fondo.
  3. Dopo ogni colpo la soglia sale alla coda attesa del rimbalzo, così un colpo non diventa due.
  4. Dopo 25 ms si decide. Nei 80 ms prima ci dev'essere quiete: la battitura e gli spostamenti non si fermano. Il segnale deve tornare indietro lungo la direzione del picco: un colpo fa vibrare la scocca, una spinta no. Conta anche la forza rispetto ai colpi precedenti, e ci sono 120 ms refrattari. L'istante del colpo è il primo campione a metà della forza.
  5. Ogni tasto premuto o clic sospende il sensore per 200 ms.
- **Verifica.** Sulla registrazione guidata il rilevatore ha contato 20 colpi su 20, con intervalli regolari entro ±30 ms e nessun doppio. Su 10 s di spostamenti ha contato un solo colpo falso. La battitura dà qualche falso positivo, ma nell'app è coperta dalla sospensione sui tasti. Alla sensibilità di base contano i colpi normali, non serve picchiare.

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

Ci sono 53 test (Node, nessuna dipendenza):

- precisione che cresce come n^-1,5;
- regressione più precisa della media degli intervalli;
- copertura reale del margine al 95%;
- battiti saltati (anche il secondo tap), doppi tap, tap isolati, cambio di tempo, pausa;
- colpi falsi a metà battito: il tempo non raddoppia mai;
- rilevatore su un segnale a 60 Hz simulato:
  - colpi in istanti qualsiasi tra due campioni;
  - scossoni in ogni direzione, urti, colpi sul fianco, tocchi leggeri;
  - movimento lento della mano, caso peggiore, sensibilità;
- sessione completa a 60 BPM con tocchi leggeri e uno scossone in mezzo;
- colpi sul MacBook: colpi a 110 BPM tutti contati con istanti regolari, colpi fortissimi senza doppi, battitura e spostamenti ignorati, sensibilità;
- accordi: media per battito, preferenza di tonalità, HMM, quote, e catena completa su un giro Do–Sol–Lam–Fa sintetico;
- ascolto: FFT, framing e ricampionamento; BPM dai battiti con salti di fase e copertura del margine; interprete ONNX contro il calcolo diretto; indizi della tonalità che si spostano con la trasposizione; media dei profili di S-KEY su finestre sovrapposte; catena completa (S-KEY + modello) su cadenze in Do maggiore, La minore e Mi♭ maggiore.

Il banco di prova con i dataset, le stanze simulate e gli script che hanno prodotto i numeri qui sopra è in [lab/](lab/README.md).

## Struttura

| File | Contenuto |
|---|---|
| [index.html](index.html), [styles.css](styles.css) | interfaccia |
| [app.js](app.js) | sessioni, sensore, ascolto, storico, pannello del sensore |
| [tempo.js](tempo.js) | stima dei BPM dai tap (pura, testabile) |
| [detector.js](detector.js) | rilevamento dei tap dall'accelerometro del telefono (puro, testabile) |
| [knock.js](knock.js), [mac-motion.js](mac-motion.js), [mac/bpm-knock.py](mac/bpm-knock.py) | colpi sul MacBook: rilevatore, collegamento, programma del sensore |
| [sound.js](sound.js) | metronomo, cadenze e accordi da ascoltare |
| [listen.js](listen.js) | microfono, AudioWorklet e Worker dell'ascolto |
| [audio/](audio/) | analisi dell'audio: tempo, S-KEY, interprete ONNX, tonalità e accordi |
| [sw.js](sw.js), [manifest.webmanifest](manifest.webmanifest), [icons/](icons/) | PWA |
| [test/](test/) | test |
| [lab/](lab/README.md) | banco di prova (non serve all'app) |
