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
    if (!r.ok) throw new Error((data && data.error) || `Request failed (${r.status})`);
    return data;
  }
  const fmtDT = (ts) => ts ? new Date(ts).toLocaleString('en-US', { timeZone: TZ, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
  const fmtD = (ts) => ts ? new Date(ts).toLocaleDateString('en-US', { timeZone: TZ, month: 'short', day: 'numeric' }) : '';
  // A DATE ('YYYY-MM-DD') is a calendar day, not an instant: format it at noon UTC so it never slips a day.
  const fmtDay = (d) => d ? new Date(d + 'T12:00:00Z').toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' }) : '';
  const todayET = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());

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
  async function shrink(file) {
    try {
      const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
      const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
      const c = document.createElement('canvas');
      c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
      c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
      return await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.82));
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
      ? `${esc(me.name)} ${me.is_admin && !me.must_change_pin ? '<a href="#/admin">Admin</a>' : ''} <a href="#/pin">PIN</a> <button id="logout">Sign out</button>`
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
      <input class="search" id="q" type="search" placeholder="${status === 'all' ? 'Search everything: tracking, order #, item, name…' : 'Filter…'}" autocomplete="off">
      ${status === 'expected' ? '<div class="row" style="margin-bottom:10px"><a class="btn dark" href="#/walkin">Arrived but not on the list</a></div>' : ''}
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
        return `<a class="item" href="#/p/${p.id}">
          <div class="thumb" ${p.photo_id ? `style="background-image:url('/api/photos/${p.photo_id}')"` : ''}>${p.photo_id ? '' : '📦'}</div>
          <div class="body"><div class="title">${esc(p.description)}</div>
            <div class="meta">${sub.filter(Boolean).map(esc).join(' · ')}</div>${pills(p)}</div></a>`;
      }).join('');
    }
    let t; qEl.oninput = () => { clearTimeout(t); t = setTimeout(() => load().catch((e) => toast(e.message)), 250); };
    await load();
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
          ${kv('Tracking', esc(p.tracking || ''))}
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
  function wireChips() {
    $app.querySelectorAll('[data-loc]').forEach((c) => c.onclick = () => { document.getElementById('loc').value = c.dataset.loc; });
  }

  async function viewArrive(id, mode) {
    const p = await api(`/packages/${id}`);
    const moving = mode === 'move';
    $app.innerHTML = `<p><a href="#/p/${id}">← Back</a></p>
      <h1>${moving ? 'New spot for' : 'Log arrival:'} ${esc(p.description)}</h1>
      <p class="muted">${moving ? `Currently: ${esc(p.location)}` : 'Take a photo showing the package where you put it, so anyone can find it.'}</p>
      <div id="pic"></div>${await locationField()}
      <p class="err" id="err"></p>
      <button class="btn primary block" id="save">${moving ? 'Save new spot' : 'Save — it is here'}</button>`;
    wireChips();
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
        await api(`/packages/${id}/${moving ? 'move' : 'arrive'}`, { method: 'POST', json: { location: location_, photo_id } });
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
      <label class="f">Tracking number (if you can read it)<input id="trk" autocomplete="off"></label>
      <div id="spot" style="margin-top:12px"></div>${await locationField()}
      <p class="err" id="err"></p><button class="btn primary block" id="save">Save — it is here</button>`;
    wireChips();
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
      try {
        const p = await api('/packages', { method: 'POST', json: { walk_in: true, description, label_name: document.getElementById('label_name').value,
          recipient_id: document.getElementById('rcp').value || null, tracking: document.getElementById('trk').value } });
        if (getLabel()) await api(`/packages/${p.id}/photo?kind=label`, { method: 'POST', blob: getLabel() });
        const photo_id = (await api(`/packages/${p.id}/photo?kind=arrival`, { method: 'POST', blob: getSpot() })).id;
        await api(`/packages/${p.id}/arrive`, { method: 'POST', json: { location: loc, photo_id } });
        toast('Logged'); location.hash = `#/p/${p.id}`;
      } catch (e) { err.textContent = e.message; btn.disabled = false; btn.textContent = 'Try again'; }
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
    const p = id ? await api(`/packages/${id}`) : {};
    const v = (k) => esc(p[k] ?? '');
    $app.innerHTML = `<p><a href="${id ? `#/p/${id}` : '#/'}">← Back</a></p>
      <h1>${id ? 'Edit package' : 'Add a package going to the office'}</h1>
      <form id="f">
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
    document.getElementById('f').onsubmit = async (ev) => {
      ev.preventDefault();
      const body = Object.fromEntries(new FormData(ev.target).entries());
      try {
        const r = id ? await api(`/packages/${id}`, { method: 'PATCH', json: body }) : await api('/packages', { method: 'POST', json: body });
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

  route();
})();
