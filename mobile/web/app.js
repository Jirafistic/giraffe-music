/* Giraffe Music — la interfaz.
 *
 * Batería primero:
 *  - En el APK el audio lo reproduce ExoPlayer nativo (con "audio offload": el chip de
 *    audio decodifica y el procesador duerme). Esta página solo es el control remoto.
 *  - Nada corre en segundo plano: el progreso se dibuja solo con la pantalla visible
 *    y el reproductor sonando, nunca con requestAnimationFrame ni bucles.
 *  - Una sola escucha de clics para toda la app (delegación), imágenes del tamaño
 *    justo y diferidas, y respuestas en memoria para no repetir pedidos.
 */
'use strict';

const NATIVE = window.GiraffeNative || null;
/** La interfaz nueva (la decide ui.js antes de dibujar; se cambia en Configuración → Información). */
const NEWUI = document.documentElement.classList.contains('ui-new');
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => r.querySelectorAll(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const ic = (id, cls = '') => `<svg class="ic ${cls}"><use href="#i-${id}"/></svg>`;
const fmt = (s) => { s = Math.max(0, Math.floor(s || 0)); const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, x = String(s % 60).padStart(2, '0'); return h ? `${h}:${String(m).padStart(2, '0')}:${x}` : `${m}:${x}`; };
const fmtN = (n) => n >= 1e9 ? (n / 1e9).toFixed(n < 1e10 ? 1 : 0).replace(/\.0$/, '') + 'B' : n >= 1e6 ? (n / 1e6).toFixed(n < 1e7 ? 2 : 1).replace(/\.?0+$/, '') + 'M' : n >= 1e3 ? (n / 1e3).toFixed(n < 1e4 ? 1 : 0).replace(/\.0$/, '') + 'K' : String(n || 0);
const fmtLong = (s) => { const m = Math.round(s / 60); return m >= 60 ? `${Math.floor(m / 60)} hr ${m % 60} min` : `${m} minutes`; };
const songs = (n) => `${n} song${n === 1 ? '' : 's'}`;
const fmtMB = (b) => b > 1e9 ? (b / 1e9).toFixed(1) + ' GB' : Math.round(b / 1e6) + ' MB';
const artists = (t) => (t.artists || []).map((a) => a.name).join(', ');
const shuffleArr = (a) => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

// ------------------------------------------------------------------ guardado local
const store = {
  get(k, d) { try { const v = localStorage.getItem('gm.' + k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('gm.' + k, JSON.stringify(v)); } catch {} },
};
const settings = Object.assign({ autoplay: true, skipNonMusic: true, dataSaver: false, libGrid: false, libSort: 'recent', squareThumbs: true, normalize: true, swipeArt: true, wifiOnlyDl: true, qMobile: 'normal', resumeHeadphones: false, lyrRoman: false, lang: 'auto', ui: 'new' }, store.get('settings', {}));
const saveSettings = () => store.set('settings', settings);
let liked = store.get('liked', {});        // id -> {t, at}
let disliked = store.get('disliked', {});  // id -> 1
// Playlists hechas sin cuenta: viven en el teléfono hasta que se pasen a la cuenta.
let localPls = store.get('localPls', []);    // [{ id: 'LP…', title, description, tracks, at }]
const saveLocalPls = () => store.set('localPls', localPls);
const isLocalPl = (id) => /^LP\d/.test(id || '');
const localPl = (id) => localPls.find((p) => p.id === id);
let savedSongs = store.get('saved', {});   // id -> {t, at}
let lib = store.get('lib', {});            // "album:ID" -> {kind,id,title,subtitle,thumb,round,at}
let hist = store.get('history', []);       // [track] recientes primero
let searches = store.get('searches', []);
let me = store.get('me', { signedIn: false }); // la cuenta de YouTube (si hay sesión)

// ------------------------------------------------------------------ API
const mem = new Map();
async function api(path, ttl = 5 * 60e3) {
  const hit = mem.get(path);
  if (hit && Date.now() - hit.t < ttl) return hit.v;
  const r = await fetch(path);
  if (!r.ok) {
    const e = await r.json().catch(() => ({}));
    throw new Error(e.error || 'HTTP ' + r.status);
  }
  const v = await r.json();
  mem.set(path, { v, t: Date.now() });
  if (mem.size > 80) mem.delete(mem.keys().next().value);
  return v;
}
const imgUrl = (u) => !u ? '' : u.startsWith('/') ? u : '/api/img?u=' + encodeURIComponent(u);

// ------------------------------------------------------------------ descargas (las guarda el núcleo nativo)
const DL = {
  items: new Map(), active: {}, bytes: 0, timer: 0,
  has(id) { return this.items.has(id); },
  busy(id) { return id in this.active; },
  thumb(t) { return this.items.get(t.id)?.track.thumb || t.thumb; },
  async refresh() {
    try {
      const d = await (await fetch('/api/downloads')).json();
      const before = new Set(this.items.keys());
      this.items = new Map(d.items.map((x) => [x.track.id, x]));
      const finished = [...this.items.keys()].filter((id) => !before.has(id) && this.wasActive?.has(id));
      this.active = d.active; this.bytes = d.bytes;
      if (Object.keys(d.active).length) NATIVE?.dlWatch?.(); // pendientes de la vez anterior
      this.wasActive = new Set(Object.keys(d.active));
      if (finished.length && location.pathname === '/downloads' && !OV.length) setTimeout(render);
      if (finished.length === 1) toast('Downloaded “' + this.items.get(finished[0]).track.title + '”');
      else if (finished.length > 1) toast(`Downloaded ${finished.length} songs`);
      dlUI();
    } catch {}
    // Solo se consulta mientras hay descargas en curso (y menos seguido sin pantalla).
    clearTimeout(this.timer);
    if (Object.keys(this.active).length) this.timer = setTimeout(() => this.refresh(), document.hidden ? 6000 : 1200);
  },
  async add(tracks, force) {
    tracks = tracks.filter((t) => t && !this.has(t.id) && !this.busy(t.id));
    if (!tracks.length) return;
    if (!force && settings.wifiOnlyDl && NATIVE?.isMetered?.()) {
      return toast('Downloads are set to Wi-Fi only', { label: 'Download now', fn: () => this.add(tracks, true) });
    }
    for (const t of tracks) {
      this.active[t.id] = 0;
      await fetch('/api/download/' + encodeURIComponent(t.id), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(t) }).catch(() => {});
    }
    this.wasActive = new Set([...(this.wasActive || []), ...tracks.map((t) => t.id)]);
    NATIVE?.dlWatch?.();
    toast(tracks.length > 1 ? `Downloading ${tracks.length} songs` : 'Downloading…');
    dlUI();
    this.refresh();
  },
  async remove(id) {
    delete this.active[id];
    await fetch('/api/download/' + encodeURIComponent(id), { method: 'DELETE' }).catch(() => {});
    this.items.delete(id);
    dlUI();
    toast('Removed from downloads');
  },
};

function dlUI() {
  for (const el of $$('[data-dlb]')) el.toggleAttribute('hidden', !DL.has(el.dataset.dlb));
  const t = cur();
  if (t) {
    const done = DL.has(t.id), busy = DL.busy(t.id);
    $('#plDlIc').setAttribute('href', done ? '#i-dl-done' : '#i-dl');
    $('#plDlTxt').textContent = done ? T('Downloaded') : busy ? `${Math.round((DL.active[t.id] || 0) * 100)}%` : T('Download');
  }
  for (const el of $$('[data-dlall]')) {
    const ids = (LISTS.get(el.dataset.dlall)?.tracks || []).map((x) => x.id);
    const done = ids.length && ids.every((id) => DL.has(id));
    const busy = ids.filter((id) => DL.busy(id));
    const p = busy.length ? ids.reduce((s, id) => s + (DL.has(id) ? 1 : DL.active[id] || 0), 0) / ids.length : 0;
    el.innerHTML = ic(done ? 'dl-done' : 'dl') + (busy.length ? `<svg class="ring" viewBox="0 0 44 44"><circle cx="22" cy="22" r="20" stroke-dasharray="${(p * 125.7).toFixed(1)} 200"/></svg>` : '');
  }
}

// ------------------------------------------------------------------ listas que se pueden tocar
const LISTS = new Map();
let listSeq = 0;
function reg(tracks, name, mode = 'list') {
  const k = 'l' + ++listSeq;
  LISTS.set(k, { tracks, name, mode });
  return k;
}
const tAt = (el) => LISTS.get(el.dataset.list)?.tracks[+el.dataset.i];

// ------------------------------------------------------------------ colores de la carátula
const colors = new Map();
// Los colores ya calculados se guardan: la misma carátula no se vuelve a bajar ni a medir.
const savedColors = store.get('colors', {});
let colorsDirty = 0;
function rememberColor(url, c) {
  savedColors[url] = c;
  const keys = Object.keys(savedColors);
  if (keys.length > 400) for (const k of keys.slice(0, 100)) delete savedColors[k];
  clearTimeout(colorsDirty);
  colorsDirty = setTimeout(() => store.set('colors', savedColors), 2000);
}
function colorOf(url) {
  if (!url) return Promise.resolve(null);
  if (colors.has(url)) return colors.get(url);
  if (savedColors[url]) { const p = Promise.resolve(savedColors[url]); colors.set(url, p); return p; }
  const p = new Promise((res) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => {
      try {
        const c = document.createElement('canvas');
        c.width = c.height = 12;
        const g = c.getContext('2d', { willReadFrequently: true });
        g.drawImage(img, 0, 0, 12, 12);
        const d = g.getImageData(0, 0, 12, 12).data;
        let r = 0, gg = 0, b = 0, w = 0;
        for (let i = 0; i < d.length; i += 4) {
          const mx = Math.max(d[i], d[i + 1], d[i + 2]), mn = Math.min(d[i], d[i + 1], d[i + 2]);
          const wt = 1 + (mx - mn) / 32; // los colores vivos pesan más que los grises
          r += d[i] * wt; gg += d[i + 1] * wt; b += d[i + 2] * wt; w += wt;
        }
        const col = hsl(r / w, gg / w, b / w);
        rememberColor(url, col);
        res(col);
      } catch { res(null); }
    };
    img.onerror = () => res(null);
    img.src = imgUrl(url);
  });
  colors.set(url, p);
  return p;
}
function hsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2;
  let h = 0, s = 0;
  if (mx !== mn) {
    const d = mx - mn;
    s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
    h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h *= 60;
  }
  return [Math.round(h), Math.round(s * 100), Math.round(l * 100)];
}
const tone = ([h, s], l, smax = 70) => `hsl(${h} ${Math.min(s, smax)}% ${l}%)`;

// ------------------------------------------------------------------ motores de audio
// Nativo (APK): ExoPlayer en un servicio, sigue sonando con la app cerrada.
class NativeEngine {
  constructor() {
    this.s = { i: 0, pos: 0, dur: 0, buf: 0, playing: false, loading: false, at: Date.now() };
    window.__gm = (m) => this.event(m);
  }
  items(ts) { return JSON.stringify(ts.map((t) => ({ id: t.id, title: t.title, artist: artists(t), album: t.album?.name || '', art: DL.items.get(t.id)?.track.art || (t.wide ? t.thumb : t.art) || t.thumb || '' }))); }
  setQueue(ts, i, startMs, play) { NATIVE.setQueue(this.items(ts), i, startMs || 0, !!play); }
  replaceUpcoming(ts) { NATIVE.replaceUpcoming(this.items(ts)); }
  rebase(before, after) { NATIVE.rebase(this.items(before), this.items(after)); }
  insert(ts, at) { NATIVE.insert(this.items(ts), at); }
  move(a, b) { NATIVE.move(a, b); }
  remove(i) { NATIVE.remove(i); }
  replaceCurrent(t, ms) { NATIVE.replaceCurrent(this.items([t]), ms || 0); }
  play() { NATIVE.play(); }
  pause() { NATIVE.pause(); }
  seek(sec) { this.s.pos = sec * 1000; this.s.at = Date.now(); NATIVE.seekTo(Math.round(sec * 1000)); }
  skipTo(i) { NATIVE.skipTo(i); }
  next() { NATIVE.next(); }
  prev() { NATIVE.prev(); }
  setRepeat(m) { NATIVE.setRepeat(m === 'one' ? 1 : m === 'all' ? 2 : 0); }
  sync() { NATIVE.sync(); }
  pos() {
    const s = this.s;
    const p = s.playing ? s.pos + (Date.now() - s.at) : s.pos;
    return { pos: Math.min(p, s.dur > 0 ? s.dur : p) / 1000, dur: Math.max(0, s.dur) / 1000, buf: s.buf / 1000 };
  }
  event(m) {
    if (m.e === 'sync') {
      if (!this.restored) {
        this.restored = true;
        if (m.n === 0 && P.queue.length) { this.setQueue(P.queue, P.i, Math.round((P.restorePos || 0) * 1000), false); return; }
      }
      if (m.n === 0) return;
      Object.assign(this.s, m, { at: Date.now() });
      P.onSync(m.i, m.playing, m.loading);
    }
    else if (m.e === 'ended') P.onEnded();
    else if (m.e === 'error') { toast("Couldn't play this song"); }
    else if (m.e === 'vis') { if (m.hidden) saveSession(true); visible = !m.hidden; ticker(); videoSync(); if (visible) NATIVE.sync(); }
    else if (m.e === 'insets') setInsets(m.top, m.bottom);
    else if (m.e === 'login') onLoginCookie(m.cookie);
    else if (m.e === 'checkUpdate') checkUpdate(true);
    else if (m.e === 'qr') TG.onQr(m);
    else if (m.e === 'update') {
      if (m.need) toast('Allow Giraffe Music to install updates, then tap Update again');
      else if (m.error) toast("Couldn't download the update");
      else if (m.p % 10 === 0) toast(m.p < 100 ? `Downloading update… ${m.p}%` : 'Installing…');
    }
    else if (m.e === 'back') onBack();
  }
}

// Web (navegador de la PC): un <audio> y Media Session para los controles del sistema.
class WebEngine {
  constructor() {
    const a = (this.a = $('#audio'));
    this.q = []; this.i = 0; this.repeat = 'off';
    a.addEventListener('play', () => P.onSync(this.i, true, false));
    a.addEventListener('pause', () => P.onSync(this.i, false, false));
    a.addEventListener('waiting', () => P.onSync(this.i, !a.paused, true));
    a.addEventListener('playing', () => P.onSync(this.i, true, false));
    a.addEventListener('timeupdate', () => tick());
    a.addEventListener('ended', () => {
      if (this.repeat === 'one') { a.currentTime = 0; a.play(); }
      else if (this.i + 1 < this.q.length) this.load(this.i + 1, 0, true);
      else if (this.repeat === 'all' && this.q.length) this.load(0, 0, true);
      else P.onEnded();
    });
    a.addEventListener('error', () => { if (a.getAttribute('src')) { toast("Couldn't play this song"); setTimeout(() => this.next(), 1500); } });
    a.addEventListener('loadedmetadata', () => this.position());
    const ms = navigator.mediaSession;
    if (ms) {
      const h = { play: () => this.play(), pause: () => this.pause(), previoustrack: () => this.prev(), nexttrack: () => this.next(), seekto: (d) => this.seek(d.seekTime) };
      for (const k in h) try { ms.setActionHandler(k, h[k]); } catch {}
    }
  }
  load(i, startMs, play) {
    this.i = i;
    const t = this.q[i];
    if (!t) return;
    this.a.src = '/api/stream/' + encodeURIComponent(t.id);
    if (startMs) this.a.currentTime = startMs / 1000;
    if (play) this.a.play().catch(() => P.onSync(this.i, false, false));
    P.onSync(i, play, true);
    this.meta(t);
    this.normalize();
    this.prefetched = false;
  }
  /** Volumen al nivel de referencia de YouTube (-14 LUFS), solo hacia abajo. */
  normalize() {
    const t = this.q[this.i];
    if (!t || !settings.normalize) { this.a.volume = 1; return; }
    api('/api/loudness/' + encodeURIComponent(t.id), 864e5).then((v) => {
      if (this.q[this.i] === t) this.a.volume = v.db > 0 ? Math.min(1, Math.pow(10, -v.db / 20)) : 1;
    }).catch(() => {});
  }
  meta(t) {
    if (!navigator.mediaSession || !window.MediaMetadata) return;
    const art = DL.items.get(t.id)?.track.art || t.art || t.thumb;
    navigator.mediaSession.metadata = new MediaMetadata({ title: t.title, artist: artists(t), album: t.album?.name || '', artwork: art ? [{ src: art, sizes: '512x512' }] : [] });
  }
  position() { try { const a = this.a; if (a.duration) navigator.mediaSession?.setPositionState({ duration: a.duration, position: Math.min(a.currentTime, a.duration), playbackRate: 1 }); } catch {} }
  setQueue(ts, i, startMs, play) { this.q = ts.slice(); this.load(i, startMs, play); }
  replaceUpcoming(ts) { this.q = this.q.slice(0, this.i + 1).concat(ts); }
  rebase(before, after) { const t = this.q[this.i]; this.q = before.concat([t], after); this.i = before.length; }
  insert(ts, at) { this.q.splice(at, 0, ...ts); if (at <= this.i) this.i += ts.length; }
  move(a, b) { const [x] = this.q.splice(a, 1); this.q.splice(b, 0, x); if (this.i === a) this.i = b; else if (a < this.i && b >= this.i) this.i--; else if (a > this.i && b <= this.i) this.i++; }
  remove(i) { this.q.splice(i, 1); if (i < this.i) this.i--; }
  replaceCurrent(t, ms) { this.q[this.i] = t; this.load(this.i, ms, !this.a.paused); }
  play() {
    if (!this.a.getAttribute('src')) {
      if (!this.q.length && P.queue.length) { this.q = P.queue.slice(); this.i = P.i; }
      const ms = Math.round((P.restorePos || 0) * 1000); P.restorePos = 0;
      return this.load(this.i, ms, true);
    }
    this.a.play().catch(() => {});
  }
  pause() { this.a.pause(); }
  seek(s) { this.a.currentTime = s; this.position(); }
  skipTo(i) { this.load(i, 0, true); }
  next() { if (this.i + 1 < this.q.length) this.load(this.i + 1, 0, true); else if (this.repeat === 'all') this.load(0, 0, true); else P.onEnded(); }
  prev() { if (this.a.currentTime > 3 || this.i === 0) this.seek(0); else this.load(this.i - 1, 0, true); }
  setRepeat(m) { this.repeat = m; }
  sync() {}
  pos() { const a = this.a, b = a.buffered; return { pos: a.currentTime || P.restorePos || 0, dur: a.duration || 0, buf: b.length ? b.end(b.length - 1) : 0 }; }
}

// ------------------------------------------------------------------ el reproductor
const P = {
  queue: [], i: -1, from: '', playing: false, loading: false,
  repeat: store.get('repeat', 'off'), shuffled: false, radioFor: null, skips: [],
  eng: null,

  play(tracks, i = 0, from = '', opts = {}) {
    if (!tracks.length) return;
    if (TG.send({ kind: 'playTracks', tracks: tracks.slice(i, i + 30), from })) return;
    this.queue = tracks.slice();
    this.i = i; this.from = from; this.radioFor = null; this.shuffled = !!opts.shuffle;
    this.eng.setQueue(this.queue, i, 0, true);
    this.changed(true);
    saveSession();
    if (opts.radio) this.fillRadio(tracks[i], true);
  },
  /** Un tema y después su radio, como al tocar una canción en Quick picks. */
  radio(t, from) {
    this.play([t], 0, from || `${t.title} Radio`, { radio: true });
  },
  async fillRadio(t, replace) {
    if (!t || this.radioFor === t.id) return;
    this.radioFor = t.id;
    try {
      const list = await api('/api/radio/' + encodeURIComponent(t.id), 10 * 60e3);
      if (cur()?.id !== t.id && replace) return;
      const have = new Set(this.queue.map((x) => x.id));
      const more = list.filter((x) => !have.has(x.id) && !disliked[x.id]);
      if (!more.length) return;
      if (replace) { this.queue = this.queue.slice(0, this.i + 1).concat(more); this.eng.replaceUpcoming(more); }
      else { const at = this.queue.length; this.queue.push(...more); this.eng.insert(more, at); }
      queueUI();
      saveSession();
    } catch {}
  },
  onSync(i, playing, loading) {
    const changed = i !== this.i && i >= 0 && i < this.queue.length;
    if (changed) this.i = i;
    if (this.playing && !playing) saveSession(true); // en pausa: guardar el segundo exacto
    this.playing = playing; this.loading = loading;
    playIcons();
    if (changed) this.changed(false);
    ticker();
    tick();
    TG.publish();
  },
  onEnded() {
    this.playing = false; playIcons(); ticker();
    if (settings.autoplay && cur()) this.fillRadio(cur(), false).then(() => { if (this.i + 1 < this.queue.length) this.eng.skipTo(this.i + 1); });
  },
  changed(fresh) {
    const t = cur();
    if (!t) return;
    trackUI(t);
    addHistory(t);
    fetch('/api/plays', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(t) }).catch(() => {});
    this.skips = [];
    if (settings.skipNonMusic && t.video) api('/api/skip/' + t.id, 864e5).then((s) => { if (cur()?.id === t.id) this.skips = s; }).catch(() => {});
    // Autoplay: que siempre haya algo después.
    if (settings.autoplay && this.queue.length - this.i <= 2) this.fillRadio(t, false);
    if (!fresh) queueUI();
    saveSession();
    if (V.mode === 'video' && t.id !== V.id) { videoRelease(); V.id = null; if (videoVisible()) setMode('video', true); }
    modeUI();
  },
  toggle() { if (!cur()) return; if (TG.send({ kind: this.playing ? 'pause' : 'play' })) return; this.playing ? this.eng.pause() : this.eng.play(); },
  next() { if (TG.send({ kind: 'next' })) return; if (this.i + 1 >= this.queue.length && this.repeat !== 'all') { this.onEnded(); return; } this.eng.next(); },
  prev() { if (TG.send({ kind: 'prev' })) return; this.eng.prev(); },
  setRepeat() {
    this.repeat = { off: 'all', all: 'one', one: 'off' }[this.repeat];
    store.set('repeat', this.repeat);
    this.eng.setRepeat(this.repeat);
    repeatUI();
    toast({ off: 'Repeat off', all: 'Repeat all', one: 'Repeat one' }[this.repeat]);
  },
  /** Como YouTube Music: la que suena queda primera y todas las demás (también las que
   *  ya sonaron) se mezclan de nuevo. Al apagarlo vuelve el orden original. */
  shuffle() {
    if (this.queue.length < 2) return;
    const t = cur();
    let before, after;
    if (!this.shuffled) {
      this.unshuffled = this.queue.slice();
      before = [];
      after = shuffleArr(this.queue.filter((_, k) => k !== this.i));
    } else {
      const orig = this.unshuffled || this.queue;
      const have = new Set(this.queue.map((x) => x.id));
      const extra = this.queue.filter((x) => !orig.some((o) => o.id === x.id)); // agregadas después (radio)
      const all = orig.filter((x) => have.has(x.id)).concat(extra);
      const at = Math.max(0, all.findIndex((x) => x.id === t.id));
      before = all.slice(0, at); after = all.slice(at + 1);
      this.unshuffled = null;
    }
    this.shuffled = !this.shuffled;
    this.queue = before.concat([t], after);
    this.i = before.length;
    this.eng.rebase(before, after);
    $('#btnShuffle').classList.toggle('off', !this.shuffled);
    queueUI(true);
    saveSession();
    toast(this.shuffled ? T('Shuffle on') : T('Shuffle off'));
  },
  /** La misma canción en otra versión (canción ↔ videoclip), en el mismo punto. */
  swapCurrent(nt) {
    const { pos } = this.eng.pos();
    this.queue[this.i] = nt;
    this.eng.replaceCurrent(nt, Math.round(pos * 1000));
    trackUI(nt);
    saveSession();
  },
  playNext(ts) { if (!cur()) return this.play(ts, 0, 'Queue'); const at = this.i + 1; this.queue.splice(at, 0, ...ts); this.eng.insert(ts, at); queueUI(); saveSession(); toast(ts.length > 1 ? `${ts.length} songs will play next` : 'Song will play next'); },
  addQueue(ts) { if (!cur()) return this.play(ts, 0, 'Queue'); const at = this.queue.length; this.queue.push(...ts); this.eng.insert(ts, at); queueUI(); saveSession(); toast(ts.length > 1 ? `${ts.length} songs added to queue` : 'Song added to queue'); },
};
const cur = () => P.queue[P.i];

