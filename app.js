// ── Piper TTS (runs in Web Worker to avoid blocking UI) ──
let piperWorker = null;
let piperMsgId = 0;
const piperCallbacks = new Map();

function getPiperWorker() {
  if (piperWorker) return piperWorker;
  piperWorker = new Worker('piper-worker.js', { type: 'module' });
  piperWorker.onmessage = (e) => {
    const { id } = e.data;
    const cb = piperCallbacks.get(id);
    if (cb) {
      piperCallbacks.delete(id);
      cb(e.data);
    }
  };
  return piperWorker;
}

function piperCall(msg) {
  return new Promise((resolve, reject) => {
    const id = ++piperMsgId;
    piperCallbacks.set(id, (data) => {
      if (data.type === 'error') reject(new Error(data.error));
      else resolve(data);
    });
    getPiperWorker().postMessage({ ...msg, id });
  });
}

// For download progress, we need a streaming callback
function piperDownloadWithProgress(voiceId, onProgress) {
  return new Promise((resolve, reject) => {
    const id = ++piperMsgId;
    const worker = getPiperWorker();
    const handler = (e) => {
      if (e.data.id !== id) return;
      if (e.data.type === 'download-progress') {
        onProgress(e.data.progress);
      } else if (e.data.type === 'download-done') {
        worker.removeEventListener('message', handler);
        piperCallbacks.delete(id);
        resolve();
      } else if (e.data.type === 'error') {
        worker.removeEventListener('message', handler);
        piperCallbacks.delete(id);
        reject(new Error(e.data.error));
      }
    };
    worker.addEventListener('message', handler);
    worker.postMessage({ type: 'download', id, voiceId });
  });
}

async function piperPredict(text, voiceId) {
  const data = await piperCall({ type: 'predict', text, voiceId });
  return new Blob([data.buffer], { type: 'audio/wav' });
}

async function piperStored() {
  const data = await piperCall({ type: 'stored' });
  return data.list;
}

async function piperResetSession() {
  await piperCall({ type: 'reset' });
}

// ── State ──
const state = {
  books: [],          // { id, title, author, cover, chapters: [{ title, words }], totalWords }
  currentBook: null,
  currentChapter: 0,
  currentWord: 0,
  wpm: 300,
  playing: false,
  timer: null,
  voiceMode: 'off',   // 'off' | 'browser' | 'piper'
  selectedVoice: null,
  piperVoiceName: 'en_US-amy',
  piperQuality: 'medium',
  piperVoiceId: 'en_US-amy-medium',
  piperReady: false,   // true when current voice is downloaded and ready
  piperAudio: null,
  piperWordTimer: null,
  piperAbort: false,
  textPanelOpen: false,
};

// ── DOM refs ──
const $ = (sel) => document.querySelector(sel);
const libraryView = $('#library-view');
const readerView = $('#reader-view');
const bookGrid = $('#book-grid');
const helpBtn = $('#help-btn');
const helpModal = $('#help-modal');
const helpClose = $('#help-close');
const epubInput = $('#epub-input');
const wordEl = $('#current-word');
const wpmSlider = $('#wpm-slider');
const wpmValue = $('#wpm-value');
const playBtn = $('#play-btn');
const prevBtn = $('#prev-btn');
const nextBtn = $('#next-btn');
const posSlider = $('#position-slider');
const progressBar = $('#progress-bar');
const chapterLabel = $('#chapter-label');
const chapterList = $('#chapter-list');
const bookInfo = $('#book-info');
const sidebar = $('#sidebar');
const toggleSidebarBtn = $('#toggle-sidebar');
const backBtn = $('#back-to-library');
const voiceSelect = $('#voice-select');
const piperVoiceSelect = $('#piper-voice-select');
const piperQualitySelect = $('#piper-quality-select');
const piperControls = $('#piper-controls');
const piperDownloadBtn = $('#piper-download-btn');
const piperStatus = $('#piper-status');
const piperProgressFill = $('#piper-progress-fill');
const piperStatusText = $('#piper-status-text');
const textPanel = $('#text-panel');
const textPanelContent = $('#text-panel-content');
const toggleTextPanelBtn = $('#toggle-textpanel');
const voiceModeBtns = document.querySelectorAll('.voice-mode-btn');

// Available quality levels per Piper voice
const PIPER_VOICE_QUALITIES = {
  'en_US-amy': ['low', 'medium'],
  'en_US-lessac': ['low', 'medium', 'high'],
  'en_US-ryan': ['low', 'medium', 'high'],
  'en_US-john': ['medium'],
  'en_GB-alba': ['medium'],
  'en_GB-alan': ['low', 'medium'],
};

