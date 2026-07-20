// Web Speech API ラッパー（音声認識 + 読み上げ）
// 非対応ブラウザではテキスト入力のみのモードにフォールバックする

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

export const sttSupported = !!SR;
export const ttsSupported = 'speechSynthesis' in window;

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