// La última sesión (cola, canción y segundo), para seguir donde quedó al abrir la app.
// Se guarda al cambiar algo (no con un reloj) y como mucho una vez por medio segundo.
let sessT = 0;
function saveSession(now) {
  clearTimeout(sessT);
  const write = () => {
    if (!P.queue.length) return;
    const from = Math.max(0, P.i - 50);
    store.set('session', { q: P.queue.slice(from, P.i + 150), i: P.i - from, pos: P.eng?.pos().pos || 0, from: P.from, shuffled: P.shuffled });
  };
  if (now) write(); else sessT = setTimeout(write, 500);
}
function restoreSession() {
  const s = store.get('session');
  if (!s?.q?.length || s.i < 0 || s.i >= s.q.length) return;
  P.queue = s.q; P.i = s.i; P.from = s.from || ''; P.shuffled = !!s.shuffled;
  P.restorePos = s.pos || 0;
  trackUI(cur());
  tick();
}

function addHistory(t) {
  hist = [t, ...hist.filter((x) => x.id !== t.id)].slice(0, 200);
  store.set('history', hist);
}

// ------------------------------------------------------------------ dibujar el estado del reproductor
const playIcons = () => {
  const h = P.playing ? '#i-pause' : '#i-play';
  for (const id of ['miniPlayIc', 'plPlayIc', 'shPlayIc']) $('#' + id).setAttribute('href', h);
};
function repeatUI() {
  $('#repeatIc').setAttribute('href', P.repeat === 'one' ? '#i-repeat1' : '#i-repeat');
  $('#btnRepeat').classList.toggle('off', P.repeat === 'off');
}
/** Carátula grande. Si un video no tiene la miniatura grande, YouTube manda un dibujo
 *  gris de 120×90 en su lugar: entonces va la 4:3 (que siempre existe) sin sus franjas. */
/** La carátula grande de una canción (la descargada si existe; la chica con Ahorro de datos). */
function artSrc(t) {
  const thumb = DL.thumb(t);
  return settings.dataSaver ? thumb : DL.items.get(t.id)?.track.art || t.art || thumb;
}
function setArt(img, t, src) {
  img.classList.remove('lb');
  const fallback = () => {
    if (t.wide && !img.classList.contains('lb')) { img.classList.add('lb'); img.src = `https://i.ytimg.com/vi/${encodeURIComponent(t.id)}/hqdefault.jpg`; }
    else if (img.src !== t.thumb && t.thumb) { img.classList.remove('lb'); img.src = t.thumb; }
  };
  img.onerror = fallback;
  img.onload = () => { if (img.naturalWidth <= 120 && img.naturalHeight <= 90) fallback(); };
  img.src = src || '';
}
async function trackUI(t) {
  document.body.classList.add('has-mini');
  $('#mini').hidden = false;
  const thumb = DL.thumb(t);
  $('#miniArt').src = thumb || ''; $('#shArt').src = thumb || '';
  setArt($('#plArt'), t, artSrc(t));
  $('#miniTitle').textContent = $('#shTitle').textContent = $('#plTitle').textContent = t.title;
  const sub = artists(t);
  $('#miniSub').textContent = $('#shSub').textContent = sub;
  $('#plArtist').textContent = sub;
  $('#plFrom').textContent = P.from || t.album?.name || '';
  $('#qName').textContent = P.from || '';
  likeUI();
  dlUI();
  $('#plSaveIc').setAttribute('href', savedSongs[t.id] ? '#i-saved' : '#i-save');
  $('#btnShuffle').classList.toggle('off', !P.shuffled);
  lyr = null;
  if (sheetTab) openSheet(sheetTab, true);
  else $('#lyrScript').hidden = true;
  for (const r of $$('.row.cur')) r.classList.remove('cur');
  // El color del reproductor sale de la carátula (una vez por canción).
  const c = await colorOf(thumb);
  if (cur() !== t || !c) return;
  const root = document.documentElement.style;
  root.setProperty('--pl-c1', tone(c, 24));
  root.setProperty('--pl-c2', tone(c, 9, 60));
  root.setProperty('--mini-bg', tone(c, 14, 40));
}
function likeUI() {
  const t = cur();
  if (!t) return;
  $('#plLikeIc').setAttribute('href', liked[t.id] ? '#i-like-f' : '#i-like');
  $('#plDislikeIc').setAttribute('href', disliked[t.id] ? '#i-dislike-f' : '#i-dislike');
  $('#plLikeN').textContent = t.plays ? fmtN(Math.round(t.plays / 180)) : liked[t.id] ? '1' : '';
}

// Lo único que corre mientras suena: actualizar la barra, y solo si se ve.
let visible = !document.hidden, tickTimer = 0, seeking = false;
function ticker() {
  // El motor web ya avisa 4 veces por segundo (timeupdate); el nativo necesita reloj,
  // y solo con la pantalla prendida, la app adelante y algo sonando.
  const want = NATIVE && visible && P.playing;
  if (want && !tickTimer) tickTimer = setInterval(tick, 500);
  if (!want && tickTimer) { clearInterval(tickTimer); tickTimer = 0; }
}
function tick() {
  videoSync();
  if (!visible || !cur()) return;
  const { pos, dur, buf } = P.eng.pos();
  const f = dur ? Math.min(1, pos / dur) : 0;
  $('#miniBar').style.transform = `scaleX(${f})`;
  if (OV.includes('player') && !seeking) {
    $('#seekFill').style.transform = `scaleX(${f})`;
    $('#seekBuf').style.transform = `scaleX(${dur ? Math.min(1, buf / dur) : 0})`;
    $('#seekThumb').style.transform = `translateX(${f * $('#seek').clientWidth}px)`;
    $('#tCur').textContent = fmt(pos);
    $('#tDur').textContent = fmt(dur || cur().duration);
  }
  if (sheetTab === 'lyrics' && lyr?.synced) lyricsTick(pos);
  // Saltar partes que no son música (SponsorBlock), como ytm-rs.
  for (const s of P.skips) if (pos >= s.start && pos < s.end - 0.5 && (!s.length || Math.abs(s.length - dur) < 3)) { P.eng.seek(s.end); toast('Skipped a non-music part'); break; }
  // Motor web: que el núcleo resuelva la próxima canción antes de que haga falta.
  if (!NATIVE && dur && dur - pos < 20 && !P.eng.prefetched) {
    P.eng.prefetched = true;
    const n = P.queue[P.i + 1];
    if (n && !DL.has(n.id)) fetch('/api/stream/' + encodeURIComponent(n.id), { method: 'HEAD' }).catch(() => {});
  }
}
document.addEventListener('visibilitychange', () => { if (document.hidden) saveSession(true); visible = !document.hidden; ticker(); videoSync(); if (visible) { P.eng?.sync(); tick(); } });

// ------------------------------------------------------------------ superposiciones e historial (atrás de Android)
let OV = [];
function applyOv(stack) {
  const was = OV;
  OV = stack.slice();
  const pl = OV.includes('player');
  const pe = $('#player');
  pe.scrollTop = 0; $('.pl-body').scrollTop = 0; $('#sheet').scrollTop = 0;
  pe.classList.toggle('open', pl);
  $('#player').setAttribute('aria-hidden', String(!pl));
  const q = OV.includes('queue'), wasQ = was.includes('queue');
  if (q !== wasQ && pl) {
    // Cuánto se mueven los controles: lo que ocupaba la carátula (medido antes del cambio).
    const art = $('.pl-art-wrap');
    if (q) applyOv.h = art.offsetHeight;
    pe.style.setProperty('--qdy', (applyOv.h || 120) + 'px');
    pe.classList.toggle('unq', !q);
    clearTimeout(applyOv.t); applyOv.t = setTimeout(() => pe.classList.remove('unq'), 400);
  }
  pe.classList.toggle('q', q);
  if (q && !wasQ) queueUI(true);
  const sh = OV.includes('sheet');
  $('#sheet').classList.toggle('open', sh);
  if (!sh) { sheetTab = null; $('#shareFab').hidden = true; }
  const m = OV.includes('menu');
  $('#menu').hidden = $('#scrim').hidden = !m;
  if (m) requestAnimationFrame(() => $('#menu').classList.add('open'));
  else { $('#menu').classList.remove('open'); if (!m) $('#menu').classList.remove('dlg'); }
  if (pl) { P.eng?.sync(); tick(); if (V.mode === 'video' && cur() && cur().id !== V.id && videoVisible()) setMode('video', true); }
  videoSync();
}
function pushOv(name) {
  const ov = [...OV.filter((x) => x !== name), name];
  history.pushState({ ...(history.state || {}), ov }, '');
  applyOv(ov);
}
const popOv = () => { if (OV.length) history.back(); };
function onBack() { if (OV.length || history.length > 1) history.back(); }

let rendered = '';
addEventListener('popstate', (e) => {
  const st = e.state || {};
  applyOv(st.ov || []);
  if (location.pathname + location.search !== rendered) render(st.y || 0);
});
function go(path) {
  if (path === location.pathname + location.search && !OV.length) return;
  const st = { ...(history.state || {}), y: scrollY };
  if (OV.length) {
    // Saliendo de un menú o del reproductor: esa entrada se reemplaza.
    history.replaceState({ ov: [], y: 0 }, '', path);
  } else {
    history.replaceState(st, '');
    history.pushState({ ov: [], y: 0 }, '', path);
  }
  applyOv([]);
  render(0);
}

// ------------------------------------------------------------------ piezas de la interfaz
// Miniaturas de video: anchas como en YouTube, o cuadradas (ajuste "Square thumbnails").
const wideTh = (t) => !settings.squareThumbs && (t.wide || t.video);
const eb = (t) => (t.explicit ? '<span class="eb">E</span>' : '');
const dlb = (t) => `<svg class="dlb" data-dlb="${esc(t.id)}"${DL.has(t.id) ? '' : ' hidden'}><use href="#i-dl-mini"/></svg>`;
// Sin carátula: el cuadro gris con una nota, como YouTube Music.
const NOART = `<svg class="noart" viewBox="0 0 24 24"><path d="M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6Z"/></svg>`;
/** Direcciones de carátula que el WebView puede cargar: siempre https (sin "//…" ni http). */
const fixUrl = (u) => !u ? '' : u.startsWith('//') ? 'https:' + u : u.replace(/^http:\/\/(?!127\.0\.0\.1|localhost)/, 'https://');
function thumbImg(src, w = 48, cls = '') {
  return src ? `<img src="${esc(fixUrl(src))}" loading="lazy" decoding="async" width="${w}" height="${w}" alt=""${cls ? ` class="${cls}"` : ''}>` : NOART;
}
/** Una carátula que no carga (video borrado, miniatura que no existe, enlace raro): primero
 *  la versión que siempre existe o pasando por el servidor de la app; si tampoco, el cuadro
 *  gris en vez del ícono de imagen rota. Un solo escuchador para todas las imágenes. */
// La misma nota sobre gris, como imagen (para <img> que el código vuelve a usar, como el mini reproductor).
const NOART_SRC = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" fill="#2a2a2a"/><path transform="translate(6.6 6.6) scale(.45)" fill="#5f5f5f" d="M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6Z"/></svg>');
document.addEventListener('error', (e) => {
  const img = e.target;
  // La carátula del reproductor y las que se asoman al deslizar tienen su propio manejo (setArt).
  if (img.tagName !== 'IMG' || img.closest('.pl-art-box')) return;
  const src = img.getAttribute('src') || '';
  if (!src || src === NOART_SRC) return;
  // Cada imagen nueva empieza su propia cadena de intentos (el mini reproductor reusa la misma <img>).
  if (!img._fb || img._fb.cur !== src) img._fb = { tries: 0 };
  const fb = img._fb, set = (u) => { fb.cur = u; img.src = u; };
  const vi = src.match(/^https:\/\/i\d?\.ytimg\.com\/vi(?:_webp)?\/([^/]+)\/(?!hqdefault)/);
  fb.tries++;
  if (fb.tries === 1 && vi) return set(`https://i.ytimg.com/vi/${vi[1]}/hqdefault.jpg`);
  if (fb.tries <= 2 && /^https?:/.test(src)) return set(imgUrl(src));
  set(NOART_SRC);
}, true);
/** Una fila de canción. `sub`: qué va después del artista. */
function rowHTML(t, k, i, { sub = 'album', num = null, rank = null, handle = false, cls = '' } = {}) {
  const extra = sub === 'album' && t.album?.name ? ` • ${esc(t.album.name)}` : sub === 'dur' && t.duration ? ` • ${fmt(t.duration)}` : sub === 'plays' && t.plays ? ` • ${fmtN(t.plays)} plays` : '';
  const curCls = cur()?.id === t.id ? ' cur' : '';
  const left = rank != null ? `<div class="rank">${rank}<small>▲</small></div><div class="th">${thumbImg(DL.thumb(t))}</div>`
    : num != null ? `<div class="num">${num}</div>` : `<div class="th${wideTh(t) ? ' wide' : ''}">${thumbImg(DL.thumb(t), wideTh(t) ? 86 : 48)}${curCls ? `<div class="eq-ov">${ic('eq')}</div>` : ''}</div>`;
  return `<div class="row${curCls}${cls}" data-act="row" data-list="${k}" data-i="${i}">${left}<div class="tx"><div class="t1">${esc(t.title)}</div><div class="t2">${eb(t)}${dlb(t)}<span>${esc(artists(t))}${extra}</span></div></div>`
    + (handle ? `<button class="icon-btn q-drag" data-drag="${i}" aria-label="Move">${ic('drag')}</button>` : `<button class="icon-btn" data-act="menu" data-list="${k}" data-i="${i}" aria-label="More">${ic('more')}</button>`) + '</div>';
}
function cardHTML(c, k, i) {
  const href = c.kind === 'song' ? '' : `/${c.kind}/${encodeURIComponent(c.id)}`;
  const tag = href ? `a href="${href}"` : `div data-act="card" data-list="${k}" data-i="${i}"`;
  const play = c.kind === 'album' || c.kind === 'playlist' ? `<button class="play-ov" data-act="playCol" data-kind="${c.kind}" data-id="${esc(c.id)}" aria-label="Play">${ic('play')}</button>` : '';
  return `<${tag} class="card${c.round ? ' round' : ''}"><div class="art">${thumbImg(c.thumb, 160)}${play}</div><div class="t1">${esc(c.title)}</div><div class="t2">${c.track ? eb(c.track) : ''}${esc(c.subtitle)}</div></${href ? 'a' : 'div'}>`;
}
function cardsHTML(cards) {
  const k = reg(cards.map((c) => c.track).filter(Boolean), '', 'radio');
  let si = 0;
  return `<div class="hscroll">${cards.map((c) => cardHTML(c, k, c.track ? si++ : -1)).join('')}</div>`;
}
function shelfHTML(s) {
  const head = (btn) => `<div class="sh-hd"><div class="grow">${s.strapline ? `<div class="strap">${s.strapThumb ? thumbImg(s.strapThumb, 24) : ''}${esc(s.strapline)}</div>` : ''}<div class="sh-title">${esc(s.title)}</div></div>${btn}</div>`;
  if (s.kind === 'songs') {
    const k = reg(s.items, s.title, 'radio');
    const rows = Math.max(1, s.rows || 4);
    let cols = '';
    for (let c = 0; c < s.items.length; c += rows) cols += `<div class="col">${s.items.slice(c, c + rows).map((t, j) => rowHTML(t, k, c + j)).join('')}</div>`;
    return `<section class="shelf">${head(`<button class="pill" data-act="playAll" data-list="${k}">Play all</button>`)}<div class="cols">${cols}</div></section>`;
  }
  return `<section class="shelf">${head('')}${cardsHTML(s.items)}</section>`;
}
const listHTML = (tracks, name, opts = {}) => { const k = reg(tracks, name, opts.mode || 'list'); return tracks.map((t, i) => rowHTML(t, k, i, opts)).join(''); };
const loadingHTML = () => `<div class="loading">${'<div class="skel" style="height:24px;width:40%"></div><div style="display:flex;gap:12px"><div class="skel" style="width:40vw;aspect-ratio:1"></div><div class="skel" style="width:40vw;aspect-ratio:1"></div><div class="skel" style="width:40vw;aspect-ratio:1"></div></div>'.repeat(2)}</div>`;
function errorHTML(e) {
  const off = !navigator.onLine || /fetch|network/i.test(String(e));
  return off
    ? `<div class="empty">${ic('offline')}<h3>You're offline</h3><div>Listen to your downloads while you reconnect.</div><a class="pill solid" href="/downloads" style="margin-top:20px">Go to downloads</a></div>`
    : `<div class="err">Something went wrong<br><small>${esc(e.message || e)}</small><br><button class="pill" data-act="retry">Retry</button></div>`;
}

