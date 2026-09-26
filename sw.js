// Service worker: rende l'app disponibile offline.
// Strategia: precache dei file dell'app, poi "prima la rete": online si usa
// sempre l'ultima versione pubblicata (e si aggiorna la cache), offline la cache.
// Aumenta VERSION a ogni rilascio per ripulire le cache vecchie.
const VERSION = 'bpm-tap-v10';

const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './tempo.js',
  './detector.js',
  './knock.js',
  './mac-motion.js',
  './listen.js',
  './file-analysis.js',
  './sound.js',
  './chord-names.js',
  './structure-view.js',
  './audio/dsp.js',
  './audio/rhythm.js',
  './audio/key.js',
  './audio/notes.js',
  './audio/tempo-choice.js',
  './audio/onnx-lite.js',
  './audio/skey.js',
  './audio/key-features.js',
  './audio/chords.js',
  './audio/chord-model.json',
  './audio/progressions.js',
  './audio/structure.js',
  './audio/progression-model.json',
  './audio/structure-model.json',
  './audio/skey-graph.json',
  './audio/key-model.json',
  './audio/pcm-tap.js',
  './audio/listen-worker.js',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(VERSION).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;

  event.respondWith(
    fetch(request, { cache: 'no-cache' })
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(VERSION).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(() => caches.match(request, { ignoreSearch: true }))
  );
});
