// Loaded only inside the iPhone app (window.TUNE_APP is injected by the native shell).
// Connects the shared UI (index.html) to:
//   - TuneEngine (YouTube access, runs here in the web view)
//   - the native side: networking without CORS, AVPlayer playback, persistent storage.
(() => {
  const native = window.webkit.messageHandlers;
  const E = window.TuneEngine;
  const LOOKAHEAD = 15; // songs pre-resolved and handed to iOS so playback continues while locked

  // ---- networking: route the engine's requests through URLSession (no CORS limits) ----
  const toB64 = bytes => { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return btoa(s); };
  const fromB64 = b64 => { const bin = atob(b64); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; };
  async function nativeFetch(input, init = {}) {
    let url, method, headers = {}, body = null;
    if (input instanceof Request) {
      url = input.url; method = init.method || input.method;
      input.headers.forEach((v, k) => (headers[k] = v));
      if (!['GET', 'HEAD'].includes(method)) body = new Uint8Array(await input.clone().arrayBuffer());
    } else { url = String(input); method = init.method || 'GET'; }
    // Plain Headers objects keep headers like Origin/User-Agent that Request() would strip.
    new Headers(init.headers || {}).forEach((v, k) => (headers[k] = v));
    if (init.body != null) body = typeof init.body === 'string' ? new TextEncoder().encode(init.body) : new Uint8Array(await new Response(init.body).arrayBuffer());
    const r = await native.fetch.postMessage({ url, method, headers, body: body ? toB64(body) : null });
    if (r.error) throw new TypeError('Network error: ' + r.error);
    const noBody = [101, 204, 205, 304].includes(r.status);
    const res = new Response(noBody ? null : fromB64(r.body || ''), { status: r.status, headers: r.headers });
    Object.defineProperty(res, 'url', { value: r.url || url });
    return res;
  }
  E.setFetch(nativeFetch);

  // ---- persistent storage (UserDefaults on the native side) ----
  const saved = window.__TUNE_STORE || {};
  const store = {
    get(k, d) { try { return k in saved ? JSON.parse(saved[k]) : d; } catch { return d; } },
    set(k, v) { saved[k] = JSON.stringify(v); native.player.postMessage({ cmd: 'store', key: k, value: saved[k] }); },
  };

  // ---- an <audio>-like facade over the native player, so the UI code stays the same ----
  const listeners = {};
  const audio = {
    currentTime_: 0, duration: NaN, paused: true, error: null, volume: 1,
    get currentTime() { return this.currentTime_; },
    set currentTime(t) { this.currentTime_ = t; native.player.postMessage({ cmd: 'seek', t }); },
    play() { native.player.postMessage({ cmd: 'play' }); return Promise.resolve(); },
    pause() { native.player.postMessage({ cmd: 'pause' }); },
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
  };
  const emit = type => (listeners[type] || []).forEach(fn => { try { fn(); } catch (e) { console.error(e); } });

  const item = (t, s) => ({ id: t.id, url: s.url, title: t.title, artist: t.artist || '', album: t.album || '', art: t.art || '' });
  let gen = 0, upGen = 0, retried = new Set();

  async function start() {
    const my = ++gen, t = cur();
    if (!t) return;
    try {
      const s = await E.stream(t.id);
      if (my !== gen) return;
      native.player.postMessage({ cmd: 'queue', items: [item(t, s)] });
      syncUpcoming();
    } catch (e) {
      if (my !== gen) return;
      toast('Couldn’t play that one — skipping'); setTimeout(() => next(), 800);
    }
  }

  // Resolve the next songs' audio links and hand them to iOS (replaces whatever it had queued).
  async function syncUpcoming() {
    const my = ++upGen, base = idx, ups = queue.slice(idx + 1, idx + 1 + LOOKAHEAD), items = [];
    for (let i = 0; i < ups.length; i++) {
      try { items.push(item(ups[i], await E.stream(ups[i].id))); } catch {}
      if (my !== upGen || base !== idx) return;
      if (i === 1) native.player.postMessage({ cmd: 'upcoming', items: items.slice() }); // fast first batch
    }
    native.player.postMessage({ cmd: 'upcoming', items });
  }

  // ---- events from the native player ----
  function onNative(ev) {
    switch (ev.type) {
      case 'time': audio.currentTime_ = ev.t; audio.duration = ev.d || NaN; emit('timeupdate'); break;
      case 'state': audio.paused = !ev.playing; emit(ev.playing ? 'play' : 'pause'); break;
      case 'track': { // iOS moved on by itself (song ended, or Next on the lock screen)
        const i = queue.findIndex((t, j) => j > idx && t.id === ev.id);
        if (i > -1) { idx = i; showTrack(); syncUpcoming(); }
        break;
      }
      case 'queueEnd': next(); break;
      case 'remote': if (ev.cmd === 'prev') prev(); else if (ev.cmd === 'next') next(); break;
      case 'error': {
        const t = cur();
        if (!t || t.id !== ev.id) break;
        E.forgetStream(t.id);
        if (!retried.has(t.id)) { retried.add(t.id); start(); } // link expired / network changed → fetch a fresh one
        else { toast('Couldn’t play that one — skipping'); setTimeout(() => next(), 800); }
        break;
      }
    }
  }

  window.TuneApp = {
    api: p => E.handle(p),
    store, audio, start, syncUpcoming, onNative,
    setRepeat: on => native.player.postMessage({ cmd: 'repeat', on }),
  };
})();
