'use strict';
/* SGNAudio 7 — Editor y grabador de audio multipista
   Desarrollado por Salvador G. Núñez */

const $ = (s) => document.querySelector(s);
const AC = window.AudioContext || window.webkitAudioContext;
const ctx = new AC();
const SR = ctx.sampleRate;
const HEAD_W = 200;

// ---------- Estado ----------
let tracks = [];            // {id,name,ch:[Float32Array],mute,solo,gain}
let nextId = 1;
let activeId = null;
let pps = 100;              // píxeles por segundo
let sel = null;             // {a,b} en segundos
let cursor = 0;             // segundos
let clipboard = null;       // [Float32Array]
let loop = false;
let undoStack = [];
let redoStack = [];
let playing = false;
let playSources = [];
let playFrom = 0, playTo = 0, playCtxStart = 0;
let recorder = null, recStream = null, recChunks = [], recAnalyser = null;
let recCount = 1;

// Cadena de salida
const master = ctx.createGain();
const outAn = ctx.createAnalyser();
outAn.fftSize = 1024;
master.connect(outAn);
outAn.connect(ctx.destination);

// ---------- Utilidades ----------
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const dur = () => tracks.reduce((m, t) => Math.max(m, t.ch[0].length), 0) / SR;
const activeTrack = () => tracks.find((t) => t.id === activeId) || tracks[0] || null;
function fmt(sec) {
  sec = Math.max(0, sec);
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return String(m).padStart(2, '0') + ':' + s.toFixed(3).padStart(6, '0');
}
function setStatus(msg) { $('#status').textContent = msg; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- Deshacer / Rehacer ----------
function snapshot() {
  undoStack.push(tracks.map((t) => ({ ...t })));
  if (undoStack.length > 60) undoStack.shift();
  redoStack = [];
}
function undo() {
  if (!undoStack.length) return setStatus('Nada que deshacer.');
  stopPlay();
  redoStack.push(tracks.map((t) => ({ ...t })));
  tracks = undoStack.pop().map((t) => ({ ...t }));
  if (!tracks.find((t) => t.id === activeId)) activeId = tracks[0]?.id ?? null;
  renderAll(); setStatus('Deshacer.');
}
function redo() {
  if (!redoStack.length) return setStatus('Nada que rehacer.');
  stopPlay();
  undoStack.push(tracks.map((t) => ({ ...t })));
  tracks = redoStack.pop().map((t) => ({ ...t }));
  if (!tracks.find((t) => t.id === activeId)) activeId = tracks[0]?.id ?? null;
  renderAll(); setStatus('Rehacer.');
}

// ---------- Pistas ----------
function channelsOf(abuf) {
  const out = [];
  for (let i = 0; i < abuf.numberOfChannels; i++) out.push(abuf.getChannelData(i).slice());
  return out;
}
function addTrack(name, ch, startSec = 0) {
  const pad = Math.round(startSec * SR);
  if (pad > 0) {
    ch = ch.map((c) => { const n = new Float32Array(c.length + pad); n.set(c, pad); return n; });
  }
  const t = { id: nextId++, name, ch, mute: false, solo: false, gain: 1 };
  tracks.push(t);
  activeId = t.id;
  return t;
}
async function loadFile(name, arrayBuffer) {
  try {
    setStatus('Cargando ' + name + '…');
    const abuf = await ctx.decodeAudioData(arrayBuffer.slice(0));
    snapshot();
    const first = tracks.length === 0;
    addTrack(name.replace(/\.[^.]+$/, ''), channelsOf(abuf));
    renderAll();
    if (first) zoomFit();
    setStatus('Cargado: ' + name + ' (' + abuf.duration.toFixed(2) + ' s)');
  } catch (e) {
    console.error(e);
    setStatus('No se pudo abrir ' + name + ' (formato no compatible).');
  }
}
async function openFiles() {
  const files = await window.sgn.openDialog();
  for (const f of files) await loadFile(f.name, f.data.buffer.slice(f.data.byteOffset, f.data.byteOffset + f.data.byteLength));
}
function newEmptyTrack() {
  snapshot();
  addTrack('Pista ' + nextId, [new Float32Array(Math.round(SR * 1))]);
  renderAll();
}
function dupTrack() {
  const t = activeTrack(); if (!t) return;
  snapshot();
  addTrack(t.name + ' (copia)', t.ch.map((c) => c.slice()));
  renderAll();
}
function delTrack() {
  const t = activeTrack(); if (!t) return;
  stopPlay(); snapshot();
  tracks = tracks.filter((x) => x.id !== t.id);
  activeId = tracks[0]?.id ?? null;
  renderAll();
}
function splitTrack() {
  const t = activeTrack(); if (!t) return;
  const p = Math.round(cursor * SR);
  if (p <= 0 || p >= t.ch[0].length) return setStatus('Coloca el cursor dentro de la pista para dividirla.');
  snapshot();
  const left = t.ch.map((c) => c.slice(0, p));
  const right = t.ch.map((c) => c.slice(p));
  t.ch = left;
  const r = { id: nextId++, name: t.name + ' (2)', ch: right, mute: false, solo: false, gain: t.gain };
  tracks.splice(tracks.indexOf(t) + 1, 0, r);
  renderAll();
}
function newProject() {
  ask('Nuevo proyecto', [], 'Descartar y empezar', 'Se cerrarán todas las pistas del proyecto actual. ¿Continuar?').then((ok) => {
    if (!ok) return;
    stopPlay(); tracks = []; undoStack = []; redoStack = []; sel = null; cursor = 0; activeId = null; renderAll();
    setStatus('Proyecto nuevo.');
  });
}

// ---------- Edición ----------
function rangeSamples(t, requireSel) {
  const len = t.ch[0].length;
  if (sel) return [clamp(Math.round(sel.a * SR), 0, len), clamp(Math.round(sel.b * SR), 0, len)];
  if (requireSel) return null;
  return [0, len];
}
function removeRange(t, a, b) {
  t.ch = t.ch.map((c) => {
    const n = new Float32Array(c.length - (b - a));
    n.set(c.subarray(0, a)); n.set(c.subarray(b), a);
    return n;
  });
}
function doCopy() {
  const t = activeTrack(); if (!t) return;
  const r = rangeSamples(t, true);
  if (!r || r[1] <= r[0]) return setStatus('Selecciona un fragmento con el ratón primero.');
  clipboard = t.ch.map((c) => c.slice(r[0], r[1]));
  setStatus('Copiado ' + ((r[1] - r[0]) / SR).toFixed(2) + ' s.');
}
function doCut() {
  const t = activeTrack(); if (!t) return;
  const r = rangeSamples(t, true);
  if (!r || r[1] <= r[0]) return setStatus('Selecciona un fragmento con el ratón primero.');
  stopPlay(); snapshot();
  clipboard = t.ch.map((c) => c.slice(r[0], r[1]));
  removeRange(t, r[0], r[1]);
  cursor = r[0] / SR; sel = null;
  renderAll(); setStatus('Cortado.');
}
function doDelete() {
  const t = activeTrack(); if (!t) return;
  const r = rangeSamples(t, true);
  if (!r || r[1] <= r[0]) return setStatus('Selecciona un fragmento con el ratón primero.');
  stopPlay(); snapshot();
  removeRange(t, r[0], r[1]);
  cursor = r[0] / SR; sel = null;
  renderAll(); setStatus('Eliminado.');
}
function doPaste() {
  const t = activeTrack();
  if (!clipboard) return setStatus('El portapapeles está vacío.');
  if (!t) return;
  stopPlay(); snapshot();
  let pos = Math.round(cursor * SR);
  const r = rangeSamples(t, true);
  if (r && r[1] > r[0]) { removeRange(t, r[0], r[1]); pos = r[0]; }
  const len = t.ch[0].length;
  if (pos > len) pos = len;
  const clipLen = clipboard[0].length;
  t.ch = t.ch.map((c, i) => {
    const src = clipboard[Math.min(i, clipboard.length - 1)];
    const n = new Float32Array(c.length + clipLen);
    n.set(c.subarray(0, pos)); n.set(src, pos); n.set(c.subarray(pos), pos + clipLen);
    return n;
  });
  sel = { a: pos / SR, b: (pos + clipLen) / SR };
  cursor = sel.a;
  renderAll(); setStatus('Pegado.');
}
function doTrim() {
  const t = activeTrack(); if (!t) return;
  const r = rangeSamples(t, true);
  if (!r || r[1] <= r[0]) return setStatus('Selecciona el fragmento que quieres conservar.');
  stopPlay(); snapshot();
  t.ch = t.ch.map((c) => c.slice(r[0], r[1]));
  sel = null; cursor = 0;
  renderAll(); setStatus('Recortado al área seleccionada.');
}
function selectAll() {
  const d = dur(); if (!d) return;
  sel = { a: 0, b: d }; updateOverlays();
}

// ---------- Efectos ----------
const FX_LABEL = {
  'fade-in': 'Fundido de entrada', 'fade-out': 'Fundido de salida', amplify: 'Amplificar', normalize: 'Normalizar',
  reverse: 'Al revés', silence: 'Silencio', invert: 'Invertir fase', 'noise-gate': 'Reducción de ruido',
  echo: 'Eco', speed: 'Velocidad', bass: 'Graves', compress: 'Compresor',
};

function eachChannelRange(t, a, b, fn) {
  t.ch = t.ch.map((c, i) => {
    const n = c.slice();
    fn(n.subarray(a, b), i);
    return n;
  });
}
const peakOf = (arr) => { let p = 0; for (let i = 0; i < arr.length; i++) { const v = Math.abs(arr[i]); if (v > p) p = v; } return p; };
function limit(arr) { for (let i = 0; i < arr.length; i++) arr[i] = clamp(arr[i], -1, 1); }

async function applyFx(name) {
  const t = activeTrack();
  if (!t) return setStatus('Abre o graba audio primero.');
  const r = rangeSamples(t, false);
  const [a, b] = r;
  if (b - a <= 0) return setStatus('No hay audio en esa zona.');
  let p = {};
  if (name === 'amplify') { p = await ask('Amplificar', [{ id: 'db', label: 'Ganancia (dB)', value: 6, step: 0.5 }]); if (!p) return; }
  if (name === 'noise-gate') { p = await ask('Reducción de ruido (puerta)', [{ id: 'thr', label: 'Umbral (dB)', value: -45, step: 1 }]); if (!p) return; }
  if (name === 'echo') { p = await ask('Eco', [{ id: 'ms', label: 'Retardo (ms)', value: 300, step: 10 }, { id: 'decay', label: 'Intensidad (0–0.9)', value: 0.4, step: 0.05 }]); if (!p) return; }
  if (name === 'speed') { p = await ask('Cambiar velocidad', [{ id: 'f', label: 'Factor (0.5 = lento, 2 = rápido)', value: 1.25, step: 0.05 }]); if (!p) return; }
  stopPlay(); snapshot();
  const len = b - a;

  switch (name) {
    case 'fade-in': eachChannelRange(t, a, b, (c) => { for (let i = 0; i < len; i++) c[i] *= i / len; }); break;
    case 'fade-out': eachChannelRange(t, a, b, (c) => { for (let i = 0; i < len; i++) c[i] *= 1 - i / len; }); break;
    case 'amplify': { const g = Math.pow(10, p.db / 20); eachChannelRange(t, a, b, (c) => { for (let i = 0; i < len; i++) c[i] *= g; limit(c); }); break; }
    case 'normalize': {
      let pk = 0; t.ch.forEach((c) => { pk = Math.max(pk, peakOf(c.subarray(a, b))); });
      if (pk < 1e-6) { undoStack.pop(); return setStatus('El fragmento está en silencio.'); }
      const g = 0.98 / pk;
      eachChannelRange(t, a, b, (c) => { for (let i = 0; i < len; i++) c[i] *= g; });
      break;
    }
    case 'reverse': eachChannelRange(t, a, b, (c) => c.reverse()); break;
    case 'silence': eachChannelRange(t, a, b, (c) => c.fill(0)); break;
    case 'invert': eachChannelRange(t, a, b, (c) => { for (let i = 0; i < len; i++) c[i] = -c[i]; }); break;
    case 'noise-gate': {
      const thr = Math.pow(10, p.thr / 20);
      const rel = Math.exp(-1 / (0.05 * SR)), atk = 1 - Math.exp(-1 / (0.005 * SR)), grel = 1 - Math.exp(-1 / (0.08 * SR));
      eachChannelRange(t, a, b, (c) => {
        let env = 0, g = 0;
        for (let i = 0; i < len; i++) {
          const v = Math.abs(c[i]);
          env = v > env ? v : env * rel;
          const target = env > thr ? 1 : 0;
          g += (target - g) * (target > g ? atk : grel);
          c[i] *= g;
        }
      });
      break;
    }
    case 'echo': {
      const d = Math.max(1, Math.round((p.ms / 1000) * SR)); const k = clamp(p.decay, 0, 0.9);
      eachChannelRange(t, a, b, (c) => { for (let i = d; i < len; i++) c[i] += k * c[i - d]; limit(c); });
      break;
    }
    case 'bass': {
      const alpha = 1 - Math.exp((-2 * Math.PI * 150) / SR);
      eachChannelRange(t, a, b, (c) => {
        let lp = 0;
        for (let i = 0; i < len; i++) { lp += alpha * (c[i] - lp); c[i] += 0.9 * lp; }
        const pk = peakOf(c); if (pk > 0.98) { const g = 0.98 / pk; for (let i = 0; i < len; i++) c[i] *= g; }
      });
      break;
    }
    case 'compress': {
      const thr = 0.25, ratio = 3;
      const atk = 1 - Math.exp(-1 / (0.01 * SR)), rel = 1 - Math.exp(-1 / (0.12 * SR));
      eachChannelRange(t, a, b, (c) => {
        let env = 0;
        for (let i = 0; i < len; i++) {
          const v = Math.abs(c[i]);
          env += (v - env) * (v > env ? atk : rel);
          if (env > thr) c[i] *= (thr + (env - thr) / ratio) / env;
        }
        const pk = peakOf(c); if (pk > 1e-6) { const g = 0.95 / pk; for (let i = 0; i < len; i++) c[i] *= g; }
      });
      break;
    }
    case 'speed': {
      const f = clamp(p.f, 0.25, 4);
      const nl = Math.max(1, Math.round(len / f));
      t.ch = t.ch.map((c) => {
        const out = new Float32Array(c.length - len + nl);
        out.set(c.subarray(0, a));
        for (let i = 0; i < nl; i++) {
          const pos = a + i * f; const i0 = Math.floor(pos); const fr = pos - i0;
          const s0 = c[i0] ?? 0, s1 = c[i0 + 1] ?? s0;
          out[a + i] = s0 + (s1 - s0) * fr;
        }
        out.set(c.subarray(b), a + nl);
        return out;
      });
      if (sel) sel = { a: a / SR, b: (a + nl) / SR };
      break;
    }
    default: undoStack.pop(); return;
  }
  renderAll();
  setStatus('Efecto aplicado: ' + (FX_LABEL[name] || name) + '.');
}

// ---------- Reproducción ----------
function trackGain(t, anySolo) {
  if (t.mute) return 0;
  if (anySolo && !t.solo) return 0;
  return t.gain;
}
function livePlayGains() {
  const anySolo = tracks.some((t) => t.solo);
  playSources.forEach(({ g, t }) => { g.gain.value = trackGain(t, anySolo); });
}
function play() {
  if (!tracks.length) return setStatus('Abre o graba audio primero.');
  stopPlay();
  if (ctx.state === 'suspended') ctx.resume();
  const total = dur();
  let from = sel ? sel.a : cursor;
  let to = sel ? sel.b : total;
  if (from >= total - 0.001) from = 0;
  const anySolo = tracks.some((t) => t.solo);
  tracks.forEach((t) => {
    const len = t.ch[0].length; if (!len) return;
    const buf = ctx.createBuffer(t.ch.length, len, SR);
    t.ch.forEach((c, i) => buf.copyToChannel(c, i));
    const src = ctx.createBufferSource(); src.buffer = buf;
    const g = ctx.createGain(); g.gain.value = trackGain(t, anySolo);
    src.connect(g); g.connect(master);
    if (loop && sel) { src.loop = true; src.loopStart = sel.a; src.loopEnd = Math.min(sel.b, len / SR); }
    const offset = Math.min(from, len / SR);
    if (offset >= len / SR) return;
    src.start(0, offset);
    if (sel && !loop) src.stop(ctx.currentTime + (to - from));
    playSources.push({ src, g, t });
  });
  playFrom = from; playTo = to; playCtxStart = ctx.currentTime; playing = true;
  $('#btnPlay').textContent = '⏸';
}
function currentPos() {
  let pos = playFrom + (ctx.currentTime - playCtxStart);
  if (loop && sel && sel.b > sel.a) pos = sel.a + ((pos - sel.a) % (sel.b - sel.a));
  return pos;
}
function stopPlay() {
  if (!playing) return;
  const pos = currentPos();
  playSources.forEach(({ src }) => { try { src.stop(); } catch (e) { /* ya detenido */ } src.disconnect(); });
  playSources = []; playing = false;
  $('#btnPlay').textContent = '▶';
  cursor = clamp(pos, 0, dur());
  updateOverlays();
}
function togglePlay() { playing ? stopPlay() : play(); }

// ---------- Grabación ----------
async function toggleRec() {
  if (recorder) { recorder.stop(); return; }
  try {
    await window.sgn.micPermission();
    recStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
  } catch (e) {
    return setStatus('No se pudo acceder al micrófono. Revisa los permisos del sistema.');
  }
  if (ctx.state === 'suspended') ctx.resume();
  const src = ctx.createMediaStreamSource(recStream);
  recAnalyser = ctx.createAnalyser(); recAnalyser.fftSize = 1024; src.connect(recAnalyser);
  recChunks = [];
  recorder = new MediaRecorder(recStream);
  recorder.ondataavailable = (e) => { if (e.data.size) recChunks.push(e.data); };
  const startAt = cursor;
  recorder.onstop = async () => {
    recStream.getTracks().forEach((tr) => tr.stop());
    src.disconnect(); recAnalyser = null; recorder = null;
    $('#btnRec').classList.remove('on');
    try {
      const ab = await new Blob(recChunks).arrayBuffer();
      const abuf = await ctx.decodeAudioData(ab);
      snapshot();
      const first = tracks.length === 0;
      addTrack('Grabación ' + recCount++, channelsOf(abuf), first ? 0 : startAt);
      renderAll(); if (first) zoomFit();
      setStatus('Grabación terminada (' + abuf.duration.toFixed(2) + ' s).');
    } catch (e) { setStatus('No se pudo procesar la grabación.'); }
  };
  recorder.start(250);
  $('#btnRec').classList.add('on');
  setStatus('Grabando… pulsa ● otra vez para terminar.');
}

// ---------- Exportar ----------
function mixdown() {
  const len = tracks.reduce((m, t) => Math.max(m, t.ch[0].length), 0);
  const L = new Float32Array(len), R = new Float32Array(len);
  const anySolo = tracks.some((t) => t.solo);
  tracks.forEach((t) => {
    const g = trackGain(t, anySolo); if (!g) return;
    const cl = t.ch[0], cr = t.ch[1] || t.ch[0];
    for (let i = 0; i < cl.length; i++) { L[i] += cl[i] * g; R[i] += cr[i] * g; }
  });
  limit(L); limit(R);
  return [L, R];
}
function encodeWav(L, R) {
  const n = L.length, buf = new ArrayBuffer(44 + n * 4), v = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + n * 4, true); w(8, 'WAVE'); w(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 2, true);
  v.setUint32(24, SR, true); v.setUint32(28, SR * 4, true); v.setUint16(32, 4, true); v.setUint16(34, 16, true);
  w(36, 'data'); v.setUint32(40, n * 4, true);
  let o = 44;
  for (let i = 0; i < n; i++) {
    v.setInt16(o, Math.round(L[i] * 32767), true); o += 2;
    v.setInt16(o, Math.round(R[i] * 32767), true); o += 2;
  }
  return buf;
}
async function exportWav() {
  if (!tracks.length) return setStatus('No hay audio para exportar.');
  const [L, R] = mixdown();
  const path = await window.sgn.saveDialog({ defaultName: 'SGNAudio7-mezcla.wav', ext: 'wav', data: encodeWav(L, R) });
  setStatus(path ? 'WAV guardado: ' + path : 'Exportación cancelada.');
}
let lameLib = null;
async function getLame() {
  if (lameLib) return lameLib;
  const code = await window.sgn.readLame();
  if (!code) throw new Error('lamejs no encontrado');
  const mod = { exports: {} };
  lameLib = new Function('module', 'exports', code + '\n;return (typeof lamejs!=="undefined")?lamejs:module.exports;')(mod, mod.exports);
  if (!lameLib || !lameLib.Mp3Encoder) throw new Error('lamejs inválido');
  return lameLib;
}
async function exportMp3() {
  if (!tracks.length) return setStatus('No hay audio para exportar.');
  let lame;
  try { lame = await getLame(); } catch (e) { return setStatus('No se pudo cargar el codificador MP3.'); }
  setStatus('Codificando MP3…');
  const [L, R] = mixdown();
  const toI16 = (f) => { const o = new Int16Array(f.length); for (let i = 0; i < f.length; i++) o[i] = Math.round(f[i] * 32767); return o; };
  const l16 = toI16(L), r16 = toI16(R);
  const enc = new lame.Mp3Encoder(2, SR, 192);
  const parts = []; const block = 1152;
  for (let i = 0, n = 0; i < l16.length; i += block, n++) {
    const buf = enc.encodeBuffer(l16.subarray(i, i + block), r16.subarray(i, i + block));
    if (buf.length) parts.push(new Uint8Array(buf));
    if (n % 200 === 0) { setStatus('Codificando MP3… ' + Math.round((i / l16.length) * 100) + '%'); await sleep(0); }
  }
  const end = enc.flush(); if (end.length) parts.push(new Uint8Array(end));
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total); let o = 0; parts.forEach((p) => { out.set(p, o); o += p.length; });
  const path = await window.sgn.saveDialog({ defaultName: 'SGNAudio7-mezcla.mp3', ext: 'mp3', data: out.buffer });
  setStatus(path ? 'MP3 guardado: ' + path : 'Exportación cancelada.');
}