// ------------------------------------------------------------------ barra superior
const $top = $('#top'), $page = $('#page');
function brandBar(extra = '', title = '') {
  if (NEWUI && title) return `<h1 class="pg-ttl">${esc(T(title))}</h1><div class="grow"></div>${extra}`;
  return `<a class="brand" href="/" aria-label="Giraffe Music"><img src="/icons/icon.svg" alt="" width="26" height="26"><b>Giraffe Music</b></a><div class="grow"></div>${extra}`
    + `<button class="icon-btn" data-act="cast" aria-label="Cast">${ic('cast')}</button><a class="icon-btn" href="/search" aria-label="Search">${ic('search')}</a>${avatarHTML()}`;
}
function detailBar(title = '', more = '', inList = false) {
  return `<button class="icon-btn" data-act="back" aria-label="Back">${ic('back')}</button><div class="grow ttl">${esc(title)}</div><button class="icon-btn" data-act="cast" aria-label="Cast">${ic('cast')}</button>${inList ? `<button class="icon-btn" data-act="plSearch" aria-label="Search">${ic('search')}</button>` : `<a class="icon-btn" href="/search" aria-label="Search">${ic('search')}</a>`}${more}`;
}
/** Buscar dentro de la playlist (o álbum) abierta: filtra sus canciones, sin salir. */
const fold = (s) => (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const PLF = {
  q: '', saved: null,
  open() {
    this.saved = { cls: $top.className, html: $top.innerHTML };
    $top.className = 'sbar psearch'; $top.hidden = false;
    $top.innerHTML = L(`<button class="icon-btn" data-act="plSearchClose" aria-label="Back">${ic('back')}</button><input id="plq" type="search" enterkeyhint="search" autocomplete="off" placeholder="Search in this playlist"><button class="icon-btn" data-act="plSearchClear" aria-label="Clear" hidden>${ic('close')}</button>`);
    const inp = $('#plq');
    inp.oninput = () => { $top.querySelector('[data-act=plSearchClear]').hidden = !inp.value; this.q = inp.value.trim(); this.run(); };
    inp.onkeydown = (e) => { if (e.key === 'Enter') inp.blur(); };
    inp.focus();
    document.body.classList.add('pl-filtering');
  },
  run() {
    const q = fold(this.q), rows = $$('#page .tracks .row[data-list]');
    let n = 0;
    for (const r of rows) {
      const t = LISTS.get(r.dataset.list)?.tracks[+r.dataset.i];
      const ok = !q || (t && fold(`${t.title} ${artists(t)} ${t.album?.name || ''}`).includes(q));
      r.classList.toggle('plf-hide', !ok);
      if (ok) n++;
    }
    document.body.classList.toggle('pl-filtering', !!q);
    $('#plNotFound')?.remove();
    if (q && !n) $('#page .tracks')?.insertAdjacentHTML('afterend', L(`<div class="empty pl-nf" id="plNotFound"><h3>${esc(T(`Not in this playlist: “${this.q}”`))}</h3><span>Search for it in all of Giraffe Music?</span><button class="pill solid" data-act="plSearchAll">${ic('search', 's20')}Search</button></div>`));
    if (q) window.scrollTo(0, 0);
  },
  close() {
    this.q = '';
    for (const r of $$('#page .plf-hide')) r.classList.remove('plf-hide');
    $('#plNotFound')?.remove();
    document.body.classList.remove('pl-filtering');
    if (this.saved) { $top.className = this.saved.cls; $top.innerHTML = this.saved.html; this.saved = null; }
  },
};
let topObs = null;
function setTop(html, cls = '') {
  $top.className = 'topbar ' + cls;
  $top.innerHTML = L(html);
  $top.hidden = false;
}
/** La barra transparente se vuelve sólida al bajar (sin escuchar el scroll). */
function watchTop() {
  topObs?.disconnect();
  const s = $('.top-sentinel');
  if (!s) return;
  topObs = new IntersectionObserver(([e]) => $top.classList.toggle('solid', !e.isIntersecting));
  topObs.observe(s);
}

// ------------------------------------------------------------------ páginas
const routes = [
  [/^\/$/, pageHome, 'home'],
  [/^\/samples$/, pageSamples, 'samples'],
  [/^\/explore$/, pageExplore, 'explore'],
  [/^\/explore\/(new|charts|moods)$/, pageExploreSub, 'explore'],
  [/^\/library$/, pageLibrary, 'library'],
  [/^\/liked$/, pageLiked, 'library'],
  [/^\/downloads$/, pageDownloads, 'library'],
  [/^\/history$/, pageHistory, 'library'],
  [/^\/search$/, pageSearch, null],
  [/^\/playlist\/(.+)\/edit$/, (m) => pageCollection(decodeURIComponent(m[1]), false), null],
  [/^\/(album|playlist)\/(.+)$/, (m) => pageCollection(decodeURIComponent(m[2]), m[1] === 'album'), null],
  [/^\/artist\/(.+)$/, (m) => pageArtist(decodeURIComponent(m[1])), null],
  [/^\/settings(?:\/(\w+))?$/, (m) => pageSettings(m[1]), null],
  [/^\/account$/, pageAccount, null],
];
let token = 0, tab = 'home', cleanup = null;
async function render(y = 0) {
  const my = ++token;
  rendered = location.pathname + location.search;
  cleanup?.(); cleanup = null;
  LISTS.clear();
  PLF.q = ''; PLF.saved = null; document.body.classList.remove('pl-filtering');
  if (addTarget && location.pathname !== '/search') {
    mem.delete('/api/playlist/' + encodeURIComponent(addTarget.id)); mem.delete('/api/me/library');
    addTarget = null;
  }
  const [re, fn, t] = routes.find(([r]) => r.test(location.pathname)) || routes[0];
  if (t) tab = t;
  document.body.classList.toggle('modal', location.pathname === '/account');
  for (const a of $$('#nav a')) {
    const on = a.dataset.tab === tab;
    a.classList.toggle('on', on);
    a.querySelector('use').setAttribute('href', `#i-${(NEWUI && NAV_NEW[a.dataset.tab]) || a.dataset.tab}${on ? '-f' : ''}`);
  }
  $page.innerHTML = loadingHTML();
  try {
    const html = await fn(location.pathname.match(re), my);
    if (my !== token) return;
    if (html != null) $page.innerHTML = L(html);
  } catch (e) {
    if (my !== token) return;
    $page.innerHTML = L(errorHTML(e));
  }
  watchTop();
  scrollTo(0, y);
  afterRender?.();
  afterRender = null;
}
let afterRender = null;

async function pageHome() {
  const p = new URLSearchParams(location.search).get('p');
  setTop(brandBar(), 'glass');
  const d = await api('/api/home' + (p ? '?params=' + encodeURIComponent(p) : ''));
  const chips = `<div class="chips">${d.chips.map((c) => `<button class="chip${c.selected ? ' on' : ''}" data-act="chip" data-p="${esc(c.params || '')}">${esc(c.title)}</button>`).join('')}</div>`;
  homeMore = d.continuation;
  afterRender = () => { watchMore(); glow(d.shelves); if (!p) capsule(); };
  return '<div class="glow" id="glow"></div><div class="top-sentinel" style="position:absolute;top:8px;height:1px;width:1px"></div>' + chips + d.shelves.map(shelfHTML).join('') + '<div id="more-sentinel" style="height:1px"></div>';
}
let homeMore = null, moreObs = null;
/** "Hace un mes escuchabas esto": un estante más en Inicio, solo si hay historial de esa época. */
async function capsule() {
  let c;
  try { c = await api('/api/capsule', 60 * 60e3); } catch { return; }
  const first = $('.shelf');
  if (!c?.tracks?.length || !first || $('#capsule')) return;
  first.insertAdjacentHTML('afterend', L(shelfHTML({ title: 'Time capsule', strapline: c.label, kind: 'songs', rows: 4, items: c.tracks }).replace('<section class="shelf"', '<section class="shelf" id="capsule"')));
}
function watchMore() {
  moreObs?.disconnect();
  const s = $('#more-sentinel');
  if (!s || !homeMore) return;
  moreObs = new IntersectionObserver(async ([e]) => {
    if (!e.isIntersecting || !homeMore) return;
    const tok = homeMore; homeMore = null;
    try {
      const d = await api('/api/home/more?token=' + encodeURIComponent(tok));
      s.insertAdjacentHTML('beforebegin', L(d.shelves.map(shelfHTML).join('')));
      homeMore = d.continuation;
    } catch {}
  }, { rootMargin: '600px' });
  moreObs.observe(s);
  cleanup = () => moreObs?.disconnect();
}

// --- Samples: canciones a pantalla completa, se escucha un pedacito de cada una.
let sampleAudio = null;
async function pageSamples(_, my) {
  $top.hidden = true;
  const d = await api('/api/home');
  if (my !== token) return;
  // Lo que ya conocés (Inicio, historial, Me gusta) y, mezcladas, canciones nuevas de las
  // radios de algunas que escuchaste: 2 nuevas por cada conocida, como Samples de YouTube Music.
  const seen = new Set();
  const mine = [];
  for (const s of d.shelves) for (const x of s.items) { const t = s.kind === 'songs' ? x : x.track; if (t && !seen.has(t.id)) { seen.add(t.id); mine.push(t); } }
  for (const t of hist) seen.add(t.id);
  for (const id in liked) seen.add(id);
  const seeds = shuffleArr(hist.slice(0, 30).concat(mine.slice(0, 10))).slice(0, 3);
  const radios = await Promise.all(seeds.map((t) => api('/api/radio/' + encodeURIComponent(t.id), 10 * 60e3).catch(() => [])));
  if (my !== token) return;
  const fresh = [];
  for (const t of shuffleArr(radios.flat())) if (t && !seen.has(t.id) && !disliked[t.id]) { seen.add(t.id); fresh.push(t); }
  const old = shuffleArr(mine);
  let tracks = [];
  while ((fresh.length || old.length) && tracks.length < 30) {
    if (fresh.length) tracks.push(fresh.shift());
    if (fresh.length) tracks.push(fresh.shift());
    if (old.length) tracks.push(old.shift());
  }
  const k = reg(tracks, 'Samples', 'radio');
  samplesSeen = seen;
  afterRender = () => startSamples(k);
  return `<div class="smp-top">Samples</div><div class="samples" id="samples">${tracks.map((t, i) => sampleHTML(t, k, i)).join('')}</div>`;
}
let samplesSeen = new Set();
function sampleHTML(t, k, i) {
  return `<section class="smp" data-i="${i}">
    <img class="s-art" src="${esc(t.art || t.thumb)}" loading="${i < 2 ? 'eager' : 'lazy'}" decoding="async" alt="">
    <div class="s-info"><div class="t1">${esc(t.title)}</div><div class="t2">${eb(t)}<span>${esc(artists(t))}</span></div>
    <button class="pill solid s-full" data-act="row" data-list="${k}" data-i="${i}">${ic('play', 's20')}${T('Play')}</button></div>
    <div class="s-side">
      <button data-act="likeT" data-list="${k}" data-i="${i}"><span class="round-btn">${ic(liked[t.id] ? 'like-f' : 'like')}</span>${T('Like')}</button>
      <button data-act="saveT" data-list="${k}" data-i="${i}"><span class="round-btn">${ic('save')}</span>${T('Save')}</button>
      <button data-act="shareT" data-list="${k}" data-i="${i}"><span class="round-btn">${ic('share')}</span>${T('Share')}</button>
      <button data-act="menu" data-list="${k}" data-i="${i}"><span class="round-btn">${ic('more')}</span></button>
    </div><div class="s-prog"><i></i></div></section>`;
}
function startSamples(k) {
  const box = $('#samples');
  if (!box) return;
  sampleAudio ||= new Audio();
  const a = sampleAudio;
  let active = null;
  const onTime = () => { if (!active || !a.duration) return; const start = a._start || 0; active.querySelector('.s-prog i').style.transform = `scaleX(${Math.min(1, (a.currentTime - start) / 30)})`; if (a.currentTime - start > 30) a.currentTime = start; };
  a.ontimeupdate = onTime;
  const obs = new IntersectionObserver((es) => {
    for (const e of es) {
      if (!e.isIntersecting || e.target === active) continue;
      active = e.target;
      const t = LISTS.get(k)?.tracks[+active.dataset.i];
      if (!t) continue;
      if (P.playing) P.eng.pause();
      const sec = active;
      colorOf(t.thumb).then((c) => { if (c) { sec.style.setProperty('--sc1', tone(c, 28)); sec.style.setProperty('--sc2', tone(c, 8, 60)); } });
      a.src = '/api/stream/' + encodeURIComponent(t.id);
      a.onloadedmetadata = () => { a._start = Math.min(a.duration * 0.3, 60); a.currentTime = a._start; };
      a.play().catch(() => {});
      // Cerca del final: más canciones nuevas, de la radio de la que estás escuchando.
      const list = LISTS.get(k)?.tracks;
      if (list && +sec.dataset.i >= list.length - 4 && !box.loadingMore) {
        box.loadingMore = true;
        api('/api/radio/' + encodeURIComponent(t.id), 10 * 60e3).then((more) => {
          const add = more.filter((x) => !samplesSeen.has(x.id) && !disliked[x.id]).slice(0, 15);
          add.forEach((x) => samplesSeen.add(x.id));
          if (!add.length || !$('#samples')) return;
          const from = list.length;
          list.push(...add);
          box.insertAdjacentHTML('beforeend', add.map((x, j) => sampleHTML(x, k, from + j)).join(''));
          for (const s of $$('.smp', box)) if (+s.dataset.i >= from) obs.observe(s);
        }).catch(() => {}).finally(() => { box.loadingMore = false; });
      }
    }
  }, { root: box, threshold: 0.6 });
  for (const s of $$('.smp', box)) obs.observe(s);
  // Al salir de Samples se suelta el audio entero (el decodificador consume).
  cleanup = () => { obs.disconnect(); a.pause(); a.removeAttribute('src'); a.load(); $top.hidden = false; };
}

async function pageExplore() {
  setTop(brandBar());
  const [d, home] = await Promise.all([api('/api/explore', 15 * 60e3), api('/api/home').catch(() => ({ chips: [] }))]);
  const kTop = reg(d.topSongs, 'Top songs', 'radio');
  const cols = [];
  for (let c = 0; c < Math.min(d.topSongs.length, 20); c += 4) cols.push(`<div class="col">${d.topSongs.slice(c, c + 4).map((t, j) => rowHTML(t, kTop, c + j, { rank: c + j + 1, sub: 'artist' })).join('')}</div>`);
  return `<div class="ex-btns">
      <a class="ex-btn" href="/explore/new">${ic('new')}New releases</a>
      <a class="ex-btn" href="/explore/charts">${ic('trend')}Charts</a>
      <a class="ex-btn" href="/explore/moods">${ic('mood')}Moods &amp; genres</a></div>
    ${d.newReleases.length ? `<section class="shelf"><div class="sh-hd"><div class="grow"><div class="sh-title">New albums &amp; singles</div></div><a class="pill" href="/explore/new">More</a></div>${cardsHTML(d.newReleases)}</section>` : ''}
    ${moodsHTML(home.chips)}
    ${d.topSongs.length ? `<section class="shelf"><div class="sh-hd"><div class="grow"><div class="sh-title">Top songs</div></div><button class="pill" data-act="playAll" data-list="${kTop}">Play all</button></div><div class="cols">${cols.join('')}</div></section>` : ''}
    ${d.charts.length ? `<section class="shelf"><div class="sh-hd"><div class="grow"><div class="sh-title">Charts</div></div></div>${cardsHTML(d.charts)}</section>` : ''}`;
}
const MOOD_COLORS = ['#f6a821', '#3ea6ff', '#e3576b', '#5ad19a', '#b98cff', '#ff8a3d', '#64d2ff', '#ffd23f', '#ff6fb5', '#9be564', '#7aa2ff'];
function moodsHTML(chips) {
  if (!chips?.length) return '';
  return `<section class="shelf"><div class="sh-hd"><div class="grow"><div class="sh-title">Moods &amp; genres</div></div><a class="pill" href="/explore/moods">More</a></div><div class="moods">${chips.map((c, i) => `<a class="mood" style="--mc:${MOOD_COLORS[i % MOOD_COLORS.length]}" href="/?p=${encodeURIComponent(c.params || '')}">${esc(c.title)}</a>`).join('')}</div></section>`;
}
async function pageExploreSub(m) {
  const which = m[1];
  const title = { new: 'New releases', charts: 'Charts', moods: 'Moods & genres' }[which];
  setTop(detailBar(title));
  $top.classList.add('solid');
  if (which === 'moods') {
    const home = await api('/api/home');
    return `<h2 class="sec-ttl">${title}</h2><div class="ex-btns" style="grid-template-columns:1fr 1fr">${home.chips.map((c, i) => `<a class="mood" style="--mc:${MOOD_COLORS[i % MOOD_COLORS.length]};height:48px" href="/?p=${encodeURIComponent(c.params || '')}">${esc(c.title)}</a>`).join('')}</div>`;
  }
  const d = await api('/api/explore', 15 * 60e3);
  if (which === 'new') return `<h2 class="sec-ttl">${title}</h2><div class="ex-btns" style="grid-template-columns:1fr 1fr">${d.newReleases.map((c, i) => cardHTML(c, '', i)).join('').replaceAll('class="card', 'style="--card-w:100%" class="card')}</div>`;
  return `<h2 class="sec-ttl">Top songs</h2>${listHTML(d.topSongs, 'Top songs', { sub: 'artist', mode: 'list' })}<h2 class="sec-ttl">Charts</h2>${cardsHTML(d.charts)}`;
}

async function pageLibrary() {
  setTop(brandBar(`<a class="icon-btn" href="/history" aria-label="History">${ic('history')}</a>`, 'Library'));
  const f = new URLSearchParams(location.search).get('f') || '';
  if (!DL.loaded) { DL.loaded = true; await DL.refresh(); }
  const chips = NEWUI ? [['downloads', 'Downloads'], ['playlists', 'Playlists'], ['songs', 'Songs'], ['albums', 'Albums'], ['artists', 'Artists']]
    : [['playlists', 'Playlists'], ['songs', 'Songs'], ['albums', 'Albums'], ['artists', 'Artists'], ['downloads', 'Downloads']];
  // Interfaz nueva: el ⋮ al costado de cada playlist o álbum, como en YouTube Music.
  const more = (kind, id, title) => NEWUI && kind !== 'artist' ? `<button class="icon-btn row-more" data-act="libItemMenu" data-kind="${kind}" data-id="${esc(id)}" data-title="${esc(title)}" aria-label="More">${ic('more')}</button>` : '';
  let html = `<div class="chips">${chips.map(([k, n]) => `<button class="chip${f === k ? ' on' : ''}" data-act="libChip" data-f="${k}">${n}</button>`).join('')}</div>`;
  const SORTS = { recent: 'Recent activity', added: 'Recently added', az: 'A–Z' };
  html += `<div class="lib-tools"><div class="grow"><button class="sort" data-act="libSort">${SORTS[settings.libSort] || SORTS.recent} ${ic('down', 's20')}</button></div>`
    + `<button class="icon-btn" data-act="libView" aria-label="${settings.libGrid ? 'List view' : 'Grid view'}">${ic(settings.libGrid ? 'list' : 'grid')}</button></div>`;
  const nLiked = Object.keys(liked).length, nDl = DL.items.size;
  const fixed = [];
  if (!f || f === 'playlists') fixed.push(`<a class="row" href="/liked"><div class="th lib-th-like">${ic('like-f')}</div><div class="tx"><div class="t1">Liked Music</div><div class="t2">${ic('pin', 's16')}<span>Auto playlist${me.signedIn ? '' : ' • ' + songs(nLiked)}</span></div></div>${more('liked', 'LM', 'Liked Music')}</a>`);
  if ((!f && !NEWUI) || f === 'downloads') fixed.push(`<a class="row" href="/downloads"><div class="th lib-th-dl">${ic('dl-done')}</div><div class="tx"><div class="t1">Downloads</div><div class="t2"><span>${songs(nDl)} • ${fmtMB(DL.bytes)}</span></div></div></a>`);
  if (f === 'songs') {
    const songs = Object.values(savedSongs).concat(Object.values(liked)).sort((a, b) => b.at - a.at).map((x) => x.t);
    const uniq = [...new Map(songs.map((t) => [t.id, t])).values()];
    return html + (uniq.length ? listHTML(uniq, 'Your library') : `<div class="empty"><h3>No songs yet</h3>Songs you like or save show up here.</div>`);
  }
  const kinds = { playlists: ['playlist'], albums: ['album'], artists: ['artist'] }[f] || (f ? [] : ['playlist', 'album', 'artist']);
  let items = Object.values(lib).filter((x) => kinds.includes(x.kind)).sort((a, b) => b.at - a.at);
  // Con la cuenta: sus playlists y álbumes (y los guardados acá que no estén).
  if (me.signedIn && kinds.length) {
    try {
      const acc = await api('/api/me/library', 5 * 60e3);
      const mine = [...(kinds.includes('playlist') ? acc.playlists : []), ...(kinds.includes('album') ? acc.albums : [])]
        .filter((c) => c.id !== 'LM' && c.id !== 'VLLM')
        .map((c) => ({ kind: c.kind, id: c.id, title: c.title, subtitle: c.subtitle, thumb: c.thumb, round: c.round }));
      const have = new Set(mine.map((x) => x.kind + x.id));
      items = mine.concat(items.filter((x) => !have.has(x.kind + x.id)));
    } catch (e) { if (/signed/.test(e.message)) refreshAccount(); }
  }
  if (kinds.includes('playlist') && localPls.length) {
    const loc = localPls.map((p) => ({ kind: 'playlist', id: p.id, title: p.title, subtitle: `${T('Saved on this device')} • ${songs(p.tracks.length)}`, thumb: p.tracks[0]?.thumb || '', at: p.at }));
    items = loc.concat(items);
  }
  if (!me.signedIn && !f) html += signinCard('Sign in to see your playlists, albums and likes from YouTube Music.');
  if (settings.libSort === 'az') items.sort((a, b) => a.title.localeCompare(b.title));
  else if (settings.libSort === 'added') items.sort((a, b) => (b.at || 0) - (a.at || 0));
  if (settings.libGrid) {
    // Cuadrícula de 2 columnas, como la vista de cuadrícula de la app.
    const fixedCards = [];
    if (!f || f === 'playlists') fixedCards.push(`<a class="card" href="/liked"><div class="art"><div class="lib-th-like">${ic('like-f')}</div></div><div class="t1">Liked Music</div><div class="t2">Auto playlist</div></a>`);
    if (!f || f === 'downloads') fixedCards.push(`<a class="card" href="/downloads"><div class="art"><div class="lib-th-dl">${ic('dl-done')}</div></div><div class="t1">Downloads</div><div class="t2">${songs(nDl)}</div></a>`);
    html += `<div class="lib-grid">${fixedCards.join('')}${items.map((x) => `<a class="card${x.round ? ' round' : ''}" href="/${x.kind}/${encodeURIComponent(x.id)}"><div class="art">${thumbImg(x.thumb, 180)}</div><div class="t1">${esc(x.title)}</div><div class="t2">${esc(x.subtitle)}</div></a>`).join('')}</div>`;
  } else {
    html += fixed.join('') + items.map((x) => `<a class="row${x.round ? ' round' : ''}" href="/${x.kind}/${encodeURIComponent(x.id)}"><div class="th">${thumbImg(x.thumb)}</div><div class="tx"><div class="t1">${esc(x.title)}</div><div class="t2"><span>${esc(x.subtitle)}</span></div></div>${more(x.kind, x.id, x.title)}</a>`).join('');
  }
  html += `<div class="fabs"><button class="fab-mini" data-act="together" aria-label="Listen together">${ic('person-add')}</button><button class="fab" data-act="newPlaylist">${ic('add')}New</button></div>`;
  if (f === 'downloads') return html + listHTML([...DL.items.values()].map((x) => x.track), 'Downloads', { sub: 'dur' });
  if (!fixed.length && !items.length) html += `<div class="empty"><h3>Nothing here yet</h3>Save albums, playlists and artists to find them fast.</div>`;
  return html;
}
/** La carátula en grande (para la cabecera de la interfaz nueva). */
function hiRes(u) {
  if (!u) return u;
  if (/=w\d+-h\d+/.test(u)) return u.replace(/=w\d+-h\d+[^&]*$/, '=w720-h720-l90-rj');
  if (/=s\d+/.test(u)) return u.replace(/=s\d+[^&]*$/, '=s720');
  return u;
}
function collHero(o) {
  return NEWUI ? collHeroNew(o) : collHeroOld(o);
}
/** Interfaz nueva: la carátula ocupa todo el ancho y se funde con el fondo, el título centrado
 *  y las acciones abajo (descargar, guardar/editar, compartir… aleatorio y reproducir). */
function collHeroNew({ title, thumb, by, meta, desc, k, thumbHTML, save }) {
  afterRender = null;
  const art = thumbHTML ? `<div class="h2-art h2-ph">${thumbHTML}</div>` : `<div class="h2-art">${thumb ? `<img src="${esc(fixUrl(hiRes(thumb)))}" alt="" decoding="async">` : NOART}</div>`;
  return `<div class="top-sentinel" style="position:absolute;top:160px;height:1px;width:1px"></div><div class="hero2">${art}
    <h1>${esc(title)}</h1>${desc ? `<div class="desc">${esc(desc)}</div>` : ''}
    <div class="meta2">${by ? `<span class="by">${by}</span> • ` : ''}${meta}</div>
    <div class="actions2">
      <button class="round-btn" data-act="dlAll" data-list="${k}" data-dlall="${k}" aria-label="Download"></button>
      ${save ?? ''}
      <button class="round-btn" data-act="shareList" data-list="${k}" aria-label="Share">${ic('share')}</button>
      <div class="grow"></div>
      <button class="icon-btn h2-shuffle" data-act="shuffleList" data-list="${k}" aria-label="Shuffle">${ic('shuffle')}</button>
      <button class="big-play" data-act="playAll" data-list="${k}" aria-label="Play">${ic('play')}</button>
    </div></div>`;
}
function collHeroOld({ title, thumb, by, meta, desc, k, thumbHTML, save }) {
  afterRender = async () => { const c = await colorOf(thumb); const h = $('.hero'); if (c && h) h.style.setProperty('--hero', tone(c, 30)); };
  return `<div class="top-sentinel" style="position:absolute;top:120px;height:1px;width:1px"></div><div class="hero">
    <div class="cover">${thumbHTML || thumbImg(thumb, 260)}</div>
    <h1>${esc(title)}</h1>${by ? `<div class="by">${by}</div>` : ''}<div class="meta">${meta}</div>${desc ? `<div class="desc">${esc(desc)}</div>` : ''}
    <div class="actions">
      <button class="round-btn" data-act="dlAll" data-list="${k}" data-dlall="${k}" aria-label="Download"></button>
      ${save ?? ''}
      <button class="big-play" data-act="playAll" data-list="${k}" aria-label="Play">${ic('play')}</button>
      <button class="round-btn" data-act="shareList" data-list="${k}" aria-label="Share">${ic('share')}</button>
      <button class="round-btn" data-act="listMenu" data-list="${k}" aria-label="More">${ic('more')}</button>
    </div></div>`;
}
const NAV_NEW = { samples: 'samples2', library: 'bookmark' };
let addTarget = null; // "Agregar": la playlist a la que se suman canciones desde la búsqueda
const addRow = (id, title) => NEWUI ? `<button class="row add-row" data-act="plAdd" data-id="${esc(id)}" data-title="${esc(title)}"><div class="th add-th">${ic('add')}</div><div class="tx"><div class="t1">Add</div></div></button>` : '';
async function pageCollection(id, isAlbum) {
  setTop(detailBar('', '', true), 'clear');
  if (!isAlbum && isLocalPl(id)) return pageLocalPlaylist(id);
  const c = await api(`/api/${isAlbum ? 'album' : 'playlist'}/${encodeURIComponent(id)}`, 60 * 60e3);
  $top.querySelector('.ttl').textContent = c.title;
  const k = reg(c.tracks, c.title);
  if (c.owned && !isAlbum) LISTS.get(k).playlistId = id;
  const key = `${isAlbum ? 'album' : 'playlist'}:${id}`;
  const by = c.artists?.length ? c.artists.map((a) => a.id ? `<a href="/artist/${encodeURIComponent(a.id)}">${esc(a.name)}</a>` : esc(a.name)).join(', ') : '';
  const save = c.owned && me.signedIn ? `<a class="round-btn" href="/playlist/${encodeURIComponent(id)}/edit" aria-label="Edit">${ic('edit')}</a>` : `<button class="round-btn" data-act="saveLib" data-key="${esc(key)}" data-kind="${isAlbum ? 'album' : 'playlist'}" data-id="${esc(id)}" data-title="${esc(c.title)}" data-sub="${esc(c.subtitle)}" data-thumb="${esc(c.thumb || '')}" data-save="${esc(c.saveId || id)}" aria-label="Save">${ic(lib[key] ? 'lib-check' : 'lib-add')}</button>`;
  if (location.pathname.endsWith('/edit')) return editHTML(id, c);
  afterRender = null;
  const hero = collHero({ title: c.title, thumb: c.thumb, by, meta: esc(c.subtitle), desc: c.description, k, save });
  const rows = c.tracks.map((t, i) => rowHTML(t, k, i, isAlbum ? { num: i + 1, sub: 'none' } : { sub: 'album' })).join('');
  setTimeout(dlUI);
  const after = afterRender;
  afterRender = () => { after?.(); loadRest(c, k, isAlbum ? { sub: 'none' } : { sub: 'album' }, isAlbum); };
  return hero + (c.owned && me.signedIn && !isAlbum ? addRow(id, c.title) : '') + `<div class="tracks">${rows}</div><div class="foot-meta">${songs(c.tracks.length)} • ${fmtLong(c.duration)}</div>`;
}
async function pageLiked() {
  setTop(detailBar('Liked Music', '', true), 'clear');
  let tracks = Object.values(liked).sort((a, b) => b.at - a.at).map((x) => x.t);
  let acc = null;
  if (me.signedIn) {
    try {
      acc = await api('/api/me/liked', 5 * 60e3);
      const ids = new Set(acc.tracks.map((t) => t.id));
      tracks = tracks.filter((t) => !ids.has(t.id)).concat(acc.tracks);
    } catch {}
  }
  const k = reg(tracks, 'Liked Music');
  const total = tracks.reduce((s, t) => s + (t.duration || 0), 0);
  setTimeout(dlUI);
  if (acc?.continuation) {
    // El resto de la playlist de la cuenta (se suma a la lista que ya se ve).
    const localOnly = tracks.length - acc.tracks.length;
    const view = { tracks, continuation: acc.continuation, limit: acc.limit === undefined ? Infinity : acc.limit + localOnly, duration: total };
    // Lo traído queda guardado con la respuesta de la cuenta (volver a la página es instantáneo).
    afterRender = () => loadRest(view, k, { sub: 'album' }).then(() => { acc.tracks = view.tracks.slice(localOnly); acc.continuation = view.continuation; });
  }
  return collHero({ title: 'Liked Music', thumb: null, thumbHTML: `<div class="lib-th-like" style="width:100%;height:100%">${ic('like-f', 's36')}</div>`, meta: `Auto playlist • ${songs(tracks.length)} • ${fmtLong(total)}`, k })
    + (tracks.length ? `<div class="tracks">${tracks.map((t, i) => rowHTML(t, k, i)).join('')}</div>` : `<div class="empty">Songs you like will show up here.</div>`);
}
async function pageDownloads() {
  setTop(detailBar('Downloads', '', true), 'clear');
  if (!DL.loaded) { DL.loaded = true; await DL.refresh(); }
  const tracks = [...DL.items.values()].map((x) => x.track);
  const busy = Object.keys(DL.active).length;
  const k = reg(tracks, 'Downloads');
  let quota = '';
  try { const e = await navigator.storage?.estimate(); if (e?.quota) quota = ` (${fmtMB(e.quota - e.usage)} free)`; } catch {}
  setTimeout(dlUI);
  return collHero({ title: 'Downloads', thumb: null, thumbHTML: `<div class="lib-th-dl" style="width:100%;height:100%">${ic('dl-done', 's36')}</div>`, meta: `${songs(tracks.length)} • ${fmtMB(DL.bytes)}${busy ? ` • downloading ${busy}…` : ''}`, k })
    + `<div class="storage">Only playable inside Giraffe Music. Audio, artwork and lyrics are kept in the app's private storage${quota}.</div>`
    + (tracks.length ? `<div class="tracks">${tracks.map((t, i) => rowHTML(t, k, i, { sub: 'dur' })).join('')}</div>` : `<div class="empty">${ic('dl')}<h3>No downloads yet</h3>Tap Download on a song, album or playlist to listen without internet.</div>`);
}
async function pageHistory() {
  setTop(detailBar('History'));
  $top.classList.add('solid');
  let list = hist;
  if (me.signedIn) try { list = await api('/api/me/history', 60e3); } catch {}
  return `<h2 class="sec-ttl">Recently played</h2>` + (list.length ? listHTML(list, 'History') : `<div class="empty">Nothing played yet.</div>`);
}

async function pageArtist(id) {
  setTop(detailBar(''), 'clear');
  const a = await api('/api/artist/' + encodeURIComponent(id), 60 * 60e3);
  $top.querySelector('.ttl').textContent = a.name;
  const kTop = reg(a.top, a.name);
  const key = 'artist:' + id;
  const subscribed = !!lib[key];
  const shelf = (title, cards, more = '') => cards?.length ? `<section class="shelf"><div class="sh-hd"><div class="grow"><div class="sh-title">${title}</div></div>${more}</div>${cardsHTML(cards)}</section>` : '';
  const albums = a.albums.filter((c) => !/^single/i.test(c.subtitle)), singles = a.albums.filter((c) => /^single/i.test(c.subtitle));
  return `<div class="top-sentinel" style="position:absolute;top:200px;height:1px;width:1px"></div>
    <div class="a-hero">${a.banner ? `<img src="${esc(a.banner)}" alt="" decoding="async">` : ''}<h1>${esc(a.name)}</h1></div>
    <div class="a-meta">${a.subscribers ? fmtN(a.subscribers) + ' subscribers' : ''}</div>
    <div class="a-btns">
      <button class="pill${subscribed ? '' : ' solid'}" data-act="saveLib" data-key="${esc(key)}" data-kind="artist" data-id="${esc(id)}" data-title="${esc(a.name)}" data-sub="Artist" data-thumb="${esc(a.banner || '')}" data-round="1">${subscribed ? 'Subscribed' : 'Subscribe'}</button>
      <div class="grow"></div>
      <button class="pill" data-act="shuffleList" data-list="${kTop}">${ic('shuffle', 's20')}Shuffle</button>
      <button class="pill" data-act="radioList" data-list="${kTop}">${ic('radio', 's20')}Radio</button>
    </div>
    ${a.top.length ? `<div class="sec-ttl"><span class="grow">Top songs</span>${a.topPlaylist ? `<a class="pill" href="/playlist/${encodeURIComponent(a.topPlaylist)}">Show all</a>` : ''}</div>${a.top.map((t, i) => rowHTML(t, kTop, i, { sub: 'plays' })).join('')}` : ''}
    ${shelf('Albums', albums)}${shelf('Singles', singles)}${shelf('Featured on', a.playlists)}${shelf('Fans might also like', a.similar)}
    ${a.description ? `<div class="sec-ttl">About</div><div class="a-about">${esc(a.description)}</div>` : ''}`;
}

// --- Búsqueda
async function pageSearch(_, my) {
  const sp = new URLSearchParams(location.search);
  const q = sp.get('q') || '', f = sp.get('f') || '', scope = sp.get('s') || '';
  $top.className = 'sbar'; $top.hidden = false;
  $top.innerHTML = L(`<button class="icon-btn" data-act="back" aria-label="Back">${ic('back')}</button><input id="sq" type="search" enterkeyhint="search" autocomplete="off" placeholder="Search songs, artists, albums" value="${esc(q)}"><button class="icon-btn" data-act="clearSearch" aria-label="Clear"${q ? '' : ' hidden'}>${ic('close')}</button><button class="icon-btn" aria-label="Voice">${ic('mic')}</button>`);
  if (addTarget) $top.insertAdjacentHTML('beforeend', L(`<div class="add-banner"><span>${esc(T(`Adding to “${addTarget.title}”`))}</span><button class="pill" data-act="addDone">Done</button></div>`));
  const input = $('#sq');
  let deb = 0;
  input.oninput = () => { clearTimeout(deb); $top.querySelector('[data-act=clearSearch]').hidden = !input.value; deb = setTimeout(() => suggest(input.value), 220); };
  input.onkeydown = (e) => { if (e.key === 'Enter' && input.value.trim()) { input.blur(); doSearch(input.value.trim()); } };
  if (!q) { afterRender = () => { input.focus(); if (me.signedIn) suggest(''); }; return suggestHTML('', []); }
  const tabs = `<div class="s-tabs"><button class="${scope ? '' : 'on'}" data-act="sScope" data-s="">Giraffe Music</button><button class="${scope ? 'on' : ''}" data-act="sScope" data-s="lib">Library</button></div>`;
  if (scope === 'lib') {
    const all = [...new Map([...Object.values(liked), ...Object.values(savedSongs)].map((x) => [x.t.id, x.t]).concat([...DL.items.values()].map((x) => [x.track.id, x.track]))).values()];
    const ql = q.toLowerCase();
    const hits = all.filter((t) => (t.title + ' ' + artists(t)).toLowerCase().includes(ql));
    return tabs + (hits.length ? listHTML(hits, 'Library') : `<div class="empty">No results in your library</div>`);
  }
  const chipsF = [['songs', 'Songs'], ['videos', 'Videos'], ['albums', 'Albums'], ['playlists', 'Featured playlists'], ['artists', 'Artists']];
  const chips = `<div class="chips">${chipsF.map(([k, n]) => `<button class="chip${f === k ? ' on' : ''}" data-act="sFilter" data-f="${f === k ? '' : k}">${n}</button>`).join('')}</div>`;
  const d = await api(`/api/search?q=${encodeURIComponent(q)}${f ? '&filter=' + f : ''}`);
  if (my !== token) return;
  const lst = (title, items, kind) => items?.length ? `<div class="sec-ttl"><span class="grow">${title}</span>${f ? '' : `<button class="pill" data-act="sFilter" data-f="${kind}">Show all</button>`}</div>` : '';
  const cardRows = (cards) => cards.map((c) => `<a class="row${c.round ? ' round' : ''}" href="/${c.kind}/${encodeURIComponent(c.id)}"><div class="th">${thumbImg(c.thumb)}</div><div class="tx"><div class="t1">${esc(c.title)}</div><div class="t2"><span>${esc(c.subtitle)}</span></div></div>${ic('chev')}</a>`).join('');
  let html = tabs + chips;
  if (!f) {
    // Resultado principal: el artista si el nombre coincide, si no la primera canción.
    const art = d.artists?.[0], song = d.songs?.[0];
    const lyr = d.lyrics || [];
    if (lyr.length && !(art && art.title.toLowerCase() === q.toLowerCase())) {
      // La frase está en la letra: esa canción es el resultado principal, con el verso.
      const k = reg(lyr, q, 'radio');
      html += `<div class="sec-ttl">Top result</div>` + lyr.map((t, i) => `<div class="top-res${i ? ' more' : ''}"><div class="row" data-act="row" data-list="${k}" data-i="${i}"><div class="th">${thumbImg(t.thumb, i ? 48 : 64)}</div><div class="tx"><div class="t1">${esc(t.title)}</div><div class="t2">${eb(t)}<span>Song • ${esc(artists(t))}</span></div><div class="lyr-line">${ic('quote', 's16')}<span>“${esc(t.lyricLine)}”</span></div></div></div>${i ? '' : `<div class="btns"><button class="pill solid" data-act="row" data-list="${k}" data-i="0">${ic('play', 's20')}Play</button><button class="pill" data-act="saveT" data-list="${k}" data-i="0">${ic('save', 's20')}Save</button></div>`}</div>`).join('');
    } else if (art && art.title.toLowerCase() === q.toLowerCase()) {
      html += `<div class="sec-ttl">Top result</div><div class="top-res"><a class="row round" href="/artist/${encodeURIComponent(art.id)}"><div class="th">${thumbImg(art.thumb, 64)}</div><div class="tx"><div class="t1">${esc(art.title)}</div><div class="t2"><span>Artist • ${esc(art.subtitle)}</span></div></div></a><div class="btns"><a class="pill solid" href="/artist/${encodeURIComponent(art.id)}">${ic('play', 's20')}Open</a></div></div>`;
    } else if (song) {
      const k = reg([song], q, 'radio');
      html += `<div class="sec-ttl">Top result</div><div class="top-res"><div class="row" data-act="row" data-list="${k}" data-i="0"><div class="th">${thumbImg(song.thumb, 64)}</div><div class="tx"><div class="t1">${esc(song.title)}</div><div class="t2">${eb(song)}<span>Song • ${esc(artists(song))}</span></div></div></div><div class="btns"><button class="pill solid" data-act="row" data-list="${k}" data-i="0">${ic('play', 's20')}Play</button><button class="pill" data-act="saveT" data-list="${k}" data-i="0">${ic('save', 's20')}Save</button></div></div>`;
    }
  }
  if (d.songs?.length) html += lst('Songs', d.songs, 'songs') + listHTML(d.songs, q, { mode: 'radio', sub: 'plays' });
  if (d.videos?.length) html += lst('Videos', d.videos, 'videos') + listHTML(d.videos, q, { mode: 'radio', sub: 'none' });
  if (d.albums?.length) html += lst('Albums', d.albums, 'albums') + cardRows(d.albums);
  if (d.artists?.length) html += lst('Artists', d.artists, 'artists') + cardRows(d.artists);
  if (d.playlists?.length) html += lst('Featured playlists', d.playlists, 'playlists') + cardRows(d.playlists);
  if (html === tabs + chips) html += `<div class="empty">No results for “${esc(q)}”</div>`;
  return html;
}
function suggestHTML(q, list) {
  // Búsquedas pasadas: las de la cuenta (sincronizadas) y las de este teléfono.
  const ql = q.toLowerCase();
  const fromAcc = list.filter((x) => x.history);
  const seen = new Set(fromAcc.map((x) => x.text.toLowerCase()));
  const local = searches.filter((s) => (!q || s.toLowerCase().startsWith(ql)) && !seen.has(s.toLowerCase())).slice(0, q ? 3 : 10).map((text) => ({ text, history: true }));
  const hist = [...fromAcc, ...local];
  const hs = new Set(hist.map((x) => x.text.toLowerCase()));
  const items = [...hist, ...list.filter((x) => !x.history && !hs.has(x.text.toLowerCase()))];
  const bold = (s) => q && s.toLowerCase().startsWith(ql) ? esc(s.slice(0, q.length)) + '<b>' + esc(s.slice(q.length)) + '</b>' : esc(s);
  return `<div id="sugg">${items.map((x) => `<div class="sugg" data-act="sugg" data-q="${esc(x.text)}"${x.history ? ` data-hist="1" data-forget="${esc(x.forget || '')}"` : ''}>${ic(x.history ? 'history' : 'search')}<div class="grow">${bold(x.text)}</div><button class="icon-btn" data-act="fill" data-q="${esc(x.text)}">${ic('nw')}</button></div>`).join('')}</div>`;
}
async function suggest(q) {
  if (location.search.includes('q=')) {
    history.replaceState(history.state, '', '/search');
    rendered = '/search';
  }
  let list = [];
  if (q.trim() || me.signedIn) try { list = await (await fetch('/api/suggest?q=' + encodeURIComponent(q.trim()))).json(); } catch {}
  if (!Array.isArray(list)) list = [];
  if ($('#sq')?.value !== q) return;
  $page.innerHTML = L(suggestHTML(q, list));
}
function doSearch(q) {
  searches = [q, ...searches.filter((s) => s !== q)].slice(0, 20);
  store.set('searches', searches);
  history.replaceState({ ov: [], y: 0 }, '', '/search?q=' + encodeURIComponent(q));
  render();
}

// --- Editar una playlist tuya: nombre, descripción y visibilidad, en tu cuenta de YouTube.
/** Una playlist del teléfono: se ve igual que las de la cuenta. */
function pageLocalPlaylist(id) {
  const p = localPl(id);
  if (!p) return `<div class="empty"><h3>Nothing here yet</h3></div>`;
  $top.querySelector('.ttl').textContent = p.title;
  if (location.pathname.endsWith('/edit')) return editHTML(id, { title: p.title, description: p.description, thumb: p.tracks[0]?.thumb, local: true });
  const k = reg(p.tracks, p.title);
  LISTS.get(k).playlistId = id;
  const dur = p.tracks.reduce((s, t) => s + (t.duration || 0), 0);
  const save = `<a class="round-btn" href="/playlist/${encodeURIComponent(id)}/edit" aria-label="Edit">${ic('edit')}</a>`;
  setTimeout(dlUI);
  return collHero({ title: p.title, thumb: p.tracks[0]?.thumb, meta: `${T('Saved on this device')} • ${songs(p.tracks.length)}${dur ? ' • ' + fmtLong(dur) : ''}`, desc: p.description, k, save })
    + addRow(id, p.title) + (p.tracks.length ? `<div class="tracks">${p.tracks.map((t, i) => rowHTML(t, k, i, { sub: 'album' })).join('')}</div>` : `<div class="empty">${T('Songs you like or save show up here.')}</div>`);
}
function editHTML(id, c) {
  setTop(`<button class="icon-btn" data-act="back" aria-label="Back">${ic('back')}</button><div class="grow"></div><button class="done-btn" data-act="edSave">Done</button>`);
  $top.className = 'topbar solid';
  afterRender = () => {
    for (const [inp, cnt, max] of [['#edTitle', '#edTitleN', 150], ['#edDesc', '#edDescN', 5000]]) {
      const i = $(inp), n = $(cnt);
      const upd = () => (n.textContent = `${i.value.length}/${max}`);
      i.oninput = upd; upd();
    }
  };
  return `<div id="edForm" data-id="${esc(id)}"><div class="ed-cover">${thumbImg(c.thumb, 200)}</div><div class="ed">
    <div class="ed-f"><label>Title</label><input id="edTitle" maxlength="150" value="${esc(c.title)}"><div class="cnt" id="edTitleN"></div></div>
    <div class="ed-f"><label>Description (optional)</label><textarea id="edDesc" rows="1" maxlength="5000">${esc(c.description || '')}</textarea><div class="cnt" id="edDescN"></div></div>
    ${c.local ? `<div class="ed-row" data-act="delLocalPl" data-id="${esc(id)}">${ic('delete')}<span>Delete playlist</span></div>` : ''}<div class="ed-row"${c.local ? ' hidden' : ''}>${ic('globe')}<select id="edPrivacy"><option value="">Keep current visibility</option><option value="PUBLIC">Public</option><option value="UNLISTED">Unlisted</option><option value="PRIVATE">Private</option></select>${ic('down')}</div>
  </div></div>`;
}

// --- Menú de la cuenta (la foto de arriba a la derecha), como en YouTube Music.
async function pageAccount() {
  setTop(`<button class="icon-btn" data-act="back" aria-label="Close">${ic('close')}</button><div class="grow" style="font-size:22px;font-weight:500;padding-left:12px">Account</div>`);
  $top.classList.add('solid');
  refreshAccount();
  const ph = me.photo ? `<img src="${esc(me.photo)}" alt="">` : esc((me.name || 'G')[0]);
  const head = me.signedIn
    ? `<a class="acc-head" href="/settings"><div class="ph">${ph}</div><div class="tx">${esc(me.name || 'YouTube account')}${me.handle ? `<br>${esc(me.handle)}` : ''}</div>${ic('chev')}</a>
       <a class="acc-link" href="#" data-act="openUrl" data-url="https://myaccount.google.com/">Manage your Google Account</a>`
    : `<div class="acc-head"><div class="ph">G</div><div class="tx">Not signed in</div><button class="gbtn" data-act="login">${ic('google')}Sign in</button></div><div style="height:20px"></div>`;
  const item = (icn, label, attrs) => `<a class="acc-item" ${attrs}>${ic(icn)}${label}</a>`;
  const channel = me.handle ? `https://www.youtube.com/${me.handle}` : 'https://www.youtube.com/channel';
  return head + '<div class="acc-div"></div><div style="padding:12px 0">'
    + (me.signedIn ? item('channel', 'Your channel', `href="#" data-act="openUrl" data-url="${esc(channel)}"`) : '')
    + item('download', 'Downloads', 'href="/downloads"')
    + item('history', 'History', 'href="/history"')
    + item('settings', 'Settings', 'href="/settings"')
    + item('help', 'Help & feedback', 'href="#" data-act="openUrl" data-url="https://github.com/grapedjuice/ytm-rs/issues"')
    + `</div><div class="acc-foot"><a href="#" data-act="openUrl" data-url="https://policies.google.com/privacy">Privacy Policy</a> &nbsp;•&nbsp; <a href="#" data-act="openUrl" data-url="https://www.youtube.com/t/terms">Terms of Service</a><br><br>Giraffe Music · no ads, ever</div>`;
}

// --- Configuración: categorías, como la de YouTube Music.
let audioTools = null;
async function pageSettings(section) {
  const TITLES = { general: 'General', playback: 'Playback & restrictions', data: 'Data saving', downloads: 'Downloads & storage', privacy: 'Privacy & data', transfer: 'Transfer from Spotify', about: 'About' };
  setTop(detailBar(TITLES[section] || 'Settings'));
  $top.classList.add('solid');
  const sw = (k, t1, t2) => `<div class="set-row" data-act="setting" data-k="${k}"><div class="tx"><div class="t1">${t1}</div><div class="t2">${t2}</div></div><div class="switch${settings[k] ? ' on' : ''}"></div></div>`;
  const row = (t1, t2, attrs) => `<div class="set-row" ${attrs}><div class="tx"><div class="t1">${t1}</div>${t2 ? `<div class="t2">${t2}</div>` : ''}</div></div>`;
  if (!section) {
    const acct = me.signedIn
      ? `<div class="acct"><div class="ph">${me.photo ? `<img src="${esc(me.photo)}" alt="">` : esc((me.name || 'G')[0])}</div><div class="tx"><div class="t1">${esc(me.name || 'YouTube account')}</div><div class="t2"><span>${esc(me.handle || 'Signed in with Google')}</span></div></div><button class="pill" data-act="logout">${ic('logout', 's20')}Sign out</button></div>`
      : signinCard('Get your playlists, likes, history and recommendations from YouTube Music.');
    const link = (k, t2) => `<a class="set-row" href="/settings/${k}"><div class="tx"><div class="t1">${TITLES[k]}</div>${t2 ? `<div class="t2">${t2}</div>` : ''}</div></a>`;
    return acct + '<div style="height:8px"></div>'
      + link('general') + link('playback') + link('data') + link('downloads') + link('privacy')
      + link('transfer', 'Copy your Spotify playlists to YouTube Music') + link('about');
  }
  if (section === 'general') {
    const LN = { auto: 'System default', en: 'English', es: 'Español' };
    return row('Language', T(LN[settings.lang] || LN.auto), 'data-act="langMenu"')
      + sw('squareThumbs', 'Square thumbnails', 'Show every thumbnail in lists as a square, videos too');
  }
  if (section === 'playback') {
    if (NATIVE && !audioTools) try { audioTools = JSON.parse(NATIVE.audioTools()); } catch { audioTools = {}; }
    const t = audioTools || {};
    return sw('autoplay', 'Autoplay', 'Keep playing similar songs when your queue ends')
      + sw('normalize', 'Normalize volume', 'Set the same volume level for all songs')
      + sw('skipNonMusic', 'Skip non-music parts', 'Skip talking and sponsor breaks in music videos (SponsorBlock)')
      + sw('resumeHeadphones', 'Resume with headphones', 'Keep playing when you connect Bluetooth or wired headphones (up to 30 min after pausing)')
      + sw('swipeArt', 'Swipe to change songs', 'Swipe the artwork left or right in the player to skip or go back')
      + (t.eq ? row('Equalizer', "Adjust the sound with your phone's equalizer. Sound effects use a bit more battery.", 'data-act="openEq"') : '')
      + (t.dolby ? row('Dolby Atmos', "Open your phone's Dolby Atmos settings", 'data-act="openDolby"') : '');
  }
  if (section === 'data') {
    const Q = { low: 'Low', normal: 'Auto', high: 'High' };
    return sw('dataSaver', 'Data saver', 'Smaller artwork and no music videos')
      + row('Audio quality on mobile network', T(Q[settings.qMobile] || 'Auto'), 'data-act="quality"')
      + row('Audio quality on Wi-Fi', 'Always high', '')
      + sw('wifiOnlyDl', 'Download over Wi-Fi only', 'Downloads wait for Wi-Fi so they don\'t use your mobile data');
  }
  if (section === 'downloads') {
    await DL.refresh();
    let quota = '';
    try { const e = await navigator.storage?.estimate(); if (e?.quota) quota = `${fmtMB(e.quota - e.usage)} free on this device`; } catch {}
    return row(`${songs(DL.items.size)} • ${fmtMB(DL.bytes)}`, 'Audio, artwork and lyrics. Only playable in Giraffe Music.', '')
      + (quota ? row('Storage', quota, '') : '')
      + `<div class="set-row" data-act="clearDownloads"><div class="tx"><div class="t1">Delete all downloads</div></div>${ic('delete')}</div>`;
  }
  if (section === 'privacy') {
    return row('Clear listening history', me.signedIn ? 'On this device. Your YouTube history stays in your account.' : 'On this device', 'data-act="clearHistory"')
      + row('Clear search history', me.signedIn ? 'On this device. Long-press a past search to remove it from your account.' : 'On this device', 'data-act="clearSearches"')
      + row('Search history', me.signedIn ? 'Synced with your YouTube Music account' : 'Sign in to sync your searches with YouTube Music', '');
  }
  if (section === 'transfer') { afterRender = () => watchTransfer(); return transferHTML(); }
  let st = {};
  try { st = await api('/api/status', 0); } catch {}
  const uiNow = settings.ui === 'old' ? 'old' : 'new';
  return row(`Giraffe Music ${esc(st.version || '')}${st.demo ? ' (demo)' : ''}`, 'No ads, ever. Built on the ytm-rs core (GPL-3.0).', '')
    + `<div class="srow ui-pick"><div class="grow"><div class="t1">Interface</div><div class="t2">${T(uiNow === 'new' ? 'New: like the latest YouTube Music' : 'Old: the classic Giraffe Music')}</div></div><div class="tg-role"><button class="${uiNow === 'old' ? 'on' : ''}" data-act="setUi" data-v="old">${T('Old')}</button><button class="${uiNow === 'new' ? 'on' : ''}" data-act="setUi" data-v="new">${T('New')}</button></div></div>`
    + row('Battery', NATIVE ? 'Native player with audio offload, a 256 MB audio cache and nothing running in the background.' : 'Web player', '')
    + (NATIVE ? row('Check for updates', `Version ${esc(NATIVE.appVersion?.() || '')}`, 'data-act="checkUpdate"') : '')
    + row('Source code', 'github.com/grapedjuice/ytm-rs', 'data-act="openUrl" data-url="https://github.com/grapedjuice/ytm-rs"');
}

// --- Transferir de Spotify
function transferHTML() {
  if (!me.signedIn) return signinCard('Sign in so Giraffe can create the playlist in your YouTube Music library.');
  return `<div class="xfer"><div class="t2" style="white-space:normal">Paste a public Spotify playlist link. Giraffe finds each song on YouTube Music and saves them as a new private playlist in your library.</div>
    <input id="xferLink" type="url" inputmode="url" placeholder="https://open.spotify.com/playlist/…" autocomplete="off">
    <button class="pill solid" data-act="startTransfer" style="justify-content:center;height:40px">${ic('spotify', 's20')}Transfer</button>
    <div id="xferState"></div></div>`;
}
let xferTimer = 0;
async function watchTransfer() {
  clearTimeout(xferTimer);
  const box = $('#xferState');
  if (!box) return;
  let st;
  try { st = await (await fetch('/api/transfer')).json(); } catch { return; }
  if (!$('#xferState')) return;
  const running = ['reading', 'matching', 'creating'].includes(st.phase);
  const pct = st.total ? st.done / st.total : 0;
  const label = { reading: 'Reading the Spotify playlist…', matching: `Finding songs on YouTube Music… ${st.done} of ${st.total}`, creating: 'Creating your playlist…', done: `${st.found} of ${st.total} songs saved to “${esc(st.name)}”`, error: esc(st.error || 'Something went wrong') }[st.phase] || '';
  box.innerHTML = st.phase === 'idle' ? '' : L(`<div class="t1" style="font-size:15px">${label}</div>${running || st.phase === 'done' ? `<div class="bar"><i style="transform:scaleX(${st.phase === 'done' ? 1 : pct})"></i></div>` : ''}
    ${st.phase === 'done' && st.playlist ? `<a class="pill" href="/playlist/${encodeURIComponent(st.playlist)}" style="justify-content:center;margin-top:12px">Open playlist</a>` : ''}
    ${st.missing?.length ? `<div class="miss"><br>Not found (${st.missing.length}):<br>${st.missing.map(esc).join('<br>')}</div>` : ''}`);
  if (st.phase === 'done') mem.delete('/api/me/library');
  // Solo se consulta mientras dura la importación y esta pantalla está abierta.
  if (running) { xferTimer = setTimeout(watchTransfer, 1000); cleanup = () => clearTimeout(xferTimer); }
}

// ------------------------------------------------------------------ hoja: letras y relacionados
let sheetTab = null, lyr = null, lyrIdx = -1;
async function openSheet(tabName, refresh) {
  const t = cur();
  if (!t) return;
  if (!refresh) { if (OV.includes('sheet')) { history.replaceState({ ...history.state, ov: OV }, ''); } else pushOv('sheet'); }
  sheetTab = tabName;
  $('#shName').textContent = T(tabName === 'lyrics' ? 'Lyrics' : 'Related');
  const body = $('#shBody');
  $('#shareFab').hidden = true;
  body.innerHTML = loadingHTML();
  body.scrollTop = 0;
  if (tabName === 'lyrics') {
    try {
      lyr = await api(`/api/lyrics?id=${encodeURIComponent(t.id)}&title=${encodeURIComponent(t.title)}&artist=${encodeURIComponent(t.artists?.[0]?.name || '')}&album=${encodeURIComponent(t.album?.name || '')}${t.duration ? '&duration=' + t.duration : ''}`, 864e5);
    } catch { lyr = {}; }
    if (cur() !== t || sheetTab !== 'lyrics') return;
    lyrIdx = -1;
    $('#lyrScript').hidden = !hasScript(lyr.synced || lyr.plain || '');
    if (lyr.synced) {
      const lines = parseLrc(lyr.synced);
      lyr.lines = lines;
      body.innerHTML = `<div class="lyrics synced"><p class="gap">♪</p>${lines.map((l, i) => `<p data-i="${i}" data-act="lyrSeek"${l.text ? '' : ' class="gap"'}>${esc(l.text || '♪')}${romanLine(l.text)}</p>`).join('')}<div class="src">${T('Lyrics from LRCLIB')}</div></div>`;
      tick();
    } else if (lyr.plain) {
      body.innerHTML = `<div class="lyrics">${lyr.plain.split('\n').map((l) => `<p>${esc(l) || '&nbsp;'}${romanLine(l)}</p>`).join('')}<div class="src">${T('Lyrics from LRCLIB')}</div></div>`;
    } else {
      body.innerHTML = L(`<div class="empty"><h3>Lyrics aren't available</h3><span>We couldn't find lyrics for this song.</span></div>`);
    }
    $('#shareFab').hidden = !(lyr.synced || lyr.plain);
  } else {
    const k = 'rel';
    let radio = [], artist = null;
    try {
      [radio, artist] = await Promise.all([
        api('/api/radio/' + encodeURIComponent(t.id), 10 * 60e3).catch(() => []),
        t.artists?.[0]?.id ? api('/api/artist/' + encodeURIComponent(t.artists[0].id), 60 * 60e3).catch(() => null) : null,
      ]);
    } catch {}
    if (cur() !== t || sheetTab !== 'related') return;
    const like = radio.slice(0, 8);
    const kk = reg(like, 'You might also like', 'radio');
    body.innerHTML = L((like.length ? `<div class="sec-ttl">You might also like</div>${like.map((x, i) => rowHTML(x, kk, i, { sub: 'none' })).join('')}` : '')
      + (artist?.similar?.length ? `<div class="sec-ttl">Similar artists</div><div class="rel-art">${artist.similar.map((c, i) => cardHTML(c, k, i)).join('')}</div>` : '')
      + (artist?.albums?.length ? `<div class="sec-ttl" style="flex-direction:column;align-items:flex-start"><span class="strap">More from</span>${esc(artist.name)}</div>${cardsHTML(artist.albums)}` : '')
      || `<div class="empty">Nothing related found.</div>`);
  }
}
function parseLrc(text) {
  const out = [];
  for (const line of text.split('\n')) {
    const tags = [...line.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)];
    if (!tags.length) continue;
    const txt = line.replace(/\[[^\]]*\]/g, '').trim();
    for (const m of tags) out.push({ t: +m[1] * 60 + +m[2], text: txt });
  }
  return out.sort((a, b) => a.t - b.t);
}
function lyricsTick(pos) {
  const lines = lyr.lines;
  if (!lines?.length) return;
  let i = lyrIdx;
  if (i < 0 || lines[i].t > pos) i = -1;
  while (i + 1 < lines.length && lines[i + 1].t <= pos + 0.15) i++;
  if (i === lyrIdx) return;
  $(`#shBody p[data-i="${lyrIdx}"]`)?.classList.remove('on');
  lyrIdx = i;
  const p = $(`#shBody p[data-i="${i}"]`);
  if (p) { p.classList.add('on'); centerIn($('#shBody'), p, true); }
}