function updatePiperQualityOptions() {
  const qualities = PIPER_VOICE_QUALITIES[state.piperVoiceName] || ['medium'];
  piperQualitySelect.innerHTML = qualities.map(q =>
    `<option value="${q}"${q === state.piperQuality ? ' selected' : ''}>${q.charAt(0).toUpperCase() + q.slice(1)}</option>`
  ).join('');
  // If current quality isn't available for this voice, pick the best available
  if (!qualities.includes(state.piperQuality)) {
    state.piperQuality = qualities[qualities.length - 1];
    piperQualitySelect.value = state.piperQuality;
  }
  state.piperVoiceId = `${state.piperVoiceName}-${state.piperQuality}`;
}

// ── IndexedDB Storage ──
const DB_NAME = 'focused_reading';
const DB_VERSION = 1;

function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('books')) {
        db.createObjectStore('books', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('positions')) {
        db.createObjectStore('positions', { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function dbPut(storeName, data) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).put(data);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function dbGet(storeName, key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const request = tx.objectStore(storeName).get(key);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
}

async function dbGetAll(storeName) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const request = tx.objectStore(storeName).getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function dbDelete(storeName, key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function saveBookData(book) {
  await dbPut('books', {
    id: book.id,
    title: book.title,
    author: book.author,
    coverBlob: book.coverBlob || null,
    chapters: book.chapters,
    totalWords: book.totalWords,
  });
}

async function loadAllBooks() {
  const rows = await dbGetAll('books');
  return rows.map(row => ({
    ...row,
    cover: row.coverBlob ? URL.createObjectURL(new Blob([row.coverBlob])) : null,
  }));
}

async function deleteBookData(id) {
  await dbDelete('books', id);
  await dbDelete('positions', id);
}

async function saveReadingPosition() {
  if (!state.currentBook) return;
  await dbPut('positions', {
    id: state.currentBook.id,
    chapter: state.currentChapter,
    word: state.currentWord,
    wpm: state.wpm,
  });
}

async function loadReadingPosition(id) {
  return await dbGet('positions', id);
}

// ── Browser Voice (Web Speech API) ──
const synth = window.speechSynthesis;

const BROWSER_VOICE_ALLOW = new Set(['Samantha', 'Daniel']);

function populateVoices() {
  const voices = synth.getVoices();
  voiceSelect.innerHTML = '';
  const allowed = voices.filter(v => BROWSER_VOICE_ALLOW.has(v.name));
  allowed.forEach(voice => {
    const opt = document.createElement('option');
    opt.value = voice.name;
    opt.textContent = `${voice.name} (${voice.lang})`;
    if (voice.default) opt.selected = true;
    voiceSelect.appendChild(opt);
  });
  if (allowed.length > 0 && !state.selectedVoice) {
    state.selectedVoice = allowed[0];
  }
}

synth.onvoiceschanged = populateVoices;
populateVoices();

function getSelectedVoice() {
  const voices = synth.getVoices();
  const name = voiceSelect.value;
  return voices.find(v => v.name === name) || voices[0] || null;
}

function wpmToRate(wpm) {
  return Math.max(0.5, Math.min(4, wpm / 160));
}

// Build a sentence string from chapter words starting at wordIndex.
function collectSentence(chapter, startWord) {
  const words = chapter.words;
  let end = startWord;
  const max = Math.min(startWord + 50, words.length);
  for (let i = startWord; i < max; i++) {
    end = i;
    if (words[i].match(/[.!?;]["'\u201d\u2019)]*$/)) {
      break;
    }
  }
  const sentenceWords = words.slice(startWord, end + 1);
  return { text: sentenceWords.join(' '), wordCount: sentenceWords.length };
}

// ── Browser Voice Playback ──
function browserVoicePlay() {
  if (!state.playing || state.voiceMode !== 'browser') return;
  const book = state.currentBook;
  if (!book) return;
  const chapter = book.chapters[state.currentChapter];
  if (!chapter) return;

  if (state.currentWord >= chapter.words.length) {
    if (state.currentChapter < book.chapters.length - 1) {
      state.currentChapter++;
      state.currentWord = 0;
      renderChapterList();
      browserVoicePlay();
      return;
    } else {
      stop();
      wordEl.textContent = '\u2014 End \u2014';
      return;
    }
  }

  const { text, wordCount } = collectSentence(chapter, state.currentWord);
  const sentenceStartWord = state.currentWord;

  const utterance = new SpeechSynthesisUtterance(text);
  utterance.voice = getSelectedVoice();
  utterance.rate = wpmToRate(state.wpm);

  let wordBoundaryIndex = 0;
  utterance.onboundary = (e) => {
    if (e.name === 'word') {
      state.currentWord = sentenceStartWord + wordBoundaryIndex;
      showCurrentWord();
      wordBoundaryIndex++;
    }
  };

  utterance.onend = () => {
    if (!state.playing) return;
    state.currentWord = sentenceStartWord + wordCount;
    showCurrentWord();
    browserVoicePlay();
  };

  utterance.onerror = (e) => {
    if (e.error === 'canceled' || e.error === 'interrupted') return;
    console.error('Speech error:', e.error);
    stop();
  };

  synth.speak(utterance);
}

function browserVoiceStop() {
  synth.cancel();
}

// ── Piper TTS Playback ──
function piperPlaybackRate() {
  return Math.max(0.5, Math.min(3, state.wpm / 150));
}

function showPiperStatus(msg, pct) {
  piperStatus.classList.remove('hidden');
  piperStatusText.textContent = msg;
  if (pct !== undefined) {
    piperProgressFill.style.width = pct + '%';
  }
}

function hidePiperStatus() {
  piperStatus.classList.add('hidden');
  piperProgressFill.style.width = '0%';
}

async function updatePiperDownloadBtn() {
  try {
    const stored = await piperStored();
    const isDownloaded = stored.includes(state.piperVoiceId);
    state.piperReady = isDownloaded;
    piperDownloadBtn.textContent = isDownloaded ? 'Ready' : 'Download Voice';
    piperDownloadBtn.classList.toggle('ready', isDownloaded);
    piperDownloadBtn.disabled = isDownloaded;

    // Update dropdown labels with download status
    for (const opt of piperVoiceSelect.options) {
      const label = opt.dataset.label;
      const qualities = PIPER_VOICE_QUALITIES[opt.value] || ['medium'];
      const anyDownloaded = qualities.some(q => stored.includes(`${opt.value}-${q}`));
      opt.textContent = anyDownloaded ? `${label} \u2713` : label;
    }
  } catch (err) {
    piperDownloadBtn.textContent = 'Error loading';
    piperDownloadBtn.disabled = true;
    state.piperReady = false;
  }
}

async function downloadPiperVoice() {
  piperDownloadBtn.disabled = true;
  piperDownloadBtn.textContent = 'Downloading...';
  showPiperStatus('Loading Piper engine...', 0);

  try {
    showPiperStatus('Downloading voice model...', 0);

    await piperDownloadWithProgress(state.piperVoiceId, (progress) => {
      if (progress.total) {
        const pct = Math.round((progress.loaded / progress.total) * 100);
        const sizeMB = (progress.total / 1024 / 1024).toFixed(0);
        const loadedMB = (progress.loaded / 1024 / 1024).toFixed(0);
        showPiperStatus(`Downloading: ${loadedMB}/${sizeMB} MB`, pct);
      }
    });

    state.piperReady = true;
    piperDownloadBtn.textContent = 'Ready';
    piperDownloadBtn.classList.add('ready');
    piperDownloadBtn.disabled = true;
    showPiperStatus('Voice ready!', 100);
    setTimeout(hidePiperStatus, 2000);
  } catch (err) {
    console.error('Piper download error:', err);
    piperDownloadBtn.textContent = 'Retry Download';
    piperDownloadBtn.disabled = false;
    showPiperStatus('Download failed: ' + err.message, 0);
    state.piperReady = false;
  }
}

// Prefetch queue: each entry has { wordStart, wordCount, audioReady }
// audioReady is a promise that resolves to { audio, blobUrl } — fully decoded and ready to play
let piperPrefetchQueue = [];

function piperMakeAudioReady(text) {
  // Chain: predict in worker → create Audio → wait for decode — all as one promise
  return piperPredict(text, state.piperVoiceId).then(wav => {
    const blobUrl = URL.createObjectURL(wav);
    const audio = new Audio(blobUrl);
    audio.playbackRate = piperPlaybackRate();
    audio.preload = 'auto';
    return new Promise((resolve, reject) => {
      audio.addEventListener('canplaythrough', () => resolve({ audio, blobUrl }), { once: true });
      audio.addEventListener('error', () => { URL.revokeObjectURL(blobUrl); reject(new Error('Audio decode error')); }, { once: true });
      audio.load();
    });
  });
}

function piperPrefetchAhead(chapter, nextWordStart) {
  piperPrefetchQueue = piperPrefetchQueue.filter(p => p.wordStart >= nextWordStart);

  let wordPos = nextWordStart;
  while (piperPrefetchQueue.length < 2 && wordPos < chapter.words.length) {
    if (piperPrefetchQueue.some(p => p.wordStart === wordPos)) {
      const existing = piperPrefetchQueue.find(p => p.wordStart === wordPos);
      wordPos = existing.wordStart + existing.wordCount;
      continue;
    }
    const { text, wordCount } = collectSentence(chapter, wordPos);
    piperPrefetchQueue.push({
      wordStart: wordPos,
      wordCount,
      audioReady: piperMakeAudioReady(text),
    });
    wordPos += wordCount;
  }
}

async function piperVoicePlay() {
  if (!state.playing || state.voiceMode !== 'piper') return;
  state.piperAbort = false;

  if (!state.piperReady) {
    showPiperStatus('Voice not downloaded. Click "Download Voice" first.', 0);
    stop();
    return;
  }

  const book = state.currentBook;
  if (!book) return;
  const chapter = book.chapters[state.currentChapter];
  if (!chapter) return;

  if (state.currentWord >= chapter.words.length) {
    if (state.currentChapter < book.chapters.length - 1) {
      state.currentChapter++;
      state.currentWord = 0;
      renderChapterList();
      piperPrefetchQueue = [];
      piperVoicePlay();
      return;
    } else {
      stop();
      wordEl.textContent = '\u2014 End \u2014';
      return;
    }
  }

  const { text, wordCount } = collectSentence(chapter, state.currentWord);
  const sentenceStartWord = state.currentWord;

  try {
    // Get a ready-to-play Audio: from prefetch queue or generate fresh
    let audio, blobUrl;
    const prefetchIdx = piperPrefetchQueue.findIndex(p => p.wordStart === sentenceStartWord);
    if (prefetchIdx !== -1) {
      ({ audio, blobUrl } = await piperPrefetchQueue[prefetchIdx].audioReady);
      piperPrefetchQueue.splice(prefetchIdx, 1);
    } else {
      piperPrefetchQueue = [];
      ({ audio, blobUrl } = await piperMakeAudioReady(text));
    }

    if (state.piperAbort || !state.playing) {
      URL.revokeObjectURL(blobUrl);
      return;
    }

    // Prefetch next 2 sentences while this one plays
    piperPrefetchAhead(chapter, sentenceStartWord + wordCount);

    audio.playbackRate = piperPlaybackRate();
    state.piperAudio = audio;

    await new Promise((resolve, reject) => {
      const duration = audio.duration / audio.playbackRate;
      const interval = (duration / wordCount) * 1000;
      let wordIdx = 0;

      state.piperWordTimer = setInterval(() => {
        if (wordIdx < wordCount) {
          state.currentWord = sentenceStartWord + wordIdx;
          showCurrentWord();
          wordIdx++;
        }
      }, interval);

      audio.addEventListener('ended', () => {
        clearInterval(state.piperWordTimer);
        state.piperWordTimer = null;
        URL.revokeObjectURL(blobUrl);
        resolve();
      });

      audio.addEventListener('error', (e) => {
        clearInterval(state.piperWordTimer);
        URL.revokeObjectURL(blobUrl);
        reject(new Error('Audio playback error'));
      });

      // Audio is already decoded — play immediately
      audio.play().catch(reject);
    });

    if (!state.playing || state.piperAbort) return;
    state.currentWord = sentenceStartWord + wordCount;
    showCurrentWord();
    piperVoicePlay();
  } catch (err) {
    if (state.piperAbort) return;
    console.error('Piper TTS error:', err);
    showPiperStatus('Speech error: ' + err.message, 0);
    stop();
  }
}

function piperVoiceStop() {
  state.piperAbort = true;
  piperPrefetchQueue = [];
  clearInterval(state.piperWordTimer);
  state.piperWordTimer = null;
  if (state.piperAudio) {
    state.piperAudio.pause();
    state.piperAudio.src = '';
    state.piperAudio = null;
  }
}

// ── Voice mode helpers ──
function voicePlay() {
  if (state.voiceMode === 'browser') browserVoicePlay();
  else if (state.voiceMode === 'piper') piperVoicePlay();
}

function voiceStop() {
  browserVoiceStop();
  piperVoiceStop();
}

function isVoiceActive() {
  return state.voiceMode !== 'off';
}

function setVoiceMode(mode) {
  const wasPlaying = state.playing;
  if (wasPlaying) {
    if (state.voiceMode === 'browser') { clearTimeout(state.timer); browserVoiceStop(); }
    else if (state.voiceMode === 'piper') piperVoiceStop();
    else clearTimeout(state.timer);
  }

  state.voiceMode = mode;

  // Update UI buttons
  voiceModeBtns.forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mode === mode);
  });

  // Show/hide dropdowns
  voiceSelect.classList.toggle('hidden', mode !== 'browser');
  piperControls.classList.toggle('hidden', mode !== 'piper');

  if (mode === 'piper') {
    updatePiperQualityOptions();
    updatePiperDownloadBtn();
  } else {
    hidePiperStatus();
  }

  if (wasPlaying) {
    if (mode === 'off') tick();
    else voicePlay();
  }
}

// ── EPUB Parsing ──
async function parseEpub(arrayBuffer) {
  const zip = await JSZip.loadAsync(arrayBuffer);

  const containerXml = await zip.file('META-INF/container.xml').async('text');
  const containerDoc = new DOMParser().parseFromString(containerXml, 'application/xml');
  const opfPath = containerDoc.querySelector('rootfile').getAttribute('full-path');
  const opfDir = opfPath.substring(0, opfPath.lastIndexOf('/') + 1);

  const opfXml = await zip.file(opfPath).async('text');
  const opfDoc = new DOMParser().parseFromString(opfXml, 'application/xml');

  const getText = (tag) => {
    const el = opfDoc.querySelector(tag) || opfDoc.getElementsByTagNameNS('http://purl.org/dc/elements/1.1/', tag.replace('dc\\:', ''))[0];
    return el ? el.textContent.trim() : '';
  };
  const title = getText('dc\\:title') || getText('title') || 'Unknown Title';
  const author = getText('dc\\:creator') || getText('creator') || 'Unknown Author';

  let cover = null;
  let coverBlob = null;
  const coverMeta = opfDoc.querySelector('meta[name="cover"]');
  if (coverMeta) {
    const coverId = coverMeta.getAttribute('content');
    const coverItem = opfDoc.querySelector(`item[id="${coverId}"]`);
    if (coverItem) {
      const coverHref = coverItem.getAttribute('href');
      const coverPath = opfDir + coverHref;
      const coverFile = zip.file(coverPath);
      if (coverFile) {
        coverBlob = await coverFile.async('arraybuffer');
        cover = URL.createObjectURL(new Blob([coverBlob]));
      }
    }
  }
  if (!cover) {
    const coverItem = opfDoc.querySelector('item[properties="cover-image"]');
    if (coverItem) {
      const coverHref = coverItem.getAttribute('href');
      const coverPath = opfDir + coverHref;
      const coverFile = zip.file(coverPath);
      if (coverFile) {
        coverBlob = await coverFile.async('arraybuffer');
        cover = URL.createObjectURL(new Blob([coverBlob]));
      }
    }
  }

  const spineItems = [...opfDoc.querySelectorAll('spine itemref')];
  const manifest = {};
  opfDoc.querySelectorAll('manifest item').forEach(item => {
    manifest[item.getAttribute('id')] = item.getAttribute('href');
  });

  const tocTitles = await parseToc(zip, opfDoc, opfDir, manifest);

  const chapters = [];
  for (const itemref of spineItems) {
    const idref = itemref.getAttribute('idref');
    const href = manifest[idref];
    if (!href) continue;

    const filePath = opfDir + href;
    const file = zip.file(filePath);
    if (!file) continue;

    const html = await file.async('text');
    const doc = new DOMParser().parseFromString(html, 'application/xhtml+xml');
    const text = extractText(doc.body);
    const words = text.split(/\s+/).filter(w => w.length > 0);

    if (words.length === 0) continue;

    const chapterHtml = sanitizeHtml(doc.body);
    const chapterTitle = tocTitles[href] || `Chapter ${chapters.length + 1}`;
    chapters.push({ title: chapterTitle, words, html: chapterHtml });
  }

  const totalWords = chapters.reduce((sum, ch) => sum + ch.words.length, 0);

  return { id: Date.now().toString(), title, author, cover, coverBlob, chapters, totalWords };
}

async function parseToc(zip, opfDoc, opfDir, manifest) {
  const titles = {};

  const navItem = opfDoc.querySelector('item[properties*="nav"]');
  if (navItem) {
    const navHref = navItem.getAttribute('href');
    const navFile = zip.file(opfDir + navHref);
    if (navFile) {
      const navHtml = await navFile.async('text');
      const navDoc = new DOMParser().parseFromString(navHtml, 'application/xhtml+xml');
      const links = navDoc.querySelectorAll('nav[*|type="toc"] a, nav.toc a, nav#toc a');
      links.forEach(a => {
        let href = a.getAttribute('href');
        if (href) {
          href = href.split('#')[0];
          titles[href] = a.textContent.trim();
        }
      });
      if (Object.keys(titles).length > 0) return titles;
    }
  }

  const ncxItem = opfDoc.querySelector('item[media-type="application/x-dtbncx+xml"]');
  if (ncxItem) {
    const ncxHref = ncxItem.getAttribute('href');
    const ncxFile = zip.file(opfDir + ncxHref);
    if (ncxFile) {
      const ncxXml = await ncxFile.async('text');
      const ncxDoc = new DOMParser().parseFromString(ncxXml, 'application/xml');
      ncxDoc.querySelectorAll('navPoint').forEach(np => {
        const label = np.querySelector('navLabel text');
        const content = np.querySelector('content');
        if (label && content) {
          let src = content.getAttribute('src');
          if (src) {
            src = src.split('#')[0];
            titles[src] = label.textContent.trim();
          }
        }
      });
    }
  }

  return titles;
}

function sanitizeHtml(node) {
  const clone = node.cloneNode(true);
  clone.querySelectorAll('script, style, svg, img').forEach(el => el.remove());
  return clone.innerHTML;
}

function extractText(node) {
  if (!node) return '';
  let text = '';
  for (const child of node.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) {
      text += child.textContent + ' ';
    } else if (child.nodeType === Node.ELEMENT_NODE) {
      const tag = child.tagName.toLowerCase();
      if (['script', 'style', 'svg'].includes(tag)) continue;
      text += extractText(child);
      if (['p', 'div', 'br', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li'].includes(tag)) {
        text += ' ';
      }
    }
  }
  return text;
}

// ── Library ──
function renderLibrary() {
  if (state.books.length === 0) {
    bookGrid.innerHTML = '<p class="empty-state">No books yet. Import an EPUB to get started.</p>';
    return;
  }
  bookGrid.innerHTML = state.books.map(book => `
    <div class="book-card" data-id="${book.id}">
      <button class="remove-btn" data-remove="${book.id}" title="Remove">&times;</button>
      <div class="cover">
        ${book.cover ? `<img src="${book.cover}" alt="Cover">` : '<span class="no-cover">📖</span>'}
      </div>
      <div class="title" title="${book.title}">${book.title}</div>
      <div class="author">${book.author}</div>
    </div>
  `).join('');
}

// ── Reader ──
async function openBook(book) {
  state.currentBook = book;
  state.playing = false;
  clearInterval(state.timer);
  voiceStop();

  const pos = await loadReadingPosition(book.id);
  if (pos) {
    state.currentChapter = Math.min(pos.chapter, book.chapters.length - 1);
    state.currentWord = pos.word;
    state.wpm = pos.wpm || 300;
  } else {
    state.currentChapter = 0;
    state.currentWord = 0;
  }

  wpmSlider.value = state.wpm;
  wpmValue.textContent = state.wpm;

  renderBookInfo();
  renderChapterList();
  showCurrentWord();
  updateProgress();
  updatePlayButton();
  if (state.textPanelOpen) renderTextPanel();

  libraryView.classList.remove('active');
  readerView.classList.add('active');
}

function renderBookInfo() {
  const book = state.currentBook;
  bookInfo.innerHTML = `
    ${book.cover ? `<img class="info-cover" src="${book.cover}" alt="Cover">` : ''}
    <h2>${book.title}</h2>
    <div class="info-author">${book.author}</div>
    <div class="info-meta">${book.totalWords.toLocaleString()} words &middot; ${book.chapters.length} chapters</div>
    <div class="info-meta">~${Math.round(book.totalWords / 250)} min read</div>
  `;
}

function renderChapterList() {
  const book = state.currentBook;
  chapterList.innerHTML = book.chapters.map((ch, i) => `
    <li class="${i === state.currentChapter ? 'active' : ''}" data-chapter="${i}">
      ${ch.title}
    </li>
  `).join('');
}

function showCurrentWord() {
  const book = state.currentBook;
  if (!book) return;
  const chapter = book.chapters[state.currentChapter];
  if (!chapter) return;

  if (state.currentWord >= chapter.words.length) {
    if (state.currentChapter < book.chapters.length - 1) {
      state.currentChapter++;
      state.currentWord = 0;
      renderChapterList();
      if (state.textPanelOpen) renderTextPanel();
      showCurrentWord();
      return;
    } else {
      stop();
      wordEl.textContent = '\u2014 End \u2014';
      return;
    }
  }

  wordEl.textContent = chapter.words[state.currentWord];
  chapterLabel.textContent = chapter.title;
  updateProgress();
  updateTextPanelHighlight();
}

function updateProgress() {
  const book = state.currentBook;
  if (!book) return;

  let wordsBefore = 0;
  for (let i = 0; i < state.currentChapter; i++) {
    wordsBefore += book.chapters[i].words.length;
  }
  wordsBefore += state.currentWord;
  const pct = (wordsBefore / book.totalWords) * 100;
  progressBar.style.width = pct + '%';
  posSlider.value = pct;
}

function seekToGlobalIndex(targetIdx) {
  const book = state.currentBook;
  let idx = 0;
  for (let i = 0; i < book.chapters.length; i++) {
    if (idx + book.chapters[i].words.length > targetIdx) {
      state.currentChapter = i;
      state.currentWord = targetIdx - idx;
      renderChapterList();
      showCurrentWord();
      return;
    }
    idx += book.chapters[i].words.length;
  }
  state.currentChapter = book.chapters.length - 1;
  state.currentWord = book.chapters[state.currentChapter].words.length - 1;
  renderChapterList();
  showCurrentWord();
}

// Unlock audio playback on user gesture so async TTS can play later
function unlockAudio() {
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const buf = ctx.createBuffer(1, 1, 22050);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(ctx.destination);
  src.start(0);
  ctx.resume();
}

function play() {
  if (state.playing) return;
  unlockAudio();
  state.playing = true;
  updatePlayButton();
  if (isVoiceActive()) {
    voicePlay();
  } else {
    tick();
  }
}

function stop() {
  state.playing = false;
  clearTimeout(state.timer);
  voiceStop();
  updatePlayButton();
  saveReadingPosition();
}

function tick() {
  if (!state.playing || isVoiceActive()) return;
  state.currentWord++;
  showCurrentWord();
  const delay = 60000 / state.wpm;
  state.timer = setTimeout(tick, delay);
}

function updatePlayButton() {
  playBtn.innerHTML = state.playing ? '&#9646;&#9646;' : '&#9654;';
}

function skipForward() {
  if (isVoiceActive() && state.playing) voiceStop();
  const chapter = state.currentBook.chapters[state.currentChapter];
  let target = state.currentWord;
  let found = false;
  for (let i = target + 1; i < Math.min(target + 30, chapter.words.length); i++) {
    if (chapter.words[i - 1].match(/[.!?]$/)) {
      target = i;
      found = true;
      break;
    }
  }
  if (!found) target = Math.min(state.currentWord + 10, chapter.words.length - 1);
  state.currentWord = target;
  showCurrentWord();
  if (isVoiceActive() && state.playing) voicePlay();
}

function skipBackward() {
  if (isVoiceActive() && state.playing) voiceStop();
  const chapter = state.currentBook.chapters[state.currentChapter];
  let target = state.currentWord;
  let found = false;
  for (let i = target - 2; i >= Math.max(0, target - 30); i--) {
    if (chapter.words[i].match(/[.!?]$/)) {
      target = i + 1;
      found = true;
      break;
    }
  }
  if (!found) target = Math.max(0, state.currentWord - 10);
  state.currentWord = target;
  showCurrentWord();
  if (isVoiceActive() && state.playing) voicePlay();
}

// ── Text Panel ──
function renderTextPanel() {
  const book = state.currentBook;
  if (!book) return;
  const chapter = book.chapters[state.currentChapter];
  if (!chapter) {
    textPanelContent.innerHTML = '';
    return;
  }
  if (chapter.html) {
    textPanelContent.innerHTML = chapter.html;
  } else {
    // Fallback for books imported before html was stored
    const p = document.createElement('p');
    p.textContent = chapter.words.join(' ');
    textPanelContent.innerHTML = '';
    textPanelContent.appendChild(p);
  }
  wrapWordsInPanel();
  updateTextPanelHighlight();
}

function wrapWordsInPanel() {
  let wordIdx = 0;
  const walker = document.createTreeWalker(textPanelContent, NodeFilter.SHOW_TEXT);
  const replacements = [];
  let node;
  while ((node = walker.nextNode())) {
    const text = node.textContent;
    const words = text.split(/(\s+)/);
    if (words.every(w => w.trim() === '')) continue;
    const frag = document.createDocumentFragment();
    for (const part of words) {
      if (part.trim() === '') {
        frag.appendChild(document.createTextNode(part));
      } else {
        const span = document.createElement('span');
        span.dataset.wordIdx = wordIdx;
        span.textContent = part;
        frag.appendChild(span);
        wordIdx++;
      }
    }
    replacements.push({ node, frag });
  }
  for (const { node, frag } of replacements) {
    node.parentNode.replaceChild(frag, node);
  }
}

function updateTextPanelHighlight() {
  if (!state.textPanelOpen) return;
  const prev = textPanelContent.querySelector('.current-word');
  if (prev) prev.classList.remove('current-word');
  const span = textPanelContent.querySelector(`[data-word-idx="${state.currentWord}"]`);
  if (span) {
    span.classList.add('current-word');
    span.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
}

function toggleTextPanel() {
  state.textPanelOpen = !state.textPanelOpen;
  textPanel.classList.toggle('collapsed', !state.textPanelOpen);
  if (state.textPanelOpen) {
    renderTextPanel();
  }
}

// ── Events ──
helpBtn.addEventListener('click', () => helpModal.classList.remove('hidden'));
helpClose.addEventListener('click', () => helpModal.classList.add('hidden'));
helpModal.addEventListener('click', (e) => {
  if (e.target === helpModal) helpModal.classList.add('hidden');
});

epubInput.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const buf = await file.arrayBuffer();
    const book = await parseEpub(buf);
    state.books.push(book);
    await saveBookData(book);
    renderLibrary();
  } catch (err) {
    console.error('Failed to parse EPUB:', err);
    alert('Failed to parse EPUB file. Please try another.');
  }
  epubInput.value = '';
});

bookGrid.addEventListener('click', async (e) => {
  const removeBtn = e.target.closest('[data-remove]');
  if (removeBtn) {
    e.stopPropagation();
    const id = removeBtn.dataset.remove;
    state.books = state.books.filter(b => b.id !== id);
    await deleteBookData(id);
    renderLibrary();
    return;
  }

  const card = e.target.closest('.book-card');
  if (card) {
    const id = card.dataset.id;
    const book = state.books.find(b => b.id === id);
    if (book) openBook(book);
  }
});

playBtn.addEventListener('click', () => {
  state.playing ? stop() : play();
});

prevBtn.addEventListener('click', skipBackward);
nextBtn.addEventListener('click', skipForward);

wpmSlider.addEventListener('input', (e) => {
  state.wpm = parseInt(e.target.value);
  wpmValue.textContent = state.wpm;
  if (state.playing) {
    if (state.voiceMode === 'browser') {
      browserVoiceStop();
      browserVoicePlay();
    } else if (state.voiceMode === 'piper' && state.piperAudio) {
      state.piperAudio.playbackRate = piperPlaybackRate();
    }
  }
});

posSlider.addEventListener('input', (e) => {
  if (isVoiceActive() && state.playing) voiceStop();
  const pct = parseFloat(e.target.value) / 100;
  const targetIdx = Math.floor(pct * state.currentBook.totalWords);
  seekToGlobalIndex(targetIdx);
  if (isVoiceActive() && state.playing) voicePlay();
});

chapterList.addEventListener('click', (e) => {
  const li = e.target.closest('li[data-chapter]');
  if (li) {
    if (isVoiceActive() && state.playing) voiceStop();
    state.currentChapter = parseInt(li.dataset.chapter);
    state.currentWord = 0;
    renderChapterList();
    if (state.textPanelOpen) renderTextPanel();
    showCurrentWord();
    if (isVoiceActive() && state.playing) voicePlay();
  }
});

// Voice mode selector
voiceModeBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    setVoiceMode(btn.dataset.mode);
  });
});