// ---------- Interfaz: modales ----------
function showModal(html) { $('#modalCard').innerHTML = html; $('#modal').classList.remove('hidden'); }
function closeModal() { $('#modal').classList.add('hidden'); }
function ask(title, fields, okLabel = 'Aplicar', message = '') {
  return new Promise((resolve) => {
    const rows = fields.map((f) => `<div class="row"><label>${f.label}</label><input type="number" id="f_${f.id}" value="${f.value}" step="${f.step || 1}"></div>`).join('');
    showModal(`<h2>${title}</h2>${message ? `<p>${message}</p>` : ''}${rows}<div class="actions"><button id="mCancel">Cancelar</button><button id="mOk" class="primary">${okLabel}</button></div>`);
    const done = (ok) => {
      const vals = {};
      fields.forEach((f) => { const n = parseFloat($('#f_' + f.id).value); vals[f.id] = Number.isFinite(n) ? n : f.value; });
      closeModal(); resolve(ok ? (fields.length ? vals : true) : null);
    };
    $('#mOk').onclick = () => done(true);
    $('#mCancel').onclick = () => done(false);
    const first = fields[0] && $('#f_' + fields[0].id); if (first) { first.focus(); first.select(); }
  });
}
function showAbout() {
  showModal(`<div class="about"><img src="logo.png" alt="SGNAudio 7"><h2>SGNAudio 7</h2>
    <p>Editor y grabador de audio multipista.<br>Versión 7.0.0</p>
    <p><b>Desarrollado por Salvador G. Núñez</b></p>
    <div class="actions" style="justify-content:center"><button id="mOk" class="primary">Cerrar</button></div></div>`);
  $('#mOk').onclick = closeModal;
}
function showEffectsMenu() {
  const items = Object.keys(FX_LABEL).filter((k) => k !== 'silence');
  showModal(`<h2>Efectos</h2><div class="fxgrid">${items.map((k) => `<button data-k="${k}">${FX_LABEL[k]}</button>`).join('')}</div>
    <div class="actions"><button id="mOk">Cerrar</button></div>`);
  document.querySelectorAll('#modalCard [data-k]').forEach((b) => { b.onclick = () => { closeModal(); applyFx(b.dataset.k); }; });
  $('#mOk').onclick = closeModal;
}
function showShortcuts() {
  const rows = [['Espacio', 'Reproducir / Pausa'], ['R', 'Grabar / Terminar'], ['S', 'Detener'], ['L', 'Repetir selección'], ['Inicio', 'Ir al inicio'],
    ['Ctrl/Cmd + Z / Shift+Z', 'Deshacer / Rehacer'], ['Ctrl/Cmd + X / C / V', 'Cortar / Copiar / Pegar'], ['Supr', 'Eliminar selección'],
    ['Ctrl/Cmd + T', 'Recortar al área'], ['Ctrl/Cmd + A', 'Seleccionar todo'], ['Ctrl/Cmd + + / −', 'Zoom'], ['Ctrl/Cmd + O', 'Abrir audio']];
  showModal(`<h2>Atajos de teclado</h2><table>${rows.map((r) => `<tr><td><kbd>${r[0]}</kbd></td><td>${r[1]}</td></tr>`).join('')}</table>
    <div class="actions"><button id="mOk" class="primary">Cerrar</button></div>`);
  $('#mOk').onclick = closeModal;
}

