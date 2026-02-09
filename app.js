// ── State ──
const state = {
  books: [],          // { id, title, author, cover, chapters: [{ title, words }], totalWords }
  currentBook: null,
  currentChapter: 0,
  currentWord: 0,
  wpm: 300,
  playing: false,
  timer: null,
  voiceEnabled: false,
  selectedVoice: null,
};

// ── DOM refs ──
const $ = (sel) => document.querySelector(sel);
const libraryView = $('#library-view');
const readerView = $('#reader-view');
const bookGrid = $('#book-grid');
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
const voiceToggle = $('#voice-toggle');
const voiceSelect = $('#voice-select');

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

// ── Voice (Web Speech API) ──
const synth = window.speechSynthesis;

function populateVoices() {
  const voices = synth.getVoices();
  voiceSelect.innerHTML = '';
  // Prefer English voices, put them first
  const english = voices.filter(v => v.lang.startsWith('en'));
  const others = voices.filter(v => !v.lang.startsWith('en'));
  const sorted = [...english, ...others];
  sorted.forEach(voice => {
    const opt = document.createElement('option');
    opt.value = voice.name;
    opt.textContent = `${voice.name} (${voice.lang})`;
    if (voice.default) opt.selected = true;
    voiceSelect.appendChild(opt);
  });
  // Default to first English voice
  if (english.length > 0 && !state.selectedVoice) {
    state.selectedVoice = english[0];
  }
}

synth.onvoiceschanged = populateVoices;
populateVoices();

function getSelectedVoice() {
  const voices = synth.getVoices();
  const name = voiceSelect.value;
  return voices.find(v => v.name === name) || voices[0] || null;
}

// Map WPM to speech rate. Normal speech ~150 WPM = rate 1.0
// SpeechSynthesis rate range: 0.1 to 10
function wpmToRate(wpm) {
  return Math.max(0.5, Math.min(4, wpm / 160));
}

// Build a sentence string from chapter words starting at wordIndex.
// Returns { text, wordCount } — collects words until sentence-ending punctuation
// or a max of ~40 words for manageable chunks.
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

// Speak from the current position, sentence by sentence.
// Uses boundary events to sync the visual word display.
function voicePlay() {
  if (!state.playing || !state.voiceEnabled) return;
  const book = state.currentBook;
  if (!book) return;
  const chapter = book.chapters[state.currentChapter];
  if (!chapter) return;

  if (state.currentWord >= chapter.words.length) {
    // Move to next chapter
    if (state.currentChapter < book.chapters.length - 1) {
      state.currentChapter++;
      state.currentWord = 0;
      renderChapterList();
      voicePlay();
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

  // Track word position within the sentence via boundary events
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
    // Advance past this sentence
    state.currentWord = sentenceStartWord + wordCount;
    showCurrentWord();
    // Speak next sentence
    voicePlay();
  };

  utterance.onerror = (e) => {
    if (e.error === 'canceled' || e.error === 'interrupted') return;
    console.error('Speech error:', e.error);
    stop();
  };

  synth.speak(utterance);
}

function voiceStop() {
  synth.cancel();
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

    const chapterTitle = tocTitles[href] || `Chapter ${chapters.length + 1}`;
    chapters.push({ title: chapterTitle, words });
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

function play() {
  if (state.playing) return;
  state.playing = true;
  updatePlayButton();
  if (state.voiceEnabled) {
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
  if (!state.playing || state.voiceEnabled) return;
  state.currentWord++;
  showCurrentWord();
  const delay = 60000 / state.wpm;
  state.timer = setTimeout(tick, delay);
}

function updatePlayButton() {
  playBtn.innerHTML = state.playing ? '&#9646;&#9646;' : '&#9654;';
}

function skipForward() {
  if (state.voiceEnabled && state.playing) voiceStop();
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
  if (state.voiceEnabled && state.playing) voicePlay();
}

function skipBackward() {
  if (state.voiceEnabled && state.playing) voiceStop();
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
  if (state.voiceEnabled && state.playing) voicePlay();
}

// ── Events ──
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
  // If voice is playing, restart with new rate
  if (state.voiceEnabled && state.playing) {
    voiceStop();
    voicePlay();
  }
});

posSlider.addEventListener('input', (e) => {
  if (state.voiceEnabled && state.playing) voiceStop();
  const pct = parseFloat(e.target.value) / 100;
  const targetIdx = Math.floor(pct * state.currentBook.totalWords);
  seekToGlobalIndex(targetIdx);
  if (state.voiceEnabled && state.playing) voicePlay();
});

chapterList.addEventListener('click', (e) => {
  const li = e.target.closest('li[data-chapter]');
  if (li) {
    if (state.voiceEnabled && state.playing) voiceStop();
    state.currentChapter = parseInt(li.dataset.chapter);
    state.currentWord = 0;
    renderChapterList();
    showCurrentWord();
    if (state.voiceEnabled && state.playing) voicePlay();
  }
});

voiceToggle.addEventListener('click', () => {
  state.voiceEnabled = !state.voiceEnabled;
  voiceToggle.textContent = state.voiceEnabled ? 'Voice: On' : 'Voice: Off';
  voiceToggle.classList.toggle('active', state.voiceEnabled);

  if (state.playing) {
    if (state.voiceEnabled) {
      // Switch from timer to voice
      clearTimeout(state.timer);
      voicePlay();
    } else {
      // Switch from voice to timer
      voiceStop();
      tick();
    }
  }
});

voiceSelect.addEventListener('change', () => {
  if (state.voiceEnabled && state.playing) {
    voiceStop();
    voicePlay();
  }
});

toggleSidebarBtn.addEventListener('click', () => {
  sidebar.classList.toggle('collapsed');
});

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
  if (e.code === 'KeyV') { e.preventDefault(); voiceToggle.click(); }
});

// ── Init ──
async function init() {
  state.books = await loadAllBooks();
  renderLibrary();
}

init();
