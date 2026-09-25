// Interprete minimo di grafi ONNX (opset 17) in JavaScript puro, per far girare S-KEY
// (Kong et al., ICASSP 2025, licenza MIT) nel telefono senza librerie esterne.
// Supporta solo le operazioni usate da quel modello; il grafo arriva come JSON
// (nodi + pesi in base64) esportato in lab/.

// ---------- Tensori ----------

const size = (dims) => dims.reduce((a, b) => a * b, 1);
const strides = (dims) => {
  const s = new Array(dims.length);
  let acc = 1;
  for (let i = dims.length - 1; i >= 0; i--) { s[i] = acc; acc *= dims[i]; }
  return s;
};
const tensor = (dims, data, dtype = 'float32') => ({ dims, data, dtype });
const floatT = (dims, data) => tensor(dims, data instanceof Float32Array ? data : Float32Array.from(data));
const intT = (dims, data) => tensor(dims, Array.from(data, Number), 'int64');

function decode(t) {
  if (t.dtype === 'float32') {
    const bin = typeof atob === 'function' ? atob(t.data) : Buffer.from(t.data, 'base64').toString('binary');
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return tensor(t.dims, new Float32Array(bytes.buffer));
  }
  return intT(t.dims, t.data);
}

// Forma risultante del broadcasting numpy.
function broadcastDims(a, b) {
  const n = Math.max(a.length, b.length);
  const out = [];
  for (let i = 0; i < n; i++) {
    const x = a[a.length - n + i] ?? 1;
    const y = b[b.length - n + i] ?? 1;
    if (x !== y && x !== 1 && y !== 1) throw new Error(`broadcast impossibile ${a} ${b}`);
    out.push(Math.max(x, y));
  }
  return out;
}

// Indice sorgente per ogni elemento dell'uscita, con broadcasting.
function broadcastIndex(srcDims, outDims) {
  const n = outDims.length;
  const src = Array(n - srcDims.length).fill(1).concat(srcDims);
  const ss = strides(src);
  const os = strides(outDims);
  const total = size(outDims);
  const idx = new Int32Array(total);
  for (let i = 0; i < total; i++) {
    let rem = i;
    let s = 0;
    for (let d = 0; d < n; d++) {
      const c = Math.floor(rem / os[d]);
      rem -= c * os[d];
      if (src[d] !== 1) s += c * ss[d];
    }
    idx[i] = s;
  }
  return idx;
}

// Se `src` (allineato a destra) ha dimensioni diverse da 1 solo su un blocco contiguo di
// assi uguali a quelli dell'uscita, restituisce { inner, count } per l'indicizzazione veloce.
function broadcastPattern(srcDims, outDims) {
  const n = outDims.length;
  const src = Array(n - srcDims.length).fill(1).concat(srcDims);
  let first = -1;
  let last = -1;
  for (let d = 0; d < n; d++) {
    if (src[d] !== 1) {
      if (src[d] !== outDims[d]) return null;
      if (first < 0) first = d;
      last = d;
    }
  }
  if (first < 0) return { inner: 1, count: 1 };
  for (let d = first; d <= last; d++) if (src[d] !== outDims[d]) return null;
  return { inner: size(outDims.slice(last + 1)), count: size(outDims.slice(first, last + 1)) };
}

