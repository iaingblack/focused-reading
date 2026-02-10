// Web Worker for Piper TTS — runs ONNX inference off the main thread
let tts = null;
let requestId = 0;

async function loadTts() {
  if (tts) return tts;
  tts = await import('./piper-tts-web.js');
  return tts;
}

self.onmessage = async (e) => {
  const { type, id, voiceId, text } = e.data;

  if (type === 'predict') {
    try {
      const mod = await loadTts();
      const wav = await mod.predict({ text, voiceId });
      // Transfer the blob back to the main thread
      const buffer = await wav.arrayBuffer();
      self.postMessage({ type: 'predict', id, buffer }, [buffer]);
    } catch (err) {
      self.postMessage({ type: 'error', id, error: err.message });
    }
  } else if (type === 'download') {
    try {
      const mod = await loadTts();
      await mod.download(voiceId, (progress) => {
        self.postMessage({ type: 'download-progress', id, progress });
      });
      self.postMessage({ type: 'download-done', id });
    } catch (err) {
      self.postMessage({ type: 'error', id, error: err.message });
    }
  } else if (type === 'stored') {
    try {
      const mod = await loadTts();
      const list = await mod.stored();
      self.postMessage({ type: 'stored', id, list });
    } catch (err) {
      self.postMessage({ type: 'error', id, error: err.message });
    }
  } else if (type === 'reset') {
    // Reset the TTS singleton for voice switching
    try {
      const mod = await loadTts();
      if (mod.TtsSession) mod.TtsSession._instance = null;
      self.postMessage({ type: 'reset', id });
    } catch (err) {
      self.postMessage({ type: 'error', id, error: err.message });
    }
  }
};