// ---------- Interfaz: dibujo ----------
function totalPx() { return Math.max(Math.ceil(dur() * pps) + 300, $('#workspace').clientWidth - HEAD_W); }
function drawWave(t, canvas) {
  const w = canvas.width, h = canvas.height, g = canvas.getContext('2d');
  const TITLE = 22;
  g.clearRect(0, 0, w, h);
  const len = t.ch[0].length, clipW = Math.min(w, Math.ceil((len / SR) * pps));
  // Clip estilo Audacity 4: banda de título + fondo durazno + onda oscura
  g.fillStyle = '#ffd2a3'; g.fillRect(0, 0, clipW, h);
  g.fillStyle = '#fde0b8'; g.fillRect(0, 0, clipW, TITLE);
  g.fillStyle = '#3a2412'; g.font = '600 12px -apple-system, Segoe UI, sans-serif';
  g.save(); g.beginPath(); g.rect(0, 0, clipW, TITLE); g.clip(); g.fillText(t.name, 6, 15); g.restore();
  const chs = t.ch.length, area = h - TITLE, lh = area / chs, spp = SR / pps;
  for (let c = 0; c < chs; c++) {
    const d = t.ch[c], mid = TITLE + lh * c + lh / 2, amp = lh / 2 * 0.94;
    g.fillStyle = 'rgba(58,36,18,.25)'; g.fillRect(0, mid, clipW, 1);
    for (let x = 0; x < clipW; x++) {
      const s0 = Math.floor(x * spp); if (s0 >= d.length) break;
      const s1 = Math.min(d.length, Math.max(s0 + 1, Math.floor((x + 1) * spp)));
      const step = Math.max(1, Math.floor((s1 - s0) / 64));
      let mn = 1, mx = -1, sum = 0, n = 0;
      for (let i = s0; i < s1; i += step) { const v = d[i]; if (v < mn) mn = v; if (v > mx) mx = v; sum += v * v; n++; }
      const rms = Math.sqrt(sum / n);
      const clip = Math.max(mx, -mn) >= 0.99;
      g.fillStyle = clip ? '#c0392b' : '#4a2c17';
      g.fillRect(x, mid - mx * amp, 1, Math.max(1, (mx - mn) * amp));
      g.fillStyle = '#2a170a';
      g.fillRect(x, mid - rms * amp, 1, Math.max(1, rms * 2 * amp));
    }
  }
}
function drawRuler() {
  const cv = $('#rulerCanvas'); const w = totalPx();
  cv.width = w; cv.height = 26; $('#ruler').style.width = w + 'px';
  const g = cv.getContext('2d'); g.fillStyle = '#cfe3ee'; g.fillRect(0, 0, w, 26);
  const steps = [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
  const step = steps.find((s) => s * pps >= 70) || 600;
  g.fillStyle = '#2a3350'; g.strokeStyle = '#5b6b8f'; g.font = '12px sans-serif';
  for (let s = 0; s * pps < w; s += step) {
    const x = Math.round(s * pps) + 0.5;
    g.beginPath(); g.moveTo(x, 14); g.lineTo(x, 26); g.stroke();
    g.fillText(fmt(s).replace(/\.?0+$/, '').replace(/\.$/, ''), x + 4, 12);
  }
}
function buildTracks() {
  const box = $('#tracks'); box.innerHTML = '';
  const w = totalPx(); box.style.width = HEAD_W + w + 'px'; box.style.position = 'relative';
  tracks.forEach((t) => {
    const row = document.createElement('div');
    row.className = 'track' + (t.id === activeId ? ' active' : ''); row.dataset.id = t.id;
    row.innerHTML = `<div class="head">
        <input class="name" value="" spellcheck="false">
        <div class="row"><input class="vol" type="range" min="0" max="1.5" step="0.01" value="${t.gain}" title="Volumen de la pista"><span class="ms"><button class="bm${t.mute ? ' on' : ''}" title="Silenciar pista">M</button> <button class="bs${t.solo ? ' on' : ''}" title="Solo">S</button></span></div>
        <button class="fxbtn">Efectos</button>
        <small>${t.ch.length === 1 ? 'Mono' : 'Estéreo'} · ${(t.ch[0].length / SR).toFixed(2)} s · <a href="#" class="bd" style="color:#c0392b;text-decoration:none">Eliminar</a></small>
      </div>
      <div class="wavewrap" style="width:${w}px;height:160px"><canvas width="${w}" height="160"></canvas><div class="selbox" style="position:absolute;top:0;bottom:0;background:var(--sel);border-left:1px solid #2e8bff;border-right:1px solid #2e8bff;pointer-events:none;display:none"></div></div>`;
    const nameInput = row.querySelector('.name');
    nameInput.value = t.name;
    const canvas = row.querySelector('canvas');
    nameInput.oninput = (e) => { t.name = e.target.value; drawWave(t, canvas); };
    row.querySelector('.bm').onclick = (e) => { t.mute = !t.mute; e.target.classList.toggle('on', t.mute); livePlayGains(); };
    row.querySelector('.bs').onclick = (e) => { t.solo = !t.solo; e.target.classList.toggle('on', t.solo); livePlayGains(); };
    row.querySelector('.bd').onclick = (e) => { e.preventDefault(); activeId = t.id; delTrack(); };
    row.querySelector('.fxbtn').onclick = () => { setActive(t.id); showEffectsMenu(); };
    row.querySelector('.vol').oninput = (e) => { t.gain = parseFloat(e.target.value); livePlayGains(); };
    row.querySelector('.head').addEventListener('mousedown', () => setActive(t.id));
    const wrap = row.querySelector('.wavewrap');
    wrap.addEventListener('mousedown', (ev) => startSelect(ev, t.id, wrap));
    box.appendChild(row);
    drawWave(t, canvas);
  });
  ['cursorLine', 'playLine'].forEach((id, k) => {
    const d = document.createElement('div'); d.id = id;
    d.style.cssText = `position:absolute;top:0;bottom:0;width:${k ? 2 : 1}px;background:#fff;pointer-events:none;z-index:4;${k ? 'display:none;box-shadow:0 0 6px #fff' : ''}`;
    box.appendChild(d);
  });
}
function setActive(id) {
  activeId = id;
  document.querySelectorAll('.track').forEach((r) => r.classList.toggle('active', Number(r.dataset.id) === id));
  updateInfo();
}
function fmtLong(sec) {
  sec = Math.max(0, sec);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec - h * 3600 - m * 60;
  return String(h).padStart(2, '0') + 'h' + String(m).padStart(2, '0') + 'm' + s.toFixed(2).padStart(5, '0') + 's';
}
function updateOverlays() {
  document.querySelectorAll('.selbox').forEach((b) => {
    if (sel && sel.b > sel.a) { b.style.display = 'block'; b.style.left = sel.a * pps + 'px'; b.style.width = (sel.b - sel.a) * pps + 'px'; }
    else b.style.display = 'none';
  });
  const cl = $('#cursorLine');
  if (cl) cl.style.left = HEAD_W + cursor * pps + 'px';
  const hasSel = sel && sel.b > sel.a;
  $('#clock').textContent = fmtLong(playing ? currentPos() : hasSel ? sel.a : cursor);
  $('#selStart').textContent = fmtLong(hasSel ? sel.a : cursor);
  $('#selEnd').textContent = fmtLong(hasSel ? sel.b : cursor);
  $('#selDur').textContent = fmtLong(hasSel ? sel.b - sel.a : dur());
  updateInfo();
}
function updateInfo() {
  const t = activeTrack();
  document.title = t ? 'SGNAudio 7 — ' + t.name : 'SGNAudio 7';
}
function renderAll() {
  $('#empty').classList.toggle('hidden', tracks.length > 0);
  $('#ruler').classList.toggle('hidden', tracks.length === 0);
  buildTracks(); drawRuler(); updateOverlays();
}

// ---------- Interfaz: selección con el ratón ----------
function startSelect(ev, id, wrap) {
  if (ev.button !== 0) return;
  setActive(id);
  const rect = () => wrap.getBoundingClientRect();
  const toTime = (e) => clamp((e.clientX - rect().left) / pps, 0, Math.max(dur(), 0) + 5);
  const x0 = ev.clientX, t0 = toTime(ev);
  let moved = false;
  const move = (e) => {
    if (!moved && Math.abs(e.clientX - x0) < 3) return;
    moved = true;
    const t1 = toTime(e);
    sel = { a: Math.min(t0, t1), b: Math.max(t0, t1) };
    updateOverlays();
  };
  const up = () => {
    window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up);
    if (!moved) { sel = null; cursor = t0; if (playing) { play(); } }
    else { cursor = sel.a; }
    updateOverlays();
  };
  window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
}

