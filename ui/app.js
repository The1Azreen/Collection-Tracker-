'use strict';
(() => {
  const { TYPES, STATUSES, CONDITIONS } = window.CT;
  const TYPE_KEYS = Object.keys(TYPES);

  /* =====================================================================
   * Backends: the desktop app (Rust, via Tauri) or a plain browser.
   * Both expose the same methods so the rest of the UI doesn't care.
   * ===================================================================== */
  const tauri = window.__TAURI__;
  const desktop = !!tauri?.core;

  function desktopBackend() {
    const invoke = tauri.core.invoke;
    let coversDir = '';
    return {
      desktop: true,
      async init() { coversDir = await invoke('covers_dir'); },
      list: () => invoke('list_items'),
      save: items => invoke('save_items', { items }),
      remove: ids => invoke('delete_items', { ids }),
      async storeCover(dataUrl) { return { coverFile: await invoke('save_cover', { data: dataUrl }), cover: '' }; },
      coverSrc: i => (i.coverFile ? tauri.core.convertFileSrc(coversDir + i.coverFile) : i.cover || ''),
      async exportBackup() {
        const path = await invoke('export_backup', { fileName: backupName() });
        return path ? `Backup saved to ${path}` : null;
      },
      importBackup: () => invoke('import_backup'),
      openFolder: () => invoke('open_data_folder'),
      fetchJson: url => invoke('fetch_json', { url }).catch(e => { throw new Error(String(e)); }),
      fetchText: url => invoke('fetch_text', { url }).catch(e => { throw new Error(String(e)); }),
      // Keep a local copy of covers found online so they still show offline.
      async remoteCover(url) {
        try { return { coverFile: await invoke('download_cover', { url }), cover: '' }; } catch { return { cover: url, coverFile: '' }; }
      },
      footnote: 'Saved in the “Collection Data” folder next to the app.',
    };
  }

  function browserBackend() {
    let dbp;
    const open = () => (dbp ||= new Promise((resolve, reject) => {
      const req = indexedDB.open('collection-tracker', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('items', { keyPath: 'id' });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }));
    const tx = (mode, fn) => open().then(db => new Promise((resolve, reject) => {
      const t = db.transaction('items', mode);
      const req = fn(t.objectStore('items'));
      t.oncomplete = () => resolve(req ? req.result : undefined);
      t.onerror = t.onabort = () => reject(t.error);
    }));
    return {
      desktop: false,
      async init() { try { await navigator.storage?.persist?.(); } catch { /* optional */ } },
      list: () => tx('readonly', s => s.getAll()),
      save: items => tx('readwrite', s => { items.forEach(i => s.put(i)); }),
      remove: ids => tx('readwrite', s => { ids.forEach(id => s.delete(id)); }),
      async storeCover(dataUrl) { return { cover: dataUrl, coverFile: '' }; },
      coverSrc: i => i.cover || '',
      async exportBackup() {
        const blob = new Blob([JSON.stringify({ app: 'collection-tracker', version: 1, items: state.items })], { type: 'application/json' });
        const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: backupName() });
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
        return 'Backup downloaded.';
      },
      importBackup: () => new Promise((resolve, reject) => {
        const input = Object.assign(document.createElement('input'), { type: 'file', accept: '.json,application/json' });
        input.onchange = async () => {
          try {
            const doc = JSON.parse(await input.files[0].text());
            const covers = doc.covers || {};
            const items = (Array.isArray(doc) ? doc : doc.items || [])
              .filter(x => x && typeof x === 'object' && x.title && x.type)
              .map(x => {
                const item = { ...x, id: String(x.id || uid()) };
                // Backups from the desktop app carry covers as separate files; inline them here.
                if (item.coverFile && covers[item.coverFile]) item.cover = `data:image/jpeg;base64,${covers[item.coverFile]}`;
                delete item.coverFile;
                return item;
              });
            if (!items.length) throw new Error('No items found in that file.');
            await this.save(items);
            resolve(items.length);
          } catch (e) { reject(e); }
        };
        input.click();
      }),
      openFolder: null,
      fetchJson: null,
      remoteCover: async url => ({ cover: url, coverFile: '' }),
      footnote: 'Saved in this browser only. Export a backup now and then.',
    };
  }

  const backend = desktop ? desktopBackend() : browserBackend();
  if (backend.fetchJson) window.Lookup.useFetcher(backend.fetchJson, backend.fetchText);

  /* =====================================================================
   * State and helpers
   * ===================================================================== */
  const pref = {
    get(k, d) { try { return localStorage.getItem('ct.' + k) ?? d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem('ct.' + k, v); } catch { /* optional */ } },
  };

  const state = {
    items: [],
    view: pref.get('view', 'shelf'),
    arrange: pref.get('arrange', 'type'),
    filter: 'all',
    query: '',
  };
  let editing = null;  // item being edited, or null when adding
  let draft = null;    // cover in the editor: { cover, coverFile, pendingData }

  const $ = (sel, el = document) => el.querySelector(sel);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
  const typeOf = i => TYPES[i.type] || { label: i.type, singular: i.type, icon: '▪', creator: 'Creator', shape: 'book', fields: [], genres: [] };
  const byText = (a, b) => String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
  const today = () => new Date().toISOString().slice(0, 10);
  const backupName = () => `collection-backup-${today()}.json`;

  function hash(str) {
    let h = 2166136261;
    for (const ch of String(str)) { h ^= ch.codePointAt(0); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }

  /* ---------- Spine looks ---------- */
  const BOOK_COLOURS = ['#6b3e26', '#8a5a3b', '#b48a68', '#3f4a3c', '#5a2e2e', '#2f3e4e', '#c9a27a', '#7a6a4f', '#9b4a3a', '#e2d3b5', '#4d3b5e', '#a3643f'];
  const RECORD_COLOURS = ['#2b2b2b', '#3d2f4f', '#7a2f2f', '#1f4a5a', '#c4a35a', '#5a4636', '#284d3a', '#b0472f', '#d9cbb0'];

  // Game cases use the Game//State palette: colour follows the platform family.
  function platformColour(p = '') {
    p = p.toLowerCase();
    if (/ps ?\d|playstation|vita|psp|pc|steam/.test(p)) return '#6de0f6';           // teal
    if (/switch ?2/.test(p)) return '#ff6ff2';                                       // magenta
    if (/^switch$|switch/.test(p)) return '#f7c948';                                 // yellow
    if (/wii|n64|gamecube|snes|nes|3ds|\bds\b|game ?boy|nintendo/.test(p)) return '#ff6ff2';
    if (/xbox/.test(p)) return '#7cffb2';                                            // mint
    if (/sega|dreamcast|saturn|mega ?drive|genesis/.test(p)) return '#ffb25c';       // orange
    return '#7a6cc0';                                                                // neutral indigo
  }
  function discColour(format = '', edition = '') {
    if (/steel/i.test(edition)) return '#8b9096';
    if (/4k|uhd/i.test(format)) return '#161616';
    if (/dvd/i.test(format)) return '#262626';
    return '#1e5bb8';
  }
  function autoColour(i) {
    const x = i.extra || {};
    const seed = hash(i.id + (i.title || ''));
    switch (typeOf(i).shape) {
      case 'game': return platformColour(x.platform);
      case 'disc': return discColour(x.format, x.edition);
      case 'vinyl':
      case 'cd': return RECORD_COLOURS[seed % RECORD_COLOURS.length];
      default: return BOOK_COLOURS[seed % BOOK_COLOURS.length];
    }
  }
  const colourOf = i => (/^#[0-9a-f]{6}$/i.test(i.spineColor || '') ? i.spineColor : autoColour(i));
  function inkFor(hex) {
    const n = parseInt(hex.slice(1), 16);
    const lum = 0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255);
    return lum > 150 ? '#2a211b' : '#f6efe4';
  }
  function dims(i) {
    switch (typeOf(i).shape) {
      case 'vinyl': return { w: 22, h: 226 };
      case 'cd': return { w: 24, h: 150 };
      case 'game': return { w: 28, h: 196 };
      case 'disc': return { w: 26, h: 184 };
      default: {
        const pages = Number(i.extra?.pages) || 250 + (hash(i.title) % 250);
        return { w: Math.round(Math.min(60, Math.max(28, 18 + pages / 18))), h: 166 + (hash(i.id) % 62) };
      }
    }
  }

  const subtitle = i => [i.creator, i.year, i.extra?.platform || i.extra?.format].filter(Boolean).join(' · ');

  /* ---------- Filtering & grouping ---------- */
  const ARRANGE = {
    type:    { label: 'Type', key: i => i.type, name: k => (TYPES[k] ? `${TYPES[k].icon} ${TYPES[k].label}` : k), order: k => TYPE_KEYS.indexOf(k) },
    genre:   { label: 'Genre', key: i => i.genre?.trim() || 'No genre' },
    creator: { label: 'Creator', key: i => i.creator?.trim() || 'Unknown', inner: (a, b) => (a.year || 0) - (b.year || 0) },
    format:  { label: 'Format / platform', key: i => (i.extra?.platform || i.extra?.format || typeOf(i).singular).trim() },
    decade:  { label: 'Decade', key: i => (i.year ? `${Math.floor(i.year / 10) * 10}s` : 'Unknown year') },
    status:  { label: 'Status', key: i => i.status || 'Owned', order: k => STATUSES.indexOf(k) },
  };
  if (!ARRANGE[state.arrange]) state.arrange = 'type';

  const FILTERS = {
    all:      i => i.status !== 'Sold',
    wishlist: i => i.status === 'Wishlist',
    lent:     i => i.status === 'Lent out',
    fav:      i => i.favourite,
    sold:     i => i.status === 'Sold',
  };

  function searchText(i) {
    return [i.title, i.creator, i.genre, i.year, i.status, i.notes, i.barcode, ...(i.tags || []), ...Object.values(i.extra || {})]
      .filter(v => v != null).join(' ').toLowerCase();
  }

  function visibleItems() {
    const f = state.filter;
    const test = TYPES[f] ? i => i.type === f && i.status !== 'Sold' : FILTERS[f] || FILTERS.all;
    const words = state.query.toLowerCase().split(/\s+/).filter(Boolean);
    return state.items.filter(i => test(i) && (!words.length || words.every(w => searchText(i).includes(w))));
  }

  function groups(list) {
    const a = ARRANGE[state.arrange];
    const map = new Map();
    for (const i of list) {
      const k = a.key(i);
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(i);
    }
    const order = a.order ? (x, y) => a.order(x) - a.order(y) || byText(x, y) : byText;
    return [...map.entries()]
      .sort((x, y) => order(x[0], y[0]))
      .map(([k, items]) => ({ name: a.name ? a.name(k) : k, items: items.sort(a.inner || ((x, y) => byText(x.title, y.title))) }));
  }

  /* =====================================================================
   * Rendering
   * ===================================================================== */
  /* Each kind of item can have its own "room": a theme the page switches to when you
   * filter to it, and that its shelf wears in the mixed view. */
  const ROOMS = {
    game:   { cls: 'room-game', eyebrow: '✦ Player one ✦', title: 'GAME<span>//</span>SHELF' },
    bluray: { cls: 'room-movie', eyebrow: 'Now showing', title: 'Movie <span>Night</span>' },
  };
  const HEADINGS = {
    all: ['Personal collection', 'Your collection'],
    book: ['Personal library', 'Your library'],
    vinyl: ['Record crate', 'Your records'],
    cd: ['Disc rack', 'Your CDs'],
  };
  const roomOf = type => ROOMS[type]?.cls || '';

  function applyRoom() {
    const room = ROOMS[state.filter];
    document.body.classList.remove(...Object.values(ROOMS).map(r => r.cls));
    if (room) document.body.classList.add(room.cls);
    const [eyebrow, title] = room ? [room.eyebrow, room.title] : (HEADINGS[state.filter] || HEADINGS.all).map(esc);
    $('#eyebrow').textContent = eyebrow;
    $('#title').innerHTML = title;
  }

  function render() {
    hideTip();
    applyRoom();
    renderStats();
    renderChips();
    document.querySelectorAll('[data-view]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.view === state.view)));
    $('#clear-sample').hidden = !state.items.some(i => i.sample);

    const main = $('#content');
    if (!state.items.length) { main.innerHTML = emptyHTML(); return; }
    const list = visibleItems();
    if (!list.length) {
      main.innerHTML = `<p class="empty-note">${state.query ? `Nothing matches “${esc(state.query)}”.` : 'Nothing on this shelf yet.'}</p>`;
      return;
    }
    main.innerHTML = state.view === 'grid' ? gridHTML(list) : shelfHTML(list, state.view === 'covers');
  }

  function renderStats() {
    const owned = state.items.filter(i => i.status !== 'Wishlist' && i.status !== 'Sold');
    const parts = [`<b>${owned.length}</b> ${owned.length === 1 ? 'item' : 'items'}`];
    for (const k of TYPE_KEYS) {
      const n = owned.filter(i => i.type === k).length;
      const word = n === 1 ? TYPES[k].singular : TYPES[k].label;
      if (n) parts.push(`<b>${n}</b> ${esc(/[A-Z]{2}/.test(word) ? word : word.toLowerCase())}`);
    }
    const wish = state.items.filter(FILTERS.wishlist).length;
    const lent = state.items.filter(FILTERS.lent).length;
    if (wish) parts.push(`<b>${wish}</b> on the wishlist`);
    if (lent) parts.push(`<b>${lent}</b> lent out`);
    $('#stats').innerHTML = parts.join('<span class="dot">·</span>');
  }

  function renderChips() {
    const chip = (key, label, count, icon = '') =>
      `<button type="button" class="chip${state.filter === key ? ' on' : ''}" data-filter="${key}" aria-pressed="${state.filter === key}"${count === 0 && key !== 'all' ? ' data-empty' : ''}>` +
      `${icon ? `<span aria-hidden="true">${icon}</span>` : ''}${esc(label)} <span class="count">${count}</span></button>`;
    const notSold = state.items.filter(FILTERS.all);
    const html = [chip('all', 'All', notSold.length)];
    for (const k of TYPE_KEYS) html.push(chip(k, TYPES[k].label, notSold.filter(i => i.type === k).length, TYPES[k].icon));
    html.push(chip('wishlist', 'Wishlist', state.items.filter(FILTERS.wishlist).length, '✨'));
    html.push(chip('fav', 'Favourites', state.items.filter(FILTERS.fav).length, '⭐'));
    const lent = state.items.filter(FILTERS.lent).length;
    const sold = state.items.filter(FILTERS.sold).length;
    if (lent || state.filter === 'lent') html.push(chip('lent', 'Lent out', lent, '🤝'));
    if (sold || state.filter === 'sold') html.push(chip('sold', 'Sold', sold, '🏷️'));
    $('#chips').innerHTML = html.join('');
  }

  function spineHTML(i) {
    const t = typeOf(i);
    const { w, h } = dims(i);
    const c = colourOf(i);
    const variant = t.shape === 'book' ? ['', ' spine--label', ' spine--caps'][hash(i.id) % 3] : '';
    const status = i.status === 'Wishlist' ? ' is-wish' : '';
    // With cover art, the spine is printed with a strip of it (like a real case's spine art).
    const src = backend.coverSrc(i);
    const art = src ? ` has-art" data-art="1` : '';
    const artVar = src ? `;--art:url(&quot;${esc(src)}&quot;)` : '';
    return `<button type="button" class="spine spine--${esc(t.shape)}${variant}${status}${art}" data-id="${esc(i.id)}" ` +
      `style="--w:${w}px;--h:${h}px;--c:${c};--t:${src ? '#fff' : inkFor(c)}${artVar}" aria-label="${esc(i.title)}${i.creator ? ', ' + esc(i.creator) : ''}">` +
      `${i.status === 'Lent out' ? '<span class="flag" aria-hidden="true"></span>' : ''}` +
      `<span class="spine-title">${esc(i.title)}</span></button>`;
  }

  // Face-out: the cover stands on the shelf, like a shop display.
  const FACE_HEIGHT = { book: 196, vinyl: 210, cd: 150, game: 200, disc: 200 };
  function faceHTML(i) {
    const shape = typeOf(i).shape;
    const c = colourOf(i);
    const src = backend.coverSrc(i);
    const status = i.status === 'Wishlist' ? ' is-wish' : '';
    return `<button type="button" class="face face--${esc(shape)}${status}" data-id="${esc(i.id)}" ` +
      `style="--fh:${FACE_HEIGHT[shape] || 196}px;--ar:${ASPECT[shape] || '2 / 3'};--c:${c};--t:${inkFor(c)}" aria-label="${esc(i.title)}${i.creator ? ', ' + esc(i.creator) : ''}">` +
      `${i.status === 'Lent out' ? '<span class="flag" aria-hidden="true"></span>' : ''}` +
      `<span class="cover-fallback">${esc(i.title)}</span>` +
      `${src ? `<img src="${esc(src)}" alt="" loading="lazy" onerror="this.remove()">` : ''}</button>`;
  }

  function shelfHTML(list, faceOut = false) {
    return '<div class="shelves">' + groups(list).map(g => {
      // A shelf holding only one kind of item wears that kind's room theme.
      const room = g.items.every(i => i.type === g.items[0].type) ? roomOf(g.items[0].type) : '';
      return `
      <section class="shelf${room ? ' themed ' + room : ''}" aria-label="${esc(g.name)}">
        <div class="shelf-row${faceOut ? ' face-row' : ''}">${g.items.map(faceOut ? faceHTML : spineHTML).join('')}</div>
        <div class="shelf-tag">${esc(g.name)} <span class="count">${g.items.length}</span></div>
      </section>`;
    }).join('') + '</div>' +
      `<p class="hint">${faceOut ? 'Click a cover to take it down.' : 'Click a spine to take it down.'} Arrow keys walk the shelf.` +
      `${state.items.some(i => !backend.coverSrc(i)) ? ' Missing covers? Use <b>⋯ → Find missing covers online</b>.' : ''}</p>`;
  }

  const ASPECT = { book: '2 / 3', vinyl: '1 / 1', cd: '1 / 1', game: '5 / 7', disc: '3 / 4' };
  function coverHTML(i) {
    const c = colourOf(i);
    const src = backend.coverSrc(i);
    const badge = i.status === 'Wishlist' ? '<span class="badge">Wishlist</span>' : i.status === 'Lent out' ? '<span class="badge">Lent out</span>' : '';
    return `<div class="cover" style="--c:${c};--t:${inkFor(c)};--ar:${ASPECT[typeOf(i).shape] || '2 / 3'}">` +
      `<span class="cover-fallback">${esc(i.title)}</span>` +
      `${src ? `<img src="${esc(src)}" alt="" loading="lazy" onerror="this.remove()">` : ''}${badge}</div>`;
  }

  function gridHTML(list) {
    const sorted = groups(list).flatMap(g => g.items);
    return `<div class="grid">${sorted.map(i => `
      <button type="button" class="card${i.status === 'Wishlist' ? ' is-wish' : ''}" data-id="${esc(i.id)}">
        ${coverHTML(i)}
        <span class="card-title">${esc(i.title)}</span>
        <span class="card-sub">${esc(subtitle(i)) || '&nbsp;'}</span>
      </button>`).join('')}</div>`;
  }

  function emptyHTML() {
    return `<div class="empty">
      <h2>Your shelves are empty</h2>
      <p>Add your first book, record, CD, game or movie. Or load a few sample items to see how the shelf looks. You can remove them later.</p>
      <div class="actions">
        <button type="button" class="btn primary" data-action="add">Add your first item</button>
        <button type="button" class="btn" data-action="sample">Load sample items</button>
      </div>
    </div>`;
  }

  /* ---------- Tooltip ---------- */
  const tip = $('#tip');
  function showTip(el) {
    const i = state.items.find(x => x.id === el.dataset.id);
    if (!i) return;
    tip.innerHTML = `<strong>${esc(i.title)}</strong><span>${esc(subtitle(i))}${i.status && i.status !== 'Owned' ? ' · ' + esc(i.status) : ''}</span>`;
    tip.hidden = false;
    const r = el.getBoundingClientRect();
    const tw = tip.offsetWidth;
    const left = Math.max(8, Math.min(window.innerWidth - tw - 8, r.left + r.width / 2 - tw / 2));
    tip.style.left = `${left}px`;
    tip.style.top = `${Math.max(8, r.top - tip.offsetHeight - 10)}px`;
  }
  function hideTip() { tip.hidden = true; }

  /* ---------- Toast ---------- */
  let toastTimer;
  /** Shows a short message; pass 0 as `ms` to keep it up until the next one. */
  function toast(msg, ms = 3200) {
    const t = $('#toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    if (!ms) return;
    toastTimer = setTimeout(() => { t.hidden = true; }, ms);
  }

  /* ---------- Confirm ---------- */
  function ask(message, okLabel = 'OK') {
    const dlg = $('#confirm');
    $('#confirm-text').textContent = message;
    $('#confirm-ok').textContent = okLabel;
    return new Promise(resolve => {
      const onClick = e => {
        const btn = e.target.closest('button[value]');
        if (btn) dlg.close(btn.value);
      };
      dlg.addEventListener('click', onClick);
      dlg.addEventListener('close', () => { dlg.removeEventListener('click', onClick); resolve(dlg.returnValue === 'ok'); }, { once: true });
      dlg.returnValue = '';
      dlg.showModal();
    });
  }

  /* =====================================================================
   * Detail view
   * ===================================================================== */
  function openDetail(id) {
    const i = state.items.find(x => x.id === id);
    if (!i) return;
    const t = typeOf(i);
    const rows = [
      ['Type', `${t.icon} ${t.singular}`],
      ['Year', i.year],
      ['Genre', i.genre],
      ...t.fields.map(f => [f.label, i.extra?.[f.key]]),
      ['Status', i.status],
      ['Condition', i.condition],
      ['Rating', i.rating ? '★'.repeat(i.rating) + '☆'.repeat(5 - i.rating) : ''],
      ['Price paid', i.price],
      ['Acquired', i.acquired ? new Date(i.acquired + 'T00:00').toLocaleDateString(undefined, { dateStyle: 'medium' }) : ''],
      ['Barcode', i.barcode],
    ].filter(([, v]) => v !== undefined && v !== null && v !== '');
    const tags = i.tags?.length ? `<dt>Tags</dt><dd class="tags">${i.tags.map(x => `<span>${esc(x)}</span>`).join('')}</dd>` : '';

    const dlg = $('#detail');
    dlg.innerHTML = `<div class="sheet-inner">
      <header class="sheet-head">
        <h2>${i.favourite ? '⭐ ' : ''}${esc(i.title)}</h2>
        <button type="button" class="icon-btn" data-close aria-label="Close"><svg viewBox="0 0 16 16"><path d="m4 4 8 8M12 4l-8 8"/></svg></button>
      </header>
      <div class="sheet-body">
        <div class="detail">
          ${coverHTML(i)}
          <div>
            ${i.creator ? `<p class="creator">${esc(t.creator)}: ${esc(i.creator)}</p>` : ''}
            <dl>${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}${tags}</dl>
            ${i.notes ? `<p class="notes">${esc(i.notes)}</p>` : ''}
          </div>
        </div>
      </div>
      <footer class="sheet-foot">
        <button type="button" class="btn danger" data-action="delete">Delete</button>
        <span class="spacer"></span>
        <button type="button" class="btn" data-action="duplicate">Duplicate</button>
        <button type="button" class="btn primary" data-action="edit">Edit</button>
      </footer>
    </div>`;
    dlg.dataset.id = i.id;
    dlg.showModal();
  }

  /* =====================================================================
   * Editor
   * ===================================================================== */
  function existingValues(type, get) {
    return state.items.filter(i => i.type === type).map(get).filter(v => typeof v === 'string' && v.trim());
  }
  const unique = list => [...new Set(list.map(s => s.trim()))].sort(byText);

  function datalist(id, values) {
    return values.length ? `<datalist id="${id}">${values.map(v => `<option value="${esc(v)}">`).join('')}</datalist>` : '';
  }

  function extraHTML(type, values) {
    const t = TYPES[type];
    return `<p class="section-title">${esc(t.singular)} details</p>` + t.fields.map(f => {
      const val = values[f.key] ?? '';
      const name = `x.${f.key}`;
      if (f.options) {
        return `<label class="field">${esc(f.label)}<select name="${name}"><option value=""></option>` +
          f.options.map(o => `<option${o === val ? ' selected' : ''}>${esc(o)}</option>`).join('') + '</select></label>';
      }
      if (f.type === 'number') {
        return `<label class="field">${esc(f.label)}<input name="${name}" type="number" min="0" inputmode="numeric" value="${esc(val)}"></label>`;
      }
      const suggestions = unique([...(f.presets || []), ...existingValues(type, i => i.extra?.[f.key])]);
      const listId = `dl-${type}-${f.key}`;
      return `<label class="field">${esc(f.label)}<input name="${name}" value="${esc(val)}" autocomplete="off"${suggestions.length ? ` list="${listId}"` : ''}>` +
        `${datalist(listId, suggestions)}</label>`;
    }).join('');
  }

  function sharedLists(type) {
    const genres = unique([...(TYPES[type].genres || []), ...existingValues(type, i => i.genre)]);
    const creators = unique(existingValues(type, i => i.creator));
    return datalist('dl-genre', genres) + datalist('dl-creator', creators);
  }

  function coverPreview() {
    const src = draft.pendingData || backend.coverSrc(draft);
    return src ? `<img src="${esc(src)}" alt="Cover preview" onerror="this.replaceWith('Couldn\\'t load image')">` : 'No cover';
  }

  function openEditor(item, { duplicate = false } = {}) {
    editing = item && !duplicate ? item : null;
    const type = item?.type && TYPES[item.type] ? item.type : TYPES[state.filter] ? state.filter : 'book';
    const v = k => esc(item?.[k] ?? '');
    draft = { cover: item?.cover || '', coverFile: duplicate ? '' : item?.coverFile || '', pendingData: '' };
    if (duplicate && item?.coverFile) draft.cover = '';
    const isUrl = /^https?:/i.test(draft.cover);
    const autoColour = !item?.spineColor;

    const form = $('#editor-form');
    form.innerHTML = `
      <header class="sheet-head">
        <h2>${editing ? 'Edit item' : duplicate ? 'Duplicate item' : 'Add to collection'}</h2>
        <button type="button" class="icon-btn" data-close aria-label="Close"><svg viewBox="0 0 16 16"><path d="m4 4 8 8M12 4l-8 8"/></svg></button>
      </header>
      <div class="sheet-body">
        <fieldset class="type-pick">
          <legend>What is it?</legend>
          ${TYPE_KEYS.map(k => `<label><input type="radio" name="type" value="${k}"${k === type ? ' checked' : ''}><span>${TYPES[k].icon} ${esc(TYPES[k].singular)}</span></label>`).join('')}
        </fieldset>

        <section class="barcode-box" aria-label="Look up by barcode">
          <div class="barcode-row">
            <label class="field">Barcode / ISBN
              <input name="barcode" value="${v('barcode')}" inputmode="numeric" autocomplete="off" placeholder="Scan it, or type the digits under the barcode">
            </label>
            <button type="button" class="btn primary" data-lookup>Look up</button>
          </div>
          <div class="row">
            <button type="button" class="btn small" data-scan>
              <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 5V3h2M12 3h2v2M14 11v2h-2M4 13H2v-2M5 5v6M7 5v6M9.5 5v6M11 5v6"/></svg>Scan with camera
            </button>
            <label class="btn small file-btn">
              <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="3" width="12" height="10" rx="1.5"/><circle cx="8" cy="8" r="2.5"/></svg>From a photo…
              <input type="file" accept="image/*" data-scan-photo>
            </label>
          </div>
          <div class="scanner" data-scanner hidden>
            <video playsinline muted></video>
            <span class="scan-line" aria-hidden="true"></span>
            <button type="button" class="btn small" data-scan-stop>Stop camera</button>
          </div>
          <p class="lookup-status" data-status role="status"></p>
          <div class="photo-peek" data-peek hidden></div>
        </section>

        <div class="form-grid">
          <div class="field span-2 title-field">
            <label for="f-title">Title</label>
            <input id="f-title" name="title" required value="${v('title')}" autocomplete="off" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="f-suggest">
            <div class="suggest" id="f-suggest" role="listbox" data-suggest hidden></div>
          </div>
          <label class="field"><span data-creator-label>${esc(TYPES[type].creator)}</span><input name="creator" value="${v('creator')}" list="dl-creator" autocomplete="off"></label>
          <label class="field">Year<input name="year" type="number" min="1000" max="2100" inputmode="numeric" value="${v('year')}"></label>
          <label class="field span-2">Genre<input name="genre" value="${v('genre')}" list="dl-genre" autocomplete="off"></label>
        </div>

        <div class="form-grid" data-extra>${extraHTML(type, item?.extra || {})}</div>

        <div class="form-grid">
          <p class="section-title">Your copy</p>
          <label class="field">Status<select name="status">${STATUSES.map(s => `<option${s === (item?.status || 'Owned') ? ' selected' : ''}>${esc(s)}</option>`).join('')}</select></label>
          <label class="field">Condition<select name="condition"><option value=""></option>${CONDITIONS.map(s => `<option${s === item?.condition ? ' selected' : ''}>${esc(s)}</option>`).join('')}</select></label>
          <label class="field">Rating<select name="rating"><option value="">No rating</option>${[5, 4, 3, 2, 1].map(n => `<option value="${n}"${n === item?.rating ? ' selected' : ''}>${'★'.repeat(n)}${'☆'.repeat(5 - n)}</option>`).join('')}</select></label>
          <label class="check"><input type="checkbox" name="favourite"${item?.favourite ? ' checked' : ''}> Favourite</label>
          <label class="field">Price paid<input name="price" value="${v('price')}" placeholder="e.g. RM 45" autocomplete="off"></label>
          <label class="field">Date acquired<input name="acquired" type="date" value="${v('acquired')}"></label>
          <label class="field span-2">Tags <input name="tags" value="${esc((item?.tags || []).join(', '))}" placeholder="Comma separated, e.g. signed, gift, import" autocomplete="off"></label>
          <label class="field span-2">Notes<textarea name="notes" rows="3">${v('notes')}</textarea></label>
        </div>

        <div class="form-grid">
          <p class="section-title">Cover &amp; spine</p>
          <div class="cover-field span-2">
            <div class="cover-preview" data-preview>${coverPreview()}</div>
            <div class="stack">
              <label class="field">Image URL<input name="coverUrl" type="url" placeholder="https://…" value="${isUrl ? esc(draft.cover) : ''}"></label>
              <div class="row">
                <label class="btn small file-btn">Choose image file…<input type="file" accept="image/*" data-cover-file></label>
                <button type="button" class="btn small" data-cover-clear>Remove cover</button>
              </div>
              <button type="button" class="btn small primary" data-cover-search>
                <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.5"/><path d="m10.5 10.5 3 3"/></svg>Find cover online
              </button>
            </div>
          </div>
          <div class="cover-results span-2" data-cover-results hidden></div>
          <div class="colour-row span-2">
            <label class="check"><input type="checkbox" name="autoColour"${autoColour ? ' checked' : ''}> Automatic spine colour</label>
            <input type="color" name="spineColor" aria-label="Spine colour" value="${esc(item?.spineColor || autoColourFor(item, type))}"${autoColour ? ' disabled' : ''}>
          </div>
        </div>
        <div data-lists>${sharedLists(type)}</div>
      </div>
      <footer class="sheet-foot">
        <button type="button" class="btn" data-close>Cancel</button>
        <button type="submit" class="btn primary">${editing ? 'Save changes' : 'Add to shelf'}</button>
      </footer>`;

    $('#editor').showModal();
    editorDirty = false;
    // New items start in the barcode box, so a USB scanner or a quick paste works straight away.
    form.elements.namedItem(editing ? 'title' : 'barcode').focus();
  }

  function autoColourFor(item, type) {
    return autoColour({ id: item?.id || 'new', title: item?.title || '', type, extra: item?.extra || {} });
  }

  function switchType(form, type) {
    const carry = {};
    form.querySelectorAll('[name^="x."]').forEach(el => { if (el.value) carry[el.name.slice(2)] = el.value; });
    $('[data-extra]', form).innerHTML = extraHTML(type, carry);
    $('[data-lists]', form).innerHTML = sharedLists(type);
    $('[data-creator-label]', form).textContent = TYPES[type].creator;
  }

  function resizeImage(file, max = 600) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(img.naturalWidth * scale);
        canvas.height = Math.round(img.naturalHeight * scale);
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        URL.revokeObjectURL(img.src);
        resolve(canvas.toDataURL('image/jpeg', 0.85));
      };
      img.onerror = () => reject(new Error("That file doesn't look like an image."));
      img.src = URL.createObjectURL(file);
    });
  }

  /* =====================================================================
   * Barcode lookup, camera scanning and title suggestions
   * ===================================================================== */
  const currentType = form => form.querySelector('input[name="type"]:checked').value;

  function setStatus(form, html, kind = '') {
    const el = $('[data-status]', form);
    el.className = 'lookup-status' + (kind ? ` is-${kind}` : '');
    el.innerHTML = html;
  }

  /** Sets a form field and flashes it so you can see what was filled in. */
  function fillField(form, name, value) {
    if (value === undefined || value === null || value === '') return;
    const el = form.elements.namedItem(name);
    if (!el || el instanceof RadioNodeList) return;
    if (el.tagName === 'SELECT' && ![...el.options].some(o => o.value === String(value))) return;
    el.value = value;
    el.classList.remove('filled');
    void el.offsetWidth;
    el.classList.add('filled');
  }

  /** Whether the editor has changes that closing would throw away. */
  let editorDirty = false;
  async function requestCloseEditor() {
    if (editorDirty && !(await ask('Discard the changes you made to this item?', 'Discard'))) return false;
    $('#editor').close();
    return true;
  }

  function applyResult(form, r) {
    editorDirty = true;
    if (r.type && TYPES[r.type] && r.type !== currentType(form)) {
      form.querySelector(`input[name="type"][value="${r.type}"]`).checked = true;
      switchType(form, r.type);
    }
    fillField(form, 'title', r.title);
    fillField(form, 'creator', r.creator);
    fillField(form, 'year', r.year);
    fillField(form, 'genre', r.genre);
    fillField(form, 'barcode', r.barcode);
    for (const [k, val] of Object.entries(r.extra || {})) fillField(form, `x.${k}`, val);
    if (r.cover) {
      draft = { cover: r.cover, coverFile: '', pendingData: '' };
      form.elements.namedItem('coverUrl').value = r.cover;
      $('[data-preview]', form).innerHTML = coverPreview();
    }
    form.elements.namedItem('title').removeAttribute('aria-invalid');
  }

  function alreadyOwned(barcode) {
    return barcode && state.items.find(i => i.id !== editing?.id && i.barcode === barcode);
  }
  const ownedNote = item => `<br><b>You already have this:</b> ${esc(item.title)}${item.extra?.platform || item.extra?.format ? ` (${esc(item.extra.platform || item.extra.format)})` : ''}. ` +
    `<button type="button" class="link" data-open-owned="${esc(item.id)}">Open it</button>`;

  /** Fills a guessed region if the field is still empty, and returns a note saying it was guessed. */
  function applyRegionGuess(form, code, productTitle) {
    const field = form.elements.namedItem('x.region');
    if (!field || field.value) return '';
    const guess = window.Lookup.guessRegion(code, currentType(form), productTitle);
    if (!guess) return '';
    fillField(form, 'x.region', guess.value);
    return ` Region <b>${esc(guess.value)}</b> is a guess (${esc(guess.why)}). Check the region mark on the case.`;
  }

  let lookupSeq = 0;
  async function lookupBarcode(form) {
    const code = window.Lookup.cleanCode(form.elements.namedItem('barcode').value);
    if (!code) { setStatus(form, 'Type or scan a barcode first.', 'warn'); return; }
    const seq = ++lookupSeq;
    if (window.Lookup.checksumOk(code) === false) {
      setStatus(form, `<b>${esc(code)}</b> doesn't look right: the last digit of a barcode is a check digit, and these digits don't add up. ` +
        'Check for a typo and try again.', 'warn');
      form.elements.namedItem('barcode').focus();
      return;
    }
    const typo = '';
    setStatus(form, `Looking up <b>${esc(code)}</b>…`, 'busy');
    const dupe = alreadyOwned(code);
    const owned = dupe ? ownedNote(dupe) : '';
    try {
      const r = await window.Lookup.byBarcode(code);
      if (seq !== lookupSeq) return;
      if (!r) {
        const region = applyRegionGuess(form, code);
        setStatus(form, `No online match for <b>${esc(code)}</b>, which is common for Asian and import editions. ` +
          `Start typing the title for suggestions, or fill it in yourself; the barcode is saved with the item.${region}${typo}${owned}`, 'warn');
        form.elements.namedItem('title').focus();
        return;
      }
      applyResult(form, r);
      let msg = `Found on ${esc(r.source)}: <b>${esc(r.title)}</b>${r.creator ? ` · ${esc(r.creator)}` : ''}. Check the details below and change anything that's wrong.`;
      if (!r.type) msg += ` It's listed as “${esc(r.note || 'unknown')}”, so pick the right type above.`;
      if (r.regionWhy) msg += ` Region <b>${esc(r.extra.region)}</b> is a guess (${esc(r.regionWhy)}). Check the region mark on the case.`;
      setStatus(form, msg + typo + owned, dupe || typo ? 'warn' : 'ok');
    } catch (e) {
      if (seq === lookupSeq) setStatus(form, esc(e?.message || String(e)) + typo + owned, 'error');
    }
  }

  /* ---------- Reading barcodes (zxing-cpp compiled to WebAssembly) ---------- */
  let wasmReady = false;
  function barcodeEngine() {
    const Z = window.ZXingWASM;
    if (!Z) return null;
    if (!wasmReady) {
      Z.prepareZXingModule({
        overrides: { locateFile: (path, prefix) => (path.endsWith('.wasm') ? new URL(`vendor/${path}`, location.href).href : prefix + path) },
      });
      wasmReady = true;
    }
    return Z;
  }
  const READ_OPTIONS = {
    formats: ['EAN-13', 'EAN-8', 'UPC-A', 'UPC-E', 'Code128'],
    tryHarder: true, tryRotate: true, tryDownscale: true, tryInvert: false, maxNumberOfSymbols: 1,
  };
  async function readBarcode(input) {
    const Z = barcodeEngine();
    if (!Z) throw new Error("The barcode reader didn't load.");
    const results = await Z.readBarcodes(input, READ_OPTIONS);
    return results.find(r => r.text)?.text || null;
  }

  function gotCode(form, code) {
    clearPhotoPeek(form);
    form.elements.namedItem('barcode').value = code;
    lookupBarcode(form);
  }

  // Live camera: grab a frame every 150 ms and try to read it.
  let camera = null; // { stream, timer }
  function stopScan(form) {
    if (camera) {
      clearInterval(camera.timer);
      camera.stream.getTracks().forEach(t => t.stop());
      camera = null;
    }
    const box = form && $('[data-scanner]', form);
    if (box) { box.hidden = true; $('video', box).srcObject = null; }
  }
  async function startScan(form) {
    stopScan(form);
    clearPhotoPeek(form);
    if (!barcodeEngine()) { setStatus(form, "The barcode reader didn't load.", 'error'); return; }
    const box = $('[data-scanner]', form);
    const video = $('video', box);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false,
      });
      box.hidden = false;
      video.srcObject = stream;
      await video.play();
      setStatus(form, 'Hold the barcode up to the camera, about a hand-width away, and keep it still…', 'busy');
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      let busy = false;
      const timer = setInterval(async () => {
        if (busy || !video.videoWidth || !camera) return;
        busy = true;
        try {
          canvas.width = video.videoWidth;
          canvas.height = video.videoHeight;
          ctx.drawImage(video, 0, 0);
          const code = await readBarcode(ctx.getImageData(0, 0, canvas.width, canvas.height));
          if (code && camera) { stopScan(form); gotCode(form, code); }
        } catch { /* keep trying on the next frame */ } finally { busy = false; }
      }, 150);
      camera = { stream, timer };
    } catch (e) {
      stopScan(form);
      const name = `${e?.name || ''} ${e?.message || ''}`;
      setStatus(form,
        /NotAllowed|Permission/i.test(name) ? 'Camera access was blocked. Allow it and try again, or use “From a photo”.'
          : /NotFound|Overconstrained|NotReadable/i.test(name) ? 'No camera available. Use “From a photo”, a USB barcode scanner, or type the number.'
            : `Couldn't start the camera: ${esc(e?.message || e)}`,
        'error');
    }
  }

  // Photo: read it; if the bars are too blurry, show the photo so the printed digits can be typed in.
  let peekUrl = '';
  function clearPhotoPeek(form) {
    const peek = form && $('[data-peek]', form);
    if (peek) { peek.hidden = true; peek.innerHTML = ''; }
    if (peekUrl) { URL.revokeObjectURL(peekUrl); peekUrl = ''; }
  }
  async function scanPhoto(form, file) {
    stopScan(form);
    clearPhotoPeek(form);
    setStatus(form, 'Reading the barcode in your photo…', 'busy');
    try {
      const code = await readBarcode(file);
      if (code) { gotCode(form, code); return; }
    } catch (e) {
      console.warn('barcode read failed', e);
    }
    peekUrl = URL.createObjectURL(file);
    const peek = $('[data-peek]', form);
    peek.innerHTML = `<img src="${peekUrl}" alt="Your photo of the barcode">`;
    peek.hidden = false;
    setStatus(form, "Couldn't read the bars in that photo; it may be a little blurry. " +
      'Type the numbers printed under the barcode (they\'re in your photo below) and press Enter, or try a sharper photo.', 'warn');
    const input = form.elements.namedItem('barcode');
    input.value = '';
    input.focus();
  }

  // Title suggestions: your own items first, then the best online matches.
  let suggestTimer = 0, suggestSeq = 0, suggestions = [], activeSuggestion = -1;
  function closeSuggest(form) {
    clearTimeout(suggestTimer);
    suggestSeq++;
    const box = form && $('[data-suggest]', form);
    if (!box) return;
    box.hidden = true;
    box.innerHTML = '';
    suggestions = [];
    activeSuggestion = -1;
    const input = form.elements.namedItem('title');
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
  }
  function queueSuggest(form) {
    clearTimeout(suggestTimer);
    const q = form.elements.namedItem('title').value.trim();
    if (q.length < 2) { closeSuggest(form); return; }
    suggestTimer = setTimeout(() => runSuggest(form, q), 350);
  }
  async function runSuggest(form, q) {
    const seq = ++suggestSeq;
    const lc = q.toLowerCase();
    const owned = state.items
      .filter(i => i.id !== editing?.id && i.title.toLowerCase().includes(lc))
      .slice(0, 3)
      .map(i => ({ owned: i, type: i.type, title: i.title, creator: i.creator, year: i.year }));
    renderSuggest(form, owned, q.length >= 3);
    let online = [];
    try { online = await window.Lookup.suggest(currentType(form), q); } catch (e) { console.warn('suggestions failed', e); }
    if (seq !== suggestSeq) return;
    renderSuggest(form, [...owned, ...online], false);
  }
  function renderSuggest(form, list, loading) {
    const box = $('[data-suggest]', form);
    suggestions = list;
    activeSuggestion = -1;
    if (!list.length && !loading) { closeSuggest(form); return; }
    box.innerHTML = list.map((s, i) => {
      const sub = [s.creator, s.year, s.owned ? 'In your collection' : s.source].filter(Boolean).join(' · ');
      const thumb = s.thumb ? `<img src="${esc(s.thumb)}" alt="" onerror="this.remove()">` : esc(TYPES[s.type]?.icon || '•');
      return `<div class="suggestion${s.owned ? ' is-owned' : ''}" role="option" id="sg-${i}" data-index="${i}" aria-selected="false">` +
        `<span class="thumb">${thumb}</span><span class="text"><b>${esc(s.title)}</b><small>${esc(sub)}</small></span></div>`;
    }).join('') + (loading ? '<div class="suggest-note">Searching…</div>' : '');
    box.hidden = false;
    form.elements.namedItem('title').setAttribute('aria-expanded', 'true');
  }
  function moveSuggestion(form, delta) {
    if (!suggestions.length) return;
    activeSuggestion = (activeSuggestion + delta + suggestions.length) % suggestions.length;
    form.querySelectorAll('.suggestion').forEach((el, i) => {
      el.classList.toggle('active', i === activeSuggestion);
      el.setAttribute('aria-selected', String(i === activeSuggestion));
      if (i === activeSuggestion) el.scrollIntoView({ block: 'nearest' });
    });
    form.elements.namedItem('title').setAttribute('aria-activedescendant', `sg-${activeSuggestion}`);
  }
  function pickSuggestion(form, index) {
    const s = suggestions[index];
    if (!s) return;
    closeSuggest(form);
    if (s.owned) {
      setStatus(form, `You already have “${esc(s.owned.title)}”. <button type="button" class="link" data-open-owned="${esc(s.owned.id)}">Open it</button>`, 'warn');
      return;
    }
    applyResult(form, s);
    setStatus(form, `Filled in from ${esc(s.source)}. Check the details and change anything that's wrong.`, 'ok');
  }

  /* ---------- Cover art search ---------- */
  let coverChoices = [];
  async function searchCovers(form) {
    const get = n => (form.elements.namedItem(n)?.value || '').trim();
    const box = $('[data-cover-results]', form);
    const item = { type: currentType(form), title: get('title'), creator: get('creator') };
    box.hidden = false;
    if (!item.title) { box.innerHTML = '<p class="cover-note">Add a title first, then search for its cover.</p>'; return; }
    box.innerHTML = `<p class="cover-note is-busy">Looking for covers of “${esc(item.title)}”…</p>`;
    coverChoices = await window.Covers.search(item).catch(() => []);
    if (!coverChoices.length) {
      box.innerHTML = '<p class="cover-note">No covers found online. You can still choose an image file or paste an image link.</p>';
      return;
    }
    box.innerHTML = `<p class="cover-note">Pick the cover that matches your copy:</p><div class="cover-grid">` +
      coverChoices.slice(0, 12).map((c, i) =>
        `<button type="button" class="cover-option${c.match ? ' is-match' : ''}" data-cover-pick="${i}" title="${esc([c.title, c.note].filter(Boolean).join(' · '))}">` +
        `<img src="${esc(c.thumb || c.url)}" alt="${esc(c.title)}" loading="lazy" onerror="this.closest('.cover-option').remove()">` +
        `<span>${esc(c.source)}</span></button>`).join('') + '</div>';
  }
  function pickCover(form, index) {
    const c = coverChoices[index];
    if (!c) return;
    draft = { cover: c.url, coverFile: '', pendingData: '' };
    form.elements.namedItem('coverUrl').value = c.url;
    $('[data-preview]', form).innerHTML = coverPreview();
    form.querySelectorAll('.cover-option').forEach(el => el.classList.toggle('picked', Number(el.dataset.coverPick) === index));
  }

  /** Finds a cover for every item that hasn't got one, using only clear title matches. */
  let fillingCovers = false;
  async function fillMissingCovers() {
    if (fillingCovers) return;
    const targets = state.items.filter(i => !backend.coverSrc(i) && i.status !== 'Sold');
    if (!targets.length) { toast('Every item already has a cover.'); return; }
    const ok = await ask(`Look online for covers for ${targets.length} ${targets.length === 1 ? 'item' : 'items'}? ` +
      "Only clear title matches are used, and you can change any of them later with Edit → Find cover online.", 'Find covers');
    if (!ok) return;
    fillingCovers = true;
    let found = 0;
    try {
      for (const [n, item] of targets.entries()) {
        toast(`Finding covers… ${n + 1} of ${targets.length}`, 0);
        try {
          const best = await window.Covers.best(item);
          if (best) {
            const latest = state.items.find(i => i.id === item.id);
            if (latest && !backend.coverSrc(latest)) {
              const updated = { ...latest, ...(await backend.remoteCover(best.url)), updated: Date.now() };
              await backend.save([updated]);
              state.items[state.items.indexOf(latest)] = updated;
              found++;
              render();
            }
          }
        } catch (e) { console.warn('cover lookup failed for', item.title, e); }
        // MusicBrainz asks for at most one request a second.
        await new Promise(r => setTimeout(r, item.type === 'vinyl' || item.type === 'cd' ? 1100 : 250));
      }
    } finally {
      fillingCovers = false;
    }
    const missed = targets.length - found;
    toast(`Found covers for ${found} of ${targets.length}.${missed ? ` ${missed} had no clear match; add those with Edit → Find cover online.` : ''}`, 6000);
  }

  function bindLookup(form) {
    const title = () => form.elements.namedItem('title');
    form.addEventListener('input', e => { if (e.target.name === 'title') queueSuggest(form); });
    form.addEventListener('focusout', e => { if (e.target.name === 'title') setTimeout(() => closeSuggest(form), 150); });
    form.addEventListener('keydown', e => {
      if (e.target.name === 'barcode' && e.key === 'Enter') { e.preventDefault(); lookupBarcode(form); return; }
      if (e.target !== title() || $('[data-suggest]', form).hidden) return;
      if (e.key === 'ArrowDown') { e.preventDefault(); moveSuggestion(form, 1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); moveSuggestion(form, -1); }
      else if (e.key === 'Enter' && activeSuggestion >= 0) { e.preventDefault(); pickSuggestion(form, activeSuggestion); }
      else if (e.key === 'Escape') { e.preventDefault(); closeSuggest(form); }
    });
    // pointerdown fires before the input loses focus, so the list is still there to pick from
    form.addEventListener('pointerdown', e => {
      const s = e.target.closest('.suggestion');
      if (s) { e.preventDefault(); pickSuggestion(form, Number(s.dataset.index)); }
    });
    form.addEventListener('click', e => {
      if (e.target.closest('[data-lookup]')) lookupBarcode(form);
      if (e.target.closest('[data-scan]')) startScan(form);
      if (e.target.closest('[data-scan-stop]')) { stopScan(form); setStatus(form, ''); }
      if (e.target.closest('[data-cover-search]')) run(() => searchCovers(form));
      const pick = e.target.closest('[data-cover-pick]');
      if (pick) pickCover(form, Number(pick.dataset.coverPick));
      const owned = e.target.closest('[data-open-owned]');
      if (owned) run(async () => { if (await requestCloseEditor()) openDetail(owned.dataset.openOwned); });
    });
    form.addEventListener('change', e => {
      if (e.target.matches('[data-scan-photo]') && e.target.files[0]) { scanPhoto(form, e.target.files[0]); e.target.value = ''; }
      if (e.target.name === 'type') closeSuggest(form);
    });
    $('#editor').addEventListener('close', () => { stopScan(form); closeSuggest(form); clearPhotoPeek(form); });
  }

  async function submitEditor(form) {
    const get = n => (form.elements.namedItem(n)?.value ?? '').trim();
    const titleInput = form.elements.namedItem('title');
    if (!get('title')) {
      titleInput.setAttribute('aria-invalid', 'true');
      titleInput.focus();
      toast('Give it a title first.');
      return;
    }
    const type = form.querySelector('input[name="type"]:checked').value;
    const extra = {};
    for (const f of TYPES[type].fields) {
      const val = get(`x.${f.key}`);
      if (val) extra[f.key] = f.type === 'number' ? Number(val) : val;
    }

    let cover = { cover: draft.cover, coverFile: draft.coverFile };
    if (draft.pendingData) cover = await backend.storeCover(draft.pendingData);
    else if (/^https:/i.test(draft.cover) && draft.cover !== editing?.cover) cover = await backend.remoteCover(draft.cover);

    const item = {
      id: editing?.id || uid(),
      type,
      title: get('title'),
      creator: get('creator'),
      year: get('year') ? Number(get('year')) : null,
      genre: get('genre'),
      barcode: window.Lookup.cleanCode(get('barcode')),
      extra,
      status: get('status') || 'Owned',
      condition: get('condition'),
      rating: get('rating') ? Number(get('rating')) : null,
      favourite: form.elements.namedItem('favourite').checked,
      price: get('price'),
      acquired: get('acquired'),
      tags: get('tags').split(',').map(s => s.trim()).filter(Boolean),
      notes: (form.elements.namedItem('notes').value || '').trim(),
      ...cover,
      spineColor: form.elements.namedItem('autoColour').checked ? '' : get('spineColor'),
      added: editing?.added || Date.now(),
      updated: Date.now(),
    };

    await backend.save([item]);
    const idx = state.items.findIndex(i => i.id === item.id);
    if (idx >= 0) state.items[idx] = item; else state.items.push(item);
    $('#editor').close();
    render();
    toast(editing ? 'Saved.' : `Added “${item.title}”.`);
  }

  /* =====================================================================
   * Sample data
   * ===================================================================== */
  function sampleItems() {
    const s = (type, title, creator, year, genre, extra, more = {}) =>
      ({ id: uid(), type, title, creator, year, genre, extra, status: 'Owned', tags: [], sample: true, added: Date.now(), updated: Date.now(), ...more });
    return [
      s('book', 'Dune', 'Frank Herbert', 1965, 'Science fiction', { format: 'Paperback', pages: 688 }, { favourite: true }),
      s('book', 'Norwegian Wood', 'Haruki Murakami', 1987, 'Fiction', { format: 'Paperback', pages: 296 }),
      s('book', 'The Hobbit', 'J.R.R. Tolkien', 1937, 'Fantasy', { format: 'Hardcover', pages: 310 }),
      s('book', 'Project Hail Mary', 'Andy Weir', 2021, 'Science fiction', { format: 'Hardcover', pages: 476 }, { status: 'Wishlist' }),
      s('vinyl', 'Rumours', 'Fleetwood Mac', 1977, 'Rock', { format: '12" LP', speed: '33⅓ RPM', variant: 'Black' }),
      s('vinyl', 'Random Access Memories', 'Daft Punk', 2013, 'Electronic', { format: '2×LP', speed: '33⅓ RPM' }, { favourite: true }),
      s('vinyl', 'Kind of Blue', 'Miles Davis', 1959, 'Jazz', { format: '12" LP' }),
      s('cd', 'OK Computer', 'Radiohead', 1997, 'Rock', { format: 'CD', edition: 'Standard' }),
      s('cd', 'Back to Black', 'Amy Winehouse', 2006, 'Soul', { format: 'CD', edition: 'Deluxe' }),
      s('game', 'Elden Ring', 'FromSoftware', 2022, 'Action RPG', { platform: 'PS5', region: 'Asia', progress: 'Beaten', completeness: 'Complete in box' }),
      s('game', 'Persona 5 Royal', 'Atlus', 2019, 'JRPG', { platform: 'PS4', region: 'Asia', progress: 'Playing' }, { status: 'Lent out', notes: 'Lent to Hafiz' }),
      s('game', 'Tears of the Kingdom', 'Nintendo', 2023, 'Adventure', { platform: 'Switch', region: 'Asia', progress: 'Playing' }),
      s('game', 'Halo 3', 'Bungie', 2007, 'Shooter', { platform: 'Xbox 360', region: 'NTSC-U (US)', progress: 'Beaten' }),
      s('bluray', 'Blade Runner 2049', 'Denis Villeneuve', 2017, 'Sci-fi', { format: '4K UHD', region: 'Region free', runtime: 164 }),
      s('bluray', 'Spirited Away', 'Hayao Miyazaki', 2001, 'Animation', { format: 'Blu-ray', region: 'B', runtime: 125 }, { favourite: true }),
      s('bluray', 'Mad Max: Fury Road', 'George Miller', 2015, 'Action', { format: 'Blu-ray', region: 'A', edition: 'Steelbook' }),
    ];
  }

  /* =====================================================================
   * Events
   * ===================================================================== */
  async function reload() {
    state.items = (await backend.list()) || [];
    render();
  }

  async function run(fn) {
    try { await fn(); } catch (e) { console.error(e); toast(e?.message || String(e)); }
  }

  function bind() {
    // View toggle, arrange, search
    document.querySelectorAll('[data-view]').forEach(btn => btn.addEventListener('click', () => {
      state.view = btn.dataset.view;
      pref.set('view', state.view);
      render();
    }));
    const arrange = $('#arrange');
    arrange.innerHTML = Object.entries(ARRANGE).map(([k, a]) => `<option value="${k}"${k === state.arrange ? ' selected' : ''}>${esc(a.label)}</option>`).join('');
    arrange.addEventListener('change', () => { state.arrange = arrange.value; pref.set('arrange', state.arrange); render(); });
    $('#search').addEventListener('input', e => { state.query = e.target.value; render(); });

    $('#chips').addEventListener('click', e => {
      const chip = e.target.closest('[data-filter]');
      if (!chip) return;
      const f = chip.dataset.filter;
      state.filter = state.filter === f && f !== 'all' ? 'all' : f;
      render();
    });

    $('#add-btn').addEventListener('click', () => openEditor(null));

    // Menu
    const menu = $('#menu');
    const closeMenu = () => { menu.open = false; };
    document.addEventListener('click', e => { if (!menu.contains(e.target)) closeMenu(); });
    $('#export-btn').addEventListener('click', () => run(async () => {
      closeMenu();
      if (!state.items.length) { toast('Nothing to export yet.'); return; }
      const msg = await backend.exportBackup();
      if (msg) toast(msg);
    }));
    $('#fill-covers-btn').addEventListener('click', () => run(async () => { closeMenu(); await fillMissingCovers(); }));
    $('#import-btn').addEventListener('click', () => run(async () => {
      closeMenu();
      const count = await backend.importBackup();
      if (count == null) return;
      await reload();
      toast(`Imported ${count} ${count === 1 ? 'item' : 'items'}.`);
    }));
    const folderBtn = $('#folder-btn');
    folderBtn.hidden = !backend.openFolder;
    folderBtn.addEventListener('click', () => run(async () => { closeMenu(); await backend.openFolder(); }));
    $('#clear-sample').addEventListener('click', () => run(async () => {
      closeMenu();
      const ids = state.items.filter(i => i.sample).map(i => i.id);
      if (!(await ask(`Remove ${ids.length} sample items? Anything you added or edited stays.`, 'Remove'))) return;
      await backend.remove(ids);
      await reload();
    }));

    // Shelf / grid
    const content = $('#content');
    content.addEventListener('click', e => run(async () => {
      const el = e.target.closest('[data-id]');
      if (el) { openDetail(el.dataset.id); return; }
      const action = e.target.closest('[data-action]')?.dataset.action;
      if (action === 'add') openEditor(null);
      if (action === 'sample') { await backend.save(sampleItems()); await reload(); }
    }));
    const SHELF_ITEM = '.spine, .face';
    content.addEventListener('pointerover', e => { const s = e.target.closest(SHELF_ITEM); if (s) showTip(s); });
    content.addEventListener('pointerout', e => { if (e.target.closest(SHELF_ITEM) && !e.relatedTarget?.closest?.(SHELF_ITEM)) hideTip(); });
    content.addEventListener('focusin', e => { const s = e.target.closest(SHELF_ITEM); if (s) showTip(s); });
    content.addEventListener('focusout', hideTip);
    window.addEventListener('scroll', hideTip, { passive: true });

    content.addEventListener('keydown', e => {
      const els = [...content.querySelectorAll('.spine, .face, .card')];
      const idx = els.indexOf(document.activeElement);
      if (idx < 0) return;
      const next = { ArrowRight: idx + 1, ArrowDown: idx + 1, ArrowLeft: idx - 1, ArrowUp: idx - 1, Home: 0, End: els.length - 1 }[e.key];
      if (next === undefined) return;
      e.preventDefault();
      els[Math.max(0, Math.min(els.length - 1, next))].focus();
    });

    // Global shortcuts
    document.addEventListener('keydown', e => {
      if (e.key !== '/' || e.ctrlKey || e.metaKey || document.querySelector('dialog[open]')) return;
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName)) return;
      e.preventDefault();
      $('#search').focus();
    });

    // Dialogs: close buttons and backdrop clicks
    // Dialogs close with their ✕/Cancel buttons or Esc. The editor never closes from a click outside it
    // (an Alt-Tab and click back would otherwise throw away what you typed); read-only dialogs do, but only
    // when the click both starts and ends on the backdrop, so dragging a text selection out doesn't count.
    document.querySelectorAll('dialog').forEach(dlg => {
      let pressedOnBackdrop = false;
      dlg.addEventListener('pointerdown', e => { pressedOnBackdrop = e.target === dlg; });
      dlg.addEventListener('click', e => {
        if (e.target.closest('[data-close]')) {
          if (dlg.id === 'editor') run(requestCloseEditor); else dlg.close();
          return;
        }
        if (dlg.id === 'detail' && e.target === dlg && pressedOnBackdrop) dlg.close();
      });
    });
    // Esc on the editor: ask first if anything was changed.
    $('#editor').addEventListener('cancel', e => {
      if (!editorDirty) return;
      e.preventDefault();
      run(requestCloseEditor);
    });

    // Detail actions
    $('#detail').addEventListener('click', e => run(async () => {
      const action = e.target.closest('[data-action]')?.dataset.action;
      if (!action) return;
      const dlg = $('#detail');
      const item = state.items.find(i => i.id === dlg.dataset.id);
      if (!item) return;
      if (action === 'edit') { dlg.close(); openEditor(item); }
      if (action === 'duplicate') { dlg.close(); openEditor(item, { duplicate: true }); }
      if (action === 'delete') {
        if (!(await ask(`Remove “${item.title}” from your collection?`, 'Delete'))) return;
        await backend.remove([item.id]);
        state.items = state.items.filter(i => i.id !== item.id);
        dlg.close();
        render();
        toast(`Removed “${item.title}”.`);
      }
    }));

    // Editor
    const form = $('#editor-form');
    bindLookup(form);
    form.addEventListener('submit', e => { e.preventDefault(); run(() => submitEditor(form)); });
    form.addEventListener('input', e => {
      editorDirty = true;
      if (e.target.name === 'title') e.target.removeAttribute('aria-invalid');
    });
    form.addEventListener('change', () => { editorDirty = true; });
    form.addEventListener('change', e => run(async () => {
      const el = e.target;
      const preview = () => { $('[data-preview]', form).innerHTML = coverPreview(); };
      if (el.name === 'type') switchType(form, el.value);
      if (el.name === 'autoColour') form.elements.namedItem('spineColor').disabled = el.checked;
      if (el.name === 'coverUrl') {
        draft = { cover: el.value.trim(), coverFile: '', pendingData: '' };
        preview();
      }
      if (el.matches('[data-cover-file]') && el.files[0]) {
        draft = { cover: '', coverFile: '', pendingData: await resizeImage(el.files[0]) };
        form.elements.namedItem('coverUrl').value = '';
        el.value = '';
        preview();
      }
    }));
    form.addEventListener('click', e => {
      if (!e.target.closest('[data-cover-clear]')) return;
      draft = { cover: '', coverFile: '', pendingData: '' };
      form.elements.namedItem('coverUrl').value = '';
      $('[data-preview]', form).innerHTML = coverPreview();
    });

    // Footnote
    const foot = $('#footnote');
    foot.textContent = backend.footnote + ' ';
    if (backend.openFolder) {
      const b = Object.assign(document.createElement('button'), { type: 'button', textContent: 'Open data folder' });
      b.addEventListener('click', () => run(() => backend.openFolder()));
      foot.append(b);
    }
  }

  /* ---------- Start ---------- */
  bind();
  run(async () => {
    await backend.init();
    await reload();
  });
})();
