#!/usr/bin/env python3
"""BPM Tap · sensore del MacBook.

I MacBook con chip Apple (M1 Pro/Max, M2 e successivi) hanno un sensore di movimento
interno che nessun browser può leggere. Questo programma lo legge e lo passa all'app
BPM Tap, che così conta i colpi di nocche sulla scocca.

Uso:  python3 bpm-knock.py
      Si apre da solo http://localhost:8765 con l'app collegata al sensore.
      Ctrl+C per chiudere.

Solo la libreria standard di Python; nessun permesso di amministratore.
Il sensore si legge come in olvvier/apple-silicon-accelerometer (licenza MIT):
dispositivo HID "AppleSPUHIDDevice", pagina 0xFF00, uso 3; resoconti di 22 byte con
x, y, z interi a 32 bit (little-endian) dal byte 6, in unità di 1/65536 g.
"""

import ctypes
import ctypes.util
import json
import mimetypes
import os
import struct
import sys
import threading
import time
import urllib.request
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = 8765
APP_URL = 'https://lorenzogiordano.github.io/bpm-tap/'
# Solo le pagine dell'app possono leggere il sensore: dalle vibrazioni si potrebbe perfino
# intuire cosa si scrive sulla tastiera.
ALLOWED_ORIGINS = {'https://lorenzogiordano.github.io', f'http://localhost:{PORT}', f'http://127.0.0.1:{PORT}'}
# Se il programma sta dentro una copia dell'app (cartella mac/), serve quei file;
# altrimenti fa da tramite verso la versione pubblicata.
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LOCAL_APP = os.path.exists(os.path.join(ROOT, 'index.html')) and os.path.exists(os.path.join(ROOT, 'knock.js'))

# ---------------------------------------------------------------- sensore

iokit = ctypes.cdll.LoadLibrary(ctypes.util.find_library('IOKit'))
cf = ctypes.cdll.LoadLibrary(ctypes.util.find_library('CoreFoundation'))
libc = ctypes.CDLL(None)

cf.CFStringCreateWithCString.restype = ctypes.c_void_p
cf.CFStringCreateWithCString.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_uint32]
cf.CFNumberCreate.restype = ctypes.c_void_p
cf.CFNumberCreate.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_void_p]
cf.CFNumberGetValue.restype = ctypes.c_bool
cf.CFNumberGetValue.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_void_p]
cf.CFRelease.argtypes = [ctypes.c_void_p]
cf.CFRunLoopGetCurrent.restype = ctypes.c_void_p
cf.CFRunLoopRunInMode.argtypes = [ctypes.c_void_p, ctypes.c_double, ctypes.c_bool]
kCFRunLoopDefaultMode = ctypes.c_void_p.in_dll(cf, 'kCFRunLoopDefaultMode')

iokit.IOServiceMatching.restype = ctypes.c_void_p
iokit.IOServiceMatching.argtypes = [ctypes.c_char_p]
iokit.IOServiceGetMatchingServices.argtypes = [ctypes.c_uint, ctypes.c_void_p, ctypes.POINTER(ctypes.c_uint)]
iokit.IOIteratorNext.restype = ctypes.c_uint
iokit.IOIteratorNext.argtypes = [ctypes.c_uint]
iokit.IORegistryEntryCreateCFProperty.restype = ctypes.c_void_p
iokit.IORegistryEntryCreateCFProperty.argtypes = [ctypes.c_uint, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_uint32]
iokit.IORegistryEntrySetCFProperty.restype = ctypes.c_int
iokit.IORegistryEntrySetCFProperty.argtypes = [ctypes.c_uint, ctypes.c_void_p, ctypes.c_void_p]
iokit.IOHIDDeviceCreate.restype = ctypes.c_void_p
iokit.IOHIDDeviceCreate.argtypes = [ctypes.c_void_p, ctypes.c_uint]
iokit.IOHIDDeviceOpen.restype = ctypes.c_int
iokit.IOHIDDeviceOpen.argtypes = [ctypes.c_void_p, ctypes.c_uint32]
REPORT_CB = ctypes.CFUNCTYPE(None, ctypes.c_void_p, ctypes.c_int, ctypes.c_void_p, ctypes.c_int,
                             ctypes.c_uint32, ctypes.POINTER(ctypes.c_uint8), ctypes.c_long, ctypes.c_uint64)
