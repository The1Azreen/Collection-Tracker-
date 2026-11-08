'use strict';
/*
 * Cover art search. Free sources, no keys:
 *   Books        Open Library covers, Wikipedia
 *   Vinyl / CDs  iTunes artwork (up to 1000px), Cover Art Archive (MusicBrainz), Wikipedia
 *   Games        Wikipedia box art, Steam portrait library art
 *   Blu-rays     Wikipedia posters
 *
 * search(item) → [{ url, thumb, source, title, note }]   best guesses first
 * best(item)   → the top candidate whose title clearly matches, or null
 */
window.Covers = (() => {
  // Shares the fetcher Lookup uses (Rust on desktop, fetch in a browser).
  const fetchJson = url => window.Lookup.fetchJson(url);
  const enc = encodeURIComponent;

  /** Loose title key: lower-case, no punctuation, "the"/"a" dropped, bracketed qualifiers dropped. */
  const norm = s => String(s || '')
    .toLowerCase()
    .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\b(the|a|an)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const sameTitle = (a, b) => {
    const x = norm(a), y = norm(b);
    if (!x || !y) return false;
    if (x === y) return true;
    if (Math.min(x.length, y.length) >= 5 && (x.startsWith(y) || y.startsWith(x))) return true;
    // a series name in front: "Legend of Zelda: Tears of the Kingdom" vs "Tears of the Kingdom"
    return Math.min(x.length, y.length) >= 8 && (x.endsWith(` ${y}`) || y.endsWith(` ${x}`));
  };

  const SOURCES = {
    book: [openLibrary, item => wikipedia(item, 'novel book')],
    vinyl: [itunes, coverArtArchive, item => wikipedia(item, 'album')],
    cd: [itunes, coverArtArchive, item => wikipedia(item, 'album')],
    game: [item => wikipedia(item, 'video game'), steam],
    bluray: [item => wikipedia(item, 'film')],
  };

  async function search(item) {
    if (!item?.title?.trim()) return [];
    const sources = SOURCES[item.type] || [item2 => wikipedia(item2, '')];
    const batches = await Promise.all(sources.map(fn => fn(item).catch(e => { console.warn('cover source failed', e); return []; })));
    // Interleave sources so the first row shows a choice, then put title matches first.
    const merged = [];
    for (let i = 0; batches.some(b => b[i]); i++) for (const b of batches) if (b[i]) merged.push(b[i]);
    const seen = new Set();
    return merged
      .filter(c => c.url && !seen.has(c.url) && seen.add(c.url))
      .map((c, i) => ({ c, i, match: sameTitle(c.title, item.title) }))
      .sort((a, b) => Number(b.match) - Number(a.match) || a.i - b.i)
      .map(x => ({ ...x.c, match: x.match }));
  }

  async function best(item) {
    const list = await search(item);
    // An exact title beats a looser one ("Elden Ring" over "Elden Ring Nightreign").
    return list.find(c => norm(c.title) === norm(item.title)) || list.find(c => c.match) || null;
  }

  /* ---------- sources ---------- */

  async function openLibrary(item) {
    const q = `title=${enc(item.title)}${item.creator ? `&author=${enc(item.creator)}` : ''}`;
    // lang=en makes Open Library prefer English editions' covers (and titles) when it has them.
    const data = await fetchJson(`https://openlibrary.org/search.json?${q}&lang=en&limit=8&fields=title,author_name,cover_i,first_publish_year`);
    return (data.docs || []).filter(d => d.cover_i).map(d => ({
      url: `https://covers.openlibrary.org/b/id/${d.cover_i}-L.jpg`,
      thumb: `https://covers.openlibrary.org/b/id/${d.cover_i}-M.jpg`,
      source: 'Open Library',
      title: d.title,
      note: [d.author_name?.[0], d.first_publish_year].filter(Boolean).join(' · '),
    }));
  }

  async function itunes(item) {
    const data = await fetchJson(`https://itunes.apple.com/search?term=${enc([item.title, item.creator].filter(Boolean).join(' '))}&entity=album&limit=8`);
    return (data.results || []).filter(r => r.artworkUrl100).map(r => ({
      url: r.artworkUrl100.replace('100x100bb', '1000x1000bb'),
      thumb: r.artworkUrl100.replace('100x100bb', '300x300bb'),
      source: 'iTunes',
      title: r.collectionName,
      note: [r.artistName, r.releaseDate?.slice(0, 4)].filter(Boolean).join(' · '),
    }));
  }

  async function coverArtArchive(item) {
    const terms = [`releasegroup:"${item.title.replace(/"/g, '')}"`];
    if (item.creator) terms.push(`artist:"${item.creator.replace(/"/g, '')}"`);
    const data = await fetchJson(`https://musicbrainz.org/ws/2/release-group?query=${enc(terms.join(' AND '))}&fmt=json&limit=4`);
    return (data['release-groups'] || []).map(g => ({
      url: `https://coverartarchive.org/release-group/${g.id}/front-500`,
      thumb: `https://coverartarchive.org/release-group/${g.id}/front-250`,
      source: 'Cover Art Archive',
      title: g.title,
      note: [(g['artist-credit'] || []).map(a => a.name).join(', '), g['first-release-date']?.slice(0, 4)].filter(Boolean).join(' · '),
    }));
  }

  async function wikipedia(item, kind) {
    const q = [item.title, item.type === 'bluray' || item.type === 'game' ? '' : item.creator, kind].filter(Boolean).join(' ');
    const url = 'https://en.wikipedia.org/w/api.php?action=query&format=json&origin=*&generator=search' +
      `&gsrsearch=${enc(q)}&gsrlimit=6&prop=pageimages|description&piprop=thumbnail&pithumbsize=800&pilicense=any`;
    const data = await fetchJson(url);
    return Object.values(data.query?.pages || {})
      .sort((a, b) => a.index - b.index)
      .filter(p => p.thumbnail?.source && !/franchise|series|character|soundtrack|concept art/i.test(`${p.title} ${p.description || ''}`))
      .map(p => {
        const src = p.thumbnail.source.replace(/\?.*$/, '');
        return {
          url: src,
          thumb: src,
          source: 'Wikipedia',
          title: p.title.replace(/\s*\([^)]*\)\s*$/, ''),
          note: p.description || '',
        };
      });
  }

  async function steam(item) {
    const data = await fetchJson(`https://store.steampowered.com/api/storesearch/?term=${enc(item.title)}&l=english&cc=US`);
    return (data.items || []).slice(0, 4).map(i => ({
      url: `https://shared.steamstatic.com/store_item_assets/steam/apps/${i.id}/library_600x900_2x.jpg`,
      thumb: `https://shared.steamstatic.com/store_item_assets/steam/apps/${i.id}/library_600x900.jpg`,
      source: 'Steam',
      title: i.name,
      note: 'PC artwork',
    }));
  }

  return { search, best, sameTitle };
})();
