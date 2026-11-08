// Hide the console window in release builds on Windows.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! Collection Tracker — desktop shell.
//!
//! Everything lives in a `Collection Data` folder next to the exe (see `data_dir`;
//! it falls back to `%APPDATA%\com.the1azreen.collectiontracker` if that isn't writable):
//!   collection.json      – every item, human-readable
//!   collection.json.bak  – the previous save, in case something goes wrong
//!   covers/              – cover images, referenced by `coverFile` on an item
//!
//! The item schema is owned by the UI (`ui/types.js`); this side only needs
//! each item to be an object with a string `id`, `title` and `type`.

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use serde_json::{json, Map, Value};
use std::{
    fs,
    path::{Path, PathBuf, MAIN_SEPARATOR},
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;

type CmdResult<T> = Result<T, String>;

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

/// A short unique token for generated ids and file names.
fn unique() -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or_default();
    format!("{nanos:x}{:x}", COUNTER.fetch_add(1, Ordering::Relaxed))
}

/// Cover file names come from backups too, so never let one escape the covers folder.
fn is_safe_file_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 120
        && !name.starts_with('.')
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

/// Accepts an item if it has the minimum shape; fills in a missing id and drops bad cover names.
fn normalize_item(value: Value) -> Option<Value> {
    let mut obj: Map<String, Value> = match value {
        Value::Object(obj) => obj,
        _ => return None,
    };
    let has_text = |obj: &Map<String, Value>, key: &str| {
        obj.get(key).and_then(Value::as_str).is_some_and(|s| !s.trim().is_empty())
    };
    if !has_text(&obj, "title") || !has_text(&obj, "type") {
        return None;
    }
    if !has_text(&obj, "id") {
        obj.insert("id".into(), Value::String(unique()));
    }
    let bad_cover = obj
        .get("coverFile")
        .and_then(Value::as_str)
        .is_some_and(|f| !f.is_empty() && !is_safe_file_name(f));
    if bad_cover {
        obj.remove("coverFile");
    }
    Some(Value::Object(obj))
}

/// Reads items from a saved collection or a backup: either `{ "items": [...] }` or a bare array.
fn items_from(doc: &Value) -> Vec<Value> {
    let list = doc.get("items").unwrap_or(doc);
    list.as_array()
        .map(|a| a.iter().cloned().filter_map(normalize_item).collect())
        .unwrap_or_default()
}

fn read_items(path: &PathBuf) -> CmdResult<Vec<Value>> {
    let text = fs::read_to_string(path).map_err(err)?;
    let doc: Value = serde_json::from_str(&text).map_err(err)?;
    Ok(items_from(&doc))
}

fn cover_file(item: &Value) -> Option<&str> {
    item.get("coverFile").and_then(Value::as_str).filter(|f| !f.is_empty())
}

struct Store {
    dir: PathBuf,
    file: PathBuf,
    covers: PathBuf,
    items: Vec<Value>,
}

impl Store {
    fn open(dir: PathBuf) -> CmdResult<Self> {
        let covers = dir.join("covers");
        fs::create_dir_all(&covers).map_err(err)?;
        let file = dir.join("collection.json");
        let backup = dir.join("collection.json.bak");

        let items = match read_items(&file) {
            Ok(items) => items,
            Err(_) if file.exists() => {
                // Don't overwrite a file we can't read: move it aside, then fall back to the last good save.
                let aside = dir.join(format!("collection.unreadable-{}.json", unique()));
                let _ = fs::rename(&file, &aside);
                read_items(&backup).unwrap_or_default()
            }
            Err(_) => Vec::new(),
        };
        Ok(Self { dir, file, covers, items })
    }

    fn persist(&self) -> CmdResult<()> {
        let doc = json!({ "app": "collection-tracker", "version": 1, "items": self.items });
        let text = serde_json::to_string_pretty(&doc).map_err(err)?;
        if self.file.exists() {
            let _ = fs::copy(&self.file, self.file.with_extension("json.bak"));
        }
        // Write to a temp file and swap it in, so a crash mid-write can't corrupt the collection.
        let tmp = self.file.with_extension("json.tmp");
        fs::write(&tmp, text).map_err(err)?;
        fs::rename(&tmp, &self.file).map_err(err)
    }

