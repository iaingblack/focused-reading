# Focused Reading

Vanilla JavaScript EPUB speed reader — no build tools, no frameworks.

## Architecture

- `index.html` — Single page with library and reader views
- `style.css` — Dark theme styling
- `app.js` — All application logic (EPUB parsing, IndexedDB storage, reader controls)
- `jszip.min.js` — Bundled locally (no CDN), used to unzip EPUB files

## Key Details

- **Fully offline** — no external dependencies or network requests
- **Storage**: IndexedDB (`focused_reading` database) with `books` and `positions` object stores
- **EPUB parsing**: Uses JSZip to extract ZIP contents, DOMParser for XHTML/XML, supports both EPUB2 (NCX) and EPUB3 (NAV) table of contents
- **Cover images**: Stored as ArrayBuffer in IndexedDB, converted to blob URLs on load
- **Reading position**: Chapter index, word index, and WPM saved per book

## Running Locally

Open `index.html` directly in a browser, or serve with:
```
python3 -m http.server 8080
```

## Conventions

- No build step, no transpilation — plain ES6+ JavaScript
- Single `state` object holds all runtime state
- DOM refs cached at top of `app.js`
- All storage functions are async (IndexedDB is async by nature)