/** Centra `el` dentro de la lista `box` moviendo solo esa lista. (scrollIntoView también
 *  movería el reproductor, que no se desplaza, y lo dejaría corrido.) */
function centerIn(box, el, smooth) {
  if (!box || !el) return;
  const top = el.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop;
  box.scrollTo({ top: top - box.clientHeight / 2 + el.offsetHeight / 2, behavior: smooth ? 'smooth' : 'auto' });
}

// ------------------------------------------------------------------ letras: cómo se pronuncian
// Ruso (cirílico) y japonés en kana a letras latinas, en el teléfono, sin internet.
// (Los kanji quedan como están: para eso hace falta un diccionario.)
const CYR = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'yo', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'shch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya', і: 'i', ї: 'yi', є: 'ye', ґ: 'g', ў: 'w' };
const KANA = (() => {
  const m = {}, rows = 'a i u e o|ka ki ku ke ko|sa shi su se so|ta chi tsu te to|na ni nu ne no|ha hi fu he ho|ma mi mu me mo|ya  yu  yo|ra ri ru re ro|wa   wo|ga gi gu ge go|za ji zu ze zo|da ji zu de do|ba bi bu be bo|pa pi pu pe po';
  const hira = 'あいうえお|かきくけこ|さしすせそ|たちつてと|なにぬねの|はひふへほ|まみむめも|や ゆ よ|らりるれろ|わ   を|がぎぐげご|ざじずぜぞ|だぢづでど|ばびぶべぼ|ぱぴぷぺぽ';
  const r = rows.split('|'), h = hira.split('|');
  r.forEach((row, i) => { const syl = row.split(' '); [...h[i]].forEach((ch, j) => { if (ch !== ' ' && syl[j]) { m[ch] = syl[j]; m[String.fromCharCode(ch.charCodeAt(0) + 96)] = syl[j]; } }); });
  Object.assign(m, { ん: 'n', ン: 'n', ー: '-', 'ァ': 'a', 'ィ': 'i', 'ゥ': 'u', 'ェ': 'e', 'ォ': 'o', 'ぁ': 'a', 'ぃ': 'i', 'ぅ': 'u', 'ぇ': 'e', 'ぉ': 'o', ゃ: 'ya', ゅ: 'yu', ょ: 'yo', ャ: 'ya', ュ: 'yu', ョ: 'yo', ヴ: 'vu', '　': ' ', '、': ', ', '。': '. ' });
  return m;
})();
const hasScript = (s) => /[\u0400-\u04ff\u3040-\u30ff]/.test(s);
function romanize(s) {
  let out = '';
  const ch = [...s];
  for (let i = 0; i < ch.length; i++) {
    const c = ch[i], lo = c.toLowerCase();
    if (CYR[lo] !== undefined) { const r = CYR[lo]; out += c !== lo && r ? r[0].toUpperCase() + r.slice(1) : r; continue; }
    if (c === 'っ' || c === 'ッ') { const n = KANA[ch[i + 1]]; if (n) out += n[0]; continue; }
    const small = { ゃ: 1, ゅ: 1, ょ: 1, ャ: 1, ュ: 1, ョ: 1 };
    if (KANA[c] && small[ch[i + 1]]) { const base = KANA[c]; out += (base.endsWith('i') ? base.slice(0, -1) : base) + KANA[ch[i + 1]].replace(/^y/, base.length > 2 ? '' : 'y'); i++; continue; }
    out += KANA[c] ?? c;
  }
  return out;
}
const romanLine = (t) => settings.lyrRoman && t && hasScript(t) ? `<span class="rom">${esc(romanize(t))}</span>` : '';