    fn remove_cover_if_unused(&self, name: &str) {
        let in_use = self.items.iter().any(|i| cover_file(i) == Some(name));
        if !in_use && is_safe_file_name(name) {
            let _ = fs::remove_file(self.covers.join(name));
        }
    }

    fn upsert(&mut self, item: Value) {
        let id = item["id"].as_str().unwrap_or_default().to_owned();
        match self.items.iter().position(|i| i["id"] == id) {
            Some(pos) => {
                let old = std::mem::replace(&mut self.items[pos], item);
                if let Some(old_cover) = cover_file(&old) {
                    if cover_file(&self.items[pos]) != Some(old_cover) {
                        self.remove_cover_if_unused(old_cover);
                    }
                }
            }
            None => self.items.push(item),
        }
    }
}

type SharedStore<'a> = State<'a, Mutex<Store>>;

fn lock<'a>(store: &'a SharedStore) -> CmdResult<std::sync::MutexGuard<'a, Store>> {
    store.lock().map_err(|_| "collection store is unavailable".to_string())
}

#[tauri::command]
fn list_items(store: SharedStore) -> CmdResult<Vec<Value>> {
    Ok(lock(&store)?.items.clone())
}

#[tauri::command]
fn save_items(store: SharedStore, items: Vec<Value>) -> CmdResult<()> {
    let mut store = lock(&store)?;
    for item in items.into_iter().filter_map(normalize_item) {
        store.upsert(item);
    }
    store.persist()
}

#[tauri::command]
fn delete_items(store: SharedStore, ids: Vec<String>) -> CmdResult<()> {
    let mut store = lock(&store)?;
    let (removed, kept): (Vec<Value>, Vec<Value>) = std::mem::take(&mut store.items)
        .into_iter()
        .partition(|i| ids.iter().any(|id| i["id"] == *id));
    store.items = kept;
    for item in &removed {
        if let Some(name) = cover_file(item) {
            store.remove_cover_if_unused(name);
        }
    }
    store.persist()
}

/// Saves a cover image (a `data:` URL or bare base64 from the UI) and returns its file name.
#[tauri::command]
fn save_cover(store: SharedStore, data: String) -> CmdResult<String> {
    let base64 = data.split_once(',').map_or(data.as_str(), |(_, b)| b);
    let bytes = B64.decode(base64.trim()).map_err(err)?;
    let name = format!("{}.jpg", unique());
    let store = lock(&store)?;
    fs::write(store.covers.join(&name), bytes).map_err(err)?;
    Ok(name)
}

/// The covers folder, with a trailing separator so the UI can append a file name.
#[tauri::command]
fn covers_dir(store: SharedStore) -> CmdResult<String> {
    Ok(format!("{}{}", lock(&store)?.covers.display(), MAIN_SEPARATOR))
}

/// Writes a self-contained backup (items plus cover images) to a file the user picks.
#[tauri::command]
async fn export_backup(app: AppHandle, store: SharedStore<'_>, file_name: String) -> CmdResult<Option<String>> {
    let Some(target) = app
        .dialog()
        .file()
        .set_title("Save collection backup")
        .set_file_name(&file_name)
        .add_filter("Collection backup", &["json"])
        .blocking_save_file()
    else {
        return Ok(None);
    };
    let target = target.into_path().map_err(err)?;

    let doc = {
        let store = lock(&store)?;
        let mut covers = Map::new();
        for name in store.items.iter().filter_map(cover_file) {
            if let Ok(bytes) = fs::read(store.covers.join(name)) {
                covers.insert(name.to_owned(), Value::String(B64.encode(bytes)));
            }
        }
        json!({ "app": "collection-tracker", "version": 1, "items": store.items, "covers": covers })
    };
    fs::write(&target, serde_json::to_string(&doc).map_err(err)?).map_err(err)?;
    Ok(Some(target.display().to_string()))
}

