(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);

  /* ---------------- optional short-link backend ----------------
     Leave blank for the default behaviour: the whole gift is packed
     into the link itself (nothing hosted, but the link grows with the
     gift). Paste your Cloudflare Worker URL here (e.g.
     'https://bloom-gifts.your-name.workers.dev') to get short, fixed
     links like  .../#i=ab3k9xqz  instead. See worker.js + the README
     for the 10-minute setup. If the Worker is ever unreachable the app
     automatically falls back to a self-contained link, so gifts always
     work. */
  const GIFT_API = '';

  /* ---------------- base64url helpers (used inside generated gift files) ---------------- */
  function bytesToBase64(bytes) {
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  }
  function base64ToBytes(b64) {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }
  function base64UrlEncode(bytes) {
    return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function base64UrlDecode(str) {
    let s = str.replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    return base64ToBytes(s);
  }

  /* ---------------- crypto (used inside generated gift files) ---------------- */
  async function deriveKey(passphrase, salt) {
    const keyMaterial = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(passphrase), { name: 'PBKDF2' }, false, ['deriveKey']
    );
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations: 150000, hash: 'SHA-256' },
      keyMaterial, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
    );
  }

  async function encryptPayload(obj, passphrase) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await deriveKey(passphrase, salt);
    const ctBuf = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(obj))
    );
    return { s: base64UrlEncode(salt), i: base64UrlEncode(iv), c: base64UrlEncode(new Uint8Array(ctBuf)) };
  }

  async function decryptPayload(payload, passphrase) {
    const salt = base64UrlDecode(payload.s);
    const iv = base64UrlDecode(payload.i);
    const key = await deriveKey(passphrase, salt);
    const ctBytes = base64UrlDecode(payload.c);
    const ptBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ctBytes);
    return JSON.parse(new TextDecoder().decode(ptBuf));
  }

  async function buildWrapper(data, passphrase) {
    if (passphrase) return { v: 1, enc: true, ...(await encryptPayload(data, passphrase)) };
    return { v: 1, enc: false, d: data };
  }

  /* ---------------- gift links (hosted mode) ----------------
     When the app is served over http(s) (e.g. GitHub Pages) the gift
     is encoded into the URL fragment. The fragment is never sent to
     the server, so the letter stays between sender and recipient.

     The gift is gzip-compressed first (via the browser's built-in
     CompressionStream) so a long letter yields a much shorter link.
     Compressed links use the #z= prefix; #g= remains for plain links
     and for browsers without CompressionStream. */
  const CAN_GZIP = typeof CompressionStream !== 'undefined' && typeof DecompressionStream !== 'undefined';

  async function gzip(bytes) {
    const cs = new CompressionStream('gzip');
    const w = cs.writable.getWriter();
    // swallow writer rejections: a stream error also rejects the read
    // below, which is the one we surface
    w.write(bytes).catch(() => {});
    w.close().catch(() => {});
    return new Uint8Array(await new Response(cs.readable).arrayBuffer());
  }
  async function gunzip(bytes) {
    const ds = new DecompressionStream('gzip');
    const w = ds.writable.getWriter();
    w.write(bytes).catch(() => {});
    w.close().catch(() => {});
    return new Uint8Array(await new Response(ds.readable).arrayBuffer());
  }

  // Encode a gift into the fragment body that follows '#': 'z=<gzip>'
  // when compression helps, otherwise 'g=<plain>'.
  async function encodeGift(wrapper) {
    const json = new TextEncoder().encode(JSON.stringify(wrapper));
    if (CAN_GZIP) {
      try {
        const gz = await gzip(json);
        if (gz.length < json.length) return 'z=' + base64UrlEncode(gz);
      } catch (e) { /* fall through to plain */ }
    }
    return 'g=' + base64UrlEncode(json);
  }

  // Decode a 'z='/'g=' fragment body back into the wrapper object.
  async function decodeGift(frag) {
    let m = /^z=([A-Za-z0-9_-]+)$/.exec(frag);
    if (m) {
      const json = await gunzip(base64UrlDecode(m[1]));
      return JSON.parse(new TextDecoder().decode(json));
    }
    m = /^g=([A-Za-z0-9_-]+)$/.exec(frag);
    if (m) return JSON.parse(new TextDecoder().decode(base64UrlDecode(m[1])));
    throw new Error('bad fragment');
  }

  async function buildGiftLink(wrapper) {
    const base = location.origin + location.pathname;
    const frag = await encodeGift(wrapper);
    // With a backend configured, store the gift and hand back a short
    // fixed-length id link; on any failure, fall back to the inline link.
    if (GIFT_API) {
      try {
        const res = await fetch(GIFT_API, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain' },
          body: frag
        });
        if (res.ok) {
          const out = await res.json();
          if (out && out.id) return base + '#i=' + out.id;
        }
      } catch (e) { /* fall back to the self-contained link */ }
    }
    return base + '#' + frag;
  }

  async function readWrapperFromHash() {
    const h = location.hash;
    // short-link id: fetch the stored gift from the backend
    const mi = /^#i=([A-Za-z0-9_-]+)$/.exec(h);
    if (mi) {
      if (!GIFT_API) return undefined;
      try {
        const sep = GIFT_API.indexOf('?') >= 0 ? '&' : '?';
        const res = await fetch(GIFT_API + sep + 'id=' + encodeURIComponent(mi[1]));
        if (!res.ok) return undefined;
        return await decodeGift((await res.text()).trim());
      } catch (e) {
        return undefined;
      }
    }
    // self-contained link (compressed or plain)
    if (/^#[zg]=[A-Za-z0-9_-]+$/.test(h)) {
      try { return await decodeGift(h.slice(1)); }
      catch (e) { return undefined; }
    }
    return null; // no gift in the URL — show the compose page
  }

  /* ---------------- watercolor flower art ----------------
     Hand-built painterly SVG symbols shared by the compose page and
     every generated gift file. Lilies come in three variants because
     they get the most screen time. All ids are prefixed fl-. */
  const FLOWER_DEFS = '<defs>'
    /* per-petal gradients run base->tip so every rotated petal copy is
       shaded along its own axis, giving the blooms dimensionality */
    + '<linearGradient id="flg-lp-petal" x1="0" y1="1" x2="0" y2="0"><stop offset="0%" stop-color="#cd7590"/><stop offset="30%" stop-color="#e39cb0"/><stop offset="70%" stop-color="#f6cbd6"/><stop offset="100%" stop-color="#fdf0f3"/></linearGradient>'
    + '<linearGradient id="flg-lp-petalB" x1="0" y1="1" x2="0" y2="0"><stop offset="0%" stop-color="#b5637f"/><stop offset="40%" stop-color="#d88ea3"/><stop offset="100%" stop-color="#f4c6d2"/></linearGradient>'
    + '<linearGradient id="flg-lw-petal" x1="0" y1="1" x2="0" y2="0"><stop offset="0%" stop-color="#d6cea9"/><stop offset="25%" stop-color="#ede6cb"/><stop offset="65%" stop-color="#faf6e9"/><stop offset="100%" stop-color="#ffffff"/></linearGradient>'
    + '<linearGradient id="flg-lw-petalB" x1="0" y1="1" x2="0" y2="0"><stop offset="0%" stop-color="#c0ba92"/><stop offset="45%" stop-color="#ded7b6"/><stop offset="100%" stop-color="#f3efdd"/></linearGradient>'
    + '<linearGradient id="flg-lg-petal" x1="0" y1="1" x2="0" y2="0"><stop offset="0%" stop-color="#c98f43"/><stop offset="30%" stop-color="#e0ab5c"/><stop offset="70%" stop-color="#f3d092"/><stop offset="100%" stop-color="#faedcd"/></linearGradient>'
    + '<linearGradient id="flg-lg-petalB" x1="0" y1="1" x2="0" y2="0"><stop offset="0%" stop-color="#ad7734"/><stop offset="45%" stop-color="#cf954b"/><stop offset="100%" stop-color="#edc582"/></linearGradient>'
    + '<linearGradient id="flg-rose-petalO" x1="0" y1="1" x2="0" y2="0"><stop offset="0%" stop-color="#c2603c"/><stop offset="35%" stop-color="#dd8a5f"/><stop offset="75%" stop-color="#f3c19a"/><stop offset="100%" stop-color="#fadfc4"/></linearGradient>'
    + '<linearGradient id="flg-rose-petalM" x1="0" y1="1" x2="0" y2="0"><stop offset="0%" stop-color="#b25535"/><stop offset="45%" stop-color="#d47a4e"/><stop offset="100%" stop-color="#efb287"/></linearGradient>'
    + '<linearGradient id="flg-rose-petalI" x1="0" y1="1" x2="0" y2="0"><stop offset="0%" stop-color="#a54c2f"/><stop offset="55%" stop-color="#c76c42"/><stop offset="100%" stop-color="#e8a172"/></linearGradient>'
    + '<linearGradient id="flg-daisy-petal" x1="0" y1="1" x2="0" y2="0"><stop offset="0%" stop-color="#ddd8c6"/><stop offset="35%" stop-color="#f3f1e8"/><stop offset="100%" stop-color="#ffffff"/></linearGradient>'
    + '<linearGradient id="flg-zin-petalO" x1="0" y1="1" x2="0" y2="0"><stop offset="0%" stop-color="#b34a42"/><stop offset="45%" stop-color="#d3705f"/><stop offset="100%" stop-color="#f0a494"/></linearGradient>'
    + '<linearGradient id="flg-zin-petalI" x1="0" y1="1" x2="0" y2="0"><stop offset="0%" stop-color="#cc6a58"/><stop offset="100%" stop-color="#f2ab9b"/></linearGradient>'
    + '<linearGradient id="flg-anem-petal" x1="0" y1="1" x2="0" y2="0"><stop offset="0%" stop-color="#d69a8b"/><stop offset="45%" stop-color="#f0cec1"/><stop offset="100%" stop-color="#fdf5f0"/></linearGradient>'
    + '<linearGradient id="flg-leaf-blade" x1="0" y1="1" x2="0" y2="0"><stop offset="0%" stop-color="#8fa77e"/><stop offset="100%" stop-color="#c2d4ae"/></linearGradient>'
    + '<radialGradient id="flg-shadow" cx="50%" cy="50%" r="50%"><stop offset="0%" stop-color="#96705a" stop-opacity=".18"/><stop offset="70%" stop-color="#96705a" stop-opacity=".07"/><stop offset="100%" stop-color="#96705a" stop-opacity="0"/></radialGradient>'
    + '<radialGradient id="flg-rose-core" cx="42%" cy="38%" r="60%"><stop offset="0%" stop-color="#dd906f"/><stop offset="100%" stop-color="#a85636"/></radialGradient>'
    + '<radialGradient id="flg-daisy-core" cx="42%" cy="38%" r="62%"><stop offset="0%" stop-color="#f7d883"/><stop offset="60%" stop-color="#e4b153"/><stop offset="100%" stop-color="#c08c33"/></radialGradient>'
    + '<radialGradient id="flg-plumeria" cx="50%" cy="50%" r="50%"><stop offset="0%" stop-color="#f2c14e"/><stop offset="25%" stop-color="#f9e6b8"/><stop offset="60%" stop-color="#fdf7ea"/><stop offset="100%" stop-color="#ffffff"/></radialGradient>'
    + '<linearGradient id="flg-sun-petal" x1="0" y1="1" x2="0" y2="0"><stop offset="0%" stop-color="#c98f30"/><stop offset="45%" stop-color="#eebd58"/><stop offset="100%" stop-color="#f8df9c"/></linearGradient>'
    + '<linearGradient id="flg-sun-petalB" x1="0" y1="1" x2="0" y2="0"><stop offset="0%" stop-color="#a8721f"/><stop offset="50%" stop-color="#d59c3c"/><stop offset="100%" stop-color="#eecb7c"/></linearGradient>'
    + '<radialGradient id="flg-sun-core" cx="42%" cy="38%" r="65%"><stop offset="0%" stop-color="#8a5e30"/><stop offset="100%" stop-color="#573a1c"/></radialGradient>'
    + '<linearGradient id="flg-dahO-out" x1="0" y1="1" x2="0" y2="0"><stop offset="0%" stop-color="#c26b40"/><stop offset="45%" stop-color="#e2915e"/><stop offset="100%" stop-color="#f6c69c"/></linearGradient>'
    + '<linearGradient id="flg-dahO-mid" x1="0" y1="1" x2="0" y2="0"><stop offset="0%" stop-color="#b25c36"/><stop offset="55%" stop-color="#d67f4e"/><stop offset="100%" stop-color="#efb384"/></linearGradient>'
    + '<linearGradient id="flg-dahP-out" x1="0" y1="1" x2="0" y2="0"><stop offset="0%" stop-color="#d3946c"/><stop offset="45%" stop-color="#eebd97"/><stop offset="100%" stop-color="#fae4cc"/></linearGradient>'
    + '<linearGradient id="flg-dahP-mid" x1="0" y1="1" x2="0" y2="0"><stop offset="0%" stop-color="#c58259"/><stop offset="55%" stop-color="#e3a97e"/><stop offset="100%" stop-color="#f6d2b0"/></linearGradient>'
    + '<linearGradient id="flg-iris-fall" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#5c4d96"/><stop offset="55%" stop-color="#8172b6"/><stop offset="100%" stop-color="#b1a4d6"/></linearGradient>'
    + '<linearGradient id="flg-iris-std" x1="0" y1="1" x2="0" y2="0"><stop offset="0%" stop-color="#8a7cba"/><stop offset="55%" stop-color="#ab9ecf"/><stop offset="100%" stop-color="#d6cfe9"/></linearGradient>'
    + '<linearGradient id="flg-cos-petal" x1="0" y1="1" x2="0" y2="0"><stop offset="0%" stop-color="#c9769a"/><stop offset="50%" stop-color="#e6a4bf"/><stop offset="100%" stop-color="#f7d6e2"/></linearGradient>'
    + '<radialGradient id="flg-seal" cx="42%" cy="36%" r="70%"><stop offset="0%" stop-color="#a186c6"/><stop offset="45%" stop-color="#7d5fa6"/><stop offset="100%" stop-color="#59417f"/></radialGradient>'
    /* soft depth shadow baked into every bloom (cheap: no filters) */
    + '<g id="fl-shadow"><ellipse cx="52" cy="55" rx="34" ry="30" fill="url(#flg-shadow)"/></g>'
    /* gentle watercolor-bleed blur applied to every bloom's outer group,
       so edges soften and colors feather like pigment on wet paper
       instead of reading as crisp vector shapes */
    + '<filter id="flt-soft" x="-25%" y="-25%" width="150%" height="150%"><feGaussianBlur in="SourceGraphic" stdDeviation="0.55"/></filter>'

    /* --- lily: layered whorls, shaded per petal, speckles, stamens --- */
    + '<g id="fl-lily-back">'
    +   '<path d="M50 51 C36 43 32 21 44 9 C47.5 5.5 52.5 5.5 56 9 C68 21 64 43 50 51 Z"/>'
    +   '<path d="M50 51 C36 43 32 21 44 9 C47.5 5.5 52.5 5.5 56 9 C68 21 64 43 50 51 Z" transform="rotate(120 50 50)"/>'
    +   '<path d="M50 51 C36 43 32 21 44 9 C47.5 5.5 52.5 5.5 56 9 C68 21 64 43 50 51 Z" transform="rotate(240 50 50)"/>'
    + '</g>'
    + '<g id="fl-lily-front">'
    +   '<path d="M50 51 C41 43 37 24 45 12 C47.5 8.5 52.5 8.5 55 12 C63 24 59 43 50 51 Z" transform="rotate(60 50 50)"/>'
    +   '<path d="M50 51 C41 43 37 24 45 12 C47.5 8.5 52.5 8.5 55 12 C63 24 59 43 50 51 Z" transform="rotate(180 50 50)"/>'
    +   '<path d="M50 51 C41 43 37 24 45 12 C47.5 8.5 52.5 8.5 55 12 C63 24 59 43 50 51 Z" transform="rotate(300 50 50)"/>'
    + '</g>'
    + '<g id="fl-lily-ribs" fill="none" stroke-width="1" opacity=".35">'
    +   '<path d="M50 47 C49.4 36 49.4 24 50 11" transform="rotate(60 50 50)"/>'
    +   '<path d="M50 47 C49.4 36 49.4 24 50 11" transform="rotate(180 50 50)"/>'
    +   '<path d="M50 47 C49.4 36 49.4 24 50 11" transform="rotate(300 50 50)"/>'
    + '</g>'
    + '<g id="fl-lily-stamens" stroke-linecap="round">'
    +   '<g transform="rotate(-38 50 50)"><path d="M50 50 C50 43 49 36 45.5 30" stroke-width="1.2" fill="none"/><ellipse cx="45" cy="28.6" rx="3" ry="1.6" transform="rotate(-30 45 28.6)" stroke="none"/></g>'
    +   '<g transform="rotate(-13 50 50)"><path d="M50 50 C50 42 49 35 46.5 29" stroke-width="1.2" fill="none"/><ellipse cx="46" cy="27.6" rx="3" ry="1.6" transform="rotate(-22 46 27.6)" stroke="none"/></g>'
    +   '<g transform="rotate(13 50 50)"><path d="M50 50 C50 42 51 35 53.5 29" stroke-width="1.2" fill="none"/><ellipse cx="54" cy="27.6" rx="3" ry="1.6" transform="rotate(22 54 27.6)" stroke="none"/></g>'
    +   '<g transform="rotate(38 50 50)"><path d="M50 50 C50 43 51 36 54.5 30" stroke-width="1.2" fill="none"/><ellipse cx="55" cy="28.6" rx="3" ry="1.6" transform="rotate(30 55 28.6)" stroke="none"/></g>'
    + '</g>'
    + '<g id="fl-lily-speckles">'
    +   '<g><circle cx="48" cy="35" r="1"/><circle cx="52" cy="31" r=".9"/><circle cx="49" cy="27" r=".8"/><circle cx="51.5" cy="38" r="1"/><circle cx="47.5" cy="30" r=".7"/></g>'
    +   '<g transform="rotate(120 50 50)"><circle cx="48" cy="35" r="1"/><circle cx="52" cy="31" r=".9"/><circle cx="49" cy="27" r=".8"/></g>'
    +   '<g transform="rotate(240 50 50)"><circle cx="48" cy="35" r="1"/><circle cx="52" cy="31" r=".9"/><circle cx="51.5" cy="38" r="1"/></g>'
    + '</g>'
    + '<g id="fl-lily-pink" filter="url(#flt-soft)">'
    +   '<use href="#fl-shadow"/>'
    +   '<use href="#fl-lily-back" fill="url(#flg-lp-petalB)"/>'
    +   '<use href="#fl-lily-speckles" fill="#c2547d" opacity=".65"/>'
    +   '<use href="#fl-lily-front" fill="url(#flg-lp-petal)"/>'
    +   '<use href="#fl-lily-ribs" stroke="#d989ab"/>'
    +   '<g stroke="#f6e3ae" fill="#d9622f"><use href="#fl-lily-stamens"/></g>'
    + '</g>'
    + '<g id="fl-lily-white" filter="url(#flt-soft)">'
    +   '<use href="#fl-shadow"/>'
    +   '<use href="#fl-lily-back" fill="url(#flg-lw-petalB)"/>'
    +   '<use href="#fl-lily-front" fill="url(#flg-lw-petal)"/>'
    +   '<use href="#fl-lily-ribs" stroke="#d8d0a9"/>'
    +   '<g stroke="#e5d094" fill="#c48c50"><use href="#fl-lily-stamens"/></g>'
    + '</g>'
    + '<g id="fl-lily-gold" filter="url(#flt-soft)">'
    +   '<use href="#fl-shadow"/>'
    +   '<use href="#fl-lily-back" fill="url(#flg-lg-petalB)"/>'
    +   '<use href="#fl-lily-speckles" fill="#9a682e" opacity=".5"/>'
    +   '<use href="#fl-lily-front" fill="url(#flg-lg-petal)"/>'
    +   '<use href="#fl-lily-ribs" stroke="#d09c55"/>'
    +   '<g stroke="#f8ecc9" fill="#a06630"><use href="#fl-lily-stamens"/></g>'
    + '</g>'

    /* --- rose: three cupped whorls deepening toward a spiral heart --- */
    + '<g id="fl-rose-petal"><path d="M50 50 C31 44 22 26 33 13 C43 3 57 3 67 13 C78 26 69 44 50 50 Z"/></g>'
    + '<g id="fl-rose-whorlO">'
    +   '<use href="#fl-rose-petal"/><use href="#fl-rose-petal" transform="rotate(51.4 50 50)"/><use href="#fl-rose-petal" transform="rotate(102.8 50 50)"/><use href="#fl-rose-petal" transform="rotate(154.2 50 50)"/><use href="#fl-rose-petal" transform="rotate(205.6 50 50)"/><use href="#fl-rose-petal" transform="rotate(257 50 50)"/><use href="#fl-rose-petal" transform="rotate(308.4 50 50)"/>'
    + '</g>'
    + '<g id="fl-rose" filter="url(#flt-soft)">'
    +   '<use href="#fl-shadow"/>'
    +   '<use href="#fl-rose-whorlO" fill="url(#flg-rose-petalO)" stroke="#c07a5c" stroke-width=".6" stroke-opacity=".25"/>'
    +   '<g transform="rotate(25.7 50 50) translate(50 50) scale(.7) translate(-50 -50)">'
    +     '<use href="#fl-rose-whorlO" fill="url(#flg-rose-petalM)" stroke="#b56f4f" stroke-width=".8" stroke-opacity=".3"/>'
    +   '</g>'
    +   '<g transform="rotate(46 50 50) translate(50 50) scale(.45) translate(-50 -50)">'
    +     '<use href="#fl-rose-whorlO" fill="url(#flg-rose-petalI)" stroke="#a9603c" stroke-width="1" stroke-opacity=".3"/>'
    +   '</g>'
    +   '<circle cx="50" cy="50" r="8.5" fill="url(#flg-rose-core)"/>'
    +   '<path d="M56 47 A7.5 7.5 0 1 0 50 57" stroke="#a25a3c" stroke-width="1.8" fill="none" opacity=".45"/>'
    +   '<path d="M53 48.5 A4 4 0 1 0 50 53.5" stroke="#a25a3c" stroke-width="1.4" fill="none" opacity=".5"/>'
    +   '<ellipse cx="42" cy="24" rx="10" ry="5" transform="rotate(-32 42 24)" fill="#ffffff" opacity=".22"/>'
    + '</g>'

    /* --- daisy: two rings of slim white petals, gold heart --- */
    + '<g id="fl-daisy-petal-back"><ellipse cx="50" cy="21" rx="6.5" ry="16"/></g>'
    + '<g id="fl-daisy-petal-front"><ellipse cx="50" cy="23" rx="6" ry="14.5"/></g>'
    + '<g id="fl-daisy-white" filter="url(#flt-soft)">'
    +   '<use href="#fl-shadow"/>'
    +   '<g fill="#e7e3d3">'
    +     '<use href="#fl-daisy-petal-back"/><use href="#fl-daisy-petal-back" transform="rotate(27.7 50 50)"/><use href="#fl-daisy-petal-back" transform="rotate(55.4 50 50)"/><use href="#fl-daisy-petal-back" transform="rotate(83.1 50 50)"/><use href="#fl-daisy-petal-back" transform="rotate(110.8 50 50)"/><use href="#fl-daisy-petal-back" transform="rotate(138.5 50 50)"/><use href="#fl-daisy-petal-back" transform="rotate(166.2 50 50)"/><use href="#fl-daisy-petal-back" transform="rotate(193.9 50 50)"/><use href="#fl-daisy-petal-back" transform="rotate(221.6 50 50)"/><use href="#fl-daisy-petal-back" transform="rotate(249.3 50 50)"/><use href="#fl-daisy-petal-back" transform="rotate(277 50 50)"/><use href="#fl-daisy-petal-back" transform="rotate(304.7 50 50)"/><use href="#fl-daisy-petal-back" transform="rotate(332.4 50 50)"/>'
    +   '</g>'
    +   '<g fill="url(#flg-daisy-petal)">'
    +     '<use href="#fl-daisy-petal-front" transform="rotate(13.85 50 50)"/><use href="#fl-daisy-petal-front" transform="rotate(41.55 50 50)"/><use href="#fl-daisy-petal-front" transform="rotate(69.25 50 50)"/><use href="#fl-daisy-petal-front" transform="rotate(96.95 50 50)"/><use href="#fl-daisy-petal-front" transform="rotate(124.65 50 50)"/><use href="#fl-daisy-petal-front" transform="rotate(152.35 50 50)"/><use href="#fl-daisy-petal-front" transform="rotate(180.05 50 50)"/><use href="#fl-daisy-petal-front" transform="rotate(207.75 50 50)"/><use href="#fl-daisy-petal-front" transform="rotate(235.45 50 50)"/><use href="#fl-daisy-petal-front" transform="rotate(263.15 50 50)"/><use href="#fl-daisy-petal-front" transform="rotate(290.85 50 50)"/><use href="#fl-daisy-petal-front" transform="rotate(318.55 50 50)"/><use href="#fl-daisy-petal-front" transform="rotate(346.25 50 50)"/>'
    +   '</g>'
    +   '<circle cx="50" cy="50" r="10.5" fill="url(#flg-daisy-core)"/>'
    +   '<path d="M41 54 A10.5 10.5 0 0 0 59 54 A13 8 0 0 1 41 54 Z" fill="#a4791f" opacity=".28"/>'
    +   '<g fill="#b08428" opacity=".6"><circle cx="46" cy="47" r="1"/><circle cx="53" cy="46" r="1"/><circle cx="55" cy="51" r="1"/><circle cx="50" cy="54" r="1"/><circle cx="45" cy="52" r="1"/><circle cx="50" cy="49" r="1"/></g>'
    +   '<circle cx="46.5" cy="45.5" r="2.2" fill="#ffe9ad" opacity=".8"/>'
    + '</g>'

    /* --- zinnia: layered pointed petals, coral --- */
    + '<g id="fl-zinnia-petal-out"><path d="M50 50 C44.5 40 43.5 26 47 16.5 C48.3 13.2 51.7 13.2 53 16.5 C56.5 26 55.5 40 50 50 Z"/></g>'
    + '<g id="fl-zinnia-petal-in"><path d="M50 50 C45.5 42 45.4 32 48 24.8 C48.9 22.3 51.1 22.3 52 24.8 C54.6 32 54.5 42 50 50 Z"/></g>'
    + '<g id="fl-zinnia" filter="url(#flt-soft)">'
    +   '<use href="#fl-shadow"/>'
    +   '<g fill="url(#flg-zin-petalO)">'
    +     '<use href="#fl-zinnia-petal-out"/><use href="#fl-zinnia-petal-out" transform="rotate(30 50 50)"/><use href="#fl-zinnia-petal-out" transform="rotate(60 50 50)"/><use href="#fl-zinnia-petal-out" transform="rotate(90 50 50)"/><use href="#fl-zinnia-petal-out" transform="rotate(120 50 50)"/><use href="#fl-zinnia-petal-out" transform="rotate(150 50 50)"/><use href="#fl-zinnia-petal-out" transform="rotate(180 50 50)"/><use href="#fl-zinnia-petal-out" transform="rotate(210 50 50)"/><use href="#fl-zinnia-petal-out" transform="rotate(240 50 50)"/><use href="#fl-zinnia-petal-out" transform="rotate(270 50 50)"/><use href="#fl-zinnia-petal-out" transform="rotate(300 50 50)"/><use href="#fl-zinnia-petal-out" transform="rotate(330 50 50)"/>'
    +   '</g>'
    +   '<g fill="url(#flg-zin-petalI)">'
    +     '<use href="#fl-zinnia-petal-in" transform="rotate(15 50 50)"/><use href="#fl-zinnia-petal-in" transform="rotate(60 50 50)"/><use href="#fl-zinnia-petal-in" transform="rotate(105 50 50)"/><use href="#fl-zinnia-petal-in" transform="rotate(150 50 50)"/><use href="#fl-zinnia-petal-in" transform="rotate(195 50 50)"/><use href="#fl-zinnia-petal-in" transform="rotate(240 50 50)"/><use href="#fl-zinnia-petal-in" transform="rotate(285 50 50)"/><use href="#fl-zinnia-petal-in" transform="rotate(330 50 50)"/>'
    +   '</g>'
    +   '<circle cx="50" cy="50" r="7.5" fill="#7d4a30"/>'
    +   '<path d="M43.5 53 A7.5 7.5 0 0 0 56.5 53 A9 5.5 0 0 1 43.5 53 Z" fill="#63381f" opacity=".4"/>'
    +   '<circle cx="47.5" cy="47" r="2" fill="#ab7448" opacity=".8"/>'
    +   '<g fill="#eebd4e"><circle cx="50" cy="41.5" r="1.2"/><circle cx="56.5" cy="44.5" r="1.2"/><circle cx="58.5" cy="51" r="1.2"/><circle cx="54.5" cy="56.5" r="1.2"/><circle cx="46.5" cy="57" r="1.2"/><circle cx="42" cy="51.5" r="1.2"/><circle cx="43.5" cy="44.5" r="1.2"/></g>'
    + '</g>'

    /* --- hydrangea: cluster of 4-petal florets, lilac blue --- */
    + '<g id="fl-hyd-floret"><g><ellipse cx="0" cy="-8" rx="7.5" ry="10"/><ellipse cx="8" cy="0" rx="10" ry="7.5"/><ellipse cx="0" cy="8" rx="7.5" ry="10"/><ellipse cx="-8" cy="0" rx="10" ry="7.5"/></g></g>'
    + '<g id="fl-hydrangea" filter="url(#flt-soft)">'
    +   '<use href="#fl-shadow"/>'
    +   '<g transform="translate(50 28) scale(.85)" fill="#adbbdf"><use href="#fl-hyd-floret"/><circle r="3" fill="#7181b8"/></g>'
    +   '<g transform="translate(69 39) scale(.8) rotate(20)" fill="#c2b3de"><use href="#fl-hyd-floret"/><circle r="3" fill="#8a7cb5"/></g>'
    +   '<g transform="translate(69 61) scale(.82) rotate(-15)" fill="#9fb0d8"><use href="#fl-hyd-floret"/><circle r="3" fill="#6d7fb2"/></g>'
    +   '<g transform="translate(50 72) scale(.85) rotate(12)" fill="#b9c4e4"><use href="#fl-hyd-floret"/><circle r="3" fill="#7d8bbd"/></g>'
    +   '<g transform="translate(31 61) scale(.8) rotate(-22)" fill="#c2b3de"><use href="#fl-hyd-floret"/><circle r="3" fill="#8a7cb5"/></g>'
    +   '<g transform="translate(31 39) scale(.82) rotate(18)" fill="#a4b6dd"><use href="#fl-hyd-floret"/><circle r="3" fill="#7181b8"/></g>'
    +   '<g transform="translate(50 50) scale(.9)" fill="#b4c0e2"><use href="#fl-hyd-floret"/><circle r="3.2" fill="#76649e"/></g>'
    + '</g>'

    /* --- anemone: blush petals, inky heart --- */
    + '<g id="fl-anemone-petal"><path d="M50 50 C36 46 28 32 36 19 C44 8 56 8 64 19 C72 32 64 46 50 50 Z"/></g>'
    + '<g id="fl-anemone" filter="url(#flt-soft)">'
    +   '<use href="#fl-shadow"/>'
    +   '<g fill="url(#flg-anem-petal)" stroke="#d29a89" stroke-width=".5" stroke-opacity=".28">'
    +     '<use href="#fl-anemone-petal"/><use href="#fl-anemone-petal" transform="rotate(51.4 50 50)"/><use href="#fl-anemone-petal" transform="rotate(102.8 50 50)"/><use href="#fl-anemone-petal" transform="rotate(154.2 50 50)"/><use href="#fl-anemone-petal" transform="rotate(205.6 50 50)"/><use href="#fl-anemone-petal" transform="rotate(257 50 50)"/><use href="#fl-anemone-petal" transform="rotate(308.4 50 50)"/>'
    +   '</g>'
    +   '<circle cx="50" cy="50" r="8.5" fill="#3a3442"/>'
    +   '<circle cx="47" cy="47" r="2.6" fill="#655e70" opacity=".9"/>'
    +   '<g fill="#595264"><circle cx="50" cy="37.5" r="1.4"/><circle cx="56" cy="39" r="1.4"/><circle cx="60.5" cy="43.5" r="1.4"/><circle cx="62.5" cy="50" r="1.4"/><circle cx="60.5" cy="56.5" r="1.4"/><circle cx="56" cy="61" r="1.4"/><circle cx="50" cy="62.5" r="1.4"/><circle cx="44" cy="61" r="1.4"/><circle cx="39.5" cy="56.5" r="1.4"/><circle cx="37.5" cy="50" r="1.4"/><circle cx="39.5" cy="43.5" r="1.4"/><circle cx="44" cy="39" r="1.4"/></g>'
    + '</g>'

    /* --- plumeria: 5 pinwheel petals, gold throat --- */
    + '<g id="fl-plumeria-petal"><path d="M50 50 C37 45 32 30 41 18 C49 8 61 11 62 23 C63 36 58 46 50 50 Z"/></g>'
    + '<g id="fl-plumeria" filter="url(#flt-soft)">'
    +   '<use href="#fl-shadow"/>'
    +   '<g fill="url(#flg-plumeria)" stroke="#e3cf9e" stroke-width=".5" stroke-opacity=".55">'
    +     '<use href="#fl-plumeria-petal"/><use href="#fl-plumeria-petal" transform="rotate(72 50 50)"/><use href="#fl-plumeria-petal" transform="rotate(144 50 50)"/><use href="#fl-plumeria-petal" transform="rotate(216 50 50)"/><use href="#fl-plumeria-petal" transform="rotate(288 50 50)"/>'
    +   '</g>'
    +   '<circle cx="50" cy="50" r="6" fill="#eeb23c" opacity=".85"/>'
    + '</g>'

    /* --- sunflower: two rings of golden petals, seeded brown heart --- */
    + '<g id="fl-sun-petal-b"><path d="M50 50 C45 40 44 26 47.4 14 C48.4 10.8 51.6 10.8 52.6 14 C56 26 55 40 50 50 Z"/></g>'
    + '<g id="fl-sun-petal-f"><path d="M50 50 C45.6 41 45 29 47.8 20 C48.7 17.2 51.3 17.2 52.2 20 C55 29 54.4 41 50 50 Z"/></g>'
    + '<g id="fl-sunflower" filter="url(#flt-soft)">'
    +   '<use href="#fl-shadow"/>'
    +   '<g fill="url(#flg-sun-petalB)">'
    +     '<use href="#fl-sun-petal-b"/><use href="#fl-sun-petal-b" transform="rotate(27.7 50 50)"/><use href="#fl-sun-petal-b" transform="rotate(55.4 50 50)"/><use href="#fl-sun-petal-b" transform="rotate(83.1 50 50)"/><use href="#fl-sun-petal-b" transform="rotate(110.8 50 50)"/><use href="#fl-sun-petal-b" transform="rotate(138.5 50 50)"/><use href="#fl-sun-petal-b" transform="rotate(166.2 50 50)"/><use href="#fl-sun-petal-b" transform="rotate(193.9 50 50)"/><use href="#fl-sun-petal-b" transform="rotate(221.6 50 50)"/><use href="#fl-sun-petal-b" transform="rotate(249.3 50 50)"/><use href="#fl-sun-petal-b" transform="rotate(277 50 50)"/><use href="#fl-sun-petal-b" transform="rotate(304.7 50 50)"/><use href="#fl-sun-petal-b" transform="rotate(332.4 50 50)"/>'
    +   '</g>'
    +   '<g fill="url(#flg-sun-petal)">'
    +     '<use href="#fl-sun-petal-f" transform="rotate(13.85 50 50)"/><use href="#fl-sun-petal-f" transform="rotate(41.55 50 50)"/><use href="#fl-sun-petal-f" transform="rotate(69.25 50 50)"/><use href="#fl-sun-petal-f" transform="rotate(96.95 50 50)"/><use href="#fl-sun-petal-f" transform="rotate(124.65 50 50)"/><use href="#fl-sun-petal-f" transform="rotate(152.35 50 50)"/><use href="#fl-sun-petal-f" transform="rotate(180.05 50 50)"/><use href="#fl-sun-petal-f" transform="rotate(207.75 50 50)"/><use href="#fl-sun-petal-f" transform="rotate(235.45 50 50)"/><use href="#fl-sun-petal-f" transform="rotate(263.15 50 50)"/><use href="#fl-sun-petal-f" transform="rotate(290.85 50 50)"/><use href="#fl-sun-petal-f" transform="rotate(318.55 50 50)"/><use href="#fl-sun-petal-f" transform="rotate(346.25 50 50)"/>'
    +   '</g>'
    +   '<circle cx="50" cy="50" r="15" fill="url(#flg-sun-core)"/>'
    +   '<path d="M37 55 A15 15 0 0 0 63 55 A18 11 0 0 1 37 55 Z" fill="#4e3418" opacity=".4"/>'
    +   '<g fill="#8a6238" opacity=".85"><circle cx="50" cy="43" r="1.3"/><circle cx="56" cy="45" r="1.3"/><circle cx="59" cy="50" r="1.3"/><circle cx="57" cy="56" r="1.3"/><circle cx="51" cy="58" r="1.3"/><circle cx="44" cy="56" r="1.3"/><circle cx="41" cy="50" r="1.3"/><circle cx="44" cy="45" r="1.3"/><circle cx="50" cy="50" r="1.3"/></g>'
    +   '<circle cx="45" cy="45" r="3.4" fill="#a87c48" opacity=".7"/>'
    + '</g>'

    /* --- dahlia: dense pom-pom of rounded petals, three layers --- */
    + '<g id="fl-dah-petal"><path d="M50 50 C44 42 43 30 47 20 C48.4 16.6 51.6 16.6 53 20 C57 30 56 42 50 50 Z"/></g>'
    + '<g id="fl-dah-ring">'
    +   '<use href="#fl-dah-petal"/><use href="#fl-dah-petal" transform="rotate(30 50 50)"/><use href="#fl-dah-petal" transform="rotate(60 50 50)"/><use href="#fl-dah-petal" transform="rotate(90 50 50)"/><use href="#fl-dah-petal" transform="rotate(120 50 50)"/><use href="#fl-dah-petal" transform="rotate(150 50 50)"/><use href="#fl-dah-petal" transform="rotate(180 50 50)"/><use href="#fl-dah-petal" transform="rotate(210 50 50)"/><use href="#fl-dah-petal" transform="rotate(240 50 50)"/><use href="#fl-dah-petal" transform="rotate(270 50 50)"/><use href="#fl-dah-petal" transform="rotate(300 50 50)"/><use href="#fl-dah-petal" transform="rotate(330 50 50)"/>'
    + '</g>'
    + '<g id="fl-dahlia-or" filter="url(#flt-soft)">'
    +   '<use href="#fl-shadow"/>'
    +   '<use href="#fl-dah-ring" fill="url(#flg-dahO-out)"/>'
    +   '<g transform="rotate(15 50 50) translate(50 50) scale(.72) translate(-50 -50)"><use href="#fl-dah-ring" fill="url(#flg-dahO-mid)"/></g>'
    +   '<g transform="rotate(30 50 50) translate(50 50) scale(.46) translate(-50 -50)"><use href="#fl-dah-ring" fill="url(#flg-dahO-out)"/></g>'
    +   '<circle cx="50" cy="50" r="5.5" fill="#a4552f"/><circle cx="48.4" cy="48.4" r="1.8" fill="#c97f52"/>'
    + '</g>'
    + '<g id="fl-dahlia-pe" filter="url(#flt-soft)">'
    +   '<use href="#fl-shadow"/>'
    +   '<use href="#fl-dah-ring" fill="url(#flg-dahP-out)"/>'
    +   '<g transform="rotate(15 50 50) translate(50 50) scale(.72) translate(-50 -50)"><use href="#fl-dah-ring" fill="url(#flg-dahP-mid)"/></g>'
    +   '<g transform="rotate(30 50 50) translate(50 50) scale(.46) translate(-50 -50)"><use href="#fl-dah-ring" fill="url(#flg-dahP-out)"/></g>'
    +   '<circle cx="50" cy="50" r="5.5" fill="#bd7a48"/><circle cx="48.4" cy="48.4" r="1.8" fill="#e0a26e"/>'
    + '</g>'

    /* --- iris: three hanging falls, three pale standards, gold beards --- */
    + '<g id="fl-iris-fall"><path d="M50 50 C42 54 35 64 37.5 76 C39 84 47 88 50 83.5 C53 88 61 84 62.5 76 C65 64 58 54 50 50 Z"/></g>'
    + '<g id="fl-iris-std"><path d="M50 50 C43 44 39.5 32 45 22 C48 16.4 52 16.4 55 22 C60.5 32 57 44 50 50 Z"/></g>'
    + '<g id="fl-iris" filter="url(#flt-soft)">'
    +   '<use href="#fl-shadow"/>'
    +   '<g fill="url(#flg-iris-std)">'
    +     '<use href="#fl-iris-std"/><use href="#fl-iris-std" transform="rotate(120 50 50)"/><use href="#fl-iris-std" transform="rotate(240 50 50)"/>'
    +   '</g>'
    +   '<g fill="url(#flg-iris-fall)" stroke="#4d3f80" stroke-width=".6" stroke-opacity=".3">'
    +     '<use href="#fl-iris-fall"/><use href="#fl-iris-fall" transform="rotate(120 50 50)"/><use href="#fl-iris-fall" transform="rotate(240 50 50)"/>'
    +   '</g>'
    +   '<g fill="#e9c05a"><ellipse cx="50" cy="61" rx="2.6" ry="5.5"/><ellipse cx="50" cy="61" rx="2.6" ry="5.5" transform="rotate(120 50 50)"/><ellipse cx="50" cy="61" rx="2.6" ry="5.5" transform="rotate(240 50 50)"/></g>'
    +   '<circle cx="50" cy="50" r="4.5" fill="#5c4d96"/>'
    + '</g>'

    /* --- cosmos: eight wide notched petals, sunny heart --- */
    + '<g id="fl-cos-petal"><path d="M50 50 C41.5 46 36.5 36 39 25.5 C40.3 20 44.8 18.4 46.8 22.6 L50 28.6 L53.2 22.6 C55.2 18.4 59.7 20 61 25.5 C63.5 36 58.5 46 50 50 Z"/></g>'
    + '<g id="fl-cosmos" filter="url(#flt-soft)">'
    +   '<use href="#fl-shadow"/>'
    +   '<g fill="url(#flg-cos-petal)" stroke="#bd6f8e" stroke-width=".5" stroke-opacity=".3">'
    +     '<use href="#fl-cos-petal"/><use href="#fl-cos-petal" transform="rotate(45 50 50)"/><use href="#fl-cos-petal" transform="rotate(90 50 50)"/><use href="#fl-cos-petal" transform="rotate(135 50 50)"/><use href="#fl-cos-petal" transform="rotate(180 50 50)"/><use href="#fl-cos-petal" transform="rotate(225 50 50)"/><use href="#fl-cos-petal" transform="rotate(270 50 50)"/><use href="#fl-cos-petal" transform="rotate(315 50 50)"/>'
    +   '</g>'
    +   '<circle cx="50" cy="50" r="7" fill="#e2a83c"/>'
    +   '<g fill="#b57d1f" opacity=".8"><circle cx="47" cy="47.5" r="1"/><circle cx="53" cy="47.5" r="1"/><circle cx="50" cy="53" r="1"/><circle cx="46.5" cy="52" r="1"/><circle cx="53.5" cy="52" r="1"/><circle cx="50" cy="49" r="1"/></g>'
    + '</g>'

    /* --- leaf sprig --- */
    + '<g id="fl-leaf">'
    +   '<path d="M50 90 C50 62 50 36 50 10" stroke="#7d9a6b" stroke-width="2.5" fill="none" stroke-linecap="round"/>'
    +   '<ellipse cx="42" cy="28" rx="6" ry="13" transform="rotate(-36 42 28)" fill="url(#flg-leaf-blade)" opacity=".95"/>'
    +   '<ellipse cx="58" cy="24" rx="6" ry="13" transform="rotate(36 58 24)" fill="url(#flg-leaf-blade)" opacity=".85"/>'
    +   '<ellipse cx="40" cy="48" rx="6" ry="13" transform="rotate(-40 40 48)" fill="url(#flg-leaf-blade)" opacity=".85"/>'
    +   '<ellipse cx="60" cy="46" rx="6" ry="13" transform="rotate(40 60 46)" fill="url(#flg-leaf-blade)" opacity=".95"/>'
    +   '<ellipse cx="42" cy="68" rx="6" ry="13" transform="rotate(-42 42 68)" fill="url(#flg-leaf-blade)" opacity=".95"/>'
    +   '<ellipse cx="58" cy="66" rx="6" ry="13" transform="rotate(42 58 66)" fill="url(#flg-leaf-blade)" opacity=".85"/>'
    + '</g>'

    /* --- torn-paper watercolor envelope (viewBoxes: pocket 300x200,
       flap 300x112, rising letter 260x160) --- */
    + '<linearGradient id="flg-kraft" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#eee0bf"/><stop offset="100%" stop-color="#d9c096"/></linearGradient>'
    + '<linearGradient id="flg-kraftD" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#e6d3ab"/><stop offset="100%" stop-color="#cdb184"/></linearGradient>'
    + '<g id="fl-env-pocket">'
    +   '<path d="M8 18 C60 10 120 12 150 11 C200 9 260 8 293 14 L296 100 C297 140 295 170 292 188 C230 196 180 193 150 194 C100 196 40 197 7 190 C4 150 5 90 8 18 Z" fill="url(#flg-kraft)" stroke="#c3a271" stroke-width="1.4" stroke-opacity=".5"/>'
    +   '<ellipse cx="70" cy="60" rx="46" ry="26" fill="#b7955f" opacity=".1"/>'
    +   '<ellipse cx="235" cy="140" rx="52" ry="30" fill="#b7955f" opacity=".12"/>'
    +   '<ellipse cx="150" cy="90" rx="60" ry="34" fill="#fdf6e2" opacity=".14"/>'
    +   '<path d="M8 18 L146 120 C149 122 151 122 154 120 L293 14 L294 40 L157 140 C152 143 148 143 143 140 L7 42 Z" fill="#c9ab78" opacity=".18"/>'
    +   '<path d="M7 190 L143 96 C148 93 152 93 157 96 L292 188 C230 196 180 193 150 194 C100 196 40 197 7 190 Z" fill="url(#flg-kraftD)" opacity=".85"/>'
    +   '<path d="M7 190 L143 96 M157 96 L292 188" stroke="#b89a6a" stroke-width="1" opacity=".35" fill="none"/>'
    + '</g>'
    + '<g id="fl-env-flap">'
    +   '<path d="M5 2 C80 -1 220 -1 295 2 C272 26 206 78 163 102 C155 107 145 107 137 102 C94 78 28 26 5 2 Z" fill="url(#flg-kraftD)" stroke="#c3a271" stroke-width="1.3" stroke-opacity=".55"/>'
    +   '<ellipse cx="105" cy="34" rx="40" ry="20" fill="#b7955f" opacity=".1"/>'
    +   '<ellipse cx="205" cy="40" rx="36" ry="18" fill="#fdf6e2" opacity=".16"/>'
    +   '<g transform="translate(150 12)">'
    +     '<path d="M0 84 C-1 60 -1 30 0 6" stroke="#7d9464" stroke-width="2.2" fill="none" stroke-linecap="round"/>'
    +     '<path d="M0 46 C-9 38 -18 32 -26 22" stroke="#8a7cae" stroke-width="1.8" fill="none" stroke-linecap="round"/>'
    +     '<path d="M0 52 C10 44 22 40 30 34" stroke="#7d9464" stroke-width="1.8" fill="none" stroke-linecap="round"/>'
    +     '<ellipse cx="16" cy="46" rx="8.5" ry="3.6" transform="rotate(-28 16 46)" fill="#93ab86"/>'
    +     '<ellipse cx="25" cy="41" rx="8" ry="3.4" transform="rotate(-24 25 41)" fill="#a6bb96" opacity=".9"/>'
    +     '<ellipse cx="33" cy="36" rx="7" ry="3" transform="rotate(-20 33 36)" fill="#93ab86"/>'
    +     '<circle cx="-12" cy="36" r="3.1" fill="#8a6fae"/><circle cx="-18" cy="30" r="2.8" fill="#9d84bd"/><circle cx="-23" cy="24" r="2.6" fill="#8a6fae"/><circle cx="-8" cy="42" r="2.9" fill="#a48fc4"/>'
    +     '<path d="M-3 10 C-7 12 -8 19 -4 22 C-1 24 3 24 6 22 C10 19 9 12 5 10 C2 8.5 0 8.5 -3 10 Z" fill="#e8a2b5"/>'
    +     '<path d="M6 22 C3 26 -1 26 -4 22" stroke="#c97e97" stroke-width="1" fill="none"/>'
    +     '<path d="M-14 22 C-17 24 -18 29 -15 31 C-12 33 -9 32 -7 30 C-4 27 -6 22 -9 21 C-11 20.4 -12 20.6 -14 22 Z" fill="#eeb3c4" transform="rotate(-18 -11 26)"/>'
    +     '<path d="M13 18 C10 20 9 25 12 27 C15 29 18 28 20 26 C23 23 21 18 18 17 C16 16.4 15 16.6 13 18 Z" fill="#e8a2b5" transform="rotate(16 16 22)"/>'
    +   '</g>'
    + '</g>'
    + '<g id="fl-env-paper">'
    +   '<path d="M8 24 L20 17 L34 22 L48 15 L64 21 L80 15 L96 20 L112 14 L128 20 L144 15 L160 20 L176 14 L192 19 L208 15 L224 20 L238 16 L250 22 L252 60 L251 150 C170 154 90 154 9 151 L7 60 Z" fill="#f8f2df" stroke="#d9cba6" stroke-width="1" stroke-opacity=".7"/>'
    +   '<path d="M30 52 C90 47 170 47 228 51 M30 70 C86 65 160 65 224 69 M30 88 C96 83 168 84 218 87 M30 106 C80 102 130 102 170 104" stroke="#9a8c6e" stroke-width="1.3" fill="none" opacity=".5" stroke-linecap="round"/>'
    +   '<path d="M120 26 C116 29 115 36 119 39 C122 41 127 41 130 39 C135 36 134 29 130 26 C127 24 124 24 120 26 Z" fill="#a48fc4" opacity=".85"/>'
    +   '<circle cx="140" cy="34" r="4" fill="#8a6fae" opacity=".7"/>'
    + '</g>'

    /* --- wax seal --- */
    + '<g id="fl-seal">'
    +   '<path d="M50 7 C69 5 88 19 91 39 C94 61 81 84 59 90 C37 96 13 83 9 60 C5 38 17 15 38 9 C42 8 46 7.5 50 7 Z" fill="url(#flg-seal)"/>'
    +   '<ellipse cx="38" cy="28" rx="14" ry="8" transform="rotate(-30 38 28)" fill="#ffffff" opacity=".16"/>'
    +   '<circle cx="50" cy="51" r="19" stroke="#d9c8ee" stroke-width="2" fill="none" opacity=".5"/>'
    +   '<g fill="#cbb6e6" opacity=".8"><circle cx="50" cy="43" r="4.2"/><circle cx="57" cy="48.5" r="4.2"/><circle cx="54.5" cy="57" r="4.2"/><circle cx="45.5" cy="57" r="4.2"/><circle cx="43" cy="48.5" r="4.2"/><circle cx="50" cy="51" r="3.2" fill="#efe6fa"/></g>'
    + '</g>'
    + '</defs>';

  const FLOWER_SPRITE = '<svg width="0" height="0" style="position:absolute" aria-hidden="true">' + FLOWER_DEFS + '</svg>';

  /* ---------------- gift-view logic (used inside generated gift files) ---------------- */
  const THEMES = ['garden', 'kraft', 'night', 'blush'];

  /* Compose the revealed card into a downloadable PNG. Drawn by hand on
     a canvas (no external libraries) so it works in every browser. */
  function saveCardImage(data, theme) {
    const PAINT = {
      garden: { bg1: '#57683f', bg2: '#2e3a26', note: '#ece3cb', ink: '#4a4234', accent: '#6d7f4e', tb: '#efe8d4', tbd: '#33402a', ti: '#2e3a26' },
      kraft:  { bg1: '#c1a06d', bg2: '#8a6a3c', note: '#f3ead3', ink: '#5a4a30', accent: '#8a6a3c', tb: '#efe2c6', tbd: '#8a6a3c', ti: '#6b4f2a' },
      night:  { bg1: '#33355a', bg2: '#171a2e', note: '#e9e6d8', ink: '#3a3550', accent: '#8f93c8', tb: '#e6e3d4', tbd: '#454a7a', ti: '#3a3550' },
      blush:  { bg1: '#e7b7c6', bg2: '#d0819c', note: '#fff2f5', ink: '#7a4b58', accent: '#c06e88', tb: '#ffe6ee', tbd: '#c06e88', ti: '#8a4a60' }
    };
    const P = PAINT[theme] || PAINT.garden;
    const photos = (data.photos || []).slice(0, 4);
    const loads = photos.map((src) => new Promise((res) => {
      const im = new Image();
      im.onload = () => res(im);
      im.onerror = () => res(null);
      im.src = src;
    }));

    Promise.all(loads).then((imgsRaw) => {
      const imgs = imgsRaw.filter(Boolean);
      const S = 2;                 // supersample for crisp output
      const W = 920;
      const pad = 60;
      const noteX = 70, noteW = W - 140, noteIn = 40;
      const measure = document.createElement('canvas').getContext('2d');

      function wrap(text, font, maxW) {
        measure.font = font;
        const out = [];
        (text || '').split('\n').forEach((para) => {
          if (!para) { out.push(''); return; }
          let line = '';
          para.split(/\s+/).forEach((w) => {
            const t = line ? line + ' ' + w : w;
            if (measure.measureText(t).width > maxW && line) { out.push(line); line = w; }
            else line = t;
          });
          out.push(line);
        });
        return out;
      }

      const fFrom = '600 30px "Playfair Display", Georgia, serif';
      const fFor = '600 26px "Playfair Display", Georgia, serif';
      const fBody = 'italic 25px "Playfair Display", Georgia, serif';
      const fSign = 'italic 26px "Playfair Display", Georgia, serif';
      const fDate = '400 18px Poppins, system-ui, sans-serif';
      const bodyLines = wrap(data.message, fBody, noteW - noteIn * 2);

      // note height
      let ny = 46;
      ny += 40;                    // From
      ny += 34;                    // For
      ny += 16;
      ny += bodyLines.length * 38;
      ny += 30;                    // signature
      ny += 26;                    // date
      ny += 40;
      const noteH = ny;

      // photo band
      let photoH = 0, cols = 0, cellW = 0, cellH = 0;
      if (imgs.length) {
        cols = Math.min(imgs.length, 2);
        cellW = (noteW - (cols - 1) * 24) / cols;
        cellH = cellW * 0.9 + 46;              // frame + caption strip
        const rows = Math.ceil(imgs.length / cols);
        photoH = rows * cellH + (rows - 1) * 24 + 40;
      }

      // tiles
      const letters = (data.to || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8) || 'YOU';
      const tileSize = Math.min(96, (W - 140 - (letters.length - 1) * 14) / letters.length);
      const tilesH = tileSize + 60;

      const H = pad + noteH + photoH + tilesH + pad + 30;

      const canvas = document.createElement('canvas');
      canvas.width = W * S;
      canvas.height = H * S;
      const ctx = canvas.getContext('2d');
      ctx.scale(S, S);
      ctx.textBaseline = 'alphabetic';

      // themed background
      const g = ctx.createLinearGradient(0, 0, 0, H);
      g.addColorStop(0, P.bg1);
      g.addColorStop(1, P.bg2);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
      if (theme === 'night') {
        ctx.fillStyle = 'rgba(255,255,255,0.85)';
        for (let i = 0; i < 60; i++) {
          const sx = Math.random() * W, sy = Math.random() * H, sr = Math.random() * 1.4 + 0.3;
          ctx.globalAlpha = Math.random() * 0.7 + 0.3;
          ctx.beginPath(); ctx.arc(sx, sy, sr, 0, 7); ctx.fill();
        }
        ctx.globalAlpha = 1;
      }

      function roundRect(x, y, w, h, r) {
        ctx.beginPath();
        ctx.moveTo(x + r, y);
        ctx.arcTo(x + w, y, x + w, y + h, r);
        ctx.arcTo(x + w, y + h, x, y + h, r);
        ctx.arcTo(x, y + h, x, y, r);
        ctx.arcTo(x, y, x + w, y, r);
        ctx.closePath();
      }

      // note card
      const noteY = pad;
      ctx.save();
      ctx.shadowColor = 'rgba(0,0,0,0.35)';
      ctx.shadowBlur = 30; ctx.shadowOffsetY = 16;
      ctx.fillStyle = P.note;
      roundRect(noteX, noteY, noteW, noteH, 10);
      ctx.fill();
      ctx.restore();

      let ty = noteY + 56;
      const tx = noteX + noteIn;
      ctx.fillStyle = P.accent;
      ctx.font = fFrom;
      ctx.fillText('From: ' + (data.from || ''), tx, ty); ty += 40;
      ctx.fillStyle = P.ink;
      ctx.font = fFor;
      ctx.fillText('For ' + (data.to || ''), tx, ty); ty += 34 + 16;
      ctx.font = fBody;
      bodyLines.forEach((ln) => { ctx.fillText(ln, tx, ty); ty += 38; });
      ty += 6;
      ctx.fillStyle = P.accent;
      ctx.font = fSign;
      ctx.fillText(data.from ? '— ' + data.from : '', tx, ty); ty += 30;
      let dstr = '';
      if (data.date) { const d = new Date(data.date); if (!isNaN(d)) dstr = d.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }); }
      ctx.fillStyle = 'rgba(0,0,0,0.4)';
      ctx.font = fDate;
      ctx.fillText(dstr, tx, ty);

      // photos as framed polaroids
      let py = noteY + noteH + 40;
      if (imgs.length) {
        imgs.forEach((im, i) => {
          const col = i % cols, row = (i / cols) | 0;
          const cx = noteX + col * (cellW + 24);
          const cy = py + row * (cellH + 24);
          ctx.save();
          ctx.shadowColor = 'rgba(0,0,0,0.4)'; ctx.shadowBlur = 20; ctx.shadowOffsetY = 10;
          ctx.fillStyle = '#fdf9ee';
          roundRect(cx, cy, cellW, cellH, 4); ctx.fill();
          ctx.restore();
          const iw = cellW - 20, ih = cellH - 46;
          const ar = im.width / im.height, box = iw / ih;
          let sw = im.width, sh = im.height, sxo = 0, syo = 0;
          if (ar > box) { sw = im.height * box; sxo = (im.width - sw) / 2; }
          else { sh = im.width / box; syo = (im.height - sh) / 2; }
          ctx.drawImage(im, sxo, syo, sw, sh, cx + 10, cy + 10, iw, ih);
        });
      }

      // name tiles
      let tyTiles = noteY + noteH + photoH + 20;
      const rowW = letters.length * tileSize + (letters.length - 1) * 14;
      let txn = (W - rowW) / 2;
      for (let i = 0; i < letters.length; i++) {
        ctx.save();
        ctx.shadowColor = 'rgba(0,0,0,0.4)'; ctx.shadowBlur = 14; ctx.shadowOffsetY = 8;
        ctx.fillStyle = P.tb;
        roundRect(txn, tyTiles, tileSize, tileSize * 1.08, 5); ctx.fill();
        ctx.restore();
        ctx.lineWidth = tileSize * 0.08;
        ctx.strokeStyle = P.tbd;
        roundRect(txn, tyTiles, tileSize, tileSize * 1.08, 5); ctx.stroke();
        ctx.fillStyle = P.ti;
        ctx.font = '600 ' + Math.round(tileSize * 0.6) + 'px "Playfair Display", Georgia, serif';
        ctx.textAlign = 'center';
        ctx.fillText(letters[i], txn + tileSize / 2, tyTiles + tileSize * 0.78);
        ctx.textAlign = 'left';
        txn += tileSize + 14;
      }

      // footer
      ctx.fillStyle = theme === 'night' || theme === 'garden' ? 'rgba(255,255,255,0.7)' : 'rgba(0,0,0,0.45)';
      ctx.font = '400 18px Poppins, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('sent with love', W / 2, H - 34);
      ctx.textAlign = 'left';

      canvas.toBlob((blob) => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'bloom-card-for-' + ((data.to || 'you').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'you') + '.png';
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 4000);
      }, 'image/png');
    });
  }

  function renderLetter(data) {
    const message = data.message || '';
    $('letterFrom').textContent = 'From: ' + data.from;
    $('letterTo').textContent = 'For ' + data.to;
    $('letterBody').textContent = message; // typewriter overwrites this on reveal
    // a script-style signature and the date the gift was written
    $('letterSign').textContent = data.from ? '— ' + data.from : '';
    let dateStr = '';
    if (data.date) {
      const dt = new Date(data.date);
      if (!isNaN(dt)) dateStr = dt.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
    }
    $('letterDate').textContent = dateStr;

    // apply the chosen card theme to the board
    const theme = THEMES.indexOf(data.theme) >= 0 ? data.theme : 'garden';
    THEMES.forEach((t) => document.body.classList.remove('theme-' + t));
    document.body.classList.add('theme-' + theme);

    // alphabet tiles spelling the recipient across the scrapbook board
    const tileRow = $('tileRow');
    tileRow.innerHTML = '';
    const letters = (data.to || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8) || 'YOU';
    for (let i = 0; i < letters.length; i++) {
      const tile = document.createElement('div');
      tile.className = 'tile';
      tile.textContent = letters[i];
      tile.style.setProperty('--i', i);
      tile.style.setProperty('--tr', ((i % 2 ? 1 : -1) * (2.5 + ((i * 37) % 45) / 10)) + 'deg');
      tileRow.appendChild(tile);
    }

    // photos pinned to the board as tilted polaroids; tap one to enlarge
    const photoStack = $('photoStack');
    const lightbox = $('lightbox');
    const lightboxImg = $('lightboxImg');
    if (lightbox && !lightbox.dataset.wired) {
      lightbox.dataset.wired = '1';
      lightbox.addEventListener('click', () => lightbox.classList.add('hidden'));
    }
    if (photoStack) {
      photoStack.innerHTML = '';
      const photos = (data.photos || []).slice(0, 4);
      if (photos.length) {
        photoStack.classList.remove('hidden');
        photos.forEach((src, i) => {
          const fig = document.createElement('figure');
          fig.className = 'polaroid';
          fig.style.setProperty('--pi', i);
          fig.style.setProperty('--pr', ((i % 2 ? 1 : -1) * (2 + ((i * 29) % 45) / 10)) + 'deg');
          const img = document.createElement('img');
          img.src = src;
          img.alt = '';
          fig.appendChild(img);
          fig.addEventListener('click', () => {
            if (!lightbox) return;
            lightboxImg.src = src;
            lightbox.classList.remove('hidden');
          });
          photoStack.appendChild(fig);
        });
      } else {
        photoStack.classList.add('hidden');
      }
    }

    // save the card as a PNG keepsake, composed on a canvas so it works
    // in any browser with no external libraries
    const saveBtn = $('saveImgBtn');
    if (saveBtn && !saveBtn.dataset.wired) {
      saveBtn.dataset.wired = '1';
      saveBtn.addEventListener('click', () => saveCardImage(data, theme));
    }

    // background song — an uploaded audio file, embedded as a data URL
    // right in the gift, so it plays with no internet connection needed
    // (even from a downloaded file opened offline). It's hidden behind a
    // spinning vinyl record that acts as the play button. On reveal we
    // try to autoplay; where the browser blocks unmuted autoplay (common
    // on phones), one tap on the record starts it.
    const songSrc = (data.song && /^data:audio\//.test(data.song)) ? data.song : '';
    const songAudio = $('songAudio');
    if (songAudio && songSrc && songAudio.getAttribute('src') !== songSrc) {
      songAudio.src = songSrc;
    }
    function setDockPlaying(playing) {
      const dock = $('songDock');
      if (!dock) return;
      dock.classList.toggle('playing', playing);
      const now = dock.querySelector('.song-now');
      if (now) {
        now.innerHTML = playing
          ? '<span class="song-note">♪</span> now playing'
          : '<span class="song-note">▸</span> tap to play';
      }
    }
    if (songAudio && !songAudio.dataset.wired) {
      songAudio.dataset.wired = '1';
      songAudio.addEventListener('play', () => setDockPlaying(true));
      songAudio.addEventListener('pause', () => setDockPlaying(false));
    }
    // called from the reveal tap (a real user gesture, so autoplay with
    // sound is allowed)
    function startSong() {
      if (!songSrc || !songAudio) return;
      const dock = $('songDock');
      if (dock) dock.classList.remove('hidden');
      songAudio.currentTime = 0;
      songAudio.play().catch(() => setDockPlaying(false));
    }
    function stopSong() {
      if (songAudio) { songAudio.pause(); songAudio.currentTime = 0; }
      const dock = $('songDock');
      if (dock) { dock.classList.add('hidden'); dock.classList.remove('playing'); }
    }
    // tapping the record plays it (a guaranteed user gesture) or toggles
    // play/pause once it's going
    const vinylBtn = $('vinylBtn');
    if (vinylBtn && !vinylBtn.dataset.wired) {
      vinylBtn.dataset.wired = '1';
      vinylBtn.addEventListener('click', () => {
        if (!songAudio) return;
        if (songAudio.paused) songAudio.play().catch(() => {});
        else songAudio.pause();
      });
    }

    const stage = $('giftStage');
    stage.classList.remove('hidden');

    const envelope = $('envelope');
    const openHint = $('openHint');
    openHint.textContent = data.openText || 'Tap to open';
    const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    // Pink lilies lead the garden mix, supported by peachy roses and
    // dahlias, with daisies/hydrangeas/sunflowers and iris/cosmos accents.
    const VARIETIES = ['lily-pink', 'lily-pink', 'lily-pink', 'lily-pink', 'lily-pink', 'lily-pink',
      'rose', 'rose', 'rose', 'dahlia-pe', 'dahlia-pe', 'dahlia-or',
      'sunflower', 'sunflower', 'daisy-white', 'daisy-white', 'lily-white',
      'hydrangea', 'hydrangea', 'iris', 'cosmos', 'anemone', 'plumeria', 'zinnia'];

    // Type the letter body out character by character once the card is up.
    let typeTimer = null;
    function typewriteBody() {
      const el = $('letterBody');
      if (reduceMotion || message.length > 900) { el.textContent = message; return; }
      el.textContent = '';
      el.classList.add('typing');
      let i = 0;
      clearInterval(typeTimer);
      typeTimer = setInterval(() => {
        el.textContent = message.slice(0, ++i);
        if (i >= message.length) { clearInterval(typeTimer); el.classList.remove('typing'); }
      }, 26);
    }

    function openCard() {
      stage.classList.add('hidden');
      document.body.classList.add('card-mode');
      const cv = $('cardView');
      cv.classList.remove('hidden');
      // one frame later, flip on the transition so the whole board
      // eases up and fades in instead of snapping into place
      requestAnimationFrame(() => requestAnimationFrame(() => cv.classList.add('revealed')));
      window.scrollTo(0, 0);
      setTimeout(typewriteBody, 900);   // begins as the note settles in
      setTimeout(spawnConfetti, 700);   // gentle petal shimmer over the card
    }

    // A soft shower of petals/confetti drifting down over the revealed card.
    function spawnConfetti() {
      if (reduceMotion) return;
      const layer = document.createElement('div');
      layer.className = 'confetti-layer';
      const vw = window.innerWidth;
      const kinds = ['lily-pink', 'rose', 'daisy-white', 'cosmos', 'plumeria'];
      const R = (a, b) => a + Math.random() * (b - a);
      for (let i = 0; i < 26; i++) {
        const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        s.setAttribute('class', 'confetti');
        s.setAttribute('viewBox', '0 0 100 100');
        const sz = R(14, 30);
        s.setAttribute('width', sz); s.setAttribute('height', sz);
        const u = document.createElementNS('http://www.w3.org/2000/svg', 'use');
        u.setAttribute('href', '#fl-' + kinds[(Math.random() * kinds.length) | 0]);
        s.appendChild(u);
        s.style.cssText = 'left:' + R(0, vw) + 'px;--cx:' + R(-40, 40) + 'px;'
          + '--rot:' + R(-220, 220) + 'deg;--cdur:' + R(2.6, 4.6) + 's;--cdelay:' + R(0, 1.1) + 's;';
        layer.appendChild(s);
      }
      document.body.appendChild(layer);
      setTimeout(() => layer.remove(), 6500);
    }

    // Replay: reseal the envelope and return to the very start.
    const replayBtn = $('replayBtn');
    if (replayBtn && !replayBtn.dataset.wired) {
      replayBtn.dataset.wired = '1';
      replayBtn.addEventListener('click', () => {
        clearInterval(typeTimer);
        document.querySelectorAll('.flower-burst, .confetti-layer').forEach((n) => n.remove());
        const cv = $('cardView');
        cv.classList.add('hidden');
        cv.classList.remove('revealed');
        document.body.classList.remove('card-mode');
        // stop and rearm the song so it plays again on the next reveal
        stopSong();
        // bring the sealed envelope back and reset its open state
        envelope.classList.remove('open-flap');
        openHint.style.animation = '';
        openHint.style.opacity = '';
        openHint.style.transition = '';
        $('letterBody').textContent = message;
        stage.classList.remove('hidden');
        window.scrollTo(0, 0);
      });
    }

    function spawnBurst() {
      const overlay = document.createElement('div');
      overlay.className = 'flower-burst';
      const rect = envelope.getBoundingClientRect();
      const originX = rect.left + rect.width / 2;
      const originY = rect.top + rect.height * 0.4;
      const vw = window.innerWidth, vh = window.innerHeight;
      const R = (a, b) => a + Math.random() * (b - a);
      // Phyllotaxis spiral: flowers are laid out on a sunflower-seed
      // spiral around the envelope. Each one pops into place where it
      // lives (a short drift from the centre, a gentle scale-up with
      // a small overshoot), so the wall grows outward ring by ring.
      const GOLDEN_ANGLE = 2.39996;
      const maxR = Math.hypot(Math.max(originX, vw - originX), Math.max(originY, vh - originY)) + 90;
      let count = 0, maxEnd = 0;
      // i = -2..-1 plant two extra blooms right at the centre so the
      // heart of the spiral is never left bare.
      for (let i = -2; count < 190; i++) {
        const r = i < 0 ? 30 : 51 * Math.sqrt(i);
        if (r > maxR) break;
        const ang = i < 0 ? i * 2.7 : i * GOLDEN_ANGLE;
        const x = originX + r * Math.cos(ang);
        const y = originY + r * Math.sin(ang);
        if (x < -90 || x > vw + 90 || y < -90 || y > vh + 90) continue;
        count++;
        const variety = VARIETIES[(Math.random() * VARIETIES.length) | 0];
        // Pink lilies read as the focal bloom: a touch larger than the
        // rest of the garden so they stand out across the wall.
        const size = variety === 'lily-pink' ? R(155, 225) : R(130, 205);
        const el = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        el.setAttribute('class', 'burst-flower');
        el.setAttribute('viewBox', '0 0 100 100');
        el.setAttribute('width', size);
        el.setAttribute('height', size);
        const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
        use.setAttribute('href', '#fl-' + variety);
        el.appendChild(use);
        const r1 = R(-28, 28);
        const delay = 0.05 + (r / maxR) * 2.1 + R(0, 0.18);
        const dur = R(0.7, 0.95);
        if (delay + dur > maxEnd) maxEnd = delay + dur;
        // Fall path: a mid keyframe (--xf/--yf) lets each flower drift
        // sideways on its way down instead of dropping in a straight line.
        const fx = x - size / 2 + R(-110, 110);
        const fy = vh + 240;
        el.style.cssText = '--xa:' + (originX + r * 0.82 * Math.cos(ang) - size / 2) + 'px;'
          + '--ya:' + (originY + r * 0.82 * Math.sin(ang) - size / 2) + 'px;'
          + '--x1:' + (x - size / 2) + 'px;--y1:' + (y - size / 2) + 'px;'
          + '--r0:' + (r1 - R(12, 30)) + 'deg;--r1:' + r1 + 'deg;'
          + '--delay:' + delay + 's;--dur:' + dur + 's;'
          + '--xf:' + ((x - size / 2) + (fx - (x - size / 2)) * 0.45 + R(-45, 45)) + 'px;'
          + '--yf:' + ((y - size / 2) + (fy - (y - size / 2)) * 0.42) + 'px;'
          + '--rf:' + (r1 + R(-55, 55)) + 'deg;'
          + '--x2:' + fx + 'px;--y2:' + fy + 'px;'
          + '--r2:' + R(-160, 160) + 'deg;--fd:' + R(0, 0.5) + 's;';
        overlay.appendChild(el);
      }
      // Once the wall has fully bloomed, invite a tap; the flowers
      // hold (breathing gently) until the viewer reveals the card.
      const hint = document.createElement('p');
      hint.className = 'reveal-hint';
      hint.textContent = data.revealText || 'Tap to reveal';
      hint.style.setProperty('--hd', (maxEnd + 0.4) + 's');
      overlay.appendChild(hint);
      document.body.appendChild(overlay);
      // keyboard users can reveal with Enter/Space too
      overlay.tabIndex = 0;
      overlay.focus({ preventScroll: true });
      overlay.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); overlay.click(); }
      });
      overlay.addEventListener('click', () => {
        if (overlay.classList.contains('falling')) return;
        overlay.classList.add('falling');
        // start the song on this tap (a user gesture, so sound is
        // allowed); the card then cross-fades up behind the falling
        // flowers so the letter emerges rather than cutting in
        startSong();
        setTimeout(openCard, 900);
        setTimeout(() => { overlay.remove(); }, 3600);
      });
    }

    if (!envelope.dataset.keys) {
      envelope.dataset.keys = '1';
      envelope.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); envelope.click(); }
      });
    }
    envelope.addEventListener('click', () => {
      if (envelope.classList.contains('open-flap')) return;
      envelope.classList.add('open-flap');
      // the pulse keyframe animation would override an inline opacity
      openHint.style.animation = 'none';
      openHint.style.opacity = '0';
      openHint.style.transition = 'opacity 0.4s';
      if (reduceMotion) {
        startSong();
        setTimeout(openCard, 350);
        return;
      }
      setTimeout(spawnBurst, 620);
    });
  }

  async function initGiftView(wrapper) {
    if (!wrapper.enc) {
      renderLetter(wrapper.d);
      return;
    }

    const gate = $('passphraseGate');
    gate.classList.remove('hidden');
    const form = $('passphraseForm');
    const errorMsg = $('passphraseError');

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const passphrase = $('passphraseInput').value;
      if (!passphrase) return;
      try {
        const data = await decryptPayload(wrapper, passphrase);
        gate.classList.add('hidden');
        renderLetter(data);
      } catch (err) {
        errorMsg.classList.remove('hidden');
      }
    });
  }

  /* ---------------- standalone gift file generator ----------------
     Embedded (not fetched) so this works when index.html is opened
     straight from disk via file://, where fetch() of local files is
     blocked by the browser. Keep in sync with style.css by hand. */
  const EMBEDDED_CSS = `:root {
  --paper: #f4ead6;
  --paper-deep: #eedfc4;
  --card: #fffdf6;
  --card-edge: #eadfc4;
  --ink: #5c5445;
  --moss: #4c5a40;
  --rose: #d98ba2;
  --rose-dark: #c06e88;
  --sage: #c3d2ae;
  --sage-dark: #8aa075;
  --gold: #ecd39a;
  --board: #57683f;
  --board-deep: #3f4d32;
  --note-paper: #ece3cb;
  --note-ink: #4a4234;
  --tile-green: #2e3a26;
  font-size: 16px;
}

* { box-sizing: border-box; }

/* the scrapbook decor intentionally bleeds past the board's edges;
   clip at the root so it can never cause sideways panning on phones */
html { overflow-x: clip; }

body {
  margin: 0;
  min-height: 100vh;
  background: linear-gradient(180deg, var(--paper) 0%, var(--paper-deep) 100%);
  font-family: 'Poppins', sans-serif;
  color: var(--ink);
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 40px 16px 80px;
  position: relative;
  overflow-x: hidden;
  transition: background 0.8s ease;
}

.hidden { display: none !important; }

/* visible keyboard focus everywhere interactive */
button:focus-visible,
a:focus-visible,
input:focus-visible,
textarea:focus-visible,
.envelope:focus-visible,
.flower-burst:focus-visible {
  outline: 2px solid var(--rose-dark);
  outline-offset: 3px;
  border-radius: 4px;
}
.flower-burst:focus-visible { outline-offset: -4px; }

/* calm ambience for reduced-motion users; core reveals stay handled in JS */
@media (prefers-reduced-motion: reduce) {
  .bg-decor { display: none; }
  .open-hint, .song-note, .reveal-hint { animation: none; opacity: 1; }
}

/* ---------- floating background petals (compose page ambience) ---------- */
.bg-decor {
  position: fixed;
  top: 0; right: 0; bottom: 0; left: 0;
  pointer-events: none;
  overflow: hidden;
  z-index: 0;
}
.petal-fall {
  position: absolute;
  top: -10%;
  opacity: 0.35;
  animation: fall linear infinite;
}
.petal-fall svg {
  display: block;
  width: 26px;
  height: 26px;
  animation: petalSway 3.6s ease-in-out infinite alternate;
}
.p1 { left: 8%;  animation-duration: 16s; animation-delay: 0s; }
.p2 { left: 25%; animation-duration: 21s; animation-delay: 3s; }
.p2 svg { width: 18px; height: 18px; animation-duration: 3.1s; }
.p3 { left: 52%; animation-duration: 18s; animation-delay: 1.5s; }
.p3 svg { animation-duration: 4s; }
.p4 { left: 74%; animation-duration: 23s; animation-delay: 5s; }
.p4 svg { width: 20px; height: 20px; animation-duration: 3.4s; }
.p5 { left: 90%; animation-duration: 17s; animation-delay: 7s; }
.p5 svg { animation-duration: 4.4s; }

@keyframes fall {
  0%   { transform: translateY(-10vh) rotate(0deg); }
  100% { transform: translateY(110vh) rotate(150deg); }
}
@keyframes petalSway {
  from { transform: translateX(-7px) rotate(-10deg); }
  to   { transform: translateX(7px) rotate(10deg); }
}

/* ---------- layout ---------- */
.view {
  width: 100%;
  max-width: 560px;
  z-index: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
}

.brand { text-align: center; margin-bottom: 28px; }
.brand h1 {
  font-family: 'Playfair Display', serif;
  font-size: 2.4rem;
  color: var(--moss);
  margin: 0 0 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
}
.brand-mark { display: inline-flex; color: var(--rose-dark); }
.tagline { color: #8b8069; max-width: 420px; margin: 0 auto; line-height: 1.5; }

.card {
  background: var(--card);
  border-radius: 22px;
  padding: 30px 28px;
  width: 100%;
  box-shadow: 0 14px 44px rgba(150, 112, 60, 0.12);
  border: 1px solid var(--card-edge);
}

.card + .card { margin-top: 22px; }

h2 { font-family: 'Playfair Display', serif; color: var(--moss); margin-top: 0; }

.muted { color: #93876f; font-size: 0.92rem; line-height: 1.5; }
.muted.small { font-size: 0.8rem; margin-top: 8px; text-align: center; }

/* ---------- form ---------- */
.field-row { display: flex; gap: 14px; }
.field { flex: 1; margin-bottom: 18px; }
label { display: block; font-size: 0.85rem; font-weight: 500; color: #6d6350; margin-bottom: 6px; }

input[type="text"], input[type="password"], textarea {
  width: 100%;
  border: 1.5px solid #e8dcbf;
  background: #fffcf2;
  border-radius: 12px;
  padding: 11px 14px;
  font-family: 'Poppins', sans-serif;
  font-size: 0.95rem;
  color: var(--ink);
  transition: border-color 0.25s ease;
}
input:focus, textarea:focus {
  outline: none;
  border-color: var(--rose);
}
textarea { resize: vertical; line-height: 1.5; }

.compose-divider {
  display: flex;
  align-items: flex-end;
  justify-content: center;
  gap: 10px;
  margin: -4px 0 18px;
}

#message {
  font-family: 'Playfair Display', serif;
  font-size: 1.05rem;
  line-height: 1.8;
  background: #fffdf5;
  padding: 16px 18px;
}

.checkbox-label {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  font-weight: 400;
  color: var(--ink);
}
.passphrase-input { margin-top: 10px; }

.opt { color: #a89a80; font-weight: 400; font-size: 0.78rem; }
.file-input {
  width: 100%;
  font-family: 'Poppins', sans-serif;
  font-size: 0.86rem;
  color: var(--ink);
  padding: 4px 0;
}
.file-input::file-selector-button {
  font-family: 'Poppins', sans-serif;
  font-size: 0.85rem;
  font-weight: 500;
  border: none;
  background: #f7e3e9;
  color: var(--rose-dark);
  padding: 9px 16px;
  border-radius: 20px;
  cursor: pointer;
  margin-right: 12px;
  transition: background 0.2s ease;
}
.file-input::file-selector-button:hover { background: #f3d7e0; }
.file-hint { text-align: left; margin-top: 8px; }
.field-error { color: #b3423c; }

/* card-theme picker */
.theme-row { display: flex; flex-wrap: wrap; gap: 10px; }
.theme-swatch {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 0.85rem;
  font-weight: 500;
  color: #6d6350;
  background: #fffcf2;
  border: 1.5px solid #e8dcbf;
  border-radius: 22px;
  padding: 7px 14px 7px 8px;
  cursor: pointer;
  transition: border-color 0.2s ease, box-shadow 0.2s ease;
}
.theme-swatch input { position: absolute; opacity: 0; pointer-events: none; }
.theme-swatch .sw {
  width: 22px; height: 22px;
  border-radius: 50%;
  box-shadow: inset 0 0 0 1.5px rgba(0, 0, 0, 0.12);
}
.sw-garden { background: linear-gradient(135deg, #57683f, #2e3a26); }
.sw-kraft  { background: linear-gradient(135deg, #c1a06d, #8a6a3c); }
.sw-night  { background: linear-gradient(135deg, #33355a, #14162a); }
.sw-blush  { background: linear-gradient(135deg, #e7b7c6, #d0819c); }
.theme-swatch:has(input:checked) {
  border-color: var(--rose);
  box-shadow: 0 0 0 2px rgba(217, 139, 162, 0.28);
}

.btn-primary {
  width: 100%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  background: linear-gradient(135deg, var(--rose), var(--rose-dark));
  color: #fff;
  border: none;
  border-radius: 30px;
  padding: 14px;
  font-size: 1rem;
  font-weight: 500;
  cursor: pointer;
  margin-top: 6px;
  transition: transform 0.2s ease, box-shadow 0.2s ease;
}
.btn-primary:hover { transform: translateY(-1px); box-shadow: 0 10px 24px rgba(192, 110, 136, 0.28); }
.btn-primary .icon { display: inline-flex; }

.btn-secondary {
  background: #f7e3e9;
  color: var(--rose-dark);
  border: none;
  border-radius: 30px;
  padding: 10px 18px;
  font-weight: 500;
  cursor: pointer;
  text-decoration: none;
  font-size: 0.9rem;
  display: inline-block;
  text-align: center;
  transition: background 0.25s ease;
}
.btn-secondary:hover { background: #f3d7e0; }
.btn-text {
  background: none;
  border: none;
  color: var(--rose-dark);
  text-decoration: underline;
  cursor: pointer;
  font-size: 0.9rem;
}

.link-row { display: flex; gap: 8px; margin: 4px 0 6px; }
.link-row input { flex: 1; font-size: 0.82rem; }

.result-actions { display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 10px; }

.error { color: #b3423c; font-size: 0.88rem; margin-top: 10px; }

/* ---------- gift stage: watercolor envelope ---------- */
#passphraseGate h2 { display: flex; align-items: center; gap: 8px; }
.lock-icon { display: inline-flex; color: var(--rose-dark); }
#passphraseGate form { display: flex; gap: 8px; margin-top: 14px; }
#passphraseGate input { flex: 1; }

.gift-stage {
  display: flex;
  flex-direction: column;
  align-items: center;
  margin-top: 26vh;
}

.open-hint {
  position: fixed;
  bottom: 34px;
  left: 0; right: 0;
  text-align: center;
  font-family: 'Playfair Display', serif;
  font-style: italic;
  color: #c9556d;
  font-size: 1.2rem;
  letter-spacing: 0.03em;
  animation: pulse 2.6s ease-in-out infinite;
  pointer-events: none;
  z-index: 5;
}
@keyframes pulse { 0%,100% { opacity: 0.55; } 50% { opacity: 1; } }

.envelope {
  position: relative;
  width: 300px;
  height: 210px;
  cursor: pointer;
  perspective: 1200px;
  transition: transform 0.35s ease;
}
.envelope:not(.open-flap):hover { transform: translateY(-4px); }

/* letter paper that rises out of the envelope once the flap opens */
.letter-window {
  position: absolute;
  left: 16px; right: 16px;
  top: -74px;
  height: 178px;
  overflow: hidden;
  z-index: 1;
  pointer-events: none;
}
.env-paper {
  position: absolute;
  left: 4px; right: 4px; bottom: 0;
  width: calc(100% - 8px);
  transform: translateY(103%);
  transition: transform 1.15s cubic-bezier(0.2, 0.75, 0.25, 1) 0.28s;
}
.envelope.open-flap .env-paper { transform: translateY(-6%); }

.env-pocket {
  position: absolute;
  top: 0; right: 0; bottom: 0; left: 0;
  width: 100%; height: 100%;
  z-index: 2;
  filter: drop-shadow(0 18px 30px rgba(140, 104, 50, 0.28));
}

.envelope-flap {
  position: absolute;
  top: 4px; left: 0;
  width: 100%;
  height: 112px;
  transform-origin: top center;
  transition: transform 0.9s cubic-bezier(0.33, 0, 0.16, 1);
  z-index: 3;
}
.envelope-flap svg { display: block; width: 100%; height: 100%; }
.envelope.open-flap .envelope-flap {
  transform: rotateX(180deg);
  z-index: 0;
}

.envelope-seal {
  position: absolute;
  top: 92px;
  left: 50%;
  width: 48px;
  height: 48px;
  transform: translateX(-50%);
  z-index: 4;
  transition: opacity 0.45s ease, transform 0.6s cubic-bezier(0.33, 0, 0.3, 1);
  filter: drop-shadow(0 3px 5px rgba(90, 60, 110, 0.32));
}
.envelope-seal svg { width: 100%; height: 100%; }
.envelope.open-flap .envelope-seal {
  opacity: 0;
  transform: translateX(-50%) translateY(-16px) scale(0.6) rotate(20deg);
}

/* ---------- full-screen flower wall ----------
   Blooms pop into place one by one, spiralling outward from the
   envelope until the screen is covered; the wall then breathes
   gently and waits for a tap before the flowers drift away. */
.flower-burst {
  position: fixed;
  top: 0; right: 0; bottom: 0; left: 0;
  z-index: 60;
  overflow: hidden;
  cursor: pointer;
}
.flower-burst.falling { pointer-events: none; cursor: default; }
.burst-flower {
  position: absolute;
  left: 0;
  top: 0;
  opacity: 0;
  will-change: transform, opacity;
  animation:
    burstPop var(--dur, 0.85s) var(--delay, 0s) both,
    burstSway 4.5s ease-in-out calc(var(--delay, 0s) + var(--dur, 0.85s)) infinite alternate;
}
@keyframes burstPop {
  0% {
    opacity: 0;
    transform: translate(var(--xa), var(--ya)) rotate(var(--r0)) scale(0.3);
    animation-timing-function: cubic-bezier(0.34, 0.4, 0.4, 1);
  }
  32% { opacity: 1; }
  70% {
    transform: translate(var(--x1), var(--y1)) rotate(var(--r1)) scale(1.05);
    animation-timing-function: cubic-bezier(0.3, 0.3, 0.3, 1);
  }
  100% {
    opacity: 1;
    transform: translate(var(--x1), var(--y1)) rotate(var(--r1)) scale(1);
  }
}
@keyframes burstSway {
  from { opacity: 1; transform: translate(var(--x1), var(--y1)) rotate(var(--r1)) scale(1); }
  to   { opacity: 1; transform: translate(var(--x1), calc(var(--y1) + 5px)) rotate(calc(var(--r1) + 2.2deg)) scale(1.02); }
}
.reveal-hint {
  position: fixed;
  bottom: 30px;
  left: 0; right: 0;
  text-align: center;
  font-family: 'Playfair Display', serif;
  font-style: italic;
  color: #fffdf4;
  font-size: 1.2rem;
  letter-spacing: 0.04em;
  text-shadow: 0 1px 12px rgba(70, 45, 25, 0.55);
  z-index: 61;
  opacity: 0;
  animation: hintIn 0.9s ease var(--hd, 2.6s) forwards, pulse 2.6s ease-in-out calc(var(--hd, 2.6s) + 0.9s) infinite;
  pointer-events: none;
}
@keyframes hintIn { to { opacity: 1; } }
.flower-burst.falling .reveal-hint { display: none; }
.flower-burst.falling .burst-flower {
  animation: flowerFall 2.3s var(--fd, 0s) both;
}
@keyframes flowerFall {
  0% {
    opacity: 1;
    transform: translate(var(--x1), var(--y1)) rotate(var(--r1)) scale(1);
    animation-timing-function: cubic-bezier(0.5, 0, 0.72, 0.42);
  }
  45% {
    transform: translate(var(--xf), var(--yf)) rotate(var(--rf)) scale(1);
    animation-timing-function: cubic-bezier(0.3, 0.2, 0.62, 0.78);
  }
  100% {
    opacity: 1;
    transform: translate(var(--x2), var(--y2)) rotate(var(--r2)) scale(1);
  }
}

/* ---------- scrapbook card (the letter itself) ----------
   Themeable via variables; body.card-mode carries the default (garden)
   palette and the theme-* classes override it. */
body.card-mode {
  --board: #57683f;
  --board-mid: #4b5b36;
  --board-deep: #3f4d32;
  --glow1: rgba(110, 128, 78, 0.55);
  --glow2: rgba(46, 58, 38, 0.6);
  --note-paper: #ece3cb;
  --note-ink: #4a4234;
  --note-accent: #6d7f4e;
  --tile-bg: #efe8d4;
  --tile-border: #33402a;
  --tile-ink: #2e3a26;
  --blob-a: #6d7f4e;
  --blob-b: #33402a;
  --blob-c: #66784a;
  --scrap-bg: #e9e2cf;
  --scrap-ink: #6b6552;
  --tape: rgba(150, 168, 110, 0.55);
  --star-fill: #93a56d;
  --star-stroke: #748551;
  --record-a: #5c6b45;
  --record-b: #22271d;
  background:
    radial-gradient(560px 420px at 88% 6%, var(--glow1) 0%, transparent 65%),
    radial-gradient(640px 520px at 4% 78%, var(--glow2) 0%, transparent 60%),
    linear-gradient(168deg, var(--board) 0%, var(--board-mid) 52%, var(--board-deep) 100%);
  padding-top: 0;
}
body.card-mode.theme-kraft {
  --board: #c1a06d; --board-mid: #a9854f; --board-deep: #8a6a3c;
  --glow1: rgba(240, 226, 196, 0.5); --glow2: rgba(120, 92, 52, 0.4);
  --note-paper: #f5ecd6; --note-ink: #5a4a30; --note-accent: #9a763f;
  --tile-bg: #efe2c6; --tile-border: #8a6a3c; --tile-ink: #6b4f2a;
  --blob-a: #cdb083; --blob-b: #8a6a3c; --blob-c: #b89a68;
  --scrap-bg: #efe6ce; --scrap-ink: #766545;
  --tape: rgba(190, 165, 120, 0.55); --star-fill: #cdb083; --star-stroke: #9a763f;
  --record-a: #a9854f; --record-b: #4a3820;
}
body.card-mode.theme-night {
  --board: #33355a; --board-mid: #24263f; --board-deep: #14162a;
  --glow1: rgba(120, 128, 200, 0.4); --glow2: rgba(20, 22, 44, 0.7);
  --note-paper: #e9e6d8; --note-ink: #3a3550; --note-accent: #6d72ad;
  --tile-bg: #e6e3d4; --tile-border: #454a7a; --tile-ink: #3a3550;
  --blob-a: #3d4270; --blob-b: #1c1e38; --blob-c: #4a4f85;
  --scrap-bg: #e6e2d2; --scrap-ink: #55506e;
  --tape: rgba(130, 138, 200, 0.4); --star-fill: #d8d29a; --star-stroke: #b7b06a;
  --record-a: #3d4270; --record-b: #101124;
}
body.card-mode.theme-blush {
  --board: #e7b7c6; --board-mid: #dd9db2; --board-deep: #d0819c;
  --glow1: rgba(255, 235, 242, 0.6); --glow2: rgba(200, 120, 150, 0.4);
  --note-paper: #fff2f5; --note-ink: #7a4b58; --note-accent: #c06e88;
  --tile-bg: #ffe6ee; --tile-border: #c06e88; --tile-ink: #8a4a60;
  --blob-a: #efc3d0; --blob-b: #cf88a2; --blob-c: #f0cdd8;
  --scrap-bg: #ffe9ef; --scrap-ink: #9c6b78;
  --tape: rgba(224, 150, 175, 0.5); --star-fill: #f0aac0; --star-stroke: #c06e88;
  --record-a: #e0a3b8; --record-b: #9c5a72;
}
body.card-mode .bg-decor,
body.card-mode .gift-footer { display: none; }
/* night theme sprinkles stars across the board */
body.card-mode.theme-night .card-board::before {
  content: "";
  position: absolute;
  inset: 0;
  pointer-events: none;
  background-image:
    radial-gradient(1.4px 1.4px at 12% 18%, #fff 50%, transparent),
    radial-gradient(1.2px 1.2px at 28% 42%, #fff 50%, transparent),
    radial-gradient(1.6px 1.6px at 46% 12%, #fff 50%, transparent),
    radial-gradient(1.2px 1.2px at 62% 32%, #fff 50%, transparent),
    radial-gradient(1.5px 1.5px at 78% 20%, #fff 50%, transparent),
    radial-gradient(1.2px 1.2px at 88% 48%, #fff 50%, transparent),
    radial-gradient(1.3px 1.3px at 18% 68%, #fff 50%, transparent),
    radial-gradient(1.4px 1.4px at 40% 82%, #fff 50%, transparent),
    radial-gradient(1.2px 1.2px at 70% 74%, #fff 50%, transparent),
    radial-gradient(1.5px 1.5px at 92% 88%, #fff 50%, transparent);
  opacity: 0.75;
}

.card-board {
  position: relative;
  width: 100%;
  max-width: 620px;
  min-height: 100vh;
  padding: 96px 20px 90px;
  display: flex;
  flex-direction: column;
  align-items: center;
  /* the board eases up and fades in when the letter is revealed, so it
     emerges gently from behind the falling flowers instead of cutting in */
  opacity: 0;
  transform: translateY(18px) scale(0.985);
  transition: opacity 1.1s ease, transform 1.25s cubic-bezier(0.2, 0.75, 0.25, 1);
}
.card-board.revealed { opacity: 1; transform: none; }
.decor { position: absolute; pointer-events: none; }

/* painted blobs */
.d-blob { border-radius: 46% 54% 58% 42% / 52% 44% 56% 48%; }
.b1 { width: 300px; height: 210px; left: -110px; top: 40px; background: var(--blob-a); opacity: 0.5; transform: rotate(-14deg); }
.b2 { width: 260px; height: 180px; right: -90px; top: 300px; background: var(--blob-b); opacity: 0.55; transform: rotate(11deg); }
.b3 { width: 320px; height: 200px; left: -80px; bottom: 60px; background: var(--blob-c); opacity: 0.4; transform: rotate(7deg); }

/* vinyl record peeking from the left */
.d-record {
  width: 250px; height: 250px;
  left: -125px; top: 150px;
  border-radius: 50%;
  background:
    radial-gradient(circle, var(--record-a) 0 17%, var(--record-b) 17% 19%, transparent 19%),
    repeating-radial-gradient(circle, var(--record-b) 0 3px, var(--record-a) 3px 6px);
  box-shadow: 0 10px 30px rgba(20, 26, 16, 0.5);
  transform: rotate(18deg);
}

/* torn newsprint scraps */
.d-scrap {
  width: 190px;
  background: var(--scrap-bg);
  color: var(--scrap-ink);
  font-family: 'Playfair Display', serif;
  font-size: 0.6rem;
  line-height: 1.55;
  padding: 14px 16px;
  clip-path: polygon(2% 6%, 14% 0%, 34% 3%, 55% 0%, 78% 4%, 97% 1%, 100% 30%, 97% 58%, 100% 85%, 94% 100%, 70% 97%, 45% 100%, 20% 96%, 0% 100%, 3% 68%, 0% 36%);
  box-shadow: 0 6px 18px rgba(24, 30, 18, 0.35);
}
.s1 { right: -46px; top: 54px; transform: rotate(9deg); }
.s2 { left: -40px; bottom: 220px; transform: rotate(-7deg); }

/* washi tape */
.d-tape {
  width: 110px; height: 30px;
  background: var(--tape);
  box-shadow: 0 2px 6px rgba(20, 26, 16, 0.25);
}
.t1 { right: 22px; top: 388px; transform: rotate(38deg); }
.t2 { left: 14px; top: 470px; transform: rotate(-24deg); }

/* star sticker */
.d-star { width: 64px; height: 64px; left: 20px; top: 34px; transform: rotate(-14deg); }
.d-star path { fill: var(--star-fill); stroke: var(--star-stroke); stroke-width: 1.5; }

/* the clipped note */
.note-wrap {
  position: relative;
  width: min(480px, 100%);
  margin-top: 8px;
  animation: noteIn 1.1s cubic-bezier(0.25, 0.7, 0.25, 1) 0.25s both;
  z-index: 2;
}
@keyframes noteIn {
  from { opacity: 0; transform: translateY(26px) rotate(-3.5deg); }
  to   { opacity: 1; transform: translateY(0) rotate(-1.6deg); }
}
.note-clip {
  position: absolute;
  top: -56px;
  left: 50%;
  width: 96px;
  height: 74px;
  transform: translateX(-50%);
  z-index: 3;
  filter: drop-shadow(0 5px 8px rgba(20, 26, 16, 0.4));
}
.note {
  position: relative;
  background: var(--note-paper);
  color: var(--note-ink);
  padding: 44px 34px 38px;
  clip-path: polygon(1% 2%, 8% 0%, 18% 1.4%, 30% 0.3%, 43% 1.6%, 55% 0.4%, 68% 1.8%, 80% 0.5%, 91% 1.6%, 99% 0.7%, 99.6% 12%, 98.9% 28%, 99.7% 46%, 98.7% 63%, 99.5% 80%, 98.9% 93%, 97% 99.4%, 86% 98.2%, 72% 99.6%, 58% 98.4%, 44% 99.7%, 30% 98.5%, 16% 99.5%, 5% 98.6%, 0.5% 99%, 1.2% 84%, 0.3% 66%, 1.5% 48%, 0.4% 30%, 1.3% 14%);
  box-shadow: 0 18px 40px rgba(18, 24, 14, 0.45);
  background-image:
    radial-gradient(340px 200px at 20% 10%, rgba(255, 252, 240, 0.55) 0%, rgba(255, 252, 240, 0) 60%),
    radial-gradient(300px 220px at 85% 90%, rgba(150, 130, 90, 0.14) 0%, rgba(150, 130, 90, 0) 60%);
}
.note-from,
.note-for {
  font-family: 'Playfair Display', serif;
  font-size: 1.06rem;
  margin: 0 0 6px;
  letter-spacing: 0.02em;
}
.note-from { color: var(--note-accent); }
.note-for { margin-bottom: 20px; }
.note-body {
  font-family: 'Playfair Display', serif;
  font-style: italic;
  font-size: 1rem;
  line-height: 1.85;
  white-space: pre-wrap;
  margin: 0;
  overflow-wrap: break-word;
  min-height: 1.85em;
}
/* blinking caret while the letter types itself in */
.note-body.typing::after {
  content: "";
  display: inline-block;
  width: 2px;
  height: 1.05em;
  margin-left: 1px;
  background: var(--note-accent);
  vertical-align: text-bottom;
  animation: caret 0.9s steps(1) infinite;
}
@keyframes caret { 50% { opacity: 0; } }
.note-sign {
  font-family: 'Playfair Display', serif;
  font-style: italic;
  font-size: 1.15rem;
  color: var(--note-accent);
  margin: 18px 0 2px;
  text-align: right;
}
.note-date {
  font-family: 'Poppins', sans-serif;
  font-size: 0.74rem;
  letter-spacing: 0.04em;
  color: rgba(0, 0, 0, 0.42);
  margin: 0;
  text-align: right;
}

/* alphabet tiles spelling the recipient */
.tile-row {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 16px;
  margin-top: 54px;
  z-index: 2;
}
.tile {
  width: 86px;
  height: 96px;
  background: var(--tile-bg);
  border: 7px solid var(--tile-border);
  border-radius: 6px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-family: 'Playfair Display', serif;
  font-weight: 600;
  font-size: 3rem;
  color: var(--tile-ink);
  box-shadow: 0 10px 22px rgba(18, 24, 14, 0.4);
  transform: rotate(var(--tr, 0deg));
  animation: tileIn 0.7s cubic-bezier(0.3, 1.15, 0.4, 1) calc(0.7s + var(--i, 0) * 0.12s) both;
}
@keyframes tileIn {
  from { opacity: 0; transform: rotate(var(--tr, 0deg)) scale(0.5); }
  to   { opacity: 1; transform: rotate(var(--tr, 0deg)) scale(1); }
}

/* photos pinned to the board as tilted polaroids */
.photo-stack {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  align-items: flex-start;
  gap: 20px 24px;
  width: min(520px, 100%);
  margin-top: 46px;
  z-index: 2;
}
.polaroid {
  margin: 0;
  width: 216px;
  max-width: 44vw;
  background: #fdf9ee;
  padding: 11px 11px 34px;
  border-radius: 3px;
  box-shadow: 0 14px 30px rgba(18, 24, 14, 0.5);
  transform: rotate(var(--pr, 0deg));
  animation: photoIn 0.85s cubic-bezier(0.25, 0.9, 0.35, 1) calc(1.2s + var(--pi, 0) * 0.15s) both;
  cursor: zoom-in;
  transition: transform 0.25s ease, box-shadow 0.25s ease;
}
.polaroid:hover {
  transform: rotate(var(--pr, 0deg)) translateY(-4px) scale(1.03);
  box-shadow: 0 20px 38px rgba(18, 24, 14, 0.55);
}
.polaroid img {
  display: block;
  width: 100%;
  height: auto;
  border-radius: 1px;
  background: #d8d2c2;
}
@keyframes photoIn {
  from { opacity: 0; transform: rotate(var(--pr, 0deg)) translateY(26px) scale(0.9); }
  to   { opacity: 1; transform: rotate(var(--pr, 0deg)); }
}

/* tap-a-photo lightbox */
.lightbox {
  position: fixed;
  inset: 0;
  z-index: 90;
  background: rgba(18, 20, 12, 0.86);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  cursor: zoom-out;
  animation: lbIn 0.25s ease;
}
@keyframes lbIn { from { opacity: 0; } to { opacity: 1; } }
.lightbox img {
  max-width: 100%;
  max-height: 100%;
  border: 10px solid #fdf9ee;
  border-bottom-width: 30px;
  border-radius: 3px;
  box-shadow: 0 24px 60px rgba(0, 0, 0, 0.6);
}

/* background-song player styled as a little spinning record ----------
   The uploaded audio plays from a hidden <audio> element, with the
   vinyl art layered on top acting as the play button. Tapping it
   plays/pauses; it spins only while the song is playing. */
.song-dock {
  position: fixed;
  right: 18px;
  bottom: 18px;
  z-index: 72;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 7px;
  padding: 12px 14px 11px;
  background: rgba(20, 24, 14, 0.8);
  border-radius: 18px;
  box-shadow: 0 12px 28px rgba(10, 14, 8, 0.55);
  animation: dockIn 0.6s ease 0.3s both;
}
@keyframes dockIn {
  from { opacity: 0; transform: translateY(14px) scale(0.92); }
  to   { opacity: 1; transform: none; }
}
.turntable {
  position: relative;
  width: 116px;
  height: 116px;
  flex: 0 0 auto;
}
#songAudio { display: none; }
.vinyl {
  position: absolute;
  inset: 0;
  border-radius: 50%;
  background:
    repeating-radial-gradient(circle at 50% 50%, #191919 0 1.5px, #232323 1.5px 3px);
  box-shadow: inset 0 0 0 2px #050505, inset 0 0 14px rgba(0, 0, 0, 0.9), 0 3px 8px rgba(0, 0, 0, 0.5);
  animation: vinylSpin 3.6s linear infinite;
  animation-play-state: paused;
}
.song-dock.playing .vinyl { animation-play-state: running; }
@keyframes vinylSpin { to { transform: rotate(360deg); } }
.vinyl-shine {
  position: absolute;
  inset: 0;
  border-radius: 50%;
  background: linear-gradient(125deg, rgba(255,255,255,0.16) 0%, rgba(255,255,255,0) 32%, rgba(255,255,255,0) 66%, rgba(255,255,255,0.09) 100%);
}
.vinyl-label {
  position: absolute;
  inset: 33%;
  border-radius: 50%;
  background: radial-gradient(circle at 42% 38%, var(--note-accent, #d98ba2), #9c5772);
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.25);
}
.vinyl-hole {
  position: absolute;
  inset: 46.5%;
  border-radius: 50%;
  background: #0c0c0c;
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.2);
}
.vinyl-btn {
  position: absolute;
  inset: 0;
  border: 0;
  background: transparent;
  border-radius: 50%;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #fff;
}
.vinyl-btn svg { filter: drop-shadow(0 1px 4px rgba(0, 0, 0, 0.85)); transition: opacity 0.2s ease; }
.vinyl-btn .ic-pause { display: none; }
.vinyl-btn .ic-play { opacity: 0.95; }
.song-dock.playing .vinyl-btn .ic-play { display: none; }
.song-dock.playing .vinyl-btn .ic-pause { display: block; }
/* the control fades back while playing, and is clear when idle/paused */
.song-dock.playing .vinyl-btn svg { opacity: 0; }
.turntable:hover .vinyl-btn svg { opacity: 0.95; }
.song-now {
  margin: 0;
  font-family: 'Poppins', sans-serif;
  font-size: 0.68rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: #f4ead6;
  display: flex;
  align-items: center;
  gap: 6px;
}
.song-note { font-size: 0.95rem; animation: notePulse 1.6s ease-in-out infinite; }
@keyframes notePulse { 0%,100% { opacity: 0.55; } 50% { opacity: 1; } }
/* until it's actually playing, pulse the record and brighten the label
   so it clearly invites a tap to play */
.song-dock:not(.playing) .turntable {
  border-radius: 50%;
  animation: tapForSound 1.6s ease-in-out infinite;
}
.song-dock:not(.playing) .song-now { color: #ffe0a3; }
@keyframes tapForSound {
  0%, 100% { box-shadow: 0 0 0 0 rgba(255, 224, 163, 0); }
  50% { box-shadow: 0 0 0 6px rgba(255, 224, 163, 0.4); }
}
@media (max-width: 420px) {
  .song-dock { right: 12px; bottom: 12px; }
  .turntable { width: 96px; height: 96px; }
}
@media (prefers-reduced-motion: reduce) {
  .song-dock:not(.playing) .turntable { animation: none; box-shadow: 0 0 0 3px rgba(255, 224, 163, 0.4); }
}
@media (prefers-reduced-motion: reduce) {
  .vinyl { animation: none; }
}

/* card action buttons (save image / replay) */
.card-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 12px;
  margin-top: 46px;
  z-index: 2;
}
.card-btn {
  font-family: 'Poppins', sans-serif;
  font-size: 0.86rem;
  font-weight: 500;
  color: var(--note-ink);
  background: var(--note-paper);
  border: none;
  border-radius: 24px;
  padding: 11px 22px;
  cursor: pointer;
  box-shadow: 0 8px 18px rgba(18, 24, 14, 0.4);
  transition: transform 0.2s ease, box-shadow 0.2s ease;
}
.card-btn:hover { transform: translateY(-2px); box-shadow: 0 12px 24px rgba(18, 24, 14, 0.5); }

/* petal shimmer drifting over the revealed card */
.confetti-layer {
  position: fixed;
  inset: 0;
  pointer-events: none;
  overflow: hidden;
  z-index: 65;
}
.confetti {
  position: absolute;
  top: -8%;
  opacity: 0;
  animation: confettiFall var(--cdur, 3.6s) ease-in var(--cdelay, 0s) forwards;
}
@keyframes confettiFall {
  0% { opacity: 0; transform: translateY(-10vh) translateX(0) rotate(0deg); }
  12% { opacity: 0.9; }
  100% { opacity: 0; transform: translateY(110vh) translateX(var(--cx, 0)) rotate(var(--rot, 180deg)); }
}

.gift-footer {
  margin-top: 50px;
  color: #a5906d;
  font-size: 0.85rem;
  text-align: center;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
}
.gift-footer .icon { display: inline-flex; }
.gift-footer .icon svg { width: 15px; height: 15px; }

@media (max-width: 420px) {
  .field-row { flex-direction: column; gap: 0; }
  .envelope { width: 260px; height: 182px; }
  .envelope-flap { height: 97px; }
  .envelope-seal { top: 78px; width: 42px; height: 42px; }
  .letter-window { top: -64px; height: 154px; }
  .tile { width: 68px; height: 78px; font-size: 2.4rem; border-width: 5px; }
}`;

  function fnSource(...fns) {
    return fns.map((fn) => fn.toString()).join('\n\n');
  }

  function safeFileName(name) {
    const slug = (name || 'gift')
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^\w\s-]/g, '')
      .trim()
      .replace(/\s+/g, '-');
    return (slug || 'gift') + '-bloom-letter.html';
  }

  function buildStandaloneHtml(wrapper) {
    const script = '(() => {\n'
      + "  'use strict';\n"
      + '  const $ = (id) => document.getElementById(id);\n\n'
      + '  const THEMES = ' + JSON.stringify(THEMES) + ';\n'
      + fnSource(bytesToBase64, base64ToBytes, base64UrlEncode, base64UrlDecode,
          deriveKey, decryptPayload, saveCardImage, renderLetter, initGiftView)
      + "\n\n  document.title = 'A letter for you';\n"
      + '  initGiftView(' + JSON.stringify(wrapper) + ');\n'
      + '})();';

    const lockIcon = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><rect x="5.5" y="10.5" width="13" height="9.5" rx="2.4" fill="currentColor"/><path d="M8 10.5V7.8a4 4 0 0 1 8 0v2.7" stroke="currentColor" stroke-width="1.7" fill="none" stroke-linecap="round"/><circle cx="12" cy="14.7" r="1.4" fill="#fff"/><rect x="11.3" y="15.6" width="1.4" height="2.4" rx="0.7" fill="#fff"/></svg>';
    const petal = (variety) => '<svg viewBox="0 0 100 100"><use href="#fl-' + variety + '"/></svg>';

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="robots" content="noindex, nofollow">
<title>A letter for you</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,500;0,600;1,500&family=Poppins:wght@300;400;500;600&display=swap" rel="stylesheet">
<style>${EMBEDDED_CSS}</style>
</head>
<body>
${FLOWER_SPRITE}
<div class="bg-decor" aria-hidden="true">
  <span class="petal-fall p1">${petal('lily-pink')}</span>
  <span class="petal-fall p2">${petal('daisy-white')}</span>
  <span class="petal-fall p3">${petal('lily-white')}</span>
  <span class="petal-fall p4">${petal('plumeria')}</span>
  <span class="petal-fall p5">${petal('zinnia')}</span>
</div>
<main id="giftView" class="view">
  <div id="passphraseGate" class="card hidden">
    <h2><span class="lock-icon">${lockIcon}</span>This letter is locked</h2>
    <p class="muted">Enter the passphrase you were given to open it.</p>
    <form id="passphraseForm">
      <input type="password" id="passphraseInput" placeholder="Passphrase" autocomplete="off" autofocus>
      <button type="submit" class="btn-primary" style="width:auto;">Unlock</button>
    </form>
    <p id="passphraseError" class="error hidden">That passphrase didn't work. Try again.</p>
  </div>
  <div id="giftStage" class="gift-stage hidden">
    <div class="envelope" id="envelope" role="button" tabindex="0" aria-label="Open the envelope">
      <div class="letter-window"><svg class="env-paper" viewBox="0 0 260 160"><use href="#fl-env-paper"/></svg></div>
      <svg class="env-pocket" viewBox="0 0 300 200"><use href="#fl-env-pocket"/></svg>
      <div class="envelope-flap"><svg viewBox="0 0 300 112"><use href="#fl-env-flap"/></svg></div>
      <div class="envelope-seal" id="envelopeSeal"><svg viewBox="0 0 100 100"><use href="#fl-seal"/></svg></div>
    </div>
    <p class="open-hint" id="openHint">Tap to open</p>
  </div>
  <div id="cardView" class="card-board hidden">
    <div class="decor d-blob b1"></div>
    <div class="decor d-blob b2"></div>
    <div class="decor d-blob b3"></div>
    <div class="decor d-record"></div>
    <div class="decor d-scrap s1">the afternoon kept its light a little longer, pressed here between the pages like a petal &mdash; proof that ordinary hours can be saved, folded, and sent on</div>
    <div class="decor d-scrap s2">slow down, the ink whispers; every letter is a small parcel of time, carried by hand across the quiet distance between two people</div>
    <div class="decor d-tape t1"></div>
    <div class="decor d-tape t2"></div>
    <svg class="decor d-star" viewBox="0 0 44 44"><path d="M22 3 L27 16 L41 17 L30 26 L34 40 L22 32 L10 40 L14 26 L3 17 L17 16 Z"/></svg>
    <div class="note-wrap">
      <svg class="note-clip" viewBox="0 0 120 92" aria-hidden="true"><defs><linearGradient id="clipg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#d8bd7e"/><stop offset=".5" stop-color="#b3924e"/><stop offset="1" stop-color="#8f7136"/></linearGradient></defs><path fill="url(#clipg)" fill-rule="evenodd" d="M34 90 L86 90 L80 38 L74 30 L70 22 Q70 12 60 12 Q50 12 50 22 L46 30 L40 38 Z M60 26 a7 7 0 1 0 0.01 0 Z"/><rect x="30" y="86" width="60" height="6" rx="2" fill="#a3854a"/><rect x="38" y="52" width="44" height="3" rx="1.5" fill="#8f7136" opacity=".6"/><rect x="38" y="60" width="44" height="3" rx="1.5" fill="#8f7136" opacity=".6"/></svg>
      <div class="note">
        <p class="note-from" id="letterFrom"></p>
        <p class="note-for" id="letterTo"></p>
        <p class="note-body" id="letterBody"></p>
        <p class="note-sign" id="letterSign"></p>
        <p class="note-date" id="letterDate"></p>
      </div>
    </div>
    <div class="photo-stack hidden" id="photoStack"></div>
    <div class="tile-row" id="tileRow"></div>
    <div class="card-actions" id="cardActions">
      <button type="button" id="saveImgBtn" class="card-btn">Save card as image</button>
      <button type="button" id="replayBtn" class="card-btn">Replay intro</button>
    </div>
  </div>
  <div class="lightbox hidden" id="lightbox"><img id="lightboxImg" alt=""></div>
  <div class="song-dock hidden" id="songDock">
    <div class="turntable">
      <audio id="songAudio" loop playsinline></audio>
      <div class="vinyl"><span class="vinyl-shine"></span><span class="vinyl-label"></span><span class="vinyl-hole"></span></div>
      <button type="button" class="vinyl-btn" id="vinylBtn" aria-label="Play or pause the song">
        <svg class="ic-play" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M8.5 6.5 L16 12 L8.5 17.5 Z" fill="currentColor"/></svg>
        <svg class="ic-pause" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><rect x="7.5" y="6.5" width="3.2" height="11" rx="1" fill="currentColor"/><rect x="13.3" y="6.5" width="3.2" height="11" rx="1" fill="currentColor"/></svg>
      </button>
    </div>
    <p class="song-now"><span class="song-note">♪</span> now playing</p>
  </div>
  <p class="gift-footer"><span class="icon">${petal('rose')}</span>sent with love</p>
</main>
<script>${script}</script>
</body>
</html>`;
  }

  /* ==================================================
     COMPOSE MODE
     ================================================== */
  const HOSTED = location.protocol === 'http:' || location.protocol === 'https:';

  /* Read an image file, scale it down so its longest side is at most
     maxDim, and return a JPEG data URL. Keeps embedded photos small
     enough to travel inside the gift. */
  function fileToResizedDataURL(file, maxDim, quality) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        // Prefer WebP — it's much smaller than JPEG at the same quality,
        // which keeps photo links shorter. Browsers that can't encode
        // WebP silently return a PNG, so verify and fall back to JPEG.
        let out = canvas.toDataURL('image/webp', quality);
        if (out.indexOf('data:image/webp') !== 0) out = canvas.toDataURL('image/jpeg', quality);
        resolve(out);
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('bad image')); };
      img.src = url;
    });
  }

  /* Read a file (used for the background song) and return it as a data
     URL, unmodified — audio can't be re-encoded in the browser the way
     photos are resized, so the cap is enforced by file size instead. */
  function fileToDataURL(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
  }

  function initCompose() {
    const form = $('composeForm');
    const usePassphrase = $('usePassphrase');
    const passphraseInput = $('passphrase');
    const resultCard = $('resultCard');
    let lastObjectUrl = null;
    let lastWrapper = null;
    let lastTo = '';

    usePassphrase.addEventListener('change', () => {
      passphraseInput.classList.toggle('hidden', !usePassphrase.checked);
      if (!usePassphrase.checked) passphraseInput.value = '';
    });

    function downloadGiftFile(wrapper, toName) {
      const html = buildStandaloneHtml(wrapper);
      const blob = new Blob([html], { type: 'text/html' });
      if (lastObjectUrl) URL.revokeObjectURL(lastObjectUrl);
      lastObjectUrl = URL.createObjectURL(blob);
      const filename = safeFileName(toName);
      const a = document.createElement('a');
      a.href = lastObjectUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      return filename;
    }

    const submitBtn = form.querySelector('.btn-primary');

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const themeInput = form.querySelector('input[name="theme"]:checked');
      const data = {
        to: $('toName').value.trim(),
        from: $('fromName').value.trim(),
        message: $('message').value.trim(),
        theme: themeInput ? themeInput.value : 'garden',
        date: new Date().toISOString()
      };
      const openText = $('openText').value.trim();
      const revealText = $('revealText').value.trim();
      if (openText) data.openText = openText;
      if (revealText) data.revealText = revealText;
      const songFile = $('songFile').files[0] || null;
      const songHint = $('songHint');
      const MAX_SONG_BYTES = 6 * 1024 * 1024;
      if (!songHint.dataset.orig) songHint.dataset.orig = songHint.textContent;
      if (songFile && !songFile.type.startsWith('audio/')) {
        songHint.classList.add('field-error');
        songHint.textContent = "That doesn't look like an audio file — pick an mp3, m4a, or similar.";
        $('songFile').focus();
        return;
      }
      if (songFile && songFile.size > MAX_SONG_BYTES) {
        songHint.classList.add('field-error');
        songHint.textContent = 'That file is too big (max 6MB) — trim it or export at a lower bitrate.';
        $('songFile').focus();
        return;
      }
      songHint.classList.remove('field-error');
      songHint.textContent = songHint.dataset.orig;
      if (!data.to || !data.from || !data.message) return;

      const passphrase = usePassphrase.checked ? passphraseInput.value : '';
      if (usePassphrase.checked && !passphrase) {
        passphraseInput.focus();
        return;
      }

      // Photos take a moment to read/resize; show progress and keep the
      // button from being double-fired.
      const btnLabel = submitBtn.innerHTML;
      submitBtn.disabled = true;
      submitBtn.textContent = 'Wrapping your gift…';
      try {
        // Keep photos small (max 4, downsized hard) so the whole gift
        // always fits inside a shareable link.
        const photoFiles = Array.from($('photos').files).slice(0, 4);
        const photos = [];
        for (const f of photoFiles) {
          try { photos.push(await fileToResizedDataURL(f, 520, 0.5)); }
          catch (err) { /* skip an unreadable image */ }
        }
        if (photos.length) data.photos = photos;

        if (songFile) {
          try { data.song = await fileToDataURL(songFile); }
          catch (err) { /* skip an unreadable file */ }
        }

        const wrapper = await buildWrapper(data, passphrase);
        lastWrapper = wrapper;
        lastTo = data.to;

        $('linkModeNote').classList.add('hidden');
        $('fileModeNote').classList.add('hidden');
        $('linkRow').classList.add('hidden');

        if (HOSTED) {
          // Always a link on a hosted site — the gift travels in the URL.
          const link = await buildGiftLink(wrapper);
          $('giftLink').value = link;
          $('previewLink').href = link;
          $('linkModeNote').classList.remove('hidden');
          $('linkRow').classList.remove('hidden');
          if (navigator.share) $('shareBtn').classList.remove('hidden');
        } else {
          // Opened straight from disk (file://) — no URL to host a link,
          // so hand back a standalone file instead.
          const filename = downloadGiftFile(wrapper, data.to);
          $('giftFileName').textContent = filename;
          $('previewLink').href = lastObjectUrl;
          $('fileModeNote').classList.remove('hidden');
        }
        resultCard.classList.remove('hidden');
        resultCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
      } finally {
        submitBtn.disabled = false;
        submitBtn.innerHTML = btnLabel;
      }
    });

    $('copyLinkBtn').addEventListener('click', async () => {
      const input = $('giftLink');
      input.select();
      try {
        await navigator.clipboard.writeText(input.value);
        const btn = $('copyLinkBtn');
        const original = btn.textContent;
        btn.textContent = 'Copied!';
        setTimeout(() => { btn.textContent = original; }, 1500);
      } catch (e) {
        document.execCommand('copy');
      }
    });

    $('shareBtn').addEventListener('click', () => {
      const url = $('giftLink').value;
      if (url && navigator.share) navigator.share({ title: 'A letter for you 💐', url }).catch(() => {});
    });

    $('resetBtn').addEventListener('click', () => {
      form.reset();
      passphraseInput.classList.add('hidden');
      resultCard.classList.add('hidden');
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  }

  /* ---------------- bootstrap ---------------- */
  // Hash-only navigation doesn't reload the page, so re-route manually
  // (e.g. opening a gift link while the compose page is already open).
  window.addEventListener('hashchange', () => location.reload());

  async function main() {
    document.body.insertAdjacentHTML('afterbegin', FLOWER_SPRITE);
    const wrapper = await readWrapperFromHash();

    if (wrapper === null) {
      $('composeView').classList.remove('hidden');
      initCompose();
    } else if (wrapper === undefined) {
      $('composeView').classList.add('hidden');
      $('giftView').classList.remove('hidden');
      $('giftError').classList.remove('hidden');
    } else {
      $('composeView').classList.add('hidden');
      $('giftView').classList.remove('hidden');
      document.title = 'A letter for you';
      initGiftView(wrapper);
    }
  }

  main();
})();