iokit.IOHIDDeviceRegisterInputReportWithTimeStampCallback.argtypes = [
    ctypes.c_void_p, ctypes.c_void_p, ctypes.c_long, REPORT_CB, ctypes.c_void_p]
iokit.IOHIDDeviceScheduleWithRunLoop.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p]


class Timebase(ctypes.Structure):
    _fields_ = [('numer', ctypes.c_uint32), ('denom', ctypes.c_uint32)]


timebase = Timebase()
libc.mach_timebase_info(ctypes.byref(timebase))
TICKS_TO_MS = timebase.numer / timebase.denom / 1e6


def cfstr(s):
    return cf.CFStringCreateWithCString(None, s.encode(), 0x08000100)


def cfnum(v):
    x = ctypes.c_int32(v)
    return cf.CFNumberCreate(None, 3, ctypes.byref(x))


def prop_int(service, key):
    ref = iokit.IORegistryEntryCreateCFProperty(service, cfstr(key), None, 0)
    if not ref:
        return None
    v = ctypes.c_int64()
    cf.CFNumberGetValue(ref, 4, ctypes.byref(v))
    cf.CFRelease(ref)
    return v.value


def services(name):
    iterator = ctypes.c_uint()
    iokit.IOServiceGetMatchingServices(0, iokit.IOServiceMatching(name), ctypes.byref(iterator))
    while True:
        service = iokit.IOIteratorNext(iterator.value)
        if not service:
            return
        yield service


class Sensor:
    """Accelerometro in un thread con il suo run loop; campioni in un buffer circolare."""

    CAPACITY = 16000  # ~20 s

    def __init__(self):
        self.lock = threading.Lock()
        self.samples = []   # [t_ms, x, y, z]
        self.total = 0      # campioni ricevuti in tutto (indice assoluto)
        self.found = None   # None = in avvio, True/False = sensore trovato o no
        self._keep = []     # riferimenti che devono restare vivi (callback, buffer)

    def start(self):
        threading.Thread(target=self._run, daemon=True).start()
        for _ in range(50):
            if self.found is not None:
                break
            time.sleep(0.05)
        return self.found

    def _run(self):
        # Accende il sensore: senza queste proprietà non manda nulla.
        for service in services(b'AppleSPUHIDDriver'):
            for key, value in (('SensorPropertyReportingState', 1), ('SensorPropertyPowerState', 1), ('ReportInterval', 1000)):
                iokit.IORegistryEntrySetCFProperty(service, cfstr(key), cfnum(value))
        callback = REPORT_CB(self._on_report)
        self._keep.append(callback)
        opened = False
        for service in services(b'AppleSPUHIDDevice'):
            if (prop_int(service, 'PrimaryUsagePage'), prop_int(service, 'PrimaryUsage')) != (0xFF00, 3):
                continue
            device = iokit.IOHIDDeviceCreate(None, service)
            if not device or iokit.IOHIDDeviceOpen(device, 0) != 0:
                continue
            buffer = (ctypes.c_uint8 * 4096)()
            self._keep.append(buffer)
            iokit.IOHIDDeviceRegisterInputReportWithTimeStampCallback(device, buffer, 4096, callback, None)
            iokit.IOHIDDeviceScheduleWithRunLoop(device, cf.CFRunLoopGetCurrent(), kCFRunLoopDefaultMode)
            opened = True
        self.found = opened
        while opened:
            cf.CFRunLoopRunInMode(kCFRunLoopDefaultMode, 1.0, False)

    def _on_report(self, ctx, result, sender, report_type, report_id, report, length, timestamp):
        if length != 22:
            return
        x, y, z = struct.unpack('<iii', bytes(report[6:18]))
        sample = [round(timestamp * TICKS_TO_MS, 3), round(x / 65536, 5), round(y / 65536, 5), round(z / 65536, 5)]
        with self.lock:
            self.samples.append(sample)
            self.total += 1
            if len(self.samples) > self.CAPACITY:
                del self.samples[: len(self.samples) - self.CAPACITY]

    def since(self, index):
        """Campioni con indice assoluto ≥ index; restituisce (campioni, nuovo indice)."""
        with self.lock:
            first = self.total - len(self.samples)
            start = max(index, first) - first
            return self.samples[start:], self.total