// ------------------------------------------------------------------ escuchar juntos (mismo Wi-Fi)
// El núcleo hace la parte de red (ver together.rs). Acá: la ventana, la barra verde y aplicar
// lo que suena. Una sola consulta en espera mientras hay sesión y la pantalla está prendida.
const TG = {
  mode: 'off', v: 0, count: 1, max: 4, code: '', bar: false, tab: 'create', view: '', polling: false, last: null, control: false, members: [],
  async init() {
    try { this.apply(await (await fetch('/api/together?since=999999999')).json()); } catch {}
  },
  /** Invitado: los controles van al anfitrión (true = ya se mandó, no hacer nada local). */
  send(cmd) {
    if (this.mode !== 'guest' || this.applying) return false;
    // Invitado: solo escucha (el anfitrión puede darle permiso desde la barra verde).
    if (!this.control) { toast('Only the host can change the music'); return true; }
    fetch('/api/together/cmd', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(cmd) }).catch(() => {});
    return true;
  },
  /** Anfitrión: cuenta qué suena (solo si cambió algo de verdad). */
  publish() {
    if (this.mode !== 'host' || !cur()) return;
    const pos = P.eng.pos().pos, t = cur(), l = this.last;
    const expect = l ? l.pos + (l.playing ? (Date.now() - l.at) / 1000 : 0) : 0;
    if (l && l.id === t.id && l.playing === P.playing && Math.abs(expect - pos) < 1.5 && l.n === P.queue.length) return;
    this.last = { id: t.id, playing: P.playing, pos, at: Date.now(), n: P.queue.length };
    const body = { track: t, upcoming: P.queue.slice(P.i + 1, P.i + 11), from: P.from, playing: P.playing, pos };
    fetch('/api/together/state', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).catch(() => {});
  },
  /** Lo que llega del núcleo: cambios de sesión, personas, pedidos o lo que suena. */
  apply(s) {
    if (!s || !s.mode) return;
    const was = this.mode;
    const hadControl = this.control;
    this.mode = s.mode; this.v = s.v || 0; this.count = s.count || 1; this.max = s.max || 4; this.code = s.code || '';
    this.members = s.members || []; this.control = !!s.control;
    if (s.mode === 'guest' && was === 'guest' && hadControl !== this.control) toast(this.control ? 'You can now change the music' : 'Only the host can change the music');
    if (s.mode === 'guest' && s.ended) { this.mode = 'off'; toast('Session ended'); fetch('/api/together/leave', { method: 'POST' }).catch(() => {}); }
    if (s.mode === 'host') for (const c of s.cmds || []) this.run(c);
    if (s.mode === 'guest' && s.state?.track) this.follow(s.state);
    if (was === 'off' && this.mode === 'host') { this.last = null; this.publish(); }
    this.barUI();
    // Sesión creada pero nadie se unió: se cierra sola a los 10 minutos.
    clearTimeout(this.idleT);
    if (this.mode === 'host' && this.count < 2) this.idleT = setTimeout(() => { if (this.mode === 'host' && this.count < 2) this.leave(); }, 10 * 60e3);
    if (OV.includes('menu') && $('#tgDlg')) this.render();
    if (this.mode !== 'off') this.poll();
  },
  /** Una sola consulta en espera a la vez (nunca dos: se acumularían y dejaría de llegar todo). */
  async poll() {
    if (this.polling || this.mode === 'off' || document.hidden) return;
    this.polling = true;
    while (this.mode !== 'off' && !document.hidden) {
      try {
        const r = await fetch('/api/together?since=' + this.v);
        this.apply(await r.json());
      } catch { await new Promise((ok) => setTimeout(ok, 2000)); }
    }
    this.polling = false;
  },
  /** Anfitrión: hace lo que pidió un invitado. */
  run(c) {
    if (c.kind === 'play') P.eng.play();
    else if (c.kind === 'pause') P.eng.pause();
    else if (c.kind === 'next') P.next();
    else if (c.kind === 'prev') P.prev();
    else if (c.kind === 'seek') P.eng.seek(+c.pos || 0);
    else if (c.kind === 'playTracks' && c.tracks?.length) P.play(c.tracks, 0, c.from || '');
    setTimeout(() => this.publish(), 400);
  },
  /** Invitado: sonar igual que el anfitrión (canción, segundo, pausa). */
  follow(st) {
    this.applying = true;
    try {
      const t = st.track, pos = +st.pos || 0;
      if (cur()?.id !== t.id) {
        P.queue = [t, ...(st.upcoming || [])]; P.i = 0; P.from = st.from || T('Listen together');
        P.eng.setQueue(P.queue, 0, Math.round(pos * 1000), !!st.playing);
        P.changed(true);
      } else {
        if (!!st.playing !== P.playing) st.playing ? P.eng.play() : P.eng.pause();
        if (Math.abs(P.eng.pos().pos - pos) > 2) P.eng.seek(pos);
        const up = st.upcoming || [];
        if (up.map((x) => x.id).join() !== P.queue.slice(P.i + 1).map((x) => x.id).join()) { P.queue = P.queue.slice(0, P.i + 1).concat(up); P.eng.replaceUpcoming(up); queueUI(); }
      }
    } finally { this.applying = false; }
  },
  barUI() {
    const on = this.mode !== 'off' && this.count > 1;
    let b = $('#tgBar');
    if (on && !b) { document.body.insertAdjacentHTML('beforeend', '<div id="tgBar" data-act="together"></div>'); b = $('#tgBar'); }
    if (b) { b.hidden = !on; if (on) b.textContent = T(`Connected · ${this.count} of ${this.max}`); }
    if (on !== this.bar) { this.bar = on; document.body.classList.toggle('tg-on', on); if (setInsets.top) setInsets(setInsets.top, parseInt(getComputedStyle(document.documentElement).getPropertyValue('--nb')) || 0); }
  },
  /** Abre la ventana (o cambia de pestaña si ya está abierta: no se apila otra encima). */
  async open(tab) {
    if (tab) this.tab = tab;
    // En una sesión, el anfitrión ve primero a las personas conectadas y sus permisos.
    this.view = !tab && this.mode === 'host' && this.count > 1 ? 'people' : '';
    if (this.view !== 'people' && this.tab === 'create' && this.mode === 'off') {
      if (NATIVE && NATIVE.onWifi && !NATIVE.onWifi()) { this.tab = 'join'; toast('Connect to Wi-Fi to listen together'); }
      else {
        try {
          const r = await fetch('/api/together/host', { method: 'POST' });
          const s = await r.json();
          if (!r.ok) throw new Error(s.error);
          this.apply(s);
        } catch { toast('Connect to Wi-Fi to listen together'); this.tab = 'join'; }
      }
    }
    this.render(true);
  },
  html() {
    const status = this.mode !== 'off' && this.count > 1 ? `<div class="tg-status">${T(`Connected · ${this.count} of ${this.max}`)}</div>` : '';
    if (this.view === 'people' && this.mode === 'host') {
      const row = (name, you, m) => `<div class="tg-person"><div class="tg-av">${esc((name || '?').replace('#', '')[0] || '?')}</div><div class="grow"><div class="t1">${esc(name)}</div>${you ? `<div class="t2">${T('You')}</div>` : ''}</div>
        ${m ? `<div class="tg-role"><button class="${m.control ? 'on' : ''}" data-act="tgRole" data-m="${esc(m.id)}" data-c="1">${T('Host')}</button><button class="${m.control ? '' : 'on'}" data-act="tgRole" data-m="${esc(m.id)}" data-c="0">${T('Guest')}</button></div>` : `<div class="tg-role fixed">${T('Host')}</div>`}</div>`;
      return `<div id="tgDlg"><h2>Listen together</h2>${status}
        <div class="t2 tg-hint" style="text-align:left">${T('Hosts can change the music. Guests can only listen.')}</div>
        <div class="tg-people">${row(me.name || T('You'), !!me.name)}${this.members.map((m) => row(m.name.startsWith('#') ? `${T('Person')} ${m.name.slice(1)}` : m.name, false, m)).join('')}</div>
        <button class="tg-scan" data-act="tgTab" data-tab="create">${ic('qr-scan')}<span>${T('Show code')}</span></button>
        <div class="dlg-btns"><button class="ghost" data-act="tgLeave">End session</button><button class="ok" data-act="dlgCancel">Done</button></div></div>`;
    }
    const inSession = this.mode !== 'off' && (this.mode === 'guest' || this.count > 1);
    const seg = this.mode === 'host' && this.count > 1 ? '' : `<div class="tg-seg"><button class="${this.tab === 'create' ? 'on' : ''}" data-act="tgTab" data-tab="create">Create</button><button class="${this.tab === 'join' ? 'on' : ''}" data-act="tgTab" data-tab="join">Join</button></div>`;
    let body;
    if (this.mode === 'guest') {
      body = `${status}<div class="tg-code big">${esc(this.code)}</div><div class="t2 tg-hint">${T(this.control ? 'The host let you change the music.' : 'You are listening along. Only the host can change the music.')}</div>
        <div class="dlg-btns"><button class="ghost" data-act="dlgCancel">Close</button><button class="ok" data-act="tgLeave">Leave</button></div>`;
    } else if (this.tab === 'create' && this.mode === 'host') {
      body = `${status}<div class="tg-qr"><img src="/api/together/qr.svg?c=${encodeURIComponent(this.code)}" alt=""></div><div class="tg-code">${esc(this.code)}</div>
        <div class="t2 tg-hint">${T('Share this code or QR with up to 3 people on your Wi-Fi')}</div>
        <div class="dlg-btns"><button class="ghost" data-act="tgLeave">End session</button><button class="ok" data-act="${this.count > 1 ? 'tgPeople' : 'dlgCancel'}">${this.count > 1 ? T('Back') : T('Done')}</button></div>`;
    } else {
      body = `<button class="tg-scan" data-act="tgScan">${ic('qr-scan')}<span>${T('Scan QR code')}</span></button>
        <div class="field"><label>${T('Enter code')}</label><input id="tgCode" maxlength="9" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="ABCD-EFGH"></div>
        <div class="t2 tg-hint">${T('Ask for the code of the person who created the session')}</div>
        <div class="dlg-btns"><button class="ghost" data-act="dlgCancel">Cancel</button><button class="ok" data-act="tgJoin" id="tgJoinBtn" disabled>Join</button></div>`;
    }
    return `<div id="tgDlg"><h2>Listen together</h2>${inSession && this.mode === 'guest' ? '' : seg}${body}</div>`;
  },
  /** Dibuja la ventana: si ya está abierta se reemplaza su contenido (sin otra entrada en "atrás"). */
  render(show) {
    const open = OV.includes('menu') && $('#tgDlg');
    if (!open && !show) return;
    const typed = $('#tgCode')?.value || '';
    if (open) $('#menu').innerHTML = L(this.html());
    else openDialog(this.html());
    const inp = $('#tgCode');
    if (inp && typed) inp.value = typed;
    if (inp) inp.oninput = () => { const v = inp.value.toUpperCase().replace(/[^0-9A-Z]/g, ''); inp.value = v.length > 4 ? v.slice(0, 4) + '-' + v.slice(4, 8) : v; $('#tgJoinBtn').disabled = v.length !== 8; };
  },
  async join(code, host) {
    toast('Joining…');
    try {
      const r = await fetch('/api/together/join', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, host, name: me.signedIn ? me.name || '' : '' }) });
      const s = await r.json();
      if (!r.ok) throw new Error(s.error);
      if (OV.includes('menu')) popOv();
      this.apply(s);
      toast(T(`Connected · ${this.count} of ${this.max}`));
    } catch (e) {
      toast(e.message === 'full' ? 'This session is full' : "Couldn't join. Check the code and that you're on the same Wi-Fi");
    }
  },
  onQr(m) {
    if (m.cancel) return;
    const g = /^GIRAFFE:([0-9A-Z]{8})@([\d.]+:\d+)$/.exec(m.text || '');
    if (!g) return toast(m.error ? "Couldn't open the camera. Type the code instead" : 'This QR is not from Giraffe Music');
    this.join(g[1], g[2]);
  },
  async leave() {
    const was = this.mode;
    await fetch('/api/together/leave', { method: 'POST' }).catch(() => {});
    this.mode = 'off'; this.count = 1; this.barUI();
    if (OV.includes('menu')) popOv();
    toast(was === 'host' ? 'Session ended' : 'You left the session');
  },
};
document.addEventListener('visibilitychange', () => { if (!document.hidden && TG.mode !== 'off') TG.poll(); });