/// Merges a backup the user picks into the collection. Items with the same id are replaced.
#[tauri::command]
async fn import_backup(app: AppHandle, store: SharedStore<'_>) -> CmdResult<Option<usize>> {
    let Some(source) = app
        .dialog()
        .file()
        .set_title("Import collection backup")
        .add_filter("Collection backup", &["json"])
        .blocking_pick_file()
    else {
        return Ok(None);
    };
    let source = source.into_path().map_err(err)?;
    let text = fs::read_to_string(&source).map_err(err)?;
    let doc: Value = serde_json::from_str(&text).map_err(|_| "That file isn't a collection backup.".to_string())?;
    let items = items_from(&doc);
    if items.is_empty() {
        return Err("No items found in that file.".into());
    }

    let mut store = lock(&store)?;
    if let Some(covers) = doc.get("covers").and_then(Value::as_object) {
        for (name, data) in covers {
            if let (true, Some(b64)) = (is_safe_file_name(name), data.as_str()) {
                if let Ok(bytes) = B64.decode(b64) {
                    fs::write(store.covers.join(name), bytes).map_err(err)?;
                }
            }
        }
    }
    let count = items.len();
    for item in items {
        store.upsert(item);
    }
    store.persist()?;
    Ok(Some(count))
}

/* ---------- Online lookups (barcode + title suggestions) ----------
 * Requests go through Rust rather than the webview so that CORS doesn't get in the way
 * and MusicBrainz gets the identifying User-Agent it asks for. Only these free, keyless
 * services can be reached this way. */

const USER_AGENT: &str = concat!(
    "CollectionTracker/",
    env!("CARGO_PKG_VERSION"),
    " ( https://github.com/The1Azreen/Collection-Tracker- )"
);

const LOOKUP_HOSTS: &[&str] = &[
    "openlibrary.org",
    "musicbrainz.org",
    "itunes.apple.com",
    "api.upcitemdb.com",
    "www.wikidata.org",
    "en.wikipedia.org",
    "store.steampowered.com",
    "api.openbd.jp",
    "ndlsearch.ndl.go.jp",
];

fn https_host(url: &str) -> Option<&str> {
    let rest = url.strip_prefix("https://")?;
    let host = rest.split(['/', '?', '#']).next()?;
    (!host.is_empty() && !host.contains('@')).then_some(host)
}

fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout(std::time::Duration::from_secs(12))
        .user_agent(USER_AGENT)
        .build()
}

/// GETs an allowed lookup URL and returns the body as text.
async fn fetch_allowed(url: String, accept: &'static str) -> CmdResult<String> {
    let host = https_host(&url).ok_or("Only https lookups are allowed.")?;
    if !LOOKUP_HOSTS.contains(&host) {
        return Err(format!("Lookups to {host} aren't allowed."));
    }
    tauri::async_runtime::spawn_blocking(move || {
        let response = agent()
            .get(&url)
            .set("Accept", accept)
            .call()
            .map_err(|e| match e {
                ureq::Error::Status(404, _) => "not found".to_string(),
                ureq::Error::Status(429 | 503, _) => "The lookup service is busy (503). Try again in a minute.".to_string(),
                ureq::Error::Status(code, _) => format!("The lookup service answered {code}."),
                ureq::Error::Transport(_) => "Couldn't reach the lookup service. Are you online?".to_string(),
            })?;
        response.into_string().map_err(err)
    })
    .await
    .map_err(err)?
}

#[tauri::command]
async fn fetch_json(url: String) -> CmdResult<Value> {
    let text = fetch_allowed(url, "application/json").await?;
    serde_json::from_str::<Value>(&text).map_err(err)
}

/// For services that answer in XML (Japan's National Diet Library).
#[tauri::command]
async fn fetch_text(url: String) -> CmdResult<String> {
    fetch_allowed(url, "application/xml, text/xml, */*").await
}