// ---------- Zoom ----------
function maxPps() { return Math.min(4000, 30000 / Math.max(dur(), 1)); }
function setZoom(v) { pps = clamp(v, 2, maxPps()); renderAll(); }
function zoomFit() {
  const d = Math.max(dur(), 0.5);
  setZoom(($('#workspace').clientWidth - HEAD_W - 40) / d);
}

// ---------- Medidores y animación ----------
const meterBuf = new Float32Array(1024);
const levels = { out: 0, inp: 0 };
function peakLevel(an) {
  an.getFloatTimeDomainData(meterBuf);
  let p = 0; for (let i = 0; i < meterBuf.length; i++) { const v = Math.abs(meterBuf[i]); if (v > p) p = v; }
  return p;
}
const pct = (p) => (p < 1e-4 ? 0 : clamp((20 * Math.log10(p) + 60) / 60, 0, 1) * 100);
function tick() {
  const po = playing ? peakLevel(outAn) : 0;
  levels.out = Math.max(po, levels.out * 0.9);
  $('#mOut').style.height = pct(levels.out) + '%';
  const pi = recAnalyser ? peakLevel(recAnalyser) : 0;
  levels.inp = Math.max(pi, levels.inp * 0.9);
  $('#mIn').style.width = pct(levels.inp) + '%';
  if (playing) {
    const pos = currentPos();
    const pl = $('#playLine');
    if (pl) { pl.style.display = 'block'; pl.style.left = HEAD_W + pos * pps + 'px'; }
    $('#clock').textContent = fmtLong(pos);
    if (!loop && pos >= playTo - 0.005) { stopPlay(); cursor = sel ? sel.a : cursor; updateOverlays(); }
    const ws = $('#workspace');
    const x = HEAD_W + pos * pps;
    if (x > ws.scrollLeft + ws.clientWidth - 40) ws.scrollLeft = x - HEAD_W - 40;
  } else {
    const pl = $('#playLine'); if (pl) pl.style.display = 'none';
  }
  requestAnimationFrame(tick);
}