// ------------------------------------------------------------------ novedades (después de actualizar)
// Una tarjeta por novedad, contadas como para cualquier persona. Se ven una sola vez.
const CHANGES = {
  '0.5.0': [
    ['spark', 'A fresh new look', 'Una interfaz nueva',
      'Giraffe looks like the latest YouTube Music: big covers, a floating mini player and roomier lists. Prefer the classic one? Settings → About → Interface.',
      'Giraffe se ve como el último YouTube Music: carátulas grandes, mini reproductor flotante y listas más amplias. ¿Preferís la clásica? Configuración → Información → Interfaz.'],
    ['search', 'Search inside a playlist', 'Busca dentro de una playlist',
      'Tap the magnifier in a playlist or album to find a song in it. Not there? Search everywhere with one tap.',
      'Toca la lupa dentro de una playlist o álbum para encontrar una canción. ¿No está? Búscala en todos lados con un toque.'],
    ['quote', 'Jump to a lyric', 'Salta a una parte de la letra',
      'Tap any line of the lyrics and the song jumps right there.',
      'Toca cualquier verso de la letra y la canción salta justo ahí.'],
    ['add', 'Add songs to your playlists', 'Agrega canciones a tus playlists',
      'Use “Add” at the top of your playlists to search and add songs without leaving.',
      'Usa “Agregar” arriba de tus playlists para buscar y sumar canciones sin salir.'],
  ],
  '0.4.0': [
    ['person-add', 'Listen together', 'Escuchar juntos',
      'Tap the person icon in Library and listen to the same music at the same time with up to 3 friends on your Wi-Fi.',
      'Toca el ícono de la persona en Biblioteca y escuchen la misma música al mismo tiempo, hasta 4 personas en el mismo Wi-Fi.'],
    ['quote', 'Search by lyrics', 'Busca por la letra',
      'Remember a line but not the name? Type a piece of the lyrics and the song shows up.',
      '¿Te acuerdas de una frase pero no del nombre? Escribe un pedazo de la letra y aparece la canción.'],
    ['globe', 'Giraffe in your language', 'Giraffe en tu idioma',
      'Giraffe now speaks Spanish. Change it anytime in Settings → General → Language.',
      'Giraffe ahora habla español. Cámbialo cuando quieras en Configuración → General → Idioma.'],
    ['samples', 'More to discover in Samples', 'Más para descubrir en Samples',
      'Samples now mixes the songs you love with new ones picked for you, and keeps going as you scroll.',
      'Samples ahora mezcla las canciones que te gustan con otras nuevas elegidas para ti, y sigue mientras deslizas.'],
    ['dl-done', 'Downloads that finish', 'Descargas que terminan',
      'Downloads keep going with the screen off and pick up where they left off if the app closes.',
      'Las descargas siguen con la pantalla apagada y continúan donde quedaron si la app se cierra.'],
    ['eq', 'Your data, your quality', 'Tus datos, tu calidad',
      'Wi-Fi always plays in high quality. On mobile data, choose Auto, Low or High.',
      'Con Wi-Fi siempre suena en alta calidad. Con datos móviles eliges Automática, Baja o Alta.'],
    ['list', 'Playlists without an account', 'Playlists sin cuenta',
      'Create playlists before signing in. When you sign in, you can move them to your YouTube account.',
      'Crea playlists sin haber accedido. Cuando accedas, puedes pasarlas a tu cuenta de YouTube.'],
    ['shuffle', 'Better shuffle and swipes', 'Aleatorio y deslizar, mejorados',
      'Shuffle now mixes everything with your song first, and swiping the artwork shows the next cover. Smoother, too.',
      'Aleatorio ahora mezcla todo con tu canción primero, y al deslizar la carátula ves la siguiente. Y todo va más fluido.'],
  ],
};
function whatsNew() {
  const mine = NATIVE?.appVersion?.() || '';
  const seenV = store.get('seenVersion', null);
  store.set('seenVersion', mine);
  // Instalación nueva (sin nada guardado de antes): no hay "novedades" que contar.
  if (!mine || seenV === mine || (seenV === null && !localStorage.getItem('gm.session') && !localStorage.getItem('gm.history'))) return;
  const cards = Object.entries(CHANGES).filter(([v]) => newer(v, seenV || '0.4.0') && !newer(v, mine)).flatMap(([, c]) => c);
  if (!cards.length) return;
  let i = 0;
  const es = LANG === 'es';
  const show = () => {
    const [icn, en, esT, enD, esD] = cards[i], last = i === cards.length - 1;
    openDialog(`<div class="wn"><button class="icon-btn wn-x" data-act="dlgCancel" aria-label="Close">${ic('close')}</button>
      <div class="wn-strap">What's new</div>
      <div class="wn-ic">${ic(icn)}</div>
      <h2>${esc(es ? esT : en)}</h2><div class="wn-tx">${esc(es ? esD : enD)}</div>
      <div class="wn-foot"><div class="wn-dots">${cards.map((_, j) => `<i${j === i ? ' class="on"' : ''}></i>`).join('')}</div>
      <button class="pill solid" data-act="${last ? 'dlgCancel' : 'wnNext'}">${last ? 'Got it' : 'Next'}</button></div></div>`);
  };
  ACT.wnNext = () => { i++; history.back(); setTimeout(show, 60); };
  show();
}

// ------------------------------------------------------------------ actualizaciones (GitHub)
const newer = (a, b) => { const pa = a.split('.').map(Number), pb = b.split('.').map(Number); for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0); } return false; };
/** Busca una versión nueva en los releases del repo. Al abrir la app, como mucho una vez
 *  por día; también desde Settings → About. */
async function checkUpdate(manual) {
  const repo = NATIVE?.updateRepo?.();
  if (!repo) { if (manual) toast('Updates are not set up in this build'); return; }
  if (!manual && Date.now() - store.get('updCheck', 0) < 864e5) return;
  store.set('updCheck', Date.now());
  let rel;
  try { rel = await (await fetch(`https://api.github.com/repos/${repo}/releases/latest`)).json(); } catch { if (manual) toast("Couldn't check for updates"); return; }
  const ver = String(rel.tag_name || '').replace(/^v/, ''), mine = NATIVE.appVersion();
  if (!ver || !newer(ver, mine)) { if (manual) toast(`You're on the latest version (${mine})`); return; }
  const apks = (rel.assets || []).filter((a) => a.name.endsWith('.apk'));
  const abi = NATIVE.abi();
  const asset = apks.find((a) => a.name.includes(abi)) || apks.find((a) => a.name.includes('universal')) || apks[0];
  if (!asset) return;
  const notes = esc(String(rel.body || '').slice(0, 600)).replace(/\n/g, '<br>');
  openDialog(`<h2>Update available</h2><div class="t1" style="font-size:16px;margin-bottom:8px">Giraffe Music ${esc(ver)}</div>
    <div class="t2" style="white-space:normal;max-height:30vh;overflow:auto;margin-bottom:16px">${notes || 'Bug fixes and improvements.'}</div>
    <div class="dlg-btns"><button class="ghost" data-act="dlgCancel">Later</button><button class="ok" data-act="doUpdate" data-url="${esc(asset.browser_download_url)}">Update</button></div>`);
}

// ------------------------------------------------------------------ cola
function queueUI(scroll) {
  if (!OV.includes('queue')) return;
  const k = reg(P.queue, P.from);
  const ql = $('#qList'), keep = ql.scrollTop;
  ql.innerHTML = P.queue.map((t, i) => rowHTML(t, k, i, { sub: 'dur', handle: true })).join('')
    + L(`<div class="autoplay" data-act="setting" data-k="autoplay"><div class="grow"><div class="t1" style="font-size:16px">Autoplay</div><div class="t2">Add similar content to the end of the queue</div></div><div class="switch${settings.autoplay ? ' on' : ''}"></div></div>`);
  $('#qName').textContent = P.from || '';
  // Al abrir: centrar la que suena (cuando la cola ya tiene su tamaño). Si no, quedarse donde estaba.
  if (scroll) requestAnimationFrame(() => setTimeout(() => centerIn(ql, $(`#qList .row[data-i="${P.i}"]`), false), 300));
  else ql.scrollTop = keep;
}
// Reordenar arrastrando el ícono ≡ de cada fila.
let drag = null;
document.addEventListener('pointerdown', (e) => {
  const h = e.target.closest('[data-drag]');
  if (!h) return;
  e.preventDefault();
  const row = h.closest('.row');
  drag = { from: +h.dataset.drag, row, y0: e.clientY, h: row.offsetHeight, to: +h.dataset.drag };
  row.classList.add('drag-on');
  h.setPointerCapture(e.pointerId);
});
document.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const dy = e.clientY - drag.y0;
  drag.row.style.transform = `translateY(${dy}px)`;
  drag.to = Math.max(0, Math.min(P.queue.length - 1, drag.from + Math.round(dy / drag.h)));
});
document.addEventListener('pointerup', () => {
  if (!drag) return;
  const { from, to, row } = drag;
  drag = null;
  row.style.transform = '';
  row.classList.remove('drag-on');
  if (from === to) return;
  const [x] = P.queue.splice(from, 1);
  P.queue.splice(to, 0, x);
  if (P.i === from) P.i = to; else if (from < P.i && to >= P.i) P.i--; else if (from > P.i && to <= P.i) P.i++;
  P.eng.move(from, to);
  queueUI();
  saveSession();
});

// ------------------------------------------------------------------ menús
function trackMenu(t, k, i, inQueue) {
  const lk = !!liked[t.id], dl = DL.has(t.id), busy = DL.busy(t.id), sv = !!savedSongs[t.id];
  const items = [
    ['radio', 'Start radio', 'mRadio'], ['playnext', 'Play next', 'mNext'], ['queue', 'Add to queue', 'mQueue'],
    [sv ? 'lib-check' : 'lib-add', sv ? 'Remove from library' : 'Save to library', 'mSave'],
    ['save', 'Save to playlist', 'mToPlaylist'],
    [lk ? 'like-f' : 'like', lk ? 'Remove from liked songs' : 'Like', 'mLike'],
    [dl ? 'delete' : 'dl', dl ? 'Remove download' : busy ? 'Downloading…' : 'Download', 'mDl'],
  ];
  if (inQueue && i !== P.i) items.push(['close', 'Remove from queue', 'mUnqueue']);
  if (!inQueue && LISTS.get(k)?.playlistId && (t.setId || isLocalPl(LISTS.get(k).playlistId))) items.push(['delete', 'Remove from playlist', 'mUnplaylist']);
  if (t.album?.id) items.push(['album', 'Go to album', 'go:/album/' + encodeURIComponent(t.album.id)]);
  if (t.artists?.[0]?.id) items.push(['artist', 'Go to artist', 'go:/artist/' + encodeURIComponent(t.artists[0].id)]);
  items.push(['share', 'Share', 'mShare']);
  openMenu(`<div class="m-head">${thumbImg(DL.thumb(t))}<div class="tx"><div class="t1">${esc(t.title)}</div><div class="t2">${eb(t)}<span>${esc(artists(t))}</span></div></div>${dl ? ic('dl-done') : ''}</div>`, items, { t, k, i });
}
let menuCtx = null;
/** Un diálogo centrado (como "Nueva playlist"), en la misma capa que los menús. */
function openDialog(html) {
  const m = $('#menu');
  m.className = 'menu dlg';
  m.innerHTML = L(html);
  pushOv('menu');
}
function openMenu(head, items, ctx) {
  $('#menu').className = 'menu';
  menuCtx = ctx;
  $('#menu').innerHTML = L(`<div class="grab"></div>${head}`) + items.map(([icn, label, act]) => `<button class="mi" data-mi="${esc(act)}">${ic(icn)}${esc(T(label))}</button>`).join('');
  pushOv('menu');
}
const MENU = {
  mShareUrl: ({ name, url }) => share(name, url),
  mDelLocal: ({ id }) => { ACT.delLocalPl({ dataset: { id } }); },
  mRadio: ({ t }) => P.radio(t),
  mNext: ({ t, tracks }) => P.playNext(tracks || [t]),
  mQueue: ({ t, tracks }) => P.addQueue(tracks || [t]),
  mSave: ({ t }) => toggleSave(t),
  mLike: ({ t }) => toggleLike(t),
  mDl: ({ t }) => (DL.has(t.id) ? DL.remove(t.id) : DL.add([t])),
  mUnqueue: ({ i }) => {
    const [t] = P.queue.splice(i, 1); if (i < P.i) P.i--; P.eng.remove(i); queueUI(); saveSession();
    toast('Removed from queue', { label: 'Undo', fn: () => { P.queue.splice(i, 0, t); if (i <= P.i) P.i++; P.eng.insert([t], i); queueUI(); saveSession(); } });
  },
  mUnplaylist: ({ t, k }) => {
    const l = LISTS.get(k), pid = l?.playlistId;
    if (isLocalPl(pid)) {
      const p = localPl(pid), at = p?.tracks.findIndex((x) => x.id === t.id) ?? -1;
      if (at < 0) return;
      p.tracks.splice(at, 1); saveLocalPls();
      const row = $(`.tracks .row[data-list="${k}"][data-i="${l.tracks.indexOf(t)}"]`);
      if (row) row.hidden = true;
      return toast('Removed from playlist', { label: 'Undo', fn: () => { p.tracks.splice(at, 0, t); saveLocalPls(); if (row) row.hidden = false; } });
    }
    if (!pid || !t.setId) return;
    fetch(`/api/me/playlist/${encodeURIComponent(pid)}/remove`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ videoId: t.id, setId: t.setId }) })
      .then((r) => {
        if (!r.ok) return toast("Couldn't remove it");
        mem.delete(`/api/playlist/${encodeURIComponent(pid)}`);
        const row = $(`.tracks .row[data-list="${k}"][data-i="${l.tracks.indexOf(t)}"]`);
        if (row) row.hidden = true;
        toast('Removed from playlist', { label: 'Undo', fn: () => {
          fetch(`/api/me/playlist/${encodeURIComponent(pid)}/add`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids: [t.id] }) })
            .then(() => { if (row) row.hidden = false; mem.delete(`/api/playlist/${encodeURIComponent(pid)}`); });
        } });
      });
  },
  mShare: ({ t }) => share(t.title + ' – ' + artists(t), 'https://music.youtube.com/watch?v=' + t.id),
  mShuffle: ({ tracks, name }) => { P.play(shuffleArr(tracks), 0, name, { shuffle: true }); P.unshuffled = tracks.slice(); },
  mListRadio: ({ tracks }) => P.radio(tracks[0]),
  mDlAll: ({ tracks }) => DL.add(tracks),
  mSleep: () => sleepMenu(),
  mForget: ({ q, token }) => {
    searches = searches.filter((s) => s !== q); store.set('searches', searches);
    const done = () => suggest($('#sq')?.value || '');
    if (token && me.signedIn) fetch('/api/me/forget', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }) }).finally(done);
    else done();
    toast('Removed from search history');
  },
  mToPlaylist: ({ t, tracks }) => setTimeout(() => saveToPlaylist(tracks || [t]), 250),
  mSleepSet: ({ min }) => setSleep(min),
};

