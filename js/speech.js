// Web Speech API ラッパー（音声認識 + 読み上げ）
// 非対応ブラウザではテキスト入力のみのモードにフォールバックする

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

export const sttSupported = !!SR;
export const ttsSupported = 'speechSynthesis' in window;

// iOS判定（iPadOSはMacを名乗るためタッチ点数でも判定）
export const isIOS =
  /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

export const recorderSupported =
  !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder);

// ---- 音声認識 ----

export function createRecognizer({ onInterim, onResult, onEnd, onError }) {
  if (!SR) return null;
  const rec = new SR();
  rec.lang = 'en-US';
  rec.interimResults = true;
  rec.continuous = false;
  rec.maxAlternatives = 1;

  let finalText = '';

  rec.onresult = (e) => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const t = e.results[i][0].transcript;
      if (e.results[i].isFinal) finalText += t;
      else interim += t;
    }
    if (interim && onInterim) onInterim(finalText + interim);
    if (finalText && onInterim) onInterim(finalText);
  };

  rec.onend = () => {
    const text = finalText.trim();
    finalText = '';
    if (text && onResult) onResult(text);
    if (onEnd) onEnd();
  };

  rec.onerror = (e) => {
    finalText = '';
    if (onError) onError(e.error);
  };

  return {
    start() {
      finalText = '';
      try {
        rec.start();
      } catch {
        // すでに開始済みの二重startは無視
      }
    },
    stop() {
      try {
        rec.stop();
      } catch {
        /* noop */
      }
    },
    abort() {
      try {
        rec.abort();
      } catch {
        /* noop */
      }
    },
  };
}

// ---- 読み上げ ----

let cachedVoices = [];

function loadVoices() {
  if (!ttsSupported) return;
  cachedVoices = speechSynthesis.getVoices();
}

if (ttsSupported) {
  loadVoices();
  speechSynthesis.onvoiceschanged = loadVoices;
}

export function getEnglishVoices() {
  return cachedVoices.filter((v) => v.lang && v.lang.toLowerCase().startsWith('en'));
}

function pickVoice(preferredName) {
  const voices = getEnglishVoices();
  if (!voices.length) return null;
  if (preferredName) {
    const match = voices.find((v) => v.name === preferredName);
    if (match) return match;
  }
  // 自然な声を優先的に選ぶ
  const preferred = [
    'Google US English',
    'Samantha',
    'Microsoft Aria Online (Natural) - English (United States)',
    'Microsoft Jenny Online (Natural) - English (United States)',
  ];
  for (const name of preferred) {
    const v = voices.find((x) => x.name === name);
    if (v) return v;
  }
  const us = voices.find((v) => v.lang === 'en-US');
  return us || voices[0];
}

// iOS Safariは「ユーザー操作起点でないと音が出ない」ため、
// ボタンタップ時に一度だけ空の発話をして解錠する
let unlocked = false;
export function unlockTTS() {
  if (!ttsSupported || unlocked) return;
  const u = new SpeechSynthesisUtterance('');
  u.volume = 0;
  speechSynthesis.speak(u);
  unlocked = true;
}

export function speak(text, { rate = 0.95, voiceName = '', onStart, onEnd } = {}) {
  if (!ttsSupported || !text) {
    if (onEnd) onEnd();
    return;
  }
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'en-US';
  u.rate = rate;
  const voice = pickVoice(voiceName);
  if (voice) u.voice = voice;
  if (onStart) u.onstart = onStart;
  if (onEnd) {
    u.onend = onEnd;
    u.onerror = onEnd;
  }
  speechSynthesis.speak(u);
}

export function stopSpeaking() {
  if (ttsSupported) speechSynthesis.cancel();
}

// ---- 録音（SpeechRecognitionが使えない/不安定な端末向け。音声はGeminiで文字起こし） ----

function pickMimeType() {
  const candidates = [
    'audio/mp4', // iOS Safari (AAC)
    'audio/webm;codecs=opus', // Chrome/Edge/Android
    'audio/webm',
    'audio/ogg;codecs=opus', // Firefox
  ];
  for (const t of candidates) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported(t)) return t;
  }
  return '';
}

export async function createAudioRecorder() {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const mimeType = pickMimeType();
  const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  const chunks = [];
  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) chunks.push(e.data);
  };
  recorder.start();

  const cleanup = () => stream.getTracks().forEach((t) => t.stop());

  return {
    mimeType: mimeType || 'audio/webm',
    stop() {
      return new Promise((resolve) => {
        recorder.onstop = () => {
          cleanup();
          resolve(new Blob(chunks, { type: mimeType || 'audio/webm' }));
        };
        recorder.stop();
      });
    },
    cancel() {
      recorder.onstop = null;
      try {
        recorder.stop();
      } catch {
        /* noop */
      }
      cleanup();
    },
  };
}

export function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

// 録音(webm/mp4/ogg)はGeminiのinlineDataが受け付けないため、
// Web Audio APIでデコードしてmono/16kHzのWAV(PCM16)に変換する。
// Geminiはaudio/wavを確実に受け付ける。
function writeStr(view, offset, str) {
  for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
}

function encodeWav(audioBuffer, targetRate) {
  const numCh = audioBuffer.numberOfChannels;
  const srcLen = audioBuffer.length;
  const srcRate = audioBuffer.sampleRate;

  // モノラルにダウンミックス
  const mono = new Float32Array(srcLen);
  for (let c = 0; c < numCh; c++) {
    const data = audioBuffer.getChannelData(c);
    for (let i = 0; i < srcLen; i++) mono[i] += data[i] / numCh;
  }

  // 16kHzへ線形リサンプル(音声認識には十分・軽量)
  const ratio = targetRate / srcRate;
  const outLen = Math.max(1, Math.round(srcLen * ratio));
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const idx = i / ratio;
    const i0 = Math.floor(idx);
    const i1 = Math.min(i0 + 1, srcLen - 1);
    const f = idx - i0;
    out[i] = mono[i0] * (1 - f) + mono[i1] * f;
  }

  const buffer = new ArrayBuffer(44 + outLen * 2);
  const view = new DataView(buffer);
  writeStr(view, 0, 'RIFF');
  view.setUint32(4, 36 + outLen * 2, true);
  writeStr(view, 8, 'WAVE');
  writeStr(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, targetRate, true);
  view.setUint32(28, targetRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(view, 36, 'data');
  view.setUint32(40, outLen * 2, true);
  let off = 44;
  for (let i = 0; i < outLen; i++) {
    const s = Math.max(-1, Math.min(1, out[i]));
    view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    off += 2;
  }
  return buffer;
}

export async function blobToWavBase64(blob) {
  const arrayBuf = await blob.arrayBuffer();
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) throw new Error('no AudioContext');
  const ctx = new Ctx();
  try {
    const audioBuffer = await ctx.decodeAudioData(arrayBuf);
    const wav = encodeWav(audioBuffer, 16000);
    const base64 = await blobToBase64(new Blob([wav]));
    return { base64, mimeType: 'audio/wav' };
  } finally {
    if (ctx.close) ctx.close();
  }
}