voiceSelect.addEventListener('change', () => {
  if (state.voiceMode === 'browser' && state.playing) {
    browserVoiceStop();
    browserVoicePlay();
  }
});

piperVoiceSelect.addEventListener('change', async () => {
  const wasPlaying = state.playing && state.voiceMode === 'piper';
  if (wasPlaying) piperVoiceStop();
  state.piperVoiceName = piperVoiceSelect.value;
  updatePiperQualityOptions();
  state.piperReady = false;
  piperResetSession();
  await updatePiperDownloadBtn();
  if (wasPlaying && state.piperReady) piperVoicePlay();
});

piperQualitySelect.addEventListener('change', async () => {
  const wasPlaying = state.playing && state.voiceMode === 'piper';
  if (wasPlaying) piperVoiceStop();
  state.piperQuality = piperQualitySelect.value;
  state.piperVoiceId = `${state.piperVoiceName}-${state.piperQuality}`;
  state.piperReady = false;
  piperResetSession();
  await updatePiperDownloadBtn();
  if (wasPlaying && state.piperReady) piperVoicePlay();
});

piperDownloadBtn.addEventListener('click', () => {
  downloadPiperVoice();
});

toggleSidebarBtn.addEventListener('click', () => {
  sidebar.classList.toggle('collapsed');
});

