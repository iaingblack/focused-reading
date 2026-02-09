# Focused Reading

A speed reader for EPUB books that displays one word at a time, helping you read faster with fewer distractions. Runs entirely in the browser with no build tools, frameworks, or server required.

## Getting Started

Open `index.html` directly in a browser — no server needed.

To use a local server (optional):

```
python3 -m http.server 8080
```

> **Note:** Piper TTS requires network access for its ONNX runtime dependency and voice model downloads. The Piper library itself (`piper-tts-web.js`) is bundled locally, but falls back to CDN if the file is missing.

## Usage

### Library

- Click **+ Add Book** to import an EPUB file
- Books are stored in the browser (IndexedDB) and persist across sessions
- Hover over a book card and click **x** to remove it

### Reader

Click a book to open the reader. The current word is displayed in the center of the screen.

**Playback controls:**

| Action | Button | Keyboard |
|---|---|---|
| Play / Pause | Play button | `Space` |
| Next sentence | >> | `Right Arrow` |
| Previous sentence | << | `Left Arrow` |
| Speed up (25 WPM) | — | `Up Arrow` |
| Slow down (25 WPM) | — | `Down Arrow` |

**Panels:**

| Panel | Button | Keyboard |
|---|---|---|
| Chapter sidebar (left) | Hamburger menu (top-left) | — |
| Text panel (right) | Hamburger menu (top-right) | `T` |

The **text panel** shows the full chapter text with the current word highlighted and auto-scrolling, so you can follow along in context while speed-reading.

**Voice narration:**

| Mode | Keyboard | Description |
|---|---|---|
| Off | `V` to cycle | Silent, word-by-word display only |
| Browser | `V` to cycle | Uses the Web Speech API with system voices |
| Piper | `V` to cycle | High-quality neural TTS (requires voice download) |

### Reading Position

Your position, chapter, and WPM setting are saved automatically per book and restored when you reopen it.