/// Downloads a cover image from the web into the covers folder so it works offline.
#[tauri::command]
async fn download_cover(store: SharedStore<'_>, url: String) -> CmdResult<String> {
    https_host(&url).ok_or("Only https images can be downloaded.")?;
    let covers = lock(&store)?.covers.clone();
    tauri::async_runtime::spawn_blocking(move || {
        use std::io::Read;
        const MAX_BYTES: u64 = 10 * 1024 * 1024;
        let response = agent().get(&url).call().map_err(err)?;
        let ext = match response.content_type() {
            "image/png" => "png",
            "image/webp" => "webp",
            "image/gif" => "gif",
            t if t.starts_with("image/") => "jpg",
            _ => return Err("That link isn't an image.".to_string()),
        };
        let mut bytes = Vec::new();
        response.into_reader().take(MAX_BYTES + 1).read_to_end(&mut bytes).map_err(err)?;
        if bytes.len() as u64 > MAX_BYTES {
            return Err("That image is too large (over 10 MB).".into());
        }
        let name = format!("{}.{ext}", unique());
        fs::write(covers.join(&name), bytes).map_err(err)?;
        Ok(name)
    })
    .await
    .map_err(err)?
}

#[tauri::command]
fn open_data_folder(store: SharedStore) -> CmdResult<()> {
    let dir = lock(&store)?.dir.clone();
    let opener = if cfg!(target_os = "windows") {
        "explorer"
    } else if cfg!(target_os = "macos") {
        "open"
    } else {
        "xdg-open"
    };
    std::process::Command::new(opener).arg(dir).spawn().map_err(err)?;
    Ok(())
}

/* ---------- Where the collection is saved ----------
 * Portable by default: a "Collection Data" folder next to the exe, so the app and its data
 * travel together and updating the exe keeps everything. If that folder can't be written
 * (e.g. the exe was installed under Program Files), it falls back to the per-user app data folder. */

const DATA_FOLDER: &str = "Collection Data";

fn is_writable(dir: &Path) -> bool {
    if fs::create_dir_all(dir).is_err() {
        return false;
    }
    let probe = dir.join(".write-test");
    let ok = fs::write(&probe, b"ok").is_ok();
    let _ = fs::remove_file(&probe);
    ok
}

fn copy_dir(from: &Path, to: &Path) -> std::io::Result<()> {
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let target = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir(&entry.path(), &target)?;
        } else {
            fs::copy(entry.path(), target)?;
        }
    }
    Ok(())
}

/// Moves a collection saved by an older version (in app data) next to the exe, once.
fn migrate(old: &Path, new: &Path) {
    let has_old = old.join("collection.json").exists();
    let has_new = new.join("collection.json").exists();
    if !has_old || has_new {
        return;
    }
    match copy_dir(old, new) {
        // Only remove the old copy once everything has been copied across.
        Ok(()) => {
            let _ = fs::remove_dir_all(old);
        }
        Err(e) => eprintln!("couldn't move the collection from {}: {e}", old.display()),
    }
}

fn data_dir(app: &tauri::App) -> Result<PathBuf, Box<dyn std::error::Error>> {
    let app_data = app.path().app_data_dir()?;
    let beside_exe = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|p| p.join(DATA_FOLDER)));
    if let Some(dir) = beside_exe.filter(|d| is_writable(d)) {
        migrate(&app_data, &dir);
        return Ok(dir);
    }
    Ok(app_data)
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let store = Store::open(data_dir(app)?)?;
            // Let the webview show cover images from wherever the collection lives.
            app.asset_protocol_scope().allow_directory(&store.covers, true)?;
            app.manage(Mutex::new(store));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_items,
            save_items,
            delete_items,
            save_cover,
            covers_dir,
            export_backup,
            import_backup,
            fetch_json,
            fetch_text,
            download_cover,
            open_data_folder
        ])
        .run(tauri::generate_context!())
        .expect("error while running Collection Tracker");
}
