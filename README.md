# Collection Tracker

A library-style shelf for your physical collection: books, vinyl, CDs, video games and Blu-rays.
Each type is drawn as its real shape on the shelf: book spines, thin record sleeves, jewel cases,
game cases coloured by platform, and movie cases.

It's a desktop app built with Rust ([Tauri](https://tauri.app)). It's free, works offline and has no account.

## Themes

- **Books, vinyl and CDs:** a warm library look (follows your system's light/dark setting)
- **Games:** the retro Game//State theme from
  [Video-Game-Visualization-of-2026](https://github.com/The1Azreen/Video-Game-Visualization-of-2026):
  night sky, neon-yellow windows, and the PixelMplus12 pixel font (M+ FONT LICENSE). Cases are coloured by platform:
  PlayStation/PC teal, Switch 2 magenta, Switch yellow, Xbox mint.
- **Blu-rays:** a 90s video-rental-store look: royal blue, ticket-yellow signs and rental stickers

Filter to Games or Blu-rays and the whole page switches to that theme. In the mixed view, each one's shelf appears as a
themed panel. The themes are at the bottom of [`ui/styles.css`](ui/styles.css) (the "Rooms" section).

## Features

- **Shelf view** with items grouped by type, genre, creator, format/platform, decade or status; spines are printed with the item's cover art
- **Covers view:** covers stand face-out on the shelf like a shop display
- **Grid view** with cover art
- **Cover art search:** **Edit → Find cover online** shows candidate covers to pick from, and
  **⋯ → Find missing covers online** fills in every item without one (only clear title matches).
  Sources: Open Library, iTunes, Cover Art Archive, Wikipedia (box art and posters), Steam (PC game art).
- **Barcode lookup:** scan the back of the case with your webcam, pick a photo of it, use a USB barcode scanner,
  or type the digits. It fills in what it finds, and you can edit anything that's wrong.
- **Title suggestions:** as you type, it suggests the closest matches. Items you already own come first, then online results.
- **Manual entry** with fields for each type (platform, region, edition, pressing, format…). Values you've typed before are suggested again.
- **Wishlist, Lent out, Sold and Favourites** filters
- **Search** across everything (`/` to focus)
- **Covers** from an image file on your PC or a URL
- **Backups:** export everything (covers included) to one `.json` file, and import it on another PC

### Where lookups come from

All of these are free and need no account or API key. Lookups need an internet connection; everything else works offline.

| | Barcode | Title suggestions |
|---|---|---|
| Books | [Open Library](https://openlibrary.org); Japanese ISBNs (978-4…) use [openBD](https://openbd.jp) and Japan's [National Diet Library](https://ndlsearch.ndl.go.jp) first | Open Library; titles typed in Japanese/Chinese/Korean also search the National Diet Library |
| Vinyl & CDs | [MusicBrainz](https://musicbrainz.org) + Cover Art Archive | iTunes Search (the Japanese, Korean or Taiwanese store when you type in that script) |
| Games | [UPCitemdb](https://www.upcitemdb.com) free tier (100 lookups/day) + Wikidata | [Wikidata](https://www.wikidata.org), matching Japanese/Chinese/Korean names too |
| Blu-rays | UPCitemdb free tier + Wikidata | Wikidata, matching Japanese/Chinese/Korean names too |

Covers found online are downloaded when you save, so they still show offline. Barcodes are read with
[zxing-wasm](https://github.com/Sec-ant/zxing-wasm) (zxing-cpp compiled to WebAssembly, MIT), bundled in `ui/vendor/`.
It handles sideways and angled photos. If a photo is too blurry to read, the app shows it to you so you can type the
printed digits. A check digit catches typos.

**Region** (games and Blu-rays) isn't in any free database, so it's a guess you should confirm against the region mark
on the case. It uses region words in the retailer's listing (e.g. "HK, Chinese") first, then the barcode's country
prefix (880 Korea, 888 Singapore and so on → Asia; 0/1 → US; 45–49 → Japan; European prefixes → PAL/Region B).

## Running it

**Easiest:** double-click **`run.bat`**. It builds the app (a few minutes the first time), puts
`Collection Tracker.exe` in `dist\`, and opens it. The exe is standalone, so you can pin it or make a shortcut to it.

You need [Rust](https://rustup.rs) (MSVC toolchain on Windows). WebView2 is already part of Windows 10/11.

```sh
cd src-tauri
cargo run              # debug build
cargo run --release    # faster, smaller
```

The UI in `ui/` is plain HTML/CSS/JS with no build step. After you edit it, run `cargo run` again to rebuild.
You can also open `ui/index.html` straight in a browser to work on the design. Data saved there stays in that browser.

### Making an installer to share

```sh
cargo install tauri-cli --version "^2"
cd src-tauri
cargo tauri build      # creates .msi and .exe installers under target/release/bundle/
```

## Where your data lives

The app is **portable**: it saves into a **`Collection Data`** folder next to the exe.

```
dist\
├── Collection Tracker.exe
└── Collection Data\
    ├── collection.json        every item, human-readable
    ├── collection.json.bak    the previous save
    └── covers\                cover images
```

- **Updating:** replace the exe (or run `run.bat` again). The `Collection Data` folder is left alone, so your collection stays.
- **Moving PCs:** copy the exe and its `Collection Data` folder together, for example onto a USB stick.
- **Older versions** saved to `%APPDATA%\com.the1azreen.collectiontracker\`. The first time the new version starts,
  it moves that save next to the exe automatically.
- If the exe's folder can't be written to (e.g. it's installed under `Program Files`), the app falls back to `%APPDATA%`.
- `dist/` is git-ignored, so your collection is never committed. Don't run `git clean -x`, which deletes ignored files.

To open the folder, use **Open data folder** at the bottom of the app. Use **⋯ → Export backup** now and then.

## Adding a new kind of item

Open [`ui/types.js`](ui/types.js), copy one of the blocks (for example `bluray`), give it a new key such as
`boardgame`, and choose a shelf `shape` (`book`, `vinyl`, `cd`, `game`, `disc`). Fields are free text by
default. `presets` are suggestions only, `options` makes a fixed dropdown, and `type: 'number'` makes a number field.

## Project layout

```
ui/          the interface (index.html, styles.css, app.js, types.js)
src-tauri/   the Rust desktop app: storage, covers, backup import/export
```
