// localStorage ラッパー（APIキー・設定・復習ノート・セッション履歴）

const KEYS = {
  apiKey: 'eikaiwa.apiKey',
  settings: 'eikaiwa.settings',
  notes: 'eikaiwa.notes',
  sessions: 'eikaiwa.sessions',
};

function readJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function writeJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // ストレージ満杯などは黙って無視（アプリ動作は継続）
  }
}

export function getApiKey() {
  return localStorage.getItem(KEYS.apiKey) || '';
}

export function setApiKey(key) {
  localStorage.setItem(KEYS.apiKey, key.trim());
}

const DEFAULT_SETTINGS = {
  level: 'beginner', // beginner | intermediate
  rate: 0.95, // 読み上げ速度
  voiceName: '', // 空なら自動選択
  feedbackDetail: 'thorough', // thorough(しっかり) | light(軽め)
};

export function getSettings() {
  return { ...DEFAULT_SETTINGS, ...readJSON(KEYS.settings, {}) };
}

export function saveSettings(patch) {
  writeJSON(KEYS.settings, { ...getSettings(), ...patch });
}

// 復習ノート: [{en, ja, addedAt}]
export function getNotes() {
  return readJSON(KEYS.notes, []);
}

export function addNotes(phrases) {
  const notes = getNotes();
  const existing = new Set(notes.map((n) => n.en));
  for (const p of phrases) {
    if (p && p.en && !existing.has(p.en)) {
      notes.unshift({ en: p.en, ja: p.ja || '', addedAt: Date.now() });
      existing.add(p.en);
    }
  }
  writeJSON(KEYS.notes, notes.slice(0, 200));
}

export function removeNote(en) {
  writeJSON(
    KEYS.notes,
    getNotes().filter((n) => n.en !== en),
  );
}

// セッション履歴（直近20件のサマリーのみ）
export function getSessions() {
  return readJSON(KEYS.sessions, []);
}

export function addSession(summary) {
  const sessions = getSessions();
  sessions.unshift({ ...summary, endedAt: Date.now() });
  writeJSON(KEYS.sessions, sessions.slice(0, 20));
}