sensor = Sensor()

# ---------------------------------------------------------------- server

proxy_cache = {}


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, *args):
        pass

    def cors(self):
        origin = self.headers.get('Origin')
        if origin in ALLOWED_ORIGINS:
            self.send_header('Access-Control-Allow-Origin', origin)
            self.send_header('Vary', 'Origin')

    def do_OPTIONS(self):
        self.send_response(204)
        self.cors()
        self.send_header('Access-Control-Allow-Methods', 'GET')
        self.send_header('Access-Control-Allow-Private-Network', 'true')  # Chrome, rete locale
        self.send_header('Content-Length', '0')
        self.end_headers()

    def do_GET(self):
        path = self.path.split('?')[0]
        if path == '/motion':
            return self.stream()
        if path == '/status':
            body = json.dumps({'sensor': bool(sensor.found), 'samples': sensor.total}).encode()
            return self.reply(200, 'application/json', body)
        return self.serve_app(path)

    def reply(self, code, content_type, body):
        self.send_response(code)
        self.cors()
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-cache')
        self.end_headers()
        self.wfile.write(body)

    def stream(self):
        """Server-Sent Events: ogni ~15 ms i campioni nuovi, come [[t, x, y, z], …]."""
        origin = self.headers.get('Origin')
        if origin and origin not in ALLOWED_ORIGINS:
            return self.reply(403, 'text/plain', b'origine non ammessa')
        self.send_response(200)
        self.cors()
        self.send_header('Content-Type', 'text/event-stream')
        self.send_header('Cache-Control', 'no-cache')
        self.send_header('Connection', 'keep-alive')
        self.end_headers()
        index = sensor.total
        try:
            while True:
                batch, index = sensor.since(index)
                if batch:
                    self.wfile.write(b'data: ' + json.dumps(batch, separators=(',', ':')).encode() + b'\n\n')
                    self.wfile.flush()
                time.sleep(0.015)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def serve_app(self, path):
        if path.endswith('/'):
            path += 'index.html'
        if LOCAL_APP:
            file = os.path.normpath(os.path.join(ROOT, path.lstrip('/')))
            if not file.startswith(ROOT) or not os.path.isfile(file) or '/lab/' in file:
                return self.reply(404, 'text/plain', b'non trovato')
            with open(file, 'rb') as f:
                body = f.read()
            kind = mimetypes.guess_type(file)[0] or 'application/octet-stream'
            if file.endswith(('.js', '.mjs')):
                kind = 'text/javascript'
            return self.reply(200, kind, body)
        if path not in proxy_cache:
            try:
                with urllib.request.urlopen(APP_URL + path.lstrip('/'), timeout=10) as response:
                    proxy_cache[path] = (response.headers.get('Content-Type', 'application/octet-stream'), response.read())
            except Exception:
                return self.reply(404, 'text/plain', b'non trovato')
        kind, body = proxy_cache[path]
        return self.reply(200, kind, body)


def main():
    if sys.platform != 'darwin':
        sys.exit('Questo programma funziona solo su Mac.')
    if not sensor.start():
        sys.exit('Sensore di movimento non trovato. Serve un MacBook con chip M1 Pro/Max, M2 o successivo.')
    try:
        server = ThreadingHTTPServer(('127.0.0.1', PORT), Handler)
    except OSError:
        sys.exit(f'La porta {PORT} è occupata: forse il programma è già aperto.')
    server.daemon_threads = True
    url = f'http://localhost:{PORT}/'
    print(f'Sensore del MacBook attivo. Apri {url} (Ctrl+C per chiudere).', flush=True)
    if '--no-browser' not in sys.argv:
        threading.Timer(0.5, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\nChiuso.')


if __name__ == '__main__':
    main()