function binary(a, b, fn) {
  const dims = broadcastDims(a.dims, b.dims);
  const total = size(dims);
  const isInt = a.dtype === 'int64' && b.dtype === 'int64';
  const out = isInt ? new Array(total) : new Float32Array(total);
  const sameA = size(a.dims) === total && a.dims.length === dims.length;
  const sameB = size(b.dims) === total && b.dims.length === dims.length;
  const scalarB = size(b.dims) === 1;
  const scalarA = size(a.dims) === 1;
  const pattern = sameA ? broadcastPattern(b.dims, dims) : null;
  const patternA = !sameA && sameB ? broadcastPattern(a.dims, dims) : null;
  if (sameA && (sameB || scalarB)) {
    const bd = b.data;
    const ad = a.data;
    if (scalarB) { const q = bd[0]; for (let i = 0; i < total; i++) out[i] = fn(ad[i], q); }
    else for (let i = 0; i < total; i++) out[i] = fn(ad[i], bd[i]);
  } else if (scalarA && sameB) {
    for (let i = 0; i < total; i++) out[i] = fn(a.data[0], b.data[i]);
  } else if (pattern) {
    // b varia solo su un blocco contiguo di assi: indice = floor(i / inner) % count.
    const { inner, count } = pattern;
    const ad = a.data;
    const bd = b.data;
    if (inner === 1) for (let i = 0; i < total; i++) out[i] = fn(ad[i], bd[i % count]);
    else for (let i = 0; i < total; i++) out[i] = fn(ad[i], bd[Math.floor(i / inner) % count]);
  } else if (patternA) {
    const { inner, count } = patternA;
    const ad = a.data;
    const bd = b.data;
    if (inner === 1) for (let i = 0; i < total; i++) out[i] = fn(ad[i % count], bd[i]);
    else for (let i = 0; i < total; i++) out[i] = fn(ad[Math.floor(i / inner) % count], bd[i]);
  } else {
    const ia = broadcastIndex(a.dims, dims);
    const ib = broadcastIndex(b.dims, dims);
    for (let i = 0; i < total; i++) out[i] = fn(a.data[ia[i]], b.data[ib[i]]);
  }
  return tensor(dims, out, isInt ? 'int64' : 'float32');
}

function unary(a, fn) {
  const out = new Float32Array(a.data.length);
  for (let i = 0; i < out.length; i++) out[i] = fn(a.data[i]);
  return tensor(a.dims.slice(), out);
}

// erf con l'approssimazione 7.1.26 di Abramowitz & Stegun (errore < 1.5e-7).
function erf(x) {
  const s = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-ax * ax);
  return s * y;
}

const normAxis = (axis, rank) => (axis < 0 ? axis + rank : axis);

function reduce(a, axes, keepdims, init, step, finish) {
  const rank = a.dims.length;
  const ax = new Set((axes && axes.length ? axes : a.dims.map((_, i) => i)).map((x) => normAxis(x, rank)));
  const outDims = a.dims.map((d, i) => (ax.has(i) ? 1 : d));
  // Caso veloce: si riducono gli ultimi assi (blocchi contigui).
  const trailing = [...ax].every((d) => d >= rank - ax.size);
  if (trailing) {
    const inner = size(a.dims.slice(rank - ax.size));
    const outer = a.data.length / inner;
    const out = new Float32Array(outer);
    for (let o = 0; o < outer; o++) {
      let acc = init;
      const base = o * inner;
      for (let i = 0; i < inner; i++) acc = step(acc, a.data[base + i]);
      out[o] = finish ? finish(acc, inner) : acc;
    }
    return tensor(keepdims ? outDims : outDims.filter((_, i) => !ax.has(i)), out);
  }
  const out = new Float32Array(size(outDims)).fill(init);
  const counts = size(a.dims) / out.length;
  const is = strides(a.dims);
  const os = strides(outDims);
  for (let i = 0; i < a.data.length; i++) {
    let rem = i;
    let o = 0;
    for (let d = 0; d < rank; d++) {
      const c = Math.floor(rem / is[d]);
      rem -= c * is[d];
      if (!ax.has(d)) o += c * os[d];
    }
    out[o] = step(out[o], a.data[i]);
  }
  if (finish) for (let i = 0; i < out.length; i++) out[i] = finish(out[i], counts);
  return tensor(keepdims ? outDims : outDims.filter((_, i) => !ax.has(i)), out);
}

function transpose(a, perm) {
  const rank = a.dims.length;
  const p = perm && perm.length ? perm : a.dims.map((_, i) => rank - 1 - i);
  const outDims = p.map((i) => a.dims[i]);
  const is = strides(a.dims);
  const os = strides(outDims);
  const out = a.dtype === 'int64' ? new Array(a.data.length) : new Float32Array(a.data.length);
  const total = a.data.length;
  const coord = new Array(rank).fill(0);
  for (let o = 0; o < total; o++) {
    let rem = o;
    let src = 0;
    for (let d = 0; d < rank; d++) {
      const c = Math.floor(rem / os[d]);
      rem -= c * os[d];
      coord[d] = c;
      src += c * is[p[d]];
    }
    out[o] = a.data[src];
  }
  return tensor(outDims, out, a.dtype);
}