let sleepTimer = 0;
function sleepMenu() {
  setTimeout(() => openMenu('<div class="m-head"><div class="tx"><div class="t1">Sleep timer</div></div></div>', [
    ['moon', '5 minutes', 'sleep:5'], ['moon', '15 minutes', 'sleep:15'], ['moon', '30 minutes', 'sleep:30'], ['moon', '45 minutes', 'sleep:45'], ['moon', '1 hour', 'sleep:60'],
    ['close', sleepTimer ? 'Turn off timer' : 'Cancel', 'sleep:0'],
  ], {}), 250);
}
function setSleep(min) {
  // Un solo setTimeout: nada que se despierte cada segundo.
  clearTimeout(sleepTimer); sleepTimer = 0;
  if (!min) return toast('Sleep timer off');
  sleepTimer = setTimeout(() => { P.eng.pause(); sleepTimer = 0; }, min * 60e3);
  toast(`Music will stop in ${min} minutes`);
}

// ------------------------------------------------------------------ biblioteca local
function rate(t, rating) {
  if (me.signedIn) fetch('/api/me/like/' + encodeURIComponent(t.id), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ rating }) }).then(() => mem.delete('/api/me/liked')).catch(() => {});
}
function toggleLike(t) {
  if (liked[t.id]) delete liked[t.id]; else { liked[t.id] = { t, at: Date.now() }; delete disliked[t.id]; }
  store.set('liked', liked); store.set('disliked', disliked);
  rate(t, liked[t.id] ? 'like' : 'none');
  likeUI();
  if (liked[t.id]) toast('Saved to Liked Music');
  else toast('Removed from Liked Music', { label: 'Undo', fn: () => toggleLike(t) });
}
function toggleSave(t) {
  if (savedSongs[t.id]) delete savedSongs[t.id]; else savedSongs[t.id] = { t, at: Date.now() };
  store.set('saved', savedSongs);
  if (cur()?.id === t.id) $('#plSaveIc').setAttribute('href', savedSongs[t.id] ? '#i-saved' : '#i-save');
  toast(savedSongs[t.id] ? 'Saved to library' : 'Removed from library');
}
function share(title, url) {
  if (NATIVE) return NATIVE.share(title, url);
  if (navigator.share) return navigator.share({ title, url }).catch(() => {});
  navigator.clipboard?.writeText(url).then(() => toast('Link copied'));
}

let toastT = 0, toastAct = null;
/** Un aviso abajo; con `action` muestra un botón (ej. "Undo") como en YouTube Music. */
function toast(msg, action) {
  const el = $('#toast');
  el.textContent = T(msg);
  toastAct = action || null;
  if (action) { const b = document.createElement('b'); b.textContent = T(action.label); b.dataset.act = 'toastAct'; el.append(b); }
  el.hidden = false;
  requestAnimationFrame(() => el.classList.add('on'));
  clearTimeout(toastT);
  toastT = setTimeout(() => { el.classList.remove('on'); toastAct = null; setTimeout(() => (el.hidden = true), 250); }, action ? 5000 : 2600);
}

// ------------------------------------------------------------------ acciones (una sola escucha para toda la app)
const ACT = {
  row: (el) => {
    const l = LISTS.get(el.dataset.list), i = +el.dataset.i;
    if (!l) return;
    const t = l.tracks[i];
    if (addTarget && location.pathname === '/search' && el.closest('#page')) {
      el.classList.add('added');
      return addToPlaylist(addTarget.id, { tracks: [t] });
    }
    if (cur()?.id === t.id && el.closest('#qList') == null && el.closest('.smp') == null) return openPlayer();
    if (el.closest('#qList')) return P.eng.skipTo(i);
    if (l.mode === 'radio') P.radio(t, l.name ? `${l.name}` : undefined);
    else P.play(l.tracks, i, l.name);
    if (el.closest('#samples')) openPlayer();
  },
  card: (el) => { const t = tAt(el); if (t) P.radio(t); },
  playAll: (el) => { const l = LISTS.get(el.dataset.list); if (l?.tracks.length) l.mode === 'radio' && l.tracks.length === 1 ? P.radio(l.tracks[0]) : P.play(l.tracks, 0, l.name); },
  shuffleList: (el) => {
    const l = LISTS.get(el.dataset.list);
    if (!l?.tracks.length) return;
    // Si ya suena una canción de esta lista, queda primera y sigue sonando; el resto se mezcla.
    const c = cur(), at = c ? l.tracks.findIndex((t) => t.id === c.id) : -1;
    if (at >= 0 && P.from === l.name) {
      const after = shuffleArr(l.tracks.filter((_, k) => k !== at));
      P.unshuffled = l.tracks.slice(); P.shuffled = true;
      P.queue = [c, ...after]; P.i = 0; P.eng.rebase([], after);
      $('#btnShuffle').classList.remove('off'); queueUI(true); saveSession();
      return;
    }
    P.play(shuffleArr(l.tracks), 0, l.name, { shuffle: true });
    P.unshuffled = l.tracks.slice();
  },
  radioList: (el) => { const l = LISTS.get(el.dataset.list); if (l?.tracks.length) P.radio(l.tracks[0]); },
  playCol: async (el, e) => {
    e.preventDefault(); e.stopPropagation();
    const c = await api(`/api/${el.dataset.kind}/${encodeURIComponent(el.dataset.id)}`, 60 * 60e3).catch(() => null);
    if (c?.tracks.length) P.play(c.tracks, 0, c.title);
  },
  menu: (el) => { const t = tAt(el); if (t) trackMenu(t, el.dataset.list, +el.dataset.i, !!el.closest('#qList')); },
  listMenu: (el) => {
    const l = LISTS.get(el.dataset.list);
    if (!l) return;
    openMenu(`<div class="m-head"><div class="tx"><div class="t1">${esc(l.name)}</div><div class="t2">${l.tracks.length} songs</div></div></div>`, [
      ['shuffle', 'Shuffle play', 'mShuffle'], ['radio', 'Start radio', 'mListRadio'], ['playnext', 'Play next', 'mNext'], ['queue', 'Add to queue', 'mQueue'], ['dl', 'Download', 'mDlAll'],
      ['save', 'Save to playlist', 'mToPlaylist'],
    ], { tracks: l.tracks, name: l.name });
  },
  dlAll: (el) => {
    const l = LISTS.get(el.dataset.list);
    if (!l?.tracks.length) return;
    if (l.tracks.every((t) => DL.has(t.id))) return toast('Already downloaded');
    DL.add(l.tracks);
  },
  shareList: (el) => { const l = LISTS.get(el.dataset.list); share(l?.name || 'Giraffe Music', location.href.startsWith('http://127.') ? 'https://music.youtube.com/' : location.href); },
  saveLib: (el) => {
    const d = el.dataset;
    if (lib[d.key]) delete lib[d.key]; else lib[d.key] = { kind: d.kind, id: d.id, title: d.title, subtitle: d.sub, thumb: d.thumb, round: !!d.round, at: Date.now() };
    store.set('lib', lib);
    const on = !!lib[d.key];
    if (me.signedIn && d.save) fetch('/api/me/save', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: d.save, save: on }) }).then(() => mem.delete('/api/me/library')).catch(() => {});
    if (d.kind === 'artist') { el.textContent = T(on ? 'Subscribed' : 'Subscribe'); el.classList.toggle('solid', !on); }
    else el.innerHTML = ic(on ? 'lib-check' : 'lib-add');
    toast(on ? 'Saved to library' : 'Removed from library');
  },
  chip: (el) => go(el.dataset.p ? '/?p=' + encodeURIComponent(el.dataset.p) : '/'),
  libView: () => { settings.libGrid = !settings.libGrid; saveSettings(); render(scrollY); },
  libSort: () => openMenu('<div class="m-head"><div class="tx"><div class="t1">Sort by</div></div></div>',
    [['recent', 'Recent activity'], ['added', 'Recently added'], ['az', 'A–Z']].map(([k, n]) => [settings.libSort === k ? 'check' : 'sort', n, 'sort:' + k]), {}),
  libChip: (el) => go(el.classList.contains('on') ? '/library' : '/library?f=' + el.dataset.f),
  sFilter: (el) => { const sp = new URLSearchParams(location.search); el.dataset.f ? sp.set('f', el.dataset.f) : sp.delete('f'); history.replaceState(history.state, '', '/search?' + sp); render(); },
  sScope: (el) => { const sp = new URLSearchParams(location.search); el.dataset.s ? sp.set('s', el.dataset.s) : sp.delete('s'); sp.delete('f'); history.replaceState(history.state, '', '/search?' + sp); render(); },
  sugg: (el) => doSearch(el.dataset.q),
  fill: (el, e) => { e.stopPropagation(); const i = $('#sq'); i.value = el.dataset.q + ' '; i.focus(); i.oninput(); },
  clearSearch: () => { const i = $('#sq'); i.value = ''; i.focus(); i.oninput(); },
  back: () => (history.length > 1 ? history.back() : go('/')),
  retry: () => { mem.clear(); render(); },
  cast: () => {
    // El navegador del celular puede mandar el audio a un parlante o TV (Remote Playback).
    const a = $('#audio');
    if (!NATIVE && a.remote?.prompt) a.remote.prompt().catch(() => toast('No devices found'));
    else toast('Use your phone’s Quick Settings to cast audio');
  },
  toggle: (el, e) => { e.stopPropagation(); P.toggle(); },
  next: (el, e) => { e.stopPropagation(); P.next(); },
  prev: () => P.prev(),
  shuffle: () => P.shuffle(),
  repeat: () => P.setRepeat(),
  closePlayer: () => popOv(),
  queueToggle: () => (OV.includes('queue') ? popOv() : pushOv('queue')),
  sheet: (el) => openSheet(el.dataset.tab),
  closeSheet: () => popOv(),
  like: () => cur() && toggleLike(cur()),
  dislike: () => {
    const t = cur();
    if (!t) return;
    if (disliked[t.id]) delete disliked[t.id]; else { disliked[t.id] = 1; delete liked[t.id]; }
    store.set('disliked', disliked); store.set('liked', liked);
    rate(t, disliked[t.id] ? 'dislike' : 'none');
    likeUI();
    if (disliked[t.id]) { toast("Got it. You won't hear this song as much"); P.next(); }
  },
  likeT: (el) => { const t = tAt(el); if (t) { toggleLike(t); el.querySelector('use').setAttribute('href', liked[t.id] ? '#i-like-f' : '#i-like'); } },
  saveT: (el) => { const t = tAt(el); if (t) toggleSave(t); },
  shareT: (el) => { const t = tAt(el); if (t) MENU.mShare({ t }); },
  saveCurrent: () => cur() && saveToPlaylist([cur()]),
  login: () => startLogin(),
  toastAct: () => { const a = toastAct; toastAct = null; $('#toast').classList.remove('on'); a?.fn(); },
  newPlaylist: (el, tracks) => {
    newPlTracks = Array.isArray(tracks) ? tracks : [];
    openDialog(`<h2>New playlist</h2>
      <div class="field"><label>Title</label><input id="npTitle" maxlength="150" autocomplete="off"></div>
      ${me.signedIn ? '' : `<div class="t2" style="white-space:normal;margin:-8px 0 16px">${T('Saved on this device')}. ${T('When you sign in, you can move it to your YouTube account.')}</div>`}
      <div class="field"${me.signedIn ? '' : ' hidden'}><label>Visibility</label><select id="npPrivacy"><option value="PUBLIC">Public</option><option value="UNLISTED">Unlisted</option><option value="PRIVATE">Private</option></select>${ic('down')}</div>
      <div class="dlg-btns"><button class="ghost" data-act="dlgCancel">Cancel</button><button class="ok" data-act="npCreate" id="npCreate" disabled>Create</button></div>`);
    const t = $('#npTitle');
    t.oninput = () => ($('#npCreate').disabled = !t.value.trim());
    setTimeout(() => t.focus(), 50);
  },
  dlgCancel: () => popOv(),
  together: () => TG.open(),
  tgTab: (el) => { TG.view = ''; TG.open(el.dataset.tab); },
  tgScan: () => { if (NATIVE?.scanQr) NATIVE.scanQr(); else toast('Enter code'); },
  tgJoin: () => TG.join($('#tgCode').value),
  tgLeave: () => TG.leave(),
  setUi: (el) => {
    if ((settings.ui === 'old' ? 'old' : 'new') === el.dataset.v) return;
    settings.ui = el.dataset.v; saveSettings();
    toast('Restarting…');
    // La app se reinicia sola (la música sigue sonando): así solo se carga la interfaz elegida.
    setTimeout(() => (NATIVE?.restart ? NATIVE.restart() : location.reload()), 400);
  },
  lyrSeek: (el) => {
    const l = lyr?.lines?.[+el.dataset.i];
    if (!l || !cur()) return;
    if (TG.send({ kind: 'seek', pos: l.t })) return;
    P.eng.seek(l.t);
    if (!P.playing) P.eng.play();
  },
  plSearch: () => PLF.open(),
  plSearchClose: () => PLF.close(),
  plSearchClear: () => { const i = $('#plq'); i.value = ''; i.oninput(); i.focus(); },
  plSearchAll: () => { const q = PLF.q; PLF.close(); go('/search?q=' + encodeURIComponent(q)); },
  plAdd: (el) => { addTarget = { id: el.dataset.id, title: el.dataset.title }; go('/search'); },
  addDone: () => history.back(),
  libItemMenu: async (el, e) => {
    e?.preventDefault(); e?.stopPropagation();
    const { kind, id, title } = el.dataset;
    let tracks = [];
    try {
      if (kind === 'liked') tracks = me.signedIn ? (await api('/api/me/liked', 60e3)).tracks || [] : Object.values(liked).sort((a, b) => b.at - a.at).map((x) => x.t);
      else if (isLocalPl(id)) tracks = localPl(id)?.tracks || [];
      else tracks = (await api(`/api/${kind}/${encodeURIComponent(id)}`, 60 * 60e3)).tracks || [];
    } catch {}
    const url = kind === 'album' ? `https://music.youtube.com/browse/${id}` : `https://music.youtube.com/playlist?list=${String(id).replace(/^VL/, '')}`;
    const items = tracks.length ? [['shuffle', 'Shuffle play', 'mShuffle'], ['playnext', 'Play next', 'mNext'], ['queue', 'Add to queue', 'mQueue'], ['dl', 'Download', 'mDlAll']] : [];
    if (!isLocalPl(id) && kind !== 'liked') items.push(['share', 'Share', 'mShareUrl']);
    if (isLocalPl(id)) items.push(['delete', 'Delete playlist', 'mDelLocal']);
    openMenu(`<div class="m-head"><div class="tx"><div class="t1">${esc(T(title))}</div><div class="t2"><span>${tracks.length ? songs(tracks.length) : ''}</span></div></div></div>`, items, { tracks, name: title, url, id });
  },
  tgPeople: () => { TG.view = 'people'; TG.render(); },
  tgRole: async (el) => {
    const r = await fetch('/api/together/role', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ member: el.dataset.m, control: el.dataset.c === '1' }) }).catch(() => null);
    if (r?.ok) TG.apply(await r.json());
  },
  delLocalPl: (el) => {
    const at = localPls.findIndex((p) => p.id === el.dataset.id);
    if (at < 0) return;
    const [p] = localPls.splice(at, 1); saveLocalPls();
    go('/library');
    toast('Removed from library', { label: 'Undo', fn: () => { localPls.splice(at, 0, p); saveLocalPls(); render(scrollY); } });
  },
  migMove: () => migrateLocal(),
  doUpdate: (el) => { const u = el.dataset.url; popOv(); toast('Downloading update…'); NATIVE?.installUpdate(u); },
  checkUpdate: () => checkUpdate(true),
  lyrScript: () => { settings.lyrRoman = !settings.lyrRoman; saveSettings(); openSheet('lyrics', true); toast(settings.lyrRoman ? 'Showing pronunciation' : 'Original lyrics only'); },
  // Calidad con datos móviles, como YouTube Music: Automática (predeterminada), Baja o Alta.
  quality: () => {
    const opts = [['normal', 'Auto (recommended)', 'Adjusts to your connection'], ['low', 'Low', 'Uses less data'], ['high', 'High', 'Uses more data']];
    openMenu(`<div class="m-head"><div class="tx"><div class="t1">Audio quality on mobile network</div></div></div>`,
      opts.map(([v, n, d]) => [settings.qMobile === v ? 'check' : 'blank', `${T(n)} · ${T(d)}`, `q:qMobile:${v}`]), {});
  },
  langMenu: () => {
    const opts = [['auto', 'System default'], ['en', 'English'], ['es', 'Español']];
    openMenu(`<div class="m-head"><div class="tx"><div class="t1">Language</div></div></div>`,
      opts.map(([v, n]) => [settings.lang === v ? 'check' : 'blank', n, `lang:${v}`]), {});
  },
  npCreate: async (el) => {
    const title = $('#npTitle').value.trim(), privacy = $('#npPrivacy').value;
    if (!title) return;
    el.disabled = true;
    const tracks = newPlTracks || [];
    newPlTracks = null;
    if (!me.signedIn) {
      const p = { id: 'LP' + Date.now(), title, description: '', tracks: tracks.slice(), at: Date.now() };
      localPls.unshift(p); saveLocalPls();
      toast(tracks.length ? `Saved to “${title}”` : `Created “${title}”`);
      history.back();
      if (!tracks.length) setTimeout(() => go('/playlist/' + p.id), 80);
      else if (location.pathname === '/library') setTimeout(() => render(scrollY), 80);
      return;
    }
    const r = await fetch('/api/me/playlists', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title, privacy, ids: tracks.map((t) => t.id) }) }).catch(() => null);
    const v = await r?.json().catch(() => ({}));
    if (!r?.ok || !v?.id) { el.disabled = false; return toast("Couldn't create the playlist"); }
    mem.delete('/api/me/library');
    toast(tracks.length ? `Saved to “${title}”` : `Created “${title}”`);
    // Al cerrar el diálogo, ir a la playlist nueva.
    history.back();
    if (!tracks.length) setTimeout(() => go('/playlist/' + encodeURIComponent(v.id)), 80);
  },
  edSave: async () => {
    const id = $('#edForm').dataset.id;
    const title = $('#edTitle').value.trim(), description = $('#edDesc').value, privacy = $('#edPrivacy').value;
    if (!title) return toast("The title can't be empty");
    if (isLocalPl(id)) {
      const p = localPl(id);
      if (p) { p.title = title; p.description = description; saveLocalPls(); }
      toast('Saved');
      return history.back();
    }
    const r = await fetch(`/api/me/playlist/${encodeURIComponent(id)}/edit`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title, description, privacy }) }).catch(() => null);
    if (!r?.ok) return toast("Couldn't save the changes");
    mem.delete(`/api/playlist/${encodeURIComponent(id)}`);
    mem.delete('/api/me/library');
    toast('Saved');
    history.back();
  },
  openUrl: (el, e) => { e.preventDefault(); const u = el.dataset.url; if (NATIVE?.openUrl) NATIVE.openUrl(u); else window.open(u, '_blank', 'noopener'); },
  openEq: () => NATIVE?.openEqualizer(),
  openDolby: () => NATIVE?.openDolby(),
  startTransfer: async () => {
    const link = $('#xferLink')?.value.trim();
    if (!link) return toast('Paste a Spotify playlist link');
    const r = await fetch('/api/transfer', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ link }) });
    if (!r.ok) return toast((await r.json().catch(() => ({}))).error || "Couldn't start the transfer");
    watchTransfer();
  },
  logout: () => logout(),
  modeSong: () => setMode('song'),
  modeVideo: () => setMode('video'),
  saveQueue: () => { if (me.signedIn) return saveToPlaylist(P.queue); for (const t of P.queue) savedSongs[t.id] ||= { t, at: Date.now() }; store.set('saved', savedSongs); toast(`Saved ${P.queue.length} songs to library`); },
  shareCurrent: () => cur() && MENU.mShare({ t: cur() }),
  dlCurrent: () => { const t = cur(); if (!t) return; if (DL.has(t.id)) { if (confirm('Remove this song from downloads?')) DL.remove(t.id); } else if (DL.busy(t.id)) toast('Downloading…'); else DL.add([t]); },
  shareLyrics: () => {
    const t = cur();
    const line = lyr?.lines?.[lyrIdx]?.text;
    share(line ? `“${line}” — ${t.title}, ${artists(t)}` : `${t.title} – ${artists(t)}`, 'https://music.youtube.com/watch?v=' + t.id);
  },
  goAlbum: (el, e) => { if (e.target.closest('#plArtist')) return; const t = cur(); if (t?.album?.id) go('/album/' + encodeURIComponent(t.album.id)); },
  goArtist: (el, e) => { e.stopPropagation(); const t = cur(); if (t?.artists?.[0]?.id) go('/artist/' + encodeURIComponent(t.artists[0].id)); },
  playerMenu: () => {
    const t = cur();
    if (!t) return;
    const items = [['radio', 'Start radio', 'mRadio'], ['moon', sleepTimer ? 'Sleep timer (on)' : 'Sleep timer', 'mSleep']];
    if (t.album?.id) items.push(['album', 'Go to album', 'go:/album/' + encodeURIComponent(t.album.id)]);
    if (t.artists?.[0]?.id) items.push(['artist', 'Go to artist', 'go:/artist/' + encodeURIComponent(t.artists[0].id)]);
    items.push(['share', 'Share', 'mShare']);
    openMenu('', items, { t });
  },
  setting: (el) => {
    const k = el.dataset.k;
    settings[k] = !settings[k];
    saveSettings();
    el.querySelector('.switch')?.classList.toggle('on', settings[k]);
    if (k === 'dataSaver' && settings[k] && V.mode === 'video') setMode('song');
    if (k === 'squareThumbs') { if (OV.includes('queue')) queueUI(); }
    if (k === 'resumeHeadphones') NATIVE?.setPref('resumeHeadphones', settings[k] ? '1' : '0');
    if (k === 'normalize') { NATIVE?.setNormalize(settings.normalize); if (!NATIVE) P.eng.normalize?.(); }
  },
  clearDownloads: async () => { if (!confirm('Delete all downloads?')) return; await fetch('/api/downloads', { method: 'DELETE' }); await DL.refresh(); render(); toast('Downloads deleted'); },
  clearHistory: () => { hist = []; store.set('history', hist); toast('History cleared'); },
  clearSearches: () => { searches = []; store.set('searches', searches); toast('Search history cleared'); },
};