// ---------- Comandos y eventos ----------
const commands = {
  open: openFiles, 'export-wav': exportWav, 'export-mp3': exportMp3, new: newProject,
  undo, redo, cut: doCut, copy: doCopy, paste: doPaste, delete: doDelete, trim: doTrim,
  'select-all': selectAll, split: splitTrack, 'new-track': newEmptyTrack, 'dup-track': dupTrack, 'del-track': delTrack,
  'zoom-in': () => setZoom(pps * 1.5), 'zoom-out': () => setZoom(pps / 1.5), 'zoom-fit': zoomFit,
  about: showAbout, shortcuts: showShortcuts,
};
window.sgn.onMenu((cmd, arg) => {
  if (cmd === 'fx') applyFx(arg);
  else if (commands[cmd]) commands[cmd]();
});

$('#btnPlay').onclick = togglePlay;
$('#btnStop').onclick = () => { stopPlay(); };
$('#btnRec').onclick = toggleRec;
$('#btnLoop').onclick = () => { loop = !loop; $('#btnLoop').classList.toggle('on', loop); if (playing) play(); };
$('#btnEnd').onclick = () => { stopPlay(); cursor = dur(); sel = null; updateOverlays(); };
$('#btnFx').onclick = showEffectsMenu;
$('#btnStart').onclick = () => { stopPlay(); cursor = 0; sel = null; $('#workspace').scrollLeft = 0; updateOverlays(); };
$('#btnUndo').onclick = undo; $('#btnRedo').onclick = redo;
$('#btnCut').onclick = doCut; $('#btnCopy').onclick = doCopy; $('#btnPaste').onclick = doPaste;
$('#btnTrim').onclick = doTrim; $('#btnSilence').onclick = () => applyFx('silence');
$('#btnZoomIn').onclick = commands['zoom-in']; $('#btnZoomOut').onclick = commands['zoom-out']; $('#btnZoomFit').onclick = zoomFit;
$('#btnOpen').onclick = openFiles; $('#btnWav').onclick = exportWav; $('#btnMp3').onclick = exportMp3;
$('#btnNewTrack').onclick = newEmptyTrack;