function slice(a, starts, ends, axes, steps) {
  const rank = a.dims.length;
  const st = new Array(rank).fill(0);
  const en = a.dims.slice();
  const sp = new Array(rank).fill(1);
  (axes || starts.map((_, i) => i)).forEach((axis, i) => {
    const d = normAxis(axis, rank);
    const dim = a.dims[d];
    const step = steps ? steps[i] : 1;
    let s = starts[i];
    let e = ends[i];
    if (s < 0) s += dim;
    if (e < 0) e += dim;
    if (step > 0) { s = Math.max(0, Math.min(dim, s)); e = Math.max(0, Math.min(dim, e)); }
    else { s = Math.max(-1, Math.min(dim - 1, s)); e = Math.max(-1, Math.min(dim - 1, e)); }
    st[d] = s; en[d] = e; sp[d] = step;
  });
  const outDims = st.map((s, d) => Math.max(0, Math.ceil((en[d] - s) / sp[d])));
  const is = strides(a.dims);
  const os = strides(outDims);
  const total = size(outDims);
  const out = a.dtype === 'int64' ? new Array(total) : new Float32Array(total);
  for (let o = 0; o < total; o++) {
    let rem = o;
    let src = 0;
    for (let d = 0; d < rank; d++) {
      const c = Math.floor(rem / os[d]);
      rem -= c * os[d];
      src += (st[d] + c * sp[d]) * is[d];
    }
    out[o] = a.data[src];
  }
  return tensor(outDims, out, a.dtype);
}

function concat(list, axis) {
  const rank = list[0].dims.length;
  const ax = normAxis(axis, rank);
  const outDims = list[0].dims.slice();
  outDims[ax] = list.reduce((a, t) => a + t.dims[ax], 0);
  const outer = size(outDims.slice(0, ax));
  const isInt = list[0].dtype === 'int64';
  const out = isInt ? [] : new Float32Array(size(outDims));
  let pos = 0;
  for (let o = 0; o < outer; o++) {
    for (const t of list) {
      const chunk = size(t.dims.slice(ax));
      for (let i = 0; i < chunk; i++) {
        if (isInt) out.push(t.data[o * chunk + i]);
        else out[pos++] = t.data[o * chunk + i];
      }
    }
  }
  return tensor(outDims, out, list[0].dtype);
}

// Pad (modi: constant, reflect, edge) su qualunque numero di assi.
function pad(a, pads, mode, value = 0) {
  const rank = a.dims.length;
  const before = pads.slice(0, rank);
  const after = pads.slice(rank);
  const outDims = a.dims.map((d, i) => d + before[i] + after[i]);
  const is = strides(a.dims);
  const os = strides(outDims);
  const out = new Float32Array(size(outDims));
  for (let o = 0; o < out.length; o++) {
    let rem = o;
    let src = 0;
    let inside = true;
    for (let d = 0; d < rank; d++) {
      const c = Math.floor(rem / os[d]);
      rem -= c * os[d];
      let x = c - before[d];
      const n = a.dims[d];
      if (x < 0 || x >= n) {
        if (mode === 'constant') { inside = false; break; }
        if (mode === 'reflect') { while (x < 0 || x >= n) x = x < 0 ? -x : 2 * (n - 1) - x; }
        else x = Math.max(0, Math.min(n - 1, x)); // edge
      }
      src += x * is[d];
    }
    out[o] = inside ? a.data[src] : value;
  }
  return tensor(outDims, out);
}

