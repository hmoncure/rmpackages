/* Office Packages — single-page app, no build step. */
(() => {
  'use strict';
  const $app = document.getElementById('app');
  const $who = document.getElementById('who');
  const TZ = 'America/New_York';
  let me = null;
  let people = [];

  // ---------- utils ----------
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  function toast(msg) {
    const t = document.getElementById('toast');
    t.textContent = msg; t.classList.add('show');
    clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), 2600);
  }
  async function api(path, opts = {}) {
    const o = { method: opts.method || 'GET', headers: { 'X-PK': '1' }, credentials: 'same-origin' };
    if (opts.json !== undefined) { o.headers['Content-Type'] = 'application/json'; o.body = JSON.stringify(opts.json); }
    if (opts.blob) { o.headers['Content-Type'] = opts.blob.type || 'image/jpeg'; o.body = opts.blob; }
    const r = await fetch('/api' + path, o);
    let data = null;
    try { data = await r.json(); } catch { /* empty */ }
    if (r.status === 401 && !path.startsWith('/login')) { me = null; location.hash = '#/login'; throw new Error('Please sign in.'); }
    if (r.status === 403 && data && data.must_change_pin) { location.hash = '#/pin'; throw new Error(data.error); }
    if (!r.ok) throw Object.assign(new Error((data && data.error) || `Request failed (${r.status})`), { data, status: r.status });
    return data;
  }
  const fmtDT = (ts) => ts ? new Date(ts).toLocaleString('en-US', { timeZone: TZ, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
  const fmtD = (ts) => ts ? new Date(ts).toLocaleDateString('en-US', { timeZone: TZ, month: 'short', day: 'numeric' }) : '';
  // A DATE ('YYYY-MM-DD') is a calendar day, not an instant: format it at noon UTC so it never slips a day.
  const fmtDay = (d) => d ? new Date(d + 'T12:00:00Z').toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' }) : '';
  const todayET = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());

  // Where to track a package: Amazon's own page (from the order + shipment ids the email
  // scan saved), otherwise the carrier's page for the tracking number.
  function trackUrl(p) {
    const q = encodeURIComponent;
    const amz = /^amazon:([\d-]+):([A-Za-z0-9]+)$/.exec(p.source_ref || '');
    if (amz) return `https://www.amazon.com/progress-tracker/package?orderId=${q(amz[1])}&shipmentId=${q(amz[2])}&packageIndex=0`;
    const t = (p.tracking || '').replace(/\s+/g, '').toUpperCase();
    const carrier = (p.carrier || '').toLowerCase();
    if (t) {
      if (/^1Z[0-9A-Z]{16}$/.test(t) || carrier.includes('ups')) return `https://www.ups.com/track?tracknum=${q(t)}`;
      if (/^TBA\d+$/.test(t)) return `https://track.amazon.com/tracking/${q(t)}`;
      if (carrier.includes('fedex')) return `https://www.fedex.com/fedextrack/?trknbr=${q(t)}`;
      if (carrier.includes('usps') || /^9[1-5]\d{18,24}$/.test(t) || /^[A-Z]{2}\d{9}US$/.test(t)) return `https://tools.usps.com/go/TrackConfirmAction?tLabels=${q(t)}`;
      if (carrier.includes('dhl')) return `https://www.dhl.com/us-en/home/tracking/tracking-express.html?tracking-id=${q(t)}`;
      if (/^(\d{12}|\d{15}|\d{20}|\d{22})$/.test(t)) return `https://www.fedex.com/fedextrack/?trknbr=${q(t)}`;
      return `https://www.google.com/search?q=${q(t + ' tracking')}`;
    }
    if (/amazon/i.test(p.vendor || '') && /^\d{3}-\d{7}-\d{7}$/.test(p.order_number || '')) {
      return `https://www.amazon.com/gp/your-account/order-details?orderID=${q(p.order_number)}`;
    }
    return null;
  }
  // Short reference for the list: the end of the tracking number is what you match on a label.
  function shortRef(p) {
    if (p.tracking) { const t = p.tracking.replace(/\s+/g, ''); return `Tracking …${t.slice(-8)}`; }
    // Amazon order numbers are not printed on the box, so don't show one to match against.
    if (/amazon/i.test(p.vendor || '')) return '';
    if (p.order_number) return `Order ${p.order_number}`;
    return '';
  }

  function pills(p) {
    const out = [];
    if (p.flag_carrier_delivered) out.push(`<span class="pill red">Carrier says delivered ${esc(fmtD(p.carrier_delivered_at))}</span>`);
    else if (p.flag_overdue) out.push(`<span class="pill amber">Overdue</span>`);
    if (p.status === 'arrived' && p.days_waiting >= 7) out.push(`<span class="pill amber">${p.days_waiting} days in office</span>`);
    if (p.status === 'missing') out.push('<span class="pill red">Missing</span>');
    if (p.status === 'cancelled') out.push('<span class="pill grey">Cancelled</span>');
    if (p.status === 'collected') out.push(`<span class="pill green">Left with ${esc(p.collected_by_name)}</span>`);
    if (p.source === 'email') out.push('<span class="pill grey">from email</span>');
    if (p.source === 'walk-in') out.push('<span class="pill grey">not on list</span>');
    return out.join('');
  }

  // Shrink a camera photo to ~1600px JPEG before upload (phones take 4–12 MB shots).
  async function shrink(file, maxSide = 1600, quality = 0.82) {
    try {
      const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
      const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
      const c = document.createElement('canvas');
      c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
      const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
      g.drawImage(bmp, 0, 0, c.width, c.height);
      return await new Promise((res) => c.toBlob(res, 'image/jpeg', quality));
    } catch {
      return file; // browser can't decode (e.g. HEIC on desktop) — send as is
    }
  }

  function photoPicker(el, label) {
    // Returns a getter for the chosen (shrunk) blob.
    let blob = null;
    el.innerHTML = `<div class="shot" tabindex="0"><div>📷<br><strong>${esc(label)}</strong><br><span class="small">Tap to open the camera</span></div></div>
      <input type="file" accept="image/*" capture="environment" hidden>`;
    const shot = el.querySelector('.shot');
    const input = el.querySelector('input');
    shot.onclick = () => input.click();
    shot.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') input.click(); };
    input.onchange = async () => {
      const f = input.files[0];
      if (!f) return;
      shot.innerHTML = '<div>Preparing photo…</div>';
      blob = await shrink(f);
      shot.innerHTML = `<img alt="Chosen photo" src="${URL.createObjectURL(blob)}">`;
    };
    return () => blob;
  }

  function lightbox(src) {
    const d = document.createElement('div');
    d.className = 'lightbox';
    d.innerHTML = `<img alt="" src="${esc(src)}">`;
    d.onclick = () => d.remove();
    document.body.appendChild(d);
  }

  function renderWho() {
    $who.innerHTML = me
      ? `<span class="me">${esc(me.name)}</span> ${me.is_admin && !me.must_change_pin ? '<a href="#/admin">Admin</a> <a href="#/notify">Alerts</a>' : ''} <a href="#/pin">PIN</a> <button id="logout">Sign out</button>`
      : '';
    const b = document.getElementById('logout');
    if (b) b.onclick = async () => { await api('/logout', { method: 'POST' }).catch(() => {}); me = null; location.hash = '#/login'; };
  }

  // ---------- router ----------
  async function route() {
    const h = location.hash.replace(/^#/, '') || '/';
    if (!me && h !== '/login') {
      try { me = await api('/me'); } catch { me = null; }
      if (!me) { location.hash = '#/login'; return; }
    }
    if (me && me.must_change_pin && h !== '/pin' && h !== '/login') { location.hash = '#/pin'; return; }
    if (me && !me.must_change_pin && !people.length) people = await api('/people').catch(() => []);
    renderWho();
    window.scrollTo(0, 0);
    let m;
    try {
      if (h === '/login') return await viewLogin();
      if (h === '/pin') return viewPin();
      if (h === '/notify') return await viewNotify();
      if (h === '/scan') return await viewScanReceive();
      if ((m = /^\/p\/(\d+)\/tracking$/.exec(h))) return await viewAddTracking(Number(m[1]));
      if (h === '/' || h.startsWith('/list/')) return await viewList(h.split('/')[2] || 'expected');
      if ((m = /^\/p\/(\d+)$/.exec(h))) return await viewPackage(Number(m[1]));
      if ((m = /^\/p\/(\d+)\/(arrive|move|collect|edit)$/.exec(h))) return await ({ arrive: viewArrive, move: viewArrive, collect: viewCollect, edit: viewEdit })[m[2]](Number(m[1]), m[2]);
      if (h === '/add') return viewEdit(null, 'add');
      if (h === '/walkin') return viewWalkIn();
      if (h === '/admin') return await viewAdmin();
      $app.innerHTML = '<p class="pad">Not found. <a href="#/">Back to packages</a></p>';
    } catch (e) {
      $app.innerHTML = `<p class="err pad">${esc(e.message)}</p><p class="pad"><a href="#/">Back to packages</a></p>`;
    }
  }
  window.addEventListener('hashchange', route);

  // ---------- login ----------
  async function viewLogin() {
    me = null; renderWho();
    const names = await api('/signin-names');
    let chosen = null; let pin = '';
    $app.innerHTML = `<h1>Who are you?</h1><div class="people" id="names">${names.map((n) =>
      `<button class="person" data-id="${n.id}">${esc(n.name)}</button>`).join('')}</div>
      <div id="pinbox" hidden><h2 id="hi"></h2><div class="dots" id="dots"></div>
      <div class="pinpad">${[1,2,3,4,5,6,7,8,9].map((d) => `<button data-d="${d}">${d}</button>`).join('')}
        <button data-d="clr" aria-label="Clear">⌫</button><button data-d="0">0</button><button data-d="go" class="primary" aria-label="Sign in">✓</button></div>
      <p class="err" id="lerr"></p></div>`;
    const dots = () => { document.getElementById('dots').textContent = '•'.repeat(pin.length); };
    $app.querySelectorAll('.person').forEach((b) => b.onclick = () => {
      $app.querySelectorAll('.person').forEach((x) => x.classList.remove('on'));
      b.classList.add('on'); chosen = Number(b.dataset.id); pin = ''; dots();
      document.getElementById('pinbox').hidden = false;
      document.getElementById('hi').textContent = `PIN for ${b.textContent}`;
      document.getElementById('lerr').textContent = '';
      document.getElementById('pinbox').scrollIntoView({ behavior: 'smooth' });
    });
    async function go() {
      try {
        await api('/login', { method: 'POST', json: { person_id: chosen, pin } });
        me = await api('/me');
        if (me.must_change_pin) { location.hash = '#/pin'; return; }
        people = await api('/people');
        location.hash = '#/';
      } catch (e) { pin = ''; dots(); document.getElementById('lerr').textContent = e.message; }
    }
    $app.querySelectorAll('.pinpad button').forEach((b) => b.onclick = () => {
      const d = b.dataset.d;
      if (d === 'clr') pin = pin.slice(0, -1);
      else if (d === 'go') { if (pin.length >= 4) go(); return; }
      else if (pin.length < 8) pin += d;
      dots();
    });
    document.onkeydown = (e) => {
      if (location.hash !== '#/login' || !chosen) return;
      if (/^\d$/.test(e.key) && pin.length < 8) { pin += e.key; dots(); }
      else if (e.key === 'Backspace') { pin = pin.slice(0, -1); dots(); }
      else if (e.key === 'Enter' && pin.length >= 4) go();
    };
  }

  // ---------- barcode scanner ----------
  // Turns whatever a label barcode decodes to into a tracking number, when it recognises one.
  function trackingFromBarcode(raw) {
    const s = String(raw || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
    let m;
    if ((m = /TBA\d{9,15}/.exec(s))) return m[0];                       // Amazon
    if ((m = /1Z[0-9A-Z]{16}/.exec(s))) return m[0];                    // UPS
    if ((m = /^420\d{5}(?:\d{4})?(9[1-5]\d{18,24})$/.exec(s))) return m[1]; // USPS with ZIP prefix
    if (/^9[1-5]\d{18,24}$/.test(s)) return s;                          // USPS
    if (/^[A-Z]{2}\d{9}US$/.test(s)) return s;                          // USPS international
    if (/^\d{34}$/.test(s)) return s.slice(-12);                        // FedEx 34-digit label barcode
    if (/^(\d{12}|\d{15}|\d{20}|\d{22})$/.test(s)) return s;            // FedEx
    return null;
  }

  let zxingLoading = null;
  function loadZxing() {
    if (window.ZXing) return Promise.resolve();
    if (!zxingLoading) {
      zxingLoading = new Promise((res, rej) => {
        const sc = document.createElement('script');
        sc.src = '/vendor/zxing-0.21.3.min.js'; sc.onload = res; sc.onerror = () => rej(new Error('Scanner failed to load.'));
        document.head.appendChild(sc);
      });
    }
    return zxingLoading;
  }

  // Opens the camera full-screen and resolves with a tracking number (or null if cancelled).
  function scanBarcode() {
    return new Promise((resolve) => {
      const ov = document.createElement('div');
      ov.className = 'scanner';
      ov.innerHTML = `<video playsinline muted></video><div class="aim"></div>
        <div class="scan-ui"><p id="scanmsg">Point the camera at the barcode on the label</p>
        <div id="scanfound"></div><button class="btn block" id="scancancel">Cancel</button></div>`;
      document.body.appendChild(ov);
      const video = ov.querySelector('video');
      const msg = ov.querySelector('#scanmsg');
      let done = false, stream = null, timer = null, lastOther = null;
      function finish(val) {
        if (done) return; done = true;
        clearInterval(timer);
        if (stream) stream.getTracks().forEach((t) => t.stop());
        ov.remove(); resolve(val);
      }
      function seen(raw) {
        const t = trackingFromBarcode(raw);
        if (t) { if (navigator.vibrate) navigator.vibrate(80); finish(t); return; }
        // A barcode we don't recognise as tracking (sort code etc.): offer it, keep scanning.
        const v = String(raw).trim();
        if (v && v !== lastOther && v.length >= 8 && v.length <= 40) {
          lastOther = v;
          ov.querySelector('#scanfound').innerHTML = `<p class="small">Read <code>${esc(v)}</code> — not a tracking number I recognise.</p>
            <button class="btn block" id="useit">Use it anyway</button>`;
          ov.querySelector('#useit').onclick = () => finish(v.replace(/\s+/g, '').toUpperCase());
        }
      }
      ov.querySelector('#scancancel').onclick = () => finish(null);
      (async () => {
        try {
          stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
          video.srcObject = stream;
          await video.play().catch(() => {});
          let detect;
          if ('BarcodeDetector' in window) {
            // Native (Android Chrome, some desktops): fast, reads straight from the video.
            const det = new window.BarcodeDetector({ formats: ['code_128', 'code_39', 'qr_code', 'data_matrix', 'pdf417', 'itf'] });
            detect = async () => (await det.detect(video)).map((b) => b.rawValue);
          } else {
            // ZXing (iPhone, Windows Firefox…): decode a downscaled copy of each frame — full-size
            // frames are far too slow to decode continuously.
            await loadZxing();
            const Z = window.ZXing;
            const hints = new Map();
            hints.set(Z.DecodeHintType.POSSIBLE_FORMATS, [Z.BarcodeFormat.CODE_128, Z.BarcodeFormat.CODE_39, Z.BarcodeFormat.ITF,
              Z.BarcodeFormat.QR_CODE, Z.BarcodeFormat.DATA_MATRIX, Z.BarcodeFormat.PDF_417]);
            const mf = new Z.MultiFormatReader(); mf.setHints(hints);
            const canvas = document.createElement('canvas');
            const ctx2d = canvas.getContext('2d', { willReadFrequently: true });
            detect = async () => {
              const vw = video.videoWidth, vh = video.videoHeight;
              if (!vw || !vh) return [];
              const scale = Math.min(1, 960 / vw);
              canvas.width = Math.round(vw * scale); canvas.height = Math.round(vh * scale);
              ctx2d.drawImage(video, 0, 0, canvas.width, canvas.height);
              try {
                const bmp = new Z.BinaryBitmap(new Z.HybridBinarizer(new Z.HTMLCanvasElementLuminanceSource(canvas)));
                return [mf.decodeWithState(bmp).getText()];
              } catch { return []; } finally { mf.reset(); }
            };
          }
          let busy = false;
          timer = setInterval(async () => {
            if (done || busy || video.readyState < 2) return;
            busy = true;
            try { (await detect()).forEach(seen); } catch { /* frame not ready */ } finally { busy = false; }
          }, 200);
        } catch (e) {
          msg.textContent = /Permission|NotAllowed/i.test(e.name + e.message)
            ? 'Camera access was blocked. Allow the camera for this site in your browser settings, or type the number instead.'
            : `Can't open the camera here (${e.message}). Type the number instead.`;
        }
      })();
    });
  }

  // Receiving: scan a label, find the package it belongs to.
  let pendingTracking = null; // carried into the arrival / walk-in screens
  async function viewScanReceive() {
    $app.innerHTML = '<p class="muted pad">Opening the camera…</p>';
    const code = await scanBarcode();
    if (!code) { location.hash = '#/list/expected'; return; }
    const hits = (await api(`/packages?status=all&q=${encodeURIComponent(code)}`))
      .filter((p) => (p.tracking || '').replace(/\s+/g, '').toUpperCase() === code);
    const open = hits.find((p) => p.status === 'expected' || p.status === 'missing');
    if (open) { pendingTracking = code; location.hash = `#/p/${open.id}/arrive`; return; }
    if (hits.length) {
      const p = hits[0];
      $app.innerHTML = `<h1>Already logged</h1><div class="card"><p><strong>${esc(p.description)}</strong></p>
        <p>${p.status === 'arrived' ? `In the office since ${esc(fmtDT(p.arrived_at))} — 📍 ${esc(p.location)}` : esc(p.status)}</p></div>
        <div class="actions"><a class="btn primary block" href="#/p/${p.id}">Open it</a><a class="btn block" href="#/scan">Scan another</a></div>`;
      return;
    }
    // No package has this number yet. Amazon numbers never come by email, so offer the
    // expected packages without a tracking number to choose from.
    const candidates = (await api('/packages?status=expected')).filter((p) => !p.tracking);
    $app.innerHTML = `<p><a href="#/list/expected">← Back</a></p><h1>Which package is this?</h1>
      <p class="muted">Scanned <code>${esc(code)}</code>. No package has this number yet${candidates.length ? ' — pick the one it belongs to' : ''}.</p>
      <div class="list">${candidates.map((p) => `<button class="item pick" data-id="${p.id}" style="text-align:left;width:100%;font:inherit">
        <div class="thumb">📦</div><div class="body"><div class="title">${esc(p.description)}</div>
        <div class="meta">${esc([p.vendor, p.expected_date ? 'Due ' + fmtDay(p.expected_date) : '', p.recipient_name ? 'for ' + p.recipient_name : ''].filter(Boolean).join(' · '))}</div></div></button>`).join('')}</div>
      <div class="actions"><button class="btn dark block" id="notlisted">It's not on the list</button><a class="btn block" href="#/scan">Scan again</a></div>`;
    $app.querySelectorAll('.pick').forEach((b) => b.onclick = () => { pendingTracking = code; location.hash = `#/p/${b.dataset.id}/arrive`; });
    document.getElementById('notlisted').onclick = () => { pendingTracking = code; location.hash = '#/walkin'; };
  }

  // ---------- add a tracking number (from a push notification) ----------
  async function viewAddTracking(id) {
    const p = await api(`/packages/${id}`);
    const tu = trackUrl(p);
    $app.innerHTML = `<p><a href="#/p/${id}">← Package</a></p>
      <h1>Tracking number for: ${esc(p.description)}</h1>
      ${p.tracking ? `<div class="banner amber">Already has one: <strong>${esc(p.tracking)}</strong>. Saving replaces it.</div>` : ''}
      <ol class="steps"><li>Open Amazon's tracking page${/amazon/i.test(p.vendor || '') ? ' (signed in to Amazon)' : ''}.</li>
        <li>Copy the <strong>Tracking ID</strong> — it starts with <strong>TBA</strong> (or 1Z for UPS).</li><li>Paste it below and save.</li></ol>
      ${tu ? `<a class="btn block" href="${esc(tu)}" target="_blank" rel="noopener">Open the tracking page ↗</a>` : ''}
      <label class="f">Tracking number<input id="trk" autocomplete="off" autocapitalize="characters" value="${esc(p.tracking || '')}" placeholder="TBA…"></label>
      <p class="err" id="err"></p>
      <button class="btn primary block" id="save">Save</button>
      <div id="next"></div>`;
    const input = document.getElementById('trk');
    input.addEventListener('paste', () => setTimeout(() => { input.value = input.value.replace(/\s+/g, '').toUpperCase(); }, 0));
    document.getElementById('save').onclick = async () => {
      const v = input.value.replace(/\s+/g, '').toUpperCase();
      if (!v) { document.getElementById('err').textContent = 'Paste the tracking number first.'; return; }
      try {
        await api(`/packages/${id}`, { method: 'PATCH', json: { tracking: v } });
        toast('Tracking number saved');
        const rest = (await api('/needs-tracking')).filter((x) => x.id !== id);
        if (rest.length) location.hash = `#/p/${rest[0].id}/tracking`; else location.hash = `#/p/${id}`;
      } catch (e) { document.getElementById('err').textContent = e.message; }
    };
    const rest = (await api('/needs-tracking').catch(() => [])).filter((x) => x.id !== id);
    if (rest.length) document.getElementById('next').innerHTML = `<p class="small muted" style="margin-top:12px">${rest.length} more Amazon package${rest.length > 1 ? 's' : ''} need a tracking number — you'll go to the next one after saving.</p>`;
  }

  // ---------- notifications on this device ----------
  function urlB64ToUint8Array(b64) {
    const pad = '='.repeat((4 - (b64.length % 4)) % 4);
    const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
  }
  async function viewNotify() {
    const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
    const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
    const info = await api('/push/key');
    let sub = null;
    if (supported) {
      const reg = await navigator.serviceWorker.register('/sw.js');
      sub = await reg.pushManager.getSubscription();
    }
    let body;
    if (isIOS && !standalone) {
      body = `<div class="card"><h2 style="margin-top:0">iPhone: one-time setup</h2>
        <ol class="steps"><li>In Safari, tap the <strong>Share</strong> button (square with an arrow).</li>
        <li>Choose <strong>Add to Home Screen</strong> (scroll down the list if you don't see it). If there's an <strong>Open as Web App</strong> switch, leave it ON. Tap <strong>Add</strong>.</li>
        <li>Open <strong>Packages</strong> from your Home Screen, sign in, and come back to this page (tap <strong>Alerts</strong> at the top).</li></ol>
        <p class="small muted">Apple only allows notifications for sites opened from the Home Screen.</p></div>`;
    } else if (!supported) {
      body = '<div class="banner amber">This browser can’t receive notifications. Use Chrome or Edge, or Safari on an iPhone added to the Home Screen.</div>';
    } else if (!info.enabled) {
      body = '<div class="banner amber">Notifications aren’t set up on the server yet.</div>';
    } else if (Notification.permission === 'denied') {
      body = '<div class="banner red">Notifications are blocked for this site. Allow them in your browser’s site settings, then reload this page.</div>';
    } else {
      body = `<div class="card"><p style="margin-top:0"><strong>${sub ? '✓ Notifications are ON for this device.' : 'Notifications are off on this device.'}</strong></p>
        <p class="small muted">You're signed up on ${info.my_devices} device${info.my_devices === 1 ? '' : 's'} in total.</p></div>
        <div class="actions">${sub ? '<button class="btn block" id="test">Send a test notification</button><button class="btn block danger" id="off">Turn off on this device</button>'
          : '<button class="btn primary block" id="on">Turn on notifications</button>'}</div>`;
    }
    const isAndroid = /Android/.test(navigator.userAgent);
    const install = standalone ? '' : (window.__installPrompt
      ? '<div class="actions"><button class="btn block" id="install">Install as an app</button></div>'
      : (isAndroid ? `<div class="card small"><strong>To install as an app:</strong> Chrome ⋮ menu → <strong>Install app</strong>
          (or <strong>Add to Home screen</strong> → <strong>Install</strong>, not “Create shortcut”).
          If you already made a shortcut, delete it first. If the option is missing, close the page and open it again — Chrome
          only offers to install after a site has been used once.</div>` : ''));
    $app.innerHTML = `<p><a href="#/">← Back</a></p><h1>Notifications</h1>
      <p class="muted">${me.is_admin ? 'You’ll get a notification when the email scan finds an Amazon package that needs its tracking number. Tap it to add the number.' : 'Notifications for your packages.'}</p>${install}${body}`;
    const ib = document.getElementById('install');
    if (ib) ib.onclick = async () => {
      const ev = window.__installPrompt; window.__installPrompt = null;
      ev.prompt(); const c = await ev.userChoice;
      toast(c.outcome === 'accepted' ? 'Installing…' : 'Not installed'); viewNotify();
    };
    const on = document.getElementById('on');
    if (on) on.onclick = async () => {
      try {
        const perm = await Notification.requestPermission();
        if (perm !== 'granted') { toast('Notifications were not allowed'); return viewNotify(); }
        const reg = await navigator.serviceWorker.ready;
        const s = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8Array(info.key) });
        await api('/push/subscribe', { method: 'POST', json: { subscription: s.toJSON() } });
        await api('/push/test', { method: 'POST' });
        toast('Turned on — a test notification is on its way'); viewNotify();
      } catch (e) { toast(e.message); }
    };
    const test = document.getElementById('test');
    if (test) test.onclick = async () => { const r = await api('/push/test', { method: 'POST' }); toast(r.sent ? 'Sent — check your notifications' : 'Not sent'); };
    const off = document.getElementById('off');
    if (off) off.onclick = async () => { await api('/push/unsubscribe', { method: 'POST', json: { endpoint: sub.endpoint } }); await sub.unsubscribe(); toast('Turned off'); viewNotify(); };
  }

  // ---------- my PIN ----------
  function viewPin() {
    const forced = !!me.must_change_pin;
    const pinInput = (id, label) => `<label class="f">${label}<input id="${id}" type="password" inputmode="numeric" pattern="\\d*" maxlength="8" autocomplete="${id === 'cur' ? 'current-password' : 'new-password'}"></label>`;
    $app.innerHTML = `${forced ? '' : '<p><a href="#/">← Back</a></p>'}
      <h1>${forced ? `Welcome, ${esc(me.name)} — choose your own PIN` : 'Change my PIN'}</h1>
      <p class="muted">${forced ? 'You signed in with a starter PIN. Pick a new one that only you know — it records your name on every package you log or hand out.' : 'Your PIN is how the tracker knows it was you.'}</p>
      <form id="pf" class="card">
        ${pinInput('cur', forced ? 'Starter PIN (the one in your email)' : 'Current PIN')}
        ${pinInput('new1', 'New PIN (4 to 8 digits)')}
        ${pinInput('new2', 'New PIN again')}
        <p class="small muted">Avoid repeated digits and runs like 1234.</p>
        <p class="err" id="err"></p>
        <button class="btn primary block">Save my PIN</button>
      </form>`;
    document.getElementById('pf').onsubmit = async (ev) => {
      ev.preventDefault();
      const err = document.getElementById('err'); err.textContent = '';
      const cur = document.getElementById('cur').value, a = document.getElementById('new1').value, b = document.getElementById('new2').value;
      if (!/^\d{4,8}$/.test(a)) { err.textContent = 'Your new PIN must be 4 to 8 digits.'; return; }
      if (a !== b) { err.textContent = 'The two new PINs don’t match.'; return; }
      try {
        await api('/me/pin', { method: 'POST', json: { current: cur, pin: a } });
        me = await api('/me'); people = await api('/people').catch(() => []);
        toast('PIN saved'); location.hash = '#/';
      } catch (e) { err.textContent = e.message; }
    };
  }

  // ---------- lists ----------
  async function viewList(status) {
    const counts = await api('/counts');
    const tab = (s, label, n, alert) => `<a class="tab ${status === s ? 'on' : ''}" href="#/list/${s}">${label}${n !== undefined ? ` <span class="n ${alert ? 'alert' : ''}">${n}</span>` : ''}</a>`;
    $app.innerHTML = `<nav class="tabs">
        ${tab('expected', 'Expected', counts.expected, counts.attention > 0)}
        ${tab('arrived', 'In office', counts.arrived)}
        ${tab('collected', 'Gone')}
        ${tab('all', 'Search')}
      </nav>
      ${status === 'expected' && counts.attention ? `<div class="banner red">${counts.attention} package${counts.attention > 1 ? 's' : ''} need attention — the carrier says delivered or it's overdue, but nobody has logged it here.</div>` : ''}
      <input class="search" id="q" type="search" placeholder="${status === 'all' ? 'Search everything: tracking, order #, item, name…' : 'Filter by item, name or tracking #…'}" autocomplete="off">
      ${status === 'expected' ? `<div class="row" style="margin-bottom:10px"><a class="btn primary" href="#/scan">📷 Scan a label</a><a class="btn dark" href="#/walkin">Not on the list</a></div>
        <div id="needtrk"></div>` : ''}
      <div class="list" id="list"></div>
      <a class="btn primary fab" href="#/add">＋ Add package</a>`;
    const listEl = document.getElementById('list');
    const qEl = document.getElementById('q');
    async function load() {
      const q = qEl.value.trim();
      if (status === 'all' && !q) { listEl.innerHTML = '<div class="empty">Type to search every package, including ones that have left.</div>'; return; }
      const rows = await api(`/packages?status=${status}${q ? '&q=' + encodeURIComponent(q) : ''}`);
      if (!rows.length) {
        listEl.innerHTML = `<div class="empty">${q ? 'Nothing matches.' : { expected: 'Nothing expected right now.', arrived: 'Nothing waiting in the office.', collected: 'Nothing has left yet.' }[status] || 'Nothing here.'}</div>`;
        return;
      }
      listEl.innerHTML = rows.map((p) => {
        const sub = [];
        if (p.status === 'expected') sub.push(p.expected_date ? `Due ${fmtDay(p.expected_date)}` : 'No date');
        if (p.status === 'arrived') sub.push(`📍 ${p.location}`, `in ${fmtDT(p.arrived_at)}`);
        if (p.status === 'collected') sub.push(fmtDT(p.collected_at));
        if (status === 'all') sub.unshift(p.status);
        sub.push(p.recipient_name ? `for ${p.recipient_name}` : (p.label_name ? `label: ${p.label_name}` : ''));
        if (p.vendor) sub.push(p.vendor);
        const ref = shortRef(p);
        return `<a class="item" href="#/p/${p.id}">
          <div class="thumb" ${p.photo_id ? `style="background-image:url('/api/photos/${p.photo_id}')"` : ''}>${p.photo_id ? '' : '📦'}</div>
          <div class="body"><div class="title">${esc(p.description)}</div>
            <div class="meta">${sub.filter(Boolean).map(esc).join(' · ')}</div>
            ${ref ? `<div class="meta ref">${esc(ref)}</div>` : ''}${pills(p)}</div></a>`;
      }).join('');
    }
    let t; qEl.oninput = () => { clearTimeout(t); t = setTimeout(() => load().catch((e) => toast(e.message)), 250); };
    await load();
    if (status === 'expected' && me.is_admin) {
      const need = await api('/needs-tracking').catch(() => []);
      const el = document.getElementById('needtrk');
      if (el && need.length) el.innerHTML = `<a class="banner amber" style="display:block;text-decoration:none" href="#/p/${need[0].id}/tracking">
        ${need.length} Amazon package${need.length > 1 ? 's' : ''} need${need.length > 1 ? '' : 's'} a tracking number — tap to add from Amazon.</a>`;
    }
  }

  // ---------- package detail ----------
  const ACTION_TEXT = {
    created: 'Added', 'walk-in created': 'Logged as arrived without being expected', imported: 'Found in email', 'email update': 'Email update',
    'matched email': 'Matched to a shipping email', arrived: 'Arrived', moved: 'Moved', collected: 'Left the office', edited: 'Edited', status: 'Status changed',
  };
  function eventDetail(e) {
    const d = e.detail || {};
    if (e.action === 'arrived') return `put at “${d.location}”`;
    if (e.action === 'moved') return `from “${d.from}” to “${d.to}”`;
    if (e.action === 'collected') return `with ${d.by}${d.note ? ` — ${d.note}` : ''}`;
    if (e.action === 'status') return `${d.from} → ${d.to}: ${d.reason}`;
    if (e.action === 'edited' || e.action === 'email update' || e.action === 'matched email') {
      return Object.entries(d).map(([k, v]) => `${k.replace(/_/g, ' ')}: ${v.to ?? '—'}`).join('; ');
    }
    return '';
  }

  async function viewPackage(id) {
    const p = await api(`/packages/${id}`);
    const kv = (k, v) => v ? `<dt>${k}</dt><dd>${v}</dd>` : '';
    const statusLine = {
      expected: 'Expected',
      arrived: `In the office since ${esc(fmtDT(p.arrived_at))}`,
      collected: `Left the office with <strong>${esc(p.collected_by_name)}</strong> on ${esc(fmtDT(p.collected_at))}`,
      missing: 'Marked missing', cancelled: 'Cancelled / not coming',
    }[p.status];
    let actions = '';
    if (p.status === 'expected' || p.status === 'missing') actions += `<a class="btn primary block" href="#/p/${id}/arrive">It's here — log arrival</a>`;
    if (p.status === 'arrived') actions += `<a class="btn primary block" href="#/p/${id}/collect">Someone is leaving with it</a>
      <a class="btn block" href="#/p/${id}/move">It moved — new spot</a>`;
    const tu = trackUrl(p);
    if (tu && (p.status === 'expected' || p.status === 'missing')) {
      actions += `<a class="btn block" href="${esc(tu)}" target="_blank" rel="noopener">Track package${/amazon\.com/.test(tu) ? ' on Amazon' : ''} ↗</a>`;
    }
    if (p.status !== 'collected' || me.is_admin) actions += `<a class="btn block" href="#/p/${id}/edit">Edit details</a>`;
    const statusBtns = [];
    if (p.status === 'expected') statusBtns.push(['missing', 'Mark missing'], ['cancelled', 'Not coming (cancelled/returned)']);
    if (p.status === 'arrived') statusBtns.push(['missing', 'Mark missing — not where it should be']);
    if (p.status === 'missing' || p.status === 'cancelled') statusBtns.push(['expected', 'Put back on the expected list']);
    if (me.is_admin && p.status === 'collected') statusBtns.push(['arrived', 'Undo: it is still in the office']);
    if (me.is_admin && p.status === 'arrived') statusBtns.push(['expected', 'Undo: it has not arrived']);
    actions += statusBtns.map(([s, l]) => `<button class="btn block danger" data-status="${s}">${esc(l)}</button>`).join('');

    $app.innerHTML = `<p><a href="#/list/${p.status === 'collected' ? 'collected' : p.status === 'arrived' ? 'arrived' : 'expected'}">← Back</a></p>
      <h1>${esc(p.description)}</h1>
      ${p.flag_carrier_delivered ? `<div class="banner red">The carrier says this was delivered on ${esc(fmtDT(p.carrier_delivered_at))}, but nobody has logged it at the office. Please look for it.</div>` : ''}
      ${p.flag_overdue && !p.flag_carrier_delivered ? `<div class="banner amber">This was due ${esc(fmtDay(p.expected_date))} and hasn't been logged.</div>` : ''}
      <div class="card"><p style="margin-top:0">${statusLine}</p>
        ${p.status === 'arrived' ? `<p style="font-size:18px">📍 <strong>${esc(p.location)}</strong></p>` : ''}
        <dl class="kv">
          ${kv('For', esc(p.recipient_name || ''))}
          ${kv('Name on label', esc(p.label_name || ''))}
          ${kv('From', esc(p.vendor || ''))}
          ${kv('Carrier', esc(p.carrier || ''))}
          ${kv('Tracking', p.tracking ? (trackUrl(p) ? `<a href="${esc(trackUrl(p))}" target="_blank" rel="noopener">${esc(p.tracking)}</a>` : esc(p.tracking))
            : (/amazon/i.test(p.vendor || '') && p.status === 'expected' ? '<span class="muted">Amazon doesn’t email it — added from the label on arrival</span>' : ''))}
          ${kv('Order #', esc(p.order_number || ''))}
          ${kv('Expected', esc(fmtDay(p.expected_date)))}
          ${kv('Carrier status', esc((p.carrier_status || '').replace(/_/g, ' ')))}
          ${kv('Logged in by', esc(p.arrived_by_name || ''))}
          ${kv('Handed out by', esc(p.released_by_name || ''))}
          ${kv('Notes', esc(p.notes || ''))}
          ${kv('Email', p.email_link && /^https:\/\//.test(p.email_link) ? `<a href="${esc(p.email_link)}" target="_blank" rel="noopener">Open the shipping email</a>` : '')}
        </dl></div>
      <div class="actions">${actions}</div>
      ${p.photos.length ? `<h2>Photos</h2><div class="photos">${p.photos.map((ph) => `<figure><img loading="lazy" alt="${esc(ph.kind)} photo" src="/api/photos/${ph.id}" data-src="/api/photos/${ph.id}">
        <figcaption>${esc(ph.kind)} · ${esc(ph.taken_by_name || '')} · ${esc(fmtDT(ph.taken_at))}</figcaption></figure>`).join('')}</div>` : ''}
      <h2>History</h2><div class="card"><ul class="timeline">${p.events.map((e) =>
        `<li><strong>${esc(ACTION_TEXT[e.action] || e.action)}</strong> ${esc(eventDetail(e))}<div class="small muted">${esc(fmtDT(e.at))} · ${esc(e.actor || '')}</div></li>`).join('')}</ul></div>`;
    $app.querySelectorAll('.photos img').forEach((img) => img.onclick = () => lightbox(img.dataset.src));
    $app.querySelectorAll('[data-status]').forEach((b) => b.onclick = async () => {
      const reason = prompt(`${b.textContent}\n\nWhy? (required — this is kept in the history)`);
      if (!reason || !reason.trim()) return;
      try { await api(`/packages/${id}/status`, { method: 'POST', json: { status: b.dataset.status, reason } }); toast('Saved'); route(); }
      catch (e) { toast(e.message); }
    });
  }

  // ---------- arrive / move ----------
  async function locationField() {
    const locs = await api('/locations').catch(() => []);
    return `<label class="f">Where did you put it?<input id="loc" list="locs" placeholder="e.g. Shelf B, under Houston's desk" autocomplete="off"></label>
      <datalist id="locs">${locs.map((l) => `<option value="${esc(l)}">`).join('')}</datalist>
      ${locs.length ? `<div class="chips">${locs.slice(0, 8).map((l) => `<button type="button" class="chip" data-loc="${esc(l)}">${esc(l)}</button>`).join('')}</div>` : ''}`;
  }
  function wireScanButton(btnId, inputId) {
    const b = document.getElementById(btnId);
    if (!b) return;
    b.onclick = async () => {
      const code = await scanBarcode();
      if (code) { document.getElementById(inputId).value = code; toast('Scanned ' + code); }
    };
  }
  function wireChips() {
    $app.querySelectorAll('[data-loc]').forEach((c) => c.onclick = () => { document.getElementById('loc').value = c.dataset.loc; });
  }

  async function viewArrive(id, mode) {
    const p = await api(`/packages/${id}`);
    const moving = mode === 'move';
    $app.innerHTML = `<p><a href="#/p/${id}">← Back</a></p>
      <h1>${moving ? 'New spot for' : 'Log arrival:'} ${esc(p.description)}</h1>
      <p class="muted">${moving ? `Currently: ${esc(p.location)}` : 'Take a photo showing the package where you put it, so anyone can find it.'}</p>
      <div id="pic"></div>
      ${!moving && !p.tracking ? `<label class="f">Tracking number on the label (Amazon ones start with TBA)
        <span class="inrow"><input id="trk" autocomplete="off" autocapitalize="characters" placeholder="e.g. TBA123456789000" value="${esc(pendingTracking || '')}">
        <button type="button" class="btn" id="scanbtn" aria-label="Scan the barcode">📷 Scan</button></span></label>` : ''}
      ${await locationField()}
      <p class="err" id="err"></p>
      <button class="btn primary block" id="save">${moving ? 'Save new spot' : 'Save — it is here'}</button>`;
    wireChips();
    pendingTracking = null;
    wireScanButton('scanbtn', 'trk');
    const getBlob = photoPicker(document.getElementById('pic'), moving ? 'Photo of the new spot (optional)' : 'Photo of where you put it');
    document.getElementById('save').onclick = async (ev) => {
      const btn = ev.currentTarget; const err = document.getElementById('err');
      const location_ = document.getElementById('loc').value.trim();
      const blob = getBlob();
      err.textContent = '';
      if (!moving && !blob) { err.textContent = 'Take the photo first.'; return; }
      if (!location_) { err.textContent = 'Say where you put it.'; return; }
      btn.disabled = true; btn.textContent = 'Saving…';
      try {
        let photo_id = null;
        if (blob) photo_id = (await api(`/packages/${id}/photo?kind=${moving ? 'moved' : 'arrival'}`, { method: 'POST', blob })).id;
        const trkEl = document.getElementById('trk');
        await api(`/packages/${id}/${moving ? 'move' : 'arrive'}`, { method: 'POST', json: { location: location_, photo_id, tracking: trkEl ? trkEl.value : undefined } });
        toast(moving ? 'Moved' : 'Logged as arrived');
        location.hash = `#/p/${id}`;
      } catch (e) { err.textContent = e.message; btn.disabled = false; btn.textContent = 'Try again'; }
    };
  }

  // ---------- walk-in (arrived, never expected) ----------
  async function viewWalkIn() {
    $app.innerHTML = `<p><a href="#/">← Back</a></p><h1>Arrived but not on the list</h1>
      <p class="muted">Log it anyway so it isn't lost. Photograph the label first, then where you put it.</p>
      <div id="label"></div>
      <label class="f">What is it / who is it from?<input id="desc" placeholder="e.g. Small box from Home Depot"></label>
      <label class="f">Name on the label<input id="label_name"></label>
      <label class="f">For<select id="rcp"><option value="">Not sure</option>${people.filter((x) => x.can_collect).map((x) => `<option value="${x.id}">${esc(x.name)}</option>`).join('')}</select></label>
      <label class="f">Tracking number on the label
        <span class="inrow"><input id="trk" autocomplete="off" autocapitalize="characters" value="${esc(pendingTracking || '')}">
        <button type="button" class="btn" id="scanbtn" aria-label="Scan the barcode">📷 Scan</button></span></label>
      <div id="spot" style="margin-top:12px"></div>${await locationField()}
      <p class="err" id="err"></p><button class="btn primary block" id="save">Save — it is here</button>`;
    wireChips();
    pendingTracking = null;
    wireScanButton('scanbtn', 'trk');
    const getLabel = photoPicker(document.getElementById('label'), 'Photo of the label');
    const getSpot = photoPicker(document.getElementById('spot'), 'Photo of where you put it');
    document.getElementById('save').onclick = async (ev) => {
      const btn = ev.currentTarget; const err = document.getElementById('err'); err.textContent = '';
      const description = document.getElementById('desc').value.trim();
      const loc = document.getElementById('loc').value.trim();
      if (!description) { err.textContent = 'Say what it is.'; return; }
      if (!getSpot()) { err.textContent = 'Take a photo of where you put it.'; return; }
      if (!loc) { err.textContent = 'Say where you put it.'; return; }
      btn.disabled = true; btn.textContent = 'Saving…';
      const logOn = async (pid) => {
        if (getLabel()) await api(`/packages/${pid}/photo?kind=label`, { method: 'POST', blob: getLabel() });
        const photo_id = (await api(`/packages/${pid}/photo?kind=arrival`, { method: 'POST', blob: getSpot() })).id;
        await api(`/packages/${pid}/arrive`, { method: 'POST', json: { location: loc, photo_id } });
      };
      try {
        const p = await api('/packages', { method: 'POST', json: { walk_in: true, description, label_name: document.getElementById('label_name').value,
          recipient_id: document.getElementById('rcp').value || null, tracking: document.getElementById('trk').value } });
        await logOn(p.id);
        toast('Logged'); location.hash = `#/p/${p.id}`;
      } catch (e) {
        const ex = e.status === 409 && e.data && e.data.existing;
        if (ex && (ex.status === 'expected' || ex.status === 'missing')) {
          // It WAS on the list (same tracking number): log the arrival there instead of making a duplicate.
          try {
            await logOn(ex.id);
            toast(`It was on the list as “${ex.description}” — logged there`); location.hash = `#/p/${ex.id}`;
            return;
          } catch (e2) { err.textContent = e2.message; }
        } else if (ex) {
          err.innerHTML = `${esc(e.message)} <a href="#/p/${ex.id}">Open it</a>`;
        } else { err.textContent = e.message; }
        btn.disabled = false; btn.textContent = 'Try again';
      }
    };
  }

  // ---------- collect ----------
  async function viewCollect(id) {
    const p = await api(`/packages/${id}`);
    const takers = people.filter((x) => x.can_collect);
    let chosen = null;
    $app.innerHTML = `<p><a href="#/p/${id}">← Back</a></p>
      <h1>Who is leaving with it?</h1>
      <p class="muted">${esc(p.description)} · 📍 ${esc(p.location)}</p>
      <div class="people">${takers.map((x) => `<button class="person" data-id="${x.id}">${esc(x.name)}</button>`).join('')}</div>
      <label class="f">Note (optional)<input id="note" placeholder="e.g. took it to the car"></label>
      <p class="err" id="err"></p>
      <button class="btn primary block" id="save" disabled>Confirm</button>`;
    const save = document.getElementById('save');
    $app.querySelectorAll('.person').forEach((b) => b.onclick = () => {
      $app.querySelectorAll('.person').forEach((x) => x.classList.remove('on'));
      b.classList.add('on'); chosen = Number(b.dataset.id);
      save.disabled = false; save.textContent = `Confirm — ${b.textContent} has it`;
    });
    save.onclick = async () => {
      save.disabled = true;
      try {
        await api(`/packages/${id}/collect`, { method: 'POST', json: { collected_by: chosen, note: document.getElementById('note').value } });
        toast('Recorded'); location.hash = '#/list/arrived';
      } catch (e) { document.getElementById('err').textContent = e.message; save.disabled = false; }
    };
  }

  // ---------- add / edit ----------
  async function viewEdit(id, mode) {
    const p = id ? await api(`/packages/${id}`) : { recipient_id: me.can_collect ? me.id : null };
    const v = (k) => esc(p[k] ?? '');
    $app.innerHTML = `<p><a href="${id ? `#/p/${id}` : '#/'}">← Back</a></p>
      <h1>${id ? 'Edit package' : 'Add a package going to the office'}</h1>
      ${id ? '' : `<div class="card shotbox"><button type="button" class="btn primary block" id="fromshot">📷 Fill in from a screenshot</button>
        <p class="small muted" style="margin:8px 0 0">Screenshot the order or tracking page (Amazon app, store email…) and pick it here. Check the details, then Add.</p>
        <input type="file" id="shotfile" accept="image/*" hidden><div id="shotres"></div></div>
        <p class="muted small" style="text-align:center;margin:4px 0 8px">— or type it in —</p>`}
      <form id="f">
      <input type="hidden" name="label_name" value="${v('label_name')}">
      <label class="f">What is it?<input name="description" required value="${v('description')}" placeholder="e.g. Printer toner"></label>
      <label class="f">For<select name="recipient_id"><option value="">—</option>${people.map((x) => `<option value="${x.id}" ${p.recipient_id === x.id ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select></label>
      <label class="f">From (store / sender)<input name="vendor" value="${v('vendor')}" placeholder="Amazon, Home Depot…"></label>
      <div class="row"><label class="f">Carrier<input name="carrier" list="carriers" value="${v('carrier')}"></label>
        <label class="f">Expected on<input name="expected_date" type="date" value="${v('expected_date')}" min="2020-01-01"></label></div>
      <datalist id="carriers"><option value="UPS"><option value="FedEx"><option value="USPS"><option value="Amazon"><option value="DHL"></datalist>
      <label class="f">Tracking number<input name="tracking" value="${v('tracking')}" autocomplete="off"></label>
      <label class="f">Order number<input name="order_number" value="${v('order_number')}" autocomplete="off"></label>
      <label class="f">Notes<textarea name="notes" rows="3">${v('notes')}</textarea></label>
      <p class="err" id="err"></p>
      <button class="btn primary block">${id ? 'Save changes' : 'Add package'}</button></form>`;
    if (!id) { const d = $app.querySelector('[name=expected_date]'); if (!d.value) d.value = ''; d.min = todayET().slice(0, 4) + '-01-01'; }
    let shotBlob = null; // the screenshot the details came from, attached to what gets added
    const form = document.getElementById('f');
    const fill = (x) => {
      for (const k of ['description', 'vendor', 'carrier', 'tracking', 'order_number', 'expected_date', 'label_name']) {
        if (x[k] && form.elements[k]) form.elements[k].value = x[k];
      }
    };
    if (!id) {
      const file = document.getElementById('shotfile');
      const res = document.getElementById('shotres');
      document.getElementById('fromshot').onclick = () => file.click();
      file.onchange = async () => {
        const f = file.files[0]; file.value = '';
        if (!f) return;
        res.innerHTML = '<p class="muted">Reading the screenshot… (about 10 seconds)</p>';
        try {
          shotBlob = await shrink(f, 2000, 0.9);
          const out = await api('/extract', { method: 'POST', blob: shotBlob });
          const pk = out.packages;
          const warn = (x) => [
            x.existing ? `<div class="banner amber">Already on the list: <a href="#/p/${x.existing.id}">${esc(x.existing.description)}</a> (${esc(x.existing.status)}).</div>` : '',
            x.ship_to_office === false ? `<div class="banner red">This is NOT going to the office — ship-to: ${esc(x.ship_to || 'another address')}.</div>` : '',
          ].join('');
          if (!pk.length) {
            res.innerHTML = `<div class="banner amber">Couldn't find a package in that screenshot${out.note ? ': ' + esc(out.note) : ''}. Type it in below.</div>`;
          } else if (pk.length === 1) {
            fill(pk[0]);
            res.innerHTML = `<div class="banner" style="background:#e9f7f7;color:var(--accent-ink)">Filled in below — please check it, then tap <strong>Add package</strong>.</div>
              ${warn(pk[0])}${out.note ? `<p class="small muted">Note: ${esc(out.note)}</p>` : ''}`;
            form.scrollIntoView({ behavior: 'smooth' });
          } else {
            res.innerHTML = `<p><strong>${pk.length} shipments found.</strong> Tick the ones to add:</p>
              ${pk.map((x, i) => `<label class="check card" style="align-items:flex-start"><input type="checkbox" data-i="${i}" ${x.existing || x.ship_to_office === false ? '' : 'checked'}>
                <span><strong>${esc(x.description || 'Package')}</strong><br><span class="small muted">${esc([x.vendor, x.expected_date ? 'due ' + fmtDay(x.expected_date) : '', x.tracking || x.order_number].filter(Boolean).join(' · '))}</span>${warn(x)}</span></label>`).join('')}
              ${out.note ? `<p class="small muted">Note: ${esc(out.note)}</p>` : ''}
              <button type="button" class="btn primary block" id="addall">Add the ticked ones</button>`;
            document.getElementById('addall').onclick = async (ev) => {
              const btn = ev.currentTarget; btn.disabled = true;
              const rid = form.elements.recipient_id.value || null;
              let n = 0, last = null;
              try {
                for (const cb of res.querySelectorAll('input[type=checkbox]:checked')) {
                  const x = pk[Number(cb.dataset.i)];
                  const r = await api('/packages', { method: 'POST', json: { ...x, recipient_id: rid } });
                  await api(`/packages/${r.id}/photo?kind=screenshot`, { method: 'POST', blob: shotBlob }).catch(() => {});
                  n++; last = r.id;
                }
                toast(`Added ${n}`); location.hash = n === 1 ? `#/p/${last}` : '#/list/expected';
              } catch (e) { btn.disabled = false; toast(e.message); }
            };
          }
        } catch (e) { res.innerHTML = `<div class="banner amber">${esc(e.message)}</div>`; }
      };
    }
    form.onsubmit = async (ev) => {
      ev.preventDefault();
      const body = Object.fromEntries(new FormData(ev.target).entries());
      try {
        const r = id ? await api(`/packages/${id}`, { method: 'PATCH', json: body }) : await api('/packages', { method: 'POST', json: body });
        if (!id && shotBlob) await api(`/packages/${r.id}/photo?kind=screenshot`, { method: 'POST', blob: shotBlob }).catch(() => {});
        toast('Saved'); location.hash = `#/p/${r.id}`;
      } catch (e) { document.getElementById('err').textContent = e.message; }
    };
    void mode;
  }

  // ---------- admin ----------
  async function viewAdmin() {
    if (!me.is_admin) { $app.innerHTML = '<p class="pad">Admins only.</p>'; return; }
    const [ps, toks] = await Promise.all([api('/admin/people'), api('/admin/tokens')]);
    $app.innerHTML = `<p><a href="#/">← Back</a></p><h1>Admin</h1>
      <h2>People</h2>
      <p class="muted small">Anyone with a PIN can sign in and log packages. “Can take packages” puts them on the “who is leaving with it” screen. Email gets arrival alerts for their packages; admins also get the weekday 8am digest.</p>
      <div class="card" style="overflow-x:auto"><table class="t"><thead><tr><th>Name</th><th>Email</th><th>PIN</th><th>Takes pkgs</th><th>Admin</th><th></th></tr></thead><tbody>
      ${ps.map((x) => `<tr style="${x.active ? '' : 'opacity:.5'}"><td>${esc(x.name)}${x.aliases && x.aliases.length ? `<div class="small muted">aka ${esc(x.aliases.join(', '))}</div>` : ''}</td><td class="small">${esc(x.email || '')}</td>
        <td>${x.has_pin ? '✓' : '—'}</td><td>${x.can_collect ? '✓' : ''}</td><td>${x.is_admin ? '✓' : ''}</td>
        <td><button class="btn" data-edit="${x.id}" style="min-height:36px;padding:6px 10px">Edit</button></td></tr>`).join('')}
      </tbody></table></div>
      <div id="pform"></div>
      <button class="btn block" id="addp">＋ Add person</button>
      <h2>Morning digest</h2>
      <p class="muted small">Weekdays at 8:00 Eastern, if anything is overdue, delivered-but-not-logged, or sitting 7+ days.</p>
      <button class="btn block" id="digest">Send the digest now</button>
      <h2>Email-scan tokens</h2>
      <p class="muted small">The scheduled email scan uses one of these to add packages.</p>
      <div class="card"><table class="t"><tbody>${toks.map((t) => `<tr><td>${esc(t.label)}</td><td class="small">created ${esc(fmtD(t.created_at))}<br>last used ${esc(t.last_used ? fmtDT(t.last_used) : 'never')}</td>
        <td>${t.revoked_at ? 'revoked' : `<button class="btn danger" data-revoke="${t.id}" style="min-height:36px;padding:6px 10px">Revoke</button>`}</td></tr>`).join('') || '<tr><td class="muted">None yet</td></tr>'}</tbody></table></div>
      <button class="btn block" id="newtok">Create a token</button><div id="tokout"></div>`;

    const form = (x) => {
      const el = document.getElementById('pform');
      el.innerHTML = `<form class="card" id="pf"><h2 style="margin-top:0">${x ? 'Edit ' + esc(x.name) : 'New person'}</h2>
        <label class="f">Name<input name="name" required value="${esc(x ? x.name : '')}"></label>
        <label class="f">Email (for alerts)<input name="email" type="email" value="${esc(x ? x.email || '' : '')}"></label>
        <label class="f">Other names on labels (comma separated)<input name="aliases" value="${esc(x && x.aliases ? x.aliases.join(', ') : '')}"></label>
        <label class="f">${x && x.has_pin ? 'New starter PIN (leave blank to keep; they choose their own at next sign-in)' : 'Starter PIN (4–8 digits; they choose their own at first sign-in; blank = never signs in)'}<input name="pin" inputmode="numeric" pattern="\\d{4,8}" autocomplete="new-password"></label>
        <label class="check"><input type="checkbox" name="can_collect" ${!x || x.can_collect ? 'checked' : ''}> Can take packages out of the office</label>
        <label class="check"><input type="checkbox" name="is_admin" ${x && x.is_admin ? 'checked' : ''}> Admin</label>
        ${x ? `<label class="check"><input type="checkbox" name="active" ${x.active ? 'checked' : ''}> Active</label>
               ${x.has_pin ? '<label class="check"><input type="checkbox" name="clear_pin"> Remove PIN (stop them signing in)</label>' : ''}` : ''}
        <p class="err" id="perr"></p><div class="row"><button class="btn primary">Save</button><button type="button" class="btn" id="pcancel">Cancel</button></div></form>`;
      document.getElementById('pcancel').onclick = () => { el.innerHTML = ''; };
      document.getElementById('pf').onsubmit = async (ev) => {
        ev.preventDefault();
        const fd = new FormData(ev.target);
        const body = { name: fd.get('name'), email: fd.get('email'), aliases: fd.get('aliases'), pin: fd.get('pin') || undefined,
          can_collect: fd.has('can_collect'), is_admin: fd.has('is_admin') };
        if (x) { body.active = fd.has('active'); body.clear_pin = fd.has('clear_pin'); }
        try {
          if (x) await api(`/admin/people/${x.id}`, { method: 'PATCH', json: body }); else await api('/admin/people', { method: 'POST', json: body });
          people = await api('/people'); toast('Saved'); viewAdmin();
        } catch (e) { document.getElementById('perr').textContent = e.message; }
      };
      el.scrollIntoView({ behavior: 'smooth' });
    };
    document.getElementById('addp').onclick = () => form(null);
    $app.querySelectorAll('[data-edit]').forEach((b) => b.onclick = () => form(ps.find((x) => x.id === Number(b.dataset.edit))));
    document.getElementById('digest').onclick = async () => {
      try { const r = await api('/admin/digest', { method: 'POST' }); toast(r.sent ? `Sent to ${r.to.join(', ')}` : (r.error || 'Not sent')); } catch (e) { toast(e.message); }
    };
    document.getElementById('newtok').onclick = async () => {
      const label = prompt('Label for this token', 'email scan'); if (!label) return;
      const r = await api('/admin/tokens', { method: 'POST', json: { label } });
      document.getElementById('tokout').innerHTML = `<p class="muted small">Copy this now — it won't be shown again:</p><code class="tok">${esc(r.token)}</code>`;
    };
    $app.querySelectorAll('[data-revoke]').forEach((b) => b.onclick = async () => {
      if (!confirm('Revoke this token? The email scan using it will stop working.')) return;
      await api(`/admin/tokens/${b.dataset.revoke}/revoke`, { method: 'POST' }); viewAdmin();
    });
  }

  // Register the worker on every visit: Chrome only treats the site as installable once it has
  // seen one controlling the page. It caches nothing (see sw.js).
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  // Chrome's own install offer, kept so the Alerts page can show an Install button.
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); window.__installPrompt = e; });
  window.addEventListener('appinstalled', () => { window.__installPrompt = null; toast('Installed'); });

  route();
})();