$('#ruler').addEventListener('mousedown', (e) => {
  const x = e.clientX - $('#ruler').getBoundingClientRect().left;
  cursor = Math.max(0, x / pps); sel = null;
  if (playing) play(); else updateOverlays();
});
$('#workspace').addEventListener('wheel', (e) => {
  if (!(e.ctrlKey || e.metaKey)) return;
  e.preventDefault(); setZoom(pps * (e.deltaY < 0 ? 1.2 : 1 / 1.2));
}, { passive: false });

window.addEventListener('keydown', (e) => {
  const tag = (e.target.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea') return;
  if (!$('#modal').classList.contains('hidden')) { if (e.key === 'Escape') closeModal(); return; }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const k = e.key.toLowerCase();
  if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
  else if (k === 'r') toggleRec();
  else if (k === 's') stopPlay();
  else if (k === 'l') $('#btnLoop').click();
  else if (e.key === 'Home') $('#btnStart').click();
  else if (e.key === 'Backspace') doDelete();
});

// Arrastrar y soltar archivos
window.addEventListener('dragover', (e) => { e.preventDefault(); document.body.classList.add('dragover'); });
window.addEventListener('dragleave', () => document.body.classList.remove('dragover'));
window.addEventListener('drop', async (e) => {
  e.preventDefault(); document.body.classList.remove('dragover');
  for (const f of e.dataTransfer.files) await loadFile(f.name, await f.arrayBuffer());
});
window.addEventListener('resize', () => { if (tracks.length) { buildTracks(); drawRuler(); updateOverlays(); } });

renderAll();
requestAnimationFrame(tick);