// Convoluzione 1D o 2D (NCL / NCHW), con gruppi, passi, padding e dilatazione.
function conv(x, w, b, attrs) {
  const spatial = x.dims.length - 2;
  const [N, C] = x.dims;
  const [M, Cg] = w.dims;
  const group = attrs.group || 1;
  const ks = w.dims.slice(2);
  const st = attrs.strides || ks.map(() => 1);
  const dl = attrs.dilations || ks.map(() => 1);
  const pd = attrs.pads || ks.map(() => 0).concat(ks.map(() => 0));
  if (spatial === 1) {
    const L = x.dims[2];
    const K = ks[0];
    const outL = Math.floor((L + pd[0] + pd[1] - dl[0] * (K - 1) - 1) / st[0]) + 1;
    const out = new Float32Array(N * M * outL);
    const mPerG = M / group;
    for (let n = 0; n < N; n++) {
      for (let m = 0; m < M; m++) {
        const g = Math.floor(m / mPerG);
        const xd = x.data;
        const wd = w.data;
        const dil = dl[0];
        for (let o = 0; o < outL; o++) {
          let acc = b ? b.data[m] : 0;
          const start = o * st[0] - pd[0];
          const inside = start >= 0 && start + (K - 1) * dil < L;
          for (let c = 0; c < Cg; c++) {
            const xc = (n * C + g * Cg + c) * L + start;
            const wc = (m * Cg + c) * K;
            if (inside) {
              for (let k = 0; k < K; k++) acc += xd[xc + k * dil] * wd[wc + k];
            } else {
              for (let k = 0; k < K; k++) {
                const pos = start + k * dil;
                if (pos >= 0 && pos < L) acc += xd[xc + k * dil] * wd[wc + k];
              }
            }
          }
          out[(n * M + m) * outL + o] = acc;
        }
      }
    }
    return tensor([N, M, outL], out);
  }
  const [H, W] = x.dims.slice(2);
  const [KH, KW] = ks;
  if (KH === 1 && group === 1 && st[0] === 1 && st[1] === KW && pd.every((v) => v === 0) && dl.every((v) => v === 1)) {
    // Riduzione nel tempo: out[m, h, t] = Σ_c Σ_k x[c, h, t·KW + k] · w[m, c, k] + b[m].
    const outW = Math.floor((W - KW) / KW) + 1;
    const out = new Float32Array(N * M * H * outW);
    const xd = x.data;
    const wd = w.data;
    for (let n = 0; n < N; n++) {
      for (let m = 0; m < M; m++) {
        const ob = (n * M + m) * H * outW;
        const bias = b ? b.data[m] : 0;
        out.fill(bias, ob, ob + H * outW);
        for (let c = 0; c < C; c++) {
          const xc = (n * C + c) * H * W;
          const wc = (m * C + c) * KW;
          for (let h = 0; h < H; h++) {
            const xr = xc + h * W;
            const or = ob + h * outW;
            for (let t = 0; t < outW; t++) {
              let acc = 0;
              const xt = xr + t * KW;
              for (let k = 0; k < KW; k++) acc += xd[xt + k] * wd[wc + k];
              out[or + t] += acc;
            }
          }
        }
      }
    }
    return tensor([N, M, H, outW], out);
  }
  const outH = Math.floor((H + pd[0] + pd[2] - dl[0] * (KH - 1) - 1) / st[0]) + 1;
  const outW = Math.floor((W + pd[1] + pd[3] - dl[1] * (KW - 1) - 1) / st[1]) + 1;
  const out = new Float32Array(N * M * outH * outW);
  const mPerG = M / group;
  for (let n = 0; n < N; n++) {
    for (let m = 0; m < M; m++) {
      const g = Math.floor(m / mPerG);
      const bias = b ? b.data[m] : 0;
      const ob = (n * M + m) * outH * outW;
      const xd = x.data;
      const wd = w.data;
      const [dh, dw] = dl;
      for (let oh = 0; oh < outH; oh++) {
        const h0 = oh * st[0] - pd[0];
        // Righe del kernel valide per questa riga d'uscita (senza controlli nel ciclo interno).
        const khLo = Math.max(0, Math.ceil(-h0 / dh));
        const khHi = Math.min(KH - 1, Math.floor((H - 1 - h0) / dh));
        for (let ow = 0; ow < outW; ow++) {
          let acc = bias;
          const w0 = ow * st[1] - pd[1];
          const kwLo = Math.max(0, Math.ceil(-w0 / dw));
          const kwHi = Math.min(KW - 1, Math.floor((W - 1 - w0) / dw));
          for (let c = 0; c < Cg; c++) {
            const xc = (n * C + g * Cg + c) * H * W;
            const wc = (m * Cg + c) * KH * KW;
            for (let kh = khLo; kh <= khHi; kh++) {
              const row = xc + (h0 + kh * dh) * W + w0;
              const wrow = wc + kh * KW;
              for (let kw = kwLo; kw <= kwHi; kw++) acc += xd[row + kw * dw] * wd[wrow + kw];
            }
          }
          out[ob + oh * outW + ow] = acc;
        }
      }
    }
  }
  return tensor([N, M, outH, outW], out);
}

