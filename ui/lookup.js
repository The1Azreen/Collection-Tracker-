'use strict';
/*
 * Online lookups: barcode → product, and title → suggestions while you type.
 * Every source is free and needs no account or API key:
 *   Books         Open Library (ISBN + title search)
 *   Vinyl / CDs   MusicBrainz + Cover Art Archive (barcode), iTunes Search (title)
 *   Games         UPCitemdb free tier (barcode, 100/day), Wikidata (title)
 *   Blu-rays      UPCitemdb free tier (barcode), Wikidata (title)
 *
 * A result looks like:
 *   { source, type, title, creator, year, genre, extra: {...}, cover, thumb, barcode }
 * Anything a source doesn't know is left out, so the form keeps what you typed.
 */
window.Lookup = (() => {
  const { TYPES } = window.CT;
  const httpGet = (url, as) => fetch(url).then(r => (r.ok ? r[as]() : Promise.reject(new Error(r.status === 404 ? 'not found' : `HTTP ${r.status}`))));
  let fetchJson = url => httpGet(url, 'json');
  let fetchText = url => httpGet(url, 'text');

  /** Which East Asian script a query is written in, if any: 'ja' | 'ko' | 'zh' | null. */
  const scriptOf = s => (/[぀-ヿㇰ-ㇿ]/.test(s) ? 'ja'
    : /[가-힯ᄀ-ᇿ]/.test(s) ? 'ko'
      : /[㐀-鿿]/.test(s) ? 'zh' : null);

  const enc = encodeURIComponent;
  const yearOf = s => { const m = String(s ?? '').match(/\b(1[89]\d\d|20\d\d)\b/); return m ? Number(m[1]) : undefined; };
  const cap = s => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
  const tidy = s => String(s ?? '').replace(/\s+/g, ' ').replace(/\s*[-–:,]\s*$/, '').trim();
  const httpsify = u => (u ? String(u).replace(/^http:\/\//, 'https://') : u);

  /** Snap a free-text genre onto the type's preset list when one fits, so genres stay consistent. */
  // How sources word things → the names used in our genre lists.
  const GENRE_ALIASES = [
    [/action role-?playing/i, 'Action RPG'], [/japanese role-?playing/i, 'JRPG'], [/tactical role-?playing/i, 'Tactical RPG'],
    [/massively multiplayer/i, 'MMORPG'], [/role-?playing/i, 'RPG'], [/first-person shooter/i, 'FPS'],
    [/third-person shooter/i, 'Third-person shooter'], [/survival horror/i, 'Survival horror'],
    [/hack and slash|hack-and-slash/i, 'Hack and slash'], [/real-time strategy/i, 'Real-time strategy'],
    [/turn-based strategy/i, 'Turn-based strategy'], [/action-adventure/i, 'Action-adventure'],
    [/science fiction/i, type => (type === 'bluray' ? 'Sci-fi' : 'Science fiction')], [/hip hop|hip-hop/i, 'Hip-hop'],
    [/rhythm and blues|\br&b\b/i, 'R&B'], [/dance|electronica/i, 'Electronic'], [/alternative/i, 'Alternative'],
    [/soundtrack|original score/i, 'Soundtrack'], [/animated/i, 'Animation'], [/juvenile|children/i, "Children's"],
  ];

  /** Snap a free-text genre onto the type's genre list when one fits, so genres stay consistent. */
  function matchGenre(type, candidates) {
    const presets = TYPES[type]?.genres || [];
    const byLower = new Map(presets.map(p => [p.toLowerCase(), p]));
    const list = (Array.isArray(candidates) ? candidates : [candidates]).filter(Boolean).map(String);
    // 1. exact name, 2. a known alias, 3. the longest list genre named inside the text
    for (const c of list) if (byLower.has(c.toLowerCase())) return byLower.get(c.toLowerCase());
    for (const c of list) {
      for (const [re, to] of GENRE_ALIASES) {
        const name = typeof to === 'function' ? to(type) : to;
        if (re.test(c) && byLower.has(name.toLowerCase())) return byLower.get(name.toLowerCase());
      }
    }
    for (const c of list) {
      const lc = ` ${c.toLowerCase()} `;
      const hit = presets
        .filter(p => p.length > 2 && lc.includes(` ${p.toLowerCase()} `))
        .sort((a, b) => b.length - a.length)[0];
      if (hit) return hit;
    }
    const first = list[0];
    return first && first.length <= 30 ? cap(first) : undefined;
  }

  /* =========================== Barcodes =========================== */

  const cleanCode = raw => String(raw ?? '').replace(/[^0-9Xx]/g, '').toUpperCase();
  const isIsbn = code => (code.length === 13 && /^97[89]/.test(code)) || /^\d{9}[\dX]$/.test(code);

  /** EAN-8 / UPC-A / EAN-13 end in a check digit. true = valid, false = typo, null = not that kind of code. */
  function checksumOk(code) {
    if (!/^\d+$/.test(code) || ![8, 12, 13].includes(code.length)) return null;
    const d = [...code].map(Number);
    const check = d.pop();
    const sum = d.reverse().reduce((s, n, i) => s + n * (i % 2 === 0 ? 3 : 1), 0);
    return (10 - (sum % 10)) % 10 === check;
  }

  /* ---------- Region guess ----------
   * Neither free database records a disc's region, so it's guessed:
   *  1. region words in the retailer's product title ("HK", "Asia", "PAL", "US version"…), else
   *  2. the barcode's GS1 prefix: which country the publisher registered the barcode in.
   * The prefix isn't the play region, so it's offered as a guess for you to confirm. */
  const AREAS = {
    // area: [game region preset, Blu-ray region preset, label]
    us:     ['NTSC-U (US)', 'A', 'the US/Canada'],
    latam:  ['NTSC-U (US)', 'A', 'Latin America'],
    japan:  ['NTSC-J (Japan)', 'A', 'Japan'],
    asia:   ['Asia', 'A', 'Asia'],
    china:  ['Asia', 'C', 'mainland China'],
    europe: ['PAL (EU/UK)', 'B', 'Europe'],
    oceania:['PAL (EU/UK)', 'B', 'Australia/NZ'],
    russia: ['PAL (EU/UK)', 'C', 'Russia'],
  };
  const PREFIXES = [
    [0, 139, 'us'], [300, 379, 'europe'], [380, 389, 'europe'], [400, 440, 'europe'], [450, 459, 'japan'],
    [460, 469, 'russia'], [471, 471, 'asia'], [474, 477, 'europe'], [480, 480, 'asia'], [489, 489, 'asia'],
    [490, 499, 'japan'], [500, 509, 'europe'], [520, 521, 'europe'], [529, 531, 'europe'], [535, 535, 'europe'],
    [539, 549, 'europe'], [560, 560, 'europe'], [569, 579, 'europe'], [590, 599, 'europe'], [600, 601, 'europe'],
    [640, 649, 'europe'], [690, 699, 'china'], [700, 709, 'europe'], [730, 739, 'europe'], [750, 750, 'latam'],
    [760, 769, 'europe'], [770, 771, 'latam'], [779, 779, 'latam'], [789, 790, 'latam'], [800, 849, 'europe'],
    [858, 860, 'europe'], [868, 879, 'europe'], [880, 880, 'asia'], [885, 885, 'asia'], [888, 888, 'asia'],
    [893, 893, 'asia'], [899, 899, 'asia'], [900, 919, 'europe'], [930, 949, 'oceania'], [955, 955, 'asia'], [958, 958, 'asia'],
  ];
  const TITLE_AREAS = [
    // [short codes, matched case-sensitively so "Among Us" or "Sea of Thieves" don't trip them; words, any case; area]
    [/\b(HK|SEA)\b/, /hong kong|\basian?\b|chinese|korean?\b|taiwan|singapore|malaysia/i, 'asia'],
    [/\b(JP|JPN)\b/, /\bjapan(ese)?\b/i, 'japan'],
    [/\b(PAL|EU|UK)\b/, /\beurope(an)?\b/i, 'europe'],
    [/\b(US|USA)\b/, /\bntsc-?u\b|north america/i, 'us'],
    [/\b(AU|AUS)\b/, /\baustralia/i, 'oceania'],
  ];
  // Retail titles are often all lower- or upper-case, so short codes are only trusted inside brackets,
  // e.g. "(hk, Chinese)"; full words like "Asia" or "Japanese" count anywhere.
  const titleArea = title => {
    const bracketed = (title.match(/[([][^)\]]*[)\]]/g) || []).join(' ').toUpperCase();
    return TITLE_AREAS.find(([codes, words]) => words.test(title) || codes.test(bracketed))?.[2];
  };

  function guessRegion(rawCode, type, productTitle = '') {
    if (type !== 'game' && type !== 'bluray') return null;
    let area = titleArea(String(productTitle || ''));
    let why = area ? 'from the product listing' : '';
    if (!area) {
      const code = cleanCode(rawCode);
      if (code.length === 12) area = 'us'; // a 12-digit UPC-A is a US/Canada barcode
      else if (code.length === 13) {
        const p = Number(code.slice(0, 3));
        area = PREFIXES.find(([lo, hi]) => p >= lo && p <= hi)?.[2];
      }
      why = area ? `the barcode is registered in ${AREAS[area][2]}` : '';
    }
    if (!area) return null;
    return { value: AREAS[area][type === 'game' ? 0 : 1], why };
  }

  async function byBarcode(raw) {
    const code = cleanCode(raw);
    if (code.length < 8) throw new Error('That barcode looks too short. It should be 8 to 13 digits.');
    // Japanese ISBNs (978-4…) are best covered by Japan's own catalogues; others try Open Library first.
    const japanese = /^9784/.test(isbn13(code) || '');
    const tries = !isIsbn(code) ? [musicBrainzBarcode, upcItemDb]
      : japanese ? [openBdIsbn, ndlIsbn, openLibraryIsbn]
        : [openLibraryIsbn, ndlIsbn, openBdIsbn];
    let lastError;
    for (const fn of tries) {
      try {
        const hit = await fn(code);
        if (hit) {
          const full = { ...(await enrich(hit)), barcode: code };
          const region = guessRegion(code, full.type, hit.productTitle);
          if (region && !full.extra?.region) {
            full.extra = { ...full.extra, region: region.value };
            full.regionWhy = region.why;
          }
          return full;
        }
      } catch (e) {
        if (!/not found/.test(e.message)) lastError = e;
      }
    }
    if (lastError) throw lastError;
    return null;
  }

  /** Retail barcodes only give a product name; for games and films, fill year/developer/director/genre from Wikidata. */
  async function enrich(hit) {
    if (!hit.title || (hit.type !== 'game' && hit.type !== 'bluray') || (hit.creator && hit.year && hit.genre)) return hit;
    try {
      const want = hit.title.toLowerCase();
      const matches = await wikidataSearch(hit.title, hit.type === 'game' ? 'game' : 'film');
      const best = matches.find(m => m.title.toLowerCase() === want) || matches.find(m => m.title.toLowerCase().startsWith(want));
      if (!best) return hit;
      return { ...hit, creator: hit.creator || best.creator, year: hit.year || best.year, genre: hit.genre || best.genre, source: `${hit.source} + Wikidata` };
    } catch {
      return hit;
    }
  }

  /** ISBN-10 → ISBN-13 (Japanese and other catalogues index the 13-digit form). */
  function isbn13(code) {
    if (/^97[89]\d{10}$/.test(code)) return code;
    if (!/^\d{9}[\dX]$/.test(code)) return null;
    const body = `978${code.slice(0, 9)}`;
    const sum = [...body].reduce((s, d, i) => s + Number(d) * (i % 2 ? 3 : 1), 0);
    return body + ((10 - (sum % 10)) % 10);
  }

  // Japanese library classification (NDC) → our genre names, for books from Japanese catalogues.
  const NDC_GENRES = [
    [/^726\.1/, 'Manga'], [/^726\.[5-6]/, 'Picture book'], [/^913/, 'Fiction'], [/^933|^923|^953|^943/, 'Fiction'],
    [/^911/, 'Poetry'], [/^798/, 'Gaming'], [/^7[0-2]\d/, 'Art'], [/^778/, 'Film & TV'], [/^76\d/, 'Music'],
    [/^596/, 'Cookbook'], [/^29\d/, 'Travel'], [/^28\d/, 'Biography'], [/^2\d\d/, 'History'], [/^1\d\d/, 'Philosophy'],
    [/^54\d|^007/, 'Computing'], [/^4\d\d/, 'Science'], [/^33\d/, 'Economics'], [/^159/, 'Self-help'],
  ];
  const ndcGenre = ndc => NDC_GENRES.find(([re]) => re.test(ndc || ''))?.[1];

  /** openBD: Japanese publishers' own book data. */
  async function openBdIsbn(code) {
    const isbn = isbn13(code);
    if (!isbn) return null;
    const [rec] = await fetchJson(`https://api.openbd.jp/v1/get?isbn=${isbn}`);
    if (!rec?.summary?.title) return null;
    const s = rec.summary;
    const result = {
      source: 'openBD',
      type: 'book',
      title: tidy(s.title),
      // openBD writes roles after a slash: "山田太郎／著" → "山田太郎"
      creator: s.author ? tidy(s.author.split(/\s+/).map(a => a.replace(/[／/].*$/, '')).join(', ')) : undefined,
      year: yearOf(s.pubdate),
      extra: { isbn, publisher: s.publisher || undefined, series: s.series || undefined },
      cover: s.cover || undefined,
    };
    // openBD has no page count or library genre; NDL usually does, so fill the gaps from there.
    try {
      const ndl = await ndlIsbn(isbn);
      if (ndl) {
        result.creator ||= ndl.creator;
        result.year ||= ndl.year;
        result.genre = ndl.genre;
        result.extra.pages = ndl.extra.pages;
        result.extra.series ||= ndl.extra.series;
        result.source = 'openBD + NDL';
      }
    } catch { /* openBD alone is still useful */ }
    return result;
  }

  /* NDL rate-limits busy clients (HTTP 429), and title suggestions fire as you type, so
   * NDL requests are cached and spaced at least 1.5 s apart. */
  const ndlCache = new Map();
  let ndlNext = 0;
  function ndlFetch(url) {
    if (ndlCache.has(url)) return ndlCache.get(url);
    const wait = Math.max(0, ndlNext - Date.now());
    ndlNext = Date.now() + wait + 1500;
    const request = new Promise(r => setTimeout(r, wait)).then(() => fetchText(url));
    request.catch(() => ndlCache.delete(url)); // don't cache failures
    ndlCache.set(url, request);
    return request;
  }

  /** NDL: Japan's National Diet Library, which keeps a copy of everything published in Japan. Answers in XML. */
  async function ndlIsbn(code) {
    const isbn = isbn13(code);
    if (!isbn) return null;
    const [hit] = ndlItems(await ndlFetch(`https://ndlsearch.ndl.go.jp/api/opensearch?isbn=${isbn}&cnt=1`));
    return hit ? { ...hit, extra: { ...hit.extra, isbn } } : null;
  }

  /** Parses NDL OpenSearch RSS into results (books only). */
  function ndlItems(xml) {
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    const text = (el, tag) => el.getElementsByTagName(tag)[0]?.textContent?.trim() || '';
    const all = (el, tag) => [...el.getElementsByTagName(tag)].map(n => n.textContent.trim()).filter(Boolean);
    return [...doc.getElementsByTagName('item')]
      .filter(it => all(it, 'category').includes('図書')) // 図書 = book (NDL also lists CDs and discs)
      .map(it => {
        const volume = text(it, 'dcndl:volume');
        const pages = Number((text(it, 'dc:extent').match(/(\d+)\s*p/) || [])[1]) || undefined;
        const creators = all(it, 'dc:creator').map(c => c.replace(/\s*(著|作|画|編|原作|イラスト|訳|監修)$/, ''));
        const ndc = [...it.getElementsByTagName('dc:subject')].find(n => /NDC/.test(n.getAttribute('xsi:type') || ''))?.textContent;
        const desc = text(it, 'description');
        const series = desc.match(/シリーズ名：([^<]+)/)?.[1]?.trim();
        return {
          source: 'NDL (National Diet Library)',
          type: 'book',
          title: tidy(volume ? `${text(it, 'dc:title') || text(it, 'title')} ${volume}` : (text(it, 'dc:title') || text(it, 'title'))),
          creator: creators.join(', ') || text(it, 'author') || undefined,
          year: yearOf(text(it, 'dcterms:issued') || text(it, 'dc:date')),
          genre: matchGenre('book', ndcGenre(ndc)),
          extra: { pages, publisher: text(it, 'dc:publisher') || undefined, series },
        };
      });
  }

  async function ndlTitleSearch(q) {
    return ndlItems(await ndlFetch(`https://ndlsearch.ndl.go.jp/api/opensearch?title=${enc(q)}&cnt=10`)).slice(0, 6);
  }

  async function openLibraryIsbn(code) {
    const data = await fetchJson(`https://openlibrary.org/api/books?bibkeys=ISBN:${code}&jscmd=data&format=json`);
    const b = data[`ISBN:${code}`];
    if (!b) return null;
    return {
      source: 'Open Library',
      type: 'book',
      title: tidy(b.subtitle ? `${b.title}: ${b.subtitle}` : b.title),
      creator: (b.authors || []).map(a => a.name).join(', ') || undefined,
      year: yearOf(b.publish_date),
      genre: matchGenre('book', (b.subjects || []).map(s => s.name)),
      extra: { isbn: code, pages: b.number_of_pages || undefined, publisher: b.publishers?.[0]?.name },
      cover: httpsify(b.cover?.large || b.cover?.medium),
    };
  }

  async function musicBrainzBarcode(code) {
    const url = `https://musicbrainz.org/ws/2/release?query=barcode:${code}&fmt=json&limit=5`;
    let data;
    try {
      data = await fetchJson(url);
    } catch (e) {
      // MusicBrainz allows about one request a second and answers 503 when busy: wait and retry once.
      if (!/503|busy/i.test(e.message)) throw e;
      await new Promise(r => setTimeout(r, 1500));
      data = await fetchJson(url);
    }
    // Only trust an exact barcode match (UPC-A and EAN-13 differ by a leading zero).
    const bare = code.replace(/^0+/, '');
    const r = (data.releases || []).find(x => x.barcode && x.barcode.replace(/^0+/, '') === bare);
    if (!r || !bare) return null;
    const media = r.media || [];
    const formats = media.map(m => m.format || '').join(' ');
    const vinyl = /vinyl|\blp\b/i.test(formats);
    const n = media.length || 1;
    let format;
    if (vinyl) {
      if (/7"/.test(formats)) format = '7" single';
      else if (/10"/.test(formats)) format = '10"';
      else format = n > 1 ? `${n}×LP` : '12" LP';
    } else {
      format = /sacd/i.test(formats) ? 'SACD' : n > 1 ? `${n}×CD` : 'CD';
    }
    const label = r['label-info']?.find(l => l.label?.name);
    const artist = (r['artist-credit'] || []).map(a => (a.name || a.artist?.name) + (a.joinphrase || '')).join('').trim();
    const rg = r['release-group'];
    return {
      source: 'MusicBrainz',
      type: vinyl ? 'vinyl' : 'cd',
      title: tidy(r.title),
      creator: artist || undefined,
      year: yearOf(r.date),
      extra: {
        format,
        label: label?.label?.name,
        catalogNo: label?.['catalog-number'],
        country: r.country && r.country !== 'XW' ? r.country : undefined,
      },
      cover: rg?.id ? `https://coverartarchive.org/release-group/${rg.id}/front-500` : `https://coverartarchive.org/release/${r.id}/front-500`,
    };
  }

  const PLATFORMS = [
    [/playstation\s*5|\bps5\b/i, 'PS5'], [/playstation\s*4|\bps4\b/i, 'PS4'], [/playstation\s*3|\bps3\b/i, 'PS3'],
    [/playstation\s*2|\bps2\b/i, 'PS2'], [/playstation\s*vita|\bps\s?vita\b/i, 'PS Vita'], [/\bpsp\b/i, 'PSP'],
    [/switch\s*2/i, 'Switch 2'], [/nintendo\s*switch|\bswitch\b/i, 'Switch'], [/wii\s*u/i, 'Wii U'], [/\bwii\b/i, 'Wii'],
    [/\b3ds\b/i, '3DS'], [/\bnds\b|nintendo ds\b/i, 'DS'], [/gamecube/i, 'GameCube'],
    [/xbox\s*series\s*[xs]/i, 'Xbox Series X'], [/xbox\s*one/i, 'Xbox One'], [/xbox\s*360/i, 'Xbox 360'],
    [/\bpc\b|windows/i, 'PC'],
  ];
  const DISC_FORMATS = [
    [/4k|uhd|ultra\s*hd/i, '4K UHD'], [/3d\s*blu/i, '3D Blu-ray'], [/blu-?ray/i, 'Blu-ray'], [/\bdvd\b/i, 'DVD'],
  ];
  const EDITIONS = [
    [/steel\s*book/i, 'Steelbook'], [/collector'?s/i, "Collector's"], [/criterion/i, 'Criterion'],
    [/deluxe/i, 'Deluxe'], [/limited/i, 'Limited'], [/greatest hits|platinum hits|nintendo selects/i, 'Greatest Hits'],
  ];
  const firstMatch = (list, text) => list.find(([re]) => re.test(text))?.[1];

  /** Remove the platform/format/edition noise retailers put in product titles. */
  function cleanProductTitle(title) {
    let t = String(title || '');
    t = t.replace(/\[[^\]]*\]|\([^)]*\)/g, ' ');
    for (const [re] of [...PLATFORMS, ...DISC_FORMATS, ...EDITIONS]) t = t.replace(new RegExp(re.source, 'gi'), ' ');
    t = t.replace(/\b(standard|edition|video game|game|for|sony|nintendo|microsoft|movie|digital code)\b/gi, ' ');
    t = t.replace(/(^|\s)[/+&]\s*\w{0,3}(?=\s|$)/g, ' '); // leftovers like "/hd" or "+" once "4K" is gone
    t = tidy(t.replace(/\s[-–|]\s/g, ' ').replace(/\s{2,}/g, ' '));
    // ALL-CAPS or all-lowercase retail titles → Title Case
    if (t === t.toUpperCase() || t === t.toLowerCase()) t = t.toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
    return t;
  }

  async function upcItemDb(code) {
    const data = await fetchJson(`https://api.upcitemdb.com/prod/trial/lookup?upc=${code}`);
    const it = data.items?.[0];
    if (!it) return null;
    const text = `${it.category || ''} ${it.title || ''}`;
    let type;
    // Retailers file plenty of games under "Video Game Consoles", so judge hardware by the product title only.
    const hardware = /\bconsole\b|controller|headset|charger|\bbundle\b.*\bconsole|\bTB\b|storage/i.test(it.title || '');
    if (/video game|playstation|xbox|nintendo|\bps[2-5]\b|switch/i.test(text) && !hardware) type = 'game';
    else if (/blu-?ray|\bdvd\b|4k ultra|uhd|movies|films?\b/i.test(text)) type = 'bluray';
    else if (/vinyl|\blp\b/i.test(text)) type = 'vinyl';
    else if (/\bcd\b|compact disc|music|album/i.test(text)) type = 'cd';
    else if (/books?\b/i.test(text)) type = 'book';
    // A categorised product that isn't media (snacks, cables…) isn't what you're cataloguing.
    if (!type && it.category) return null;
    const image = (it.images || []).find(u => /^https:/.test(u)) || httpsify(it.images?.[0]);
    const extra = {};
    if (type === 'game') extra.platform = firstMatch(PLATFORMS, it.title);
    if (type === 'bluray') {
      extra.format = firstMatch(DISC_FORMATS, it.title);
      if (extra.format === '4K UHD' && /blu-?ray/i.test(it.title)) extra.format = '4K UHD + Blu-ray';
      // Retailers sometimes stuff several studios into "brand"; only keep a clean single name.
      if (it.brand && !/\s{2,}|,|\//.test(it.brand) && it.brand.length <= 40) extra.studio = it.brand;
    }
    if (type === 'game' || type === 'bluray') extra.edition = firstMatch(EDITIONS, it.title);
    return {
      source: 'UPCitemdb',
      type,
      title: cleanProductTitle(it.title) || it.title,
      // Retail "brand" is the publisher, not the developer, so the developer comes from Wikidata (see enrich).
      extra,
      cover: image,
      note: it.category,
      productTitle: it.title,
    };
  }

  /* ======================= Title suggestions ======================= */

  async function suggest(type, query) {
    const q = query.trim();
    if (q.length < 3) return [];
    switch (type) {
      case 'book':
        // Japanese/Chinese/Korean titles: Japan's library catalogue first, then Open Library.
        if (scriptOf(q)) {
          const [ndl, ol] = await Promise.all([ndlTitleSearch(q).catch(() => []), openLibrarySearch(q).catch(() => [])]);
          return [...ndl, ...ol].slice(0, 8);
        }
        return openLibrarySearch(q);
      case 'vinyl':
      case 'cd': return itunesAlbums(q, type);
      case 'game': return wikidataSearch(q, 'game');
      case 'bluray': return wikidataSearch(q, 'film');
      default: return [];
    }
  }

  async function openLibrarySearch(q) {
    const fields = 'title,author_name,first_publish_year,subject,number_of_pages_median,cover_i,publisher';
    const data = await fetchJson(`https://openlibrary.org/search.json?q=${enc(q)}&limit=6&fields=${fields}`);
    return (data.docs || []).map(d => ({
      source: 'Open Library',
      type: 'book',
      title: tidy(d.title),
      creator: d.author_name?.slice(0, 2).join(', '),
      year: d.first_publish_year,
      genre: matchGenre('book', d.subject?.slice(0, 15)),
      extra: { pages: d.number_of_pages_median || undefined, publisher: d.publisher?.[0] },
      cover: d.cover_i ? `https://covers.openlibrary.org/b/id/${d.cover_i}-L.jpg` : undefined,
      thumb: d.cover_i ? `https://covers.openlibrary.org/b/id/${d.cover_i}-S.jpg` : undefined,
    }));
  }

  async function itunesAlbums(q, type) {
    // Search the store for the script the title is typed in, so Japanese/Korean/Chinese releases show up.
    const country = { ja: 'JP', ko: 'KR', zh: 'TW' }[scriptOf(q)] || 'US';
    const data = await fetchJson(`https://itunes.apple.com/search?term=${enc(q)}&entity=album&limit=8&country=${country}`);
    const seen = new Set();
    return (data.results || [])
      .map(r => ({
        source: 'iTunes',
        type,
        title: tidy(String(r.collectionName || '').replace(/\s-\s(Single|EP)$/i, '')),
        creator: r.artistName,
        year: yearOf(r.releaseDate),
        genre: matchGenre(type, r.primaryGenreName),
        extra: {},
        cover: r.artworkUrl100?.replace('100x100bb', '600x600bb'),
        thumb: r.artworkUrl100?.replace('100x100bb', '60x60bb'),
      }))
      .filter(r => r.title && !seen.has(`${r.title}|${r.creator}`) && seen.add(`${r.title}|${r.creator}`))
      .slice(0, 6);
  }

  async function wikidataSearch(q, kind) {
    // Search names in the query's own language (e.g. ドールズフロントライン), but read descriptions in English
    // so the "video game"/"film" filters below still work.
    const lang = scriptOf(q) || 'en';
    const data = await fetchJson(`https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${enc(q)}&language=${lang}&uselang=en&type=item&limit=20&format=json&origin=*`);
    const isGame = kind === 'game';
    const wanted = isGame ? /video game/i : /\bfilm\b|television series|miniseries|anime/i;
    const unwanted = isGame
      ? /series|franchise|character|soundtrack|bundle|manga|film|novel|album|company|engine|tournament/i
      : /festival|award|character|soundtrack|video game|novel|album|company|franchise|film series|song|essay|trailer|review|scene/i;
    const results = (data.search || [])
      .filter(s => s.description && wanted.test(s.description) && !unwanted.test(s.description.replace(/television series/i, '')))
      .map(s => {
        const d = s.description;
        const year = yearOf(d);
        let creator, genre;
        if (isGame) {
          creator = d.match(/developed by (.+?)(?: and published| for |,|;|$)/i)?.[1];
          genre = d.match(/(?:\d{4}\s+)?(.*?)\s*video game/i)?.[1];
        } else {
          creator = d.match(/(?:directed|created) by (.+?)(?:,|;| and starring|$)/i)?.[1];
          // "2017 American science fiction film" → "science fiction"
          genre = /television series|miniseries/i.test(d) ? 'TV series'
            : d.match(/(?:\d{4}\s+)?((?:[A-Z][\w-]*\s+)*)([a-z][\w\s-]*?)\s*film/)?.[2];
          if (/anime/i.test(d)) genre = 'Anime';
        }
        return {
          source: 'Wikidata',
          type: isGame ? 'game' : 'bluray',
          title: s.label,
          creator: tidy(creator) || undefined,
          year,
          genre: matchGenre(isGame ? 'game' : 'bluray', genre?.trim()),
          extra: {},
          description: d,
        };
      });
    // Rank like a search engine would: exact title first, then well-documented entries
    // (ones with a known developer/director and year), keeping Wikidata's order otherwise.
    const lq = q.toLowerCase();
    const score = r => (r.title.toLowerCase() === lq ? 4 : 0) + (r.title.toLowerCase().startsWith(lq) ? 1 : 0) + (r.creator ? 2 : 0) + (r.year ? 1 : 0);
    return results
      .map((r, i) => ({ r, i, s: score(r) }))
      .sort((a, b) => b.s - a.s || a.i - b.i)
      .slice(0, 6)
      .map(x => x.r);
  }

  return {
    byBarcode,
    suggest,
    cleanCode,
    checksumOk,
    guessRegion,
    fetchJson: url => fetchJson(url),
    /** The desktop app routes requests through Rust; the browser build uses fetch directly. */
    useFetcher(jsonFn, textFn) { fetchJson = jsonFn; if (textFn) fetchText = textFn; },
  };
})();