toggleTextPanelBtn.addEventListener('click', toggleTextPanel);

backBtn.addEventListener('click', () => {
  stop();
  saveReadingPosition();
  readerView.classList.remove('active');
  libraryView.classList.add('active');
});

// Keyboard shortcuts
document.addEventListener('keydown', (e) => {
  if (!readerView.classList.contains('active')) return;
  if (e.code === 'Space') { e.preventDefault(); state.playing ? stop() : play(); }
  if (e.code === 'ArrowRight') { e.preventDefault(); skipForward(); }
  if (e.code === 'ArrowLeft') { e.preventDefault(); skipBackward(); }
  if (e.code === 'ArrowUp') { e.preventDefault(); wpmSlider.value = Math.min(1000, state.wpm + 25); wpmSlider.dispatchEvent(new Event('input')); }
  if (e.code === 'ArrowDown') { e.preventDefault(); wpmSlider.value = Math.max(100, state.wpm - 25); wpmSlider.dispatchEvent(new Event('input')); }
  if (e.code === 'KeyT') { e.preventDefault(); toggleTextPanel(); }
  if (e.code === 'KeyV') {
    e.preventDefault();
    // Cycle voice modes: off -> browser -> piper -> off
    const modes = ['off', 'browser', 'piper'];
    const nextIdx = (modes.indexOf(state.voiceMode) + 1) % modes.length;
    setVoiceMode(modes[nextIdx]);
  }
});

// ── Init ──
async function init() {
  state.books = await loadAllBooks();
  renderLibrary();
}

init();