// MatMul con B bidimensionale (il caso del modello) o batch con broadcasting semplice.
function matmul(a, b) {
  if (b.dims.length === 2) {
    const K = a.dims[a.dims.length - 1];
    const [K2, N] = b.dims;
    if (K !== K2) throw new Error('MatMul: dimensioni incompatibili');
    const rows = a.data.length / K;
    const out = new Float32Array(rows * N);
    for (let r = 0; r < rows; r++) {
      const ao = r * K;
      const oo = r * N;
      for (let k = 0; k < K; k++) {
        const av = a.data[ao + k];
        if (av === 0) continue;
        const bo = k * N;
        for (let j = 0; j < N; j++) out[oo + j] += av * b.data[bo + j];
      }
    }
    return tensor(a.dims.slice(0, -1).concat([N]), out);
  }
  throw new Error('MatMul: caso non supportato');
}

// ---------- Esecuzione del grafo ----------

export class OnnxLite {
  constructor(graph) {
    this.graph = graph;
    this.weights = {};
    for (const [name, t] of Object.entries(graph.tensors)) this.weights[name] = decode(t);
    for (const node of graph.nodes) {
      for (const [k, v] of Object.entries(node.attrs)) if (v && v.tensor) node.attrs[k] = decode(v);
    }
  }

