# Banco di prova della modalità Ascolta

Script Node (nessuna dipendenza) per scegliere e verificare i metodi di tempo e tonalità dall'audio. L'app non usa nulla di questa cartella, tranne i pesi che gli script esportano in `audio/`.

## Dati

L'audio e le annotazioni non sono nel repository. Vanno in `lab/work/data/<raccolta>/` (oppure nella cartella indicata da `BPM_LAB_DATA`), con `index.json` e l'audio mono a 22050 o 11025 Hz in int16 (`.s16`). Cache e risultati finiscono in `lab/work/`.

| Raccolta | Brani | Uso | Fonte |
|---|---|---|---|
| GTZAN | 1000 (837 con tonalità) | tempo, tonalità | audio [marsyas/gtzan](https://huggingface.co/datasets/marsyas/gtzan); tonalità [Kraft, Lerch, Zölzer](https://github.com/alexanderlerch/gtzan_key); tempo [gtzan_tempo_beat](https://github.com/TempoBeatDownbeat/gtzan_tempo_beat) |
| GiantSteps Key | 604 | tonalità | [giantsteps-key-dataset](https://github.com/GiantSteps/giantsteps-key-dataset), audio dal backup JKU |
| GiantSteps Tempo | 664 | tempo | [giantsteps-tempo-dataset](https://github.com/GiantSteps/giantsteps-tempo-dataset), annotazioni v2 (Schreiber & Müller 2018) |
| GiantSteps MTG Key | 1349 | tonalità (allenamento) | [giantsteps-mtg-key-dataset](https://github.com/GiantSteps/giantsteps-mtg-key-dataset) |
| FMAK | 5488 | tonalità (allenamento) | annotazioni FMAK v2 (Kong et al., STONE, ISMIR 2024), audio da `fma_large` del [Free Music Archive](https://github.com/mdeff/fma) |

Tutti i brani durano 30 s: GTZAN e FMA sono già clip da 30 s; delle anteprime GiantSteps (2 minuti) si è tenuto, per lo spazio su disco, l'estratto centrale di 30 s (20 s per GiantSteps Tempo). I risultati pubblicati sulle anteprime intere non sono quindi direttamente confrontabili.

## Stanza simulata

`micScenario` in [common.mjs](common.mjs) simula una canzone che esce da una cassa e viene ripresa dal telefono:

- cassa piccola: passa-alto a 120, 250 o 400 Hz (4° ordine) e passa-basso a 8 kHz;
- eco della stanza: risposta all'impulso con RT60 tra 0,3 e 0,7 s;
- rumore: ventola, ronzio di rete a 50 Hz, chiacchiericcio o rumore rosa, a 10–20 dB sotto la musica;
- `mic-near`: telefono vicino alla cassa, con 10 dB in più di suono diretto rispetto all'eco e di musica rispetto al rumore.

Ogni brano ha il suo scenario, estratto da un seme ricavato dal nome del brano. Le condizioni `mic-calib` e `mic-auto` passano l'audio per la pulizia del rumore ([denoise.mjs](denoise.mjs)): nelle prove non ha aiutato e l'app non la usa.

## Script principali

| Script | Cosa fa |
|---|---|
| `tempo-learn.mjs` | candidati di tempo per brano (in cache) e scelta imparata; `--condition mic` per la stanza simulata |
| `tempo-final.mjs [--write]` | validazione incrociata per brano, pulito contro pulito + stanza; `--write` scrive i pesi in `audio/tempo-choice.js` |
| `skey-js.mjs <raccolta> <condizione>` | S-KEY (con l'interprete JS dell'app) su ogni brano: probabilità e profili interni |
| `key-final-eval.mjs <esclusa> <pulito\|stanza>` | allena senza una raccolta e la usa come prova, in tutte le condizioni |
| `key-export.mjs deep6,deep5,deep4 nnls-mic` | allena il modello finale ed esporta `audio/key-model.json`; con `--exclude` e `--out` esporta un modello senza una raccolta |
| `key-app-eval.mjs <raccolta> <modello>` | prova un modello esportato con il codice dell'app: per condizione e tipo di rumore, prime due, MIREX, affidabilità |
| `listen-sim.mjs` / `listen-proxy.mjs` | la tonalità come la vede l'app durante l'ascolto (dopo 6, 14, 22, 30 s) e come unire i passaggi di S-KEY |

Gli altri script (`key-learn`, `key-big`, `sweep`, `key-baseline`, `diagnose`, `by-genre`, `error-structure`, `noise-types`…) sono le prove intermedie citate nel README principale.
