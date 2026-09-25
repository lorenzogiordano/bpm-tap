// Converte l'audio dei dataset da float32 a int16 (metà spazio), aggiornando index.json.
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { DATA } from './common.mjs';
for (const dataset of process.argv.slice(2)) {
  const indexPath = join(DATA, dataset, 'index.json');
  const index = JSON.parse(readFileSync(indexPath, 'utf8'));
  let converted = 0;
  for (const item of index) {
    if (!item.file || !item.file.endsWith('.f32')) continue;
    const src = join(DATA, dataset, item.file);
    if (!existsSync(src)) continue;
    const buf = readFileSync(src);
    const f = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
    const peak = f.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
    const gain = peak > 1 ? 1 / peak : 1;
    const s = Int16Array.from(f, (v) => Math.max(-32768, Math.min(32767, Math.round(v * gain * 32767))));
    const dst = src.replace(/\.f32$/, '.s16');
    writeFileSync(dst, Buffer.from(s.buffer));
    unlinkSync(src);
    item.file = item.file.replace(/\.f32$/, '.s16');
    converted += 1;
  }
  writeFileSync(indexPath, JSON.stringify(index, null, 1));
  console.log(dataset, 'convertiti', converted);
}