  run(inputs, profile = null) {
    const env = { ...this.weights, ...inputs };
    const get = (name) => (name ? env[name] : undefined);
    const ints = (t) => Array.from(t.data, Number);
    for (const node of this.graph.nodes) {
      const a = node.attrs;
      const x = node.in.map(get);
      const t0 = profile ? performance.now() : 0;
      let y;
      switch (node.op) {
        case 'Identity': y = x[0]; break;
        case 'Constant': y = a.value; break;
        case 'Abs': y = unary(x[0], Math.abs); break;
        case 'Neg': y = x[0].dtype === 'int64' ? intT(x[0].dims, x[0].data.map((v) => -v)) : unary(x[0], (v) => -v); break;
        case 'Sqrt': y = unary(x[0], Math.sqrt); break;
        case 'Log': y = unary(x[0], Math.log); break;
        case 'Erf': y = unary(x[0], erf); break;
        case 'Add': y = binary(x[0], x[1], (p, q) => p + q); break;
        case 'Sub': y = binary(x[0], x[1], (p, q) => p - q); break;
        case 'Mul': y = binary(x[0], x[1], (p, q) => p * q); break;
        case 'Div': y = binary(x[0], x[1], x[0].dtype === 'int64' && x[1].dtype === 'int64' ? (p, q) => Math.trunc(p / q) : (p, q) => p / q); break;
        case 'Pow': y = binary(x[0], x[1], (p, q) => (q === 2 ? p * p : p ** q)); break;
        case 'Max': y = x.slice(1).reduce((acc, t) => binary(acc, t, Math.max), x[0]); break;
        case 'Clip': {
          const lo = x[1] ? x[1].data[0] : -Infinity;
          const hi = x[2] ? x[2].data[0] : Infinity;
          y = unary(x[0], (v) => Math.min(hi, Math.max(lo, v)));
          break;
        }
        case 'ReduceMax': y = reduce(x[0], a.axes, a.keepdims ?? 1, -Infinity, Math.max); break;
        case 'ReduceMean': y = reduce(x[0], a.axes, a.keepdims ?? 1, 0, (s, v) => s + v, (s, n) => s / n); break;
        case 'ReduceSum': y = reduce(x[0], x[1] ? ints(x[1]) : [], a.keepdims ?? 1, 0, (s, v) => s + v); break;
        case 'Shape': y = intT([x[0].dims.length], x[0].dims); break;
        case 'Cast': y = a.to === 7 || a.to === 6 ? intT(x[0].dims, Array.from(x[0].data, (v) => Math.trunc(Number(v)))) : floatT(x[0].dims, Array.from(x[0].data, Number)); break;
        case 'ConstantOfShape': {
          const dims = ints(x[0]);
          const v = a.value ? a.value.data[0] : 0;
          y = a.value && a.value.dtype === 'int64' ? intT(dims, new Array(size(dims)).fill(v)) : floatT(dims, new Float32Array(size(dims)).fill(v));
          break;
        }
        case 'Unsqueeze': {
          const axes = ints(x[1]);
          const rank = x[0].dims.length + axes.length;
          const dims = x[0].dims.slice();
          axes.map((ax) => normAxis(ax, rank)).sort((p, q) => p - q).forEach((ax) => dims.splice(ax, 0, 1));
          y = tensor(dims, x[0].data, x[0].dtype);
          break;
        }
        case 'Reshape': {
          const shape = ints(x[1]);
          const total = x[0].data.length;
          const dims = shape.map((d, i) => (d === 0 && !a.allowzero ? x[0].dims[i] : d));
          const known = dims.reduce((p, d) => (d === -1 ? p : p * d), 1);
          y = tensor(dims.map((d) => (d === -1 ? total / known : d)), x[0].data, x[0].dtype);
          break;
        }
        case 'Flatten': {
          const axis = normAxis(a.axis ?? 1, x[0].dims.length);
          y = tensor([size(x[0].dims.slice(0, axis)), size(x[0].dims.slice(axis))], x[0].data, x[0].dtype);
          break;
        }
        case 'Transpose': y = transpose(x[0], a.perm); break;
        case 'Slice': y = slice(x[0], ints(x[1]), ints(x[2]), x[3] ? ints(x[3]) : null, x[4] ? ints(x[4]) : null); break;
        case 'Concat': y = concat(x, a.axis); break;
        case 'Gather': {
          const axis = normAxis(a.axis ?? 0, x[0].dims.length);
          const idx = ints(x[1]).map((i) => (i < 0 ? i + x[0].dims[axis] : i));
          if (x[0].dims.length !== 1 || axis !== 0) throw new Error('Gather: caso non supportato');
          const vals = idx.map((i) => x[0].data[i]);
          y = tensor(x[1].dims.slice(), x[0].dtype === 'int64' ? vals : Float32Array.from(vals), x[0].dtype);
          break;
        }
        case 'Pad': {
          const mode = a.mode || 'constant';
          y = pad(x[0], ints(x[1]), mode, x[2] ? x[2].data[0] : 0);
          break;
        }
        case 'Conv': y = conv(x[0], x[1], x[2], a); break;
        case 'MatMul': y = matmul(x[0], x[1]); break;
        case 'Softmax': {
          const axis = normAxis(a.axis ?? -1, x[0].dims.length);
          if (axis !== x[0].dims.length - 1) throw new Error('Softmax: solo sull\'ultimo asse');
          const n = x[0].dims[axis];
          const out = new Float32Array(x[0].data.length);
          for (let r = 0; r < out.length / n; r++) {
            let max = -Infinity;
            for (let i = 0; i < n; i++) max = Math.max(max, x[0].data[r * n + i]);
            let z = 0;
            for (let i = 0; i < n; i++) { out[r * n + i] = Math.exp(x[0].data[r * n + i] - max); z += out[r * n + i]; }
            for (let i = 0; i < n; i++) out[r * n + i] /= z;
          }
          y = tensor(x[0].dims.slice(), out);
          break;
        }
        default:
          throw new Error(`Operazione ONNX non supportata: ${node.op}`);
      }
      node.out.forEach((name) => { env[name] = y; });
      if (profile) {
        const key = `${node.op} ${JSON.stringify(x[0]?.dims)}${node.op === 'Conv' ? ` k${JSON.stringify(x[1].dims)} g${a.group || 1}` : ''}`;
        profile[key] = (profile[key] || 0) + performance.now() - t0;
      }
    }
    return Object.fromEntries([...this.graph.outputs, ...(this.extraOutputs || [])].map((name) => [name, env[name]]));
  }
}