document.addEventListener('click', (e) => {
  const mi = e.target.closest('[data-mi]');
  if (mi) {
    const act = mi.dataset.mi;
    const ctx = menuCtx;
    if (act.startsWith('go:')) return go(act.slice(3));
    history.back();
    if (act.startsWith('sleep:')) return setSleep(+act.slice(6));
    if (act.startsWith('pl:')) return addToPlaylist(act.slice(3), ctx);
    if (act.startsWith('lang:')) { settings.lang = act.slice(5); saveSettings(); NATIVE?.setPref('lang', settings.lang); return setTimeout(() => location.reload(), 120); }
    if (act.startsWith('q:')) { const [, k, v] = act.split(':'); settings[k] = v; saveSettings(); NATIVE?.setPref(k, v); return setTimeout(() => render(scrollY), 60); }
    if (act.startsWith('sort:')) { settings.libSort = act.slice(5); saveSettings(); return setTimeout(() => render(), 60); }
    return MENU[act]?.(ctx);
  }
  if (e.target === $('#scrim')) return popOv();
  const el = e.target.closest('[data-act], a[href]');
  if (!el) {
    if (e.target.closest('#mini')) openPlayer();
    return;
  }
  if (el.tagName === 'A') {
    if (el.closest('#nav')) NATIVE?.haptic?.();
    const href = el.getAttribute('href');
    if (href === '#' && el.dataset.act) { e.preventDefault(); return ACT[el.dataset.act]?.(el, e); }
    if (!href.startsWith('/') || e.ctrlKey || e.metaKey) return;
    e.preventDefault();
    if (e.target.closest('[data-act]') && e.target.closest('[data-act]') !== el && el.contains(e.target.closest('[data-act]'))) return ACT[e.target.closest('[data-act]').dataset.act]?.(e.target.closest('[data-act]'), e);
    return go(href);
  }
  ACT[el.dataset.act]?.(el, e);
});
// Mantener apretado una canción abre su menú, como en la app.
document.addEventListener('contextmenu', (e) => {
  const sg = e.target.closest('.sugg[data-hist]');
  if (sg) {
    e.preventDefault();
    return openMenu(`<div class="m-head"><div class="tx"><div class="t1">${esc(sg.dataset.q)}</div></div></div>`, [['delete', 'Remove from search history', 'mForget']], { q: sg.dataset.q, token: sg.dataset.forget });
  }
  const row = e.target.closest('.row[data-list]');
  if (!row) return;
  e.preventDefault();
  const t = tAt(row);
  if (t) trackMenu(t, row.dataset.list, +row.dataset.i, !!row.closest('#qList'));
});

function openPlayer() { if (cur() && !OV.includes('player')) pushOv('player'); }

// Gestos: deslizar el mini reproductor hacia arriba lo abre; en el reproductor, hacia
// abajo lo cierra y hacia arriba muestra la cola.
let sw = null;
document.addEventListener('touchstart', (e) => {
  const t = e.touches[0];
  sw = { y: t.clientY, x: t.clientX, el: e.target, at: Date.now() };
}, { passive: true });
document.addEventListener('touchend', (e) => {
  if (!sw || drag) return (sw = null);
  const t = e.changedTouches[0];
  const dy = t.clientY - sw.y, dx = Math.abs(t.clientX - sw.x), el = sw.el;
  sw = null;
  if (Math.abs(dy) < 60 || dx > Math.abs(dy)) return;
  if (el.closest('#mini') && dy < 0) return openPlayer();
  if (!el.closest('#player') || el.closest('#seek, .pl-chips, #qList, #sheet')) return;
  if (el.closest('#plArtBox') && settings.swipeArt && dx > 30) return;
  if (dy > 0) popOv();
  else if (!OV.includes('queue')) pushOv('queue');
}, { passive: true });

// Deslizar la carátula a los costados: siguiente / anterior (se puede apagar en Ajustes).
// Como en YouTube Music, mientras se arrastra se asoma la carátula de la canción a la que vas.
// Solo se mueve con transform (la GPU, sin redibujar la página) y las carátulas vecinas
// se cargan recién al empezar a deslizar.
(() => {
  const box = $('#plArtBox'), GAP = 24;
  let x0 = 0, y0 = 0, dx = 0, on = false, horiz = null;
  const neighbor = (d) => {
    const j = P.i + d;
    if (j >= 0 && j < P.queue.length) return P.queue[j];
    if (d > 0 && P.repeat === 'all') return P.queue[0];
    return null;
  };
  const peek = (img, t) => {
    img.parentNode.style.opacity = t ? '' : '0';
    if (t && img.dataset.id !== t.id) { img.dataset.id = t.id; setArt(img, t, artSrc(t)); }
  };
  box.addEventListener('touchstart', (e) => {
    if (!settings.swipeArt || OV.includes('queue')) return;
    const t = e.touches[0];
    x0 = t.clientX; y0 = t.clientY; dx = 0; on = true; horiz = null;
    box.classList.remove('slide');
  }, { passive: true });
  box.addEventListener('touchmove', (e) => {
    if (!on) return;
    const t = e.touches[0];
    dx = t.clientX - x0;
    if (horiz === null && (Math.abs(dx) > 10 || Math.abs(t.clientY - y0) > 10)) {
      horiz = Math.abs(dx) > Math.abs(t.clientY - y0);
      if (horiz) { peek($('#plArtPrev'), neighbor(-1)); peek($('#plArtNext'), neighbor(1)); box.classList.add('peeking'); }
    }
    // Sin canción de ese lado: se resiste, como un borde elástico.
    if (horiz) box.style.transform = `translateX(${neighbor(dx < 0 ? 1 : -1) ? dx : dx / 3}px)`;
  }, { passive: true });
  box.addEventListener('touchend', () => {
    if (!on) return;
    on = false;
    box.classList.add('slide');
    const w = box.clientWidth, next = dx < 0;
    if (horiz && Math.abs(dx) > Math.min(90, w / 4) && cur() && neighbor(next ? 1 : -1)) {
      box.style.transform = `translateX(${next ? -(w + GAP) : w + GAP}px)`;
      const nt = neighbor(next ? 1 : -1), to = next ? (P.i + 1 < P.queue.length ? P.i + 1 : 0) : P.i - 1;
      setTimeout(() => {
        // A la vecina de verdad (sin el "volver al principio" del botón anterior).
        P.eng.skipTo(to);
        setArt($('#plArt'), nt, artSrc(nt));
        // La carátula nueva ya está en caché (es la que se asomaba): vuelve al centro sin salto.
        box.classList.remove('slide', 'peeking');
        box.style.transform = '';
      }, 230);
    } else {
      box.style.transform = '';
      setTimeout(() => { if (!on) box.classList.remove('peeking'); }, 240);
    }
  }, { passive: true });
})();

// Barra de progreso: tocar o arrastrar.
(() => {
  const s = $('#seek');
  const frac = (e) => { const r = s.getBoundingClientRect(); return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)); };
  const show = (f) => {
    const dur = P.eng.pos().dur || cur()?.duration || 0;
    $('#seekFill').style.transform = `scaleX(${f})`;
    $('#seekThumb').style.transform = `translateX(${f * s.clientWidth}px)`;
    $('#tCur').textContent = fmt(f * dur);
  };
  s.addEventListener('pointerdown', (e) => { seeking = true; s.classList.add('drag'); s.setPointerCapture(e.pointerId); show(frac(e)); });
  s.addEventListener('pointermove', (e) => { if (seeking) show(frac(e)); });
  const end = (e) => {
    if (!seeking) return;
    seeking = false; s.classList.remove('drag');
    const dur = P.eng.pos().dur || cur()?.duration || 0;
    if (dur && !TG.send({ kind: 'seek', pos: frac(e) * dur })) P.eng.seek(frac(e) * dur);
  };
  s.addEventListener('pointerup', end);
  s.addEventListener('pointercancel', () => { seeking = false; s.classList.remove('drag'); });
})();

// ------------------------------------------------------------------ playlists largas
/** Trae el resto de una playlist de a páginas (~100 canciones) y las va agregando a la
 *  lista, mientras la página siga abierta. Lo traído queda guardado con la playlist. */
async function loadRest(c, k, opts, numbered) {
  const my = token;
  const list = LISTS.get(k);
  while (c.continuation && c.tracks.length < (c.limit || Infinity)) {
    let page;
    try { page = await api('/api/playlist-more?token=' + encodeURIComponent(c.continuation), 10 * 60e3); } catch { return; }
    if (my !== token) return;
    const start = c.tracks.length;
    const add = page.tracks.slice(0, (c.limit || Infinity) - start);
    c.tracks.push(...add);
    c.duration = (c.duration || 0) + add.reduce((s, t) => s + (t.duration || 0), 0);
    c.continuation = page.continuation;
    if (list && list.tracks !== c.tracks) list.tracks.push(...add);
    $('.tracks')?.insertAdjacentHTML('beforeend', add.map((t, j) => rowHTML(t, k, start + j, numbered ? { num: start + j + 1, sub: 'none' } : opts)).join(''));
    if (PLF.q) PLF.run();
    const foot = $('.foot-meta');
    if (foot) foot.textContent = T(`${songs(c.tracks.length)} • ${fmtLong(c.duration)}`);
    if (!add.length) break;
  }
}

// ------------------------------------------------------------------ cuenta de YouTube
function avatarHTML() {
  if (me.signedIn && me.photo) return `<a class="avatar" href="/account" aria-label="Account"><img src="${esc(me.photo)}" alt="" width="28" height="28"></a>`;
  return `<a class="avatar" href="/account" aria-label="Account">${esc(me.signedIn ? (me.name || 'G')[0] : 'G')}</a>`;
}
const signinCard = (txt) => `<div class="signin"><div class="tx"><div class="t1" style="font-size:15px;font-weight:500">Sign in to YouTube Music</div><div class="t2" style="white-space:normal">${esc(txt)}</div></div><button class="gbtn" data-act="login">${ic('google')}Sign in</button></div>`;
async function refreshAccount() {
  try {
    me = await (await fetch('/api/account')).json();
    store.set('me', me);
    const a = $('#top .avatar');
    if (a) a.outerHTML = avatarHTML();
  } catch {}
}
function startLogin() {
  if (NATIVE?.login) return NATIVE.login();
  // En la PC: el modo demo entra con la cuenta de ejemplo; si no, se pega la cookie.
  fetch('/api/status').then((r) => r.json()).then((st) => {
    if (st.demo) return onLoginCookie('SAPISID=demo');
    const c = prompt('Paste the Cookie header of music.youtube.com (from your browser\'s developer tools):');
    if (c) onLoginCookie(c);
  });
}
async function onLoginCookie(cookie) {
  if (!cookie) return;
  toast('Signing in…');
  try {
    const r = await fetch('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cookie }) });
    const v = await r.json();
    if (!r.ok || !v.signedIn) throw new Error(v.error || 'failed');
    me = v; store.set('me', me);
    mem.clear();
    toast(`Signed in${me.name ? ' as ' + me.name : ''}`);
    render();
    if (localPls.length) setTimeout(offerMigration, 1200);
  } catch (e) { toast("Couldn't sign in. Try again."); }
}
/** Después de acceder: ofrece pasar a la cuenta las playlists que se hicieron sin ella. */
function offerMigration() {
  if (!me.signedIn || !localPls.length) return;
  openDialog(`<h2>Move your playlists to your account?</h2>
    <div class="t2" style="white-space:normal;margin-bottom:12px">${esc(T('They will be saved as private playlists in your YouTube Music library, on all your devices.'))}</div>
    <div class="mig-list">${localPls.map((p) => `<div class="row"><div class="th">${thumbImg(p.tracks[0]?.thumb)}</div><div class="tx"><div class="t1">${esc(p.title)}</div><div class="t2"><span>${songs(p.tracks.length)}</span></div></div></div>`).join('')}</div>
    <div class="dlg-btns"><button class="ghost" data-act="dlgCancel">Not now</button><button class="ok" data-act="migMove">Move</button></div>`);
}
async function migrateLocal() {
  popOv();
  toast('Moving your playlists…');
  let ok = 0;
  for (const p of localPls.slice().reverse()) {
    const r = await fetch('/api/me/playlists', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: p.title, description: p.description || '', privacy: 'PRIVATE', ids: p.tracks.map((t) => t.id) }) }).catch(() => null);
    const v = await r?.json().catch(() => null);
    if (r?.ok && v?.id) { localPls = localPls.filter((x) => x.id !== p.id); saveLocalPls(); ok++; }
  }
  mem.delete('/api/me/library');
  toast(localPls.length ? "Couldn't move some playlists. Try again later" : 'Your playlists are in your account');
  if (location.pathname === '/library') render(scrollY);
}
async function logout() {
  await fetch('/api/logout', { method: 'POST' }).catch(() => {});
  NATIVE?.logout?.();
  me = { signedIn: false }; store.set('me', me);
  mem.clear();
  toast('Signed out');
  render();
}
let newPlTracks = null;
async function saveToPlaylist(tracks) {
  let pls = [];
  if (me.signedIn) {
    try { pls = (await api('/api/me/library', 5 * 60e3)).playlists.filter((c) => c.id !== 'LM' && c.id !== 'VLLM' && c.id !== 'SE'); } catch {}
  }
  openMenu(`<div class="m-head"><div class="tx"><div class="t1">Save to playlist</div><div class="t2"><span>${tracks.length > 1 ? tracks.length + ' songs' : esc(tracks[0].title)}</span></div></div></div>`,
    [['add', 'New playlist', 'pl:new'], ...localPls.map((p) => ['queue', p.title, 'pl:' + p.id]), ...pls.map((c) => ['queue', c.title, 'pl:' + c.id])], { tracks });
}
async function addToPlaylist(id, { tracks }) {
  const ids = tracks.map((t) => t.id);
  let r;
  if (id === 'new') return setTimeout(() => ACT.newPlaylist(null, tracks), 250);
  if (isLocalPl(id)) {
    const p = localPl(id);
    if (!p) return;
    const have = new Set(p.tracks.map((t) => t.id));
    p.tracks.push(...tracks.filter((t) => !have.has(t.id)));
    p.at = Date.now(); saveLocalPls();
    return toast(`Saved to “${p.title}”`);
  }
  {
    r = await fetch(`/api/me/playlist/${encodeURIComponent(id)}/add`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids }) });
    if (r.ok) toast('Saved to playlist');
  }
  if (!r.ok) toast("Couldn't save to that playlist");
  mem.delete('/api/me/library');
}

// ------------------------------------------------------------------ luces de fondo
async function glow(shelves) {
  const g = $('#glow');
  if (!g) return;
  const thumbs = [];
  for (const s of shelves) for (const x of s.items) { const u = x.thumb || x.track?.thumb; if (u && thumbs.length < 3) thumbs.push(u); }
  const cs = (await Promise.all(thumbs.map(colorOf))).filter(Boolean);
  if (!cs.length || !$('#glow')) return;
  // Un resplandor oscuro y apagado, sobre todo del color de la primera carátula,
  // como el de YouTube Music: se nota, pero no encandila.
  const [h1, s1] = cs[0], [h2, s2] = cs[1] || cs[0];
  g.style.setProperty('--g1', `hsl(${h1} ${Math.min(s1, 48)}% 24% / .9)`);
  g.style.setProperty('--g2', `hsl(${h2} ${Math.min(s2, 40)}% 17% / .8)`);
  g.style.setProperty('--g3', `hsl(${h1} ${Math.min(s1, 35)}% 13% / .7)`);
  g.classList.add('on');
}

// ------------------------------------------------------------------ video (botón Song | Video)
// El video va sin sonido arriba del audio, que sigue saliendo del reproductor. Solo se
// carga con el reproductor abierto y la pantalla prendida: al bloquear el teléfono o
// salir de la app se suelta (la música sigue sola).
const V = { mode: 'song', id: null, loaded: false, el: $('#plVideo'), busy: false };
const videoVisible = () => visible && OV.includes('player') && !OV.includes('sheet') && !OV.includes('queue');
async function setMode(m, quiet) {
  const t = cur();
  if (!t) return;
  if (m === 'song') {
    V.mode = 'song';
    videoRelease();
    V.id = null;
    if (t.songOf) P.swapCurrent(t.songOf);
    return modeUI();
  }
  if (settings.dataSaver) return toast('Video is off while Data saver is on');
  if (V.busy) return;
  V.busy = true;
  try {
    let vt = t;
    if (!t.video) {
      const r = await api(`/api/video/${encodeURIComponent(t.id)}?title=${encodeURIComponent(t.title)}&artist=${encodeURIComponent(t.artists?.[0]?.name || '')}${t.duration ? '&duration=' + t.duration : ''}`, 864e5);
      if (cur() !== t) return;
      if (!r.id) { if (!quiet) toast("This song doesn't have a music video"); V.mode = 'song'; return modeUI(); }
      if (r.id !== t.id) {
        vt = { ...(r.track || t), id: r.id, video: true, songOf: t };
        if (!vt.album) vt.album = t.album;
        P.swapCurrent(vt);
      }
    }
    V.mode = 'video';
    V.id = vt.id;
    modeUI();
    videoSync();
  } catch { if (!quiet) toast("Couldn't load the video"); }
  finally { V.busy = false; }
}
function modeUI() {
  const vid = V.mode === 'video';
  $('#segSong').classList.toggle('on', !vid);
  $('#segVideo').classList.toggle('on', vid);
  const show = vid && V.id && cur()?.id === V.id;
  $('#player').classList.toggle('vid', !!show);
  V.el.hidden = !show;
}
function videoRelease() {
  V.el.pause();
  if (V.loaded) { V.el.removeAttribute('src'); V.el.load(); V.loaded = false; }
}
function videoSync() {
  const want = V.mode === 'video' && V.id && cur()?.id === V.id && videoVisible();
  if (!want) { if (V.loaded) videoRelease(); return; }
  const { pos } = P.eng.pos();
  if (!V.loaded) {
    V.loaded = true;
    V.el.src = '/api/vstream/' + encodeURIComponent(V.id);
    V.el.addEventListener('loadedmetadata', () => { V.el.currentTime = P.eng.pos().pos; }, { once: true });
  } else if (V.el.readyState > 0 && Math.abs(V.el.currentTime - pos) > 0.4) {
    V.el.currentTime = pos;
  }
  if (P.playing && V.el.paused) V.el.play().catch(() => {});
  if (!P.playing && !V.el.paused) V.el.pause();
}

// ------------------------------------------------------------------ arranque
function setInsets(top, bottom) {
  if (!top) return; // todavía sin medir: se queda el valor de reserva
  const r = document.documentElement.style;
  setInsets.top = top;
  r.setProperty('--nt', top + (TG.bar ? 22 : 0) + 'px');
  r.setProperty('--nt0', top + 'px');
  r.setProperty('--nb', bottom + 'px');
}
P.eng = NATIVE ? new NativeEngine() : new WebEngine();
P.eng.setRepeat(P.repeat);
repeatUI();
history.scrollRestoration = 'manual';
history.replaceState({ ov: [], y: 0 }, '');
if (NATIVE) {
  try { const [t, b] = NATIVE.insets().split(',').map(Number); setInsets(t || 28, b); } catch { setInsets(28, 0); }
  document.documentElement.classList.add('native');
}
restoreSession();
render();
DL.refresh();
refreshAccount();
if (NATIVE) {
  NATIVE.sync();
  try {
    NATIVE.setNormalize(settings.normalize);
    NATIVE.setPref('qMobile', settings.qMobile); NATIVE.setPref('lang', LANG);
    NATIVE.setPref('resumeHeadphones', settings.resumeHeadphones ? '1' : '0');
  } catch {}
  TG.init();
  setTimeout(whatsNew, 1200);
  // Playlists del teléfono con la cuenta ya abierta: se ofrece pasarlas (como mucho cada 3 días).
  setTimeout(() => { if (me.signedIn && localPls.length && Date.now() - store.get('migAsked', 0) > 3 * 864e5 && !OV.length) { store.set('migAsked', Date.now()); offerMigration(); } }, 6000);
  setTimeout(() => checkUpdate(NATIVE?.takeUpdateIntent?.() === true), 4000);
}
// Fuera del APK: que la app quede guardada en el teléfono (funciona sin red).
if (!NATIVE && 'serviceWorker' in navigator) addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
