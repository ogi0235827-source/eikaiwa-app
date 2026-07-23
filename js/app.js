// 画面遷移・会話フロー・UI制御

import { FREE_TALK, SCENARIOS, getScenario } from './scenarios.js';
import * as store from './storage.js';
import * as speech from './speech.js';
import { chatTurn, sessionReview, GeminiError } from './gemini.js';

const APP_VERSION = '1.7';
const MOCK = new URLSearchParams(location.search).has('mock');

const $ = (id) => document.getElementById(id);

// ---- DOMヘルパー（textContentベースでXSS安全に組み立てる） ----
function h(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text != null) el.textContent = text;
  return el;
}

// ---- 画面遷移 ----
function showScreen(id) {
  document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
  $(id).classList.add('active');
  window.scrollTo(0, 0);
}

// ---- トースト ----
let toastTimer = null;
function toast(message, ms = 3200) {
  const el = $('toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), ms);
}

// ---- アプリ状態 ----
let settings = store.getSettings();
let session = null; // { scenario, history: [{role, text}], busy }
let recognizer = null;
let recording = false;

// ---- ホーム ----
function renderScenarioGrid() {
  const grid = $('scenario-grid');
  grid.textContent = '';
  for (const sc of SCENARIOS) {
    const card = h('button', 'scenario-card');
    card.append(h('span', 'sc-emoji', sc.emoji), h('span', 'sc-title', sc.title), h('span', 'sc-sub', sc.subtitle));
    card.addEventListener('click', () => startSession(sc.id));
    grid.append(card);
  }
}

function renderNotesCount() {
  const n = store.getNotes().length;
  $('notes-count').textContent = n ? `${n}フレーズ` : '';
}

function setLevelUI() {
  document.querySelectorAll('#level-toggle .seg-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.level === settings.level);
  });
}

// ---- 会話 ----
function setStatus(text, avatarState) {
  $('chat-status').textContent = text;
  const wrap = $('chat-avatar-wrap');
  wrap.classList.remove('speaking', 'thinking');
  if (avatarState) wrap.classList.add(avatarState);
}

function scrollLog() {
  const log = $('chat-log');
  log.scrollTop = log.scrollHeight;
}

function speakAndAnimate(text) {
  speech.speak(text, {
    rate: settings.rate,
    voiceName: settings.voiceName,
    onStart: () => setStatus('話しています…', 'speaking'),
    onEnd: () => setStatus('あなたの番です！', ''),
  });
}

function addAiBubble(text, ja) {
  const msg = h('div', 'msg ai');
  msg.append(h('div', 'bubble', text));
  if (ja) msg.append(h('div', 'bubble-ja', ja));
  const replay = h('button', 'replay-btn', '🔊 もう一度聞く');
  replay.addEventListener('click', () => speakAndAnimate(text));
  msg.append(replay);
  $('chat-log').append(msg);
  scrollLog();
}

function addUserBubble(text) {
  const msg = h('div', 'msg user');
  msg.append(h('div', 'bubble', text));
  $('chat-log').append(msg);
  scrollLog();
  return msg;
}

function attachFeedback(userMsg, fb) {
  if (!fb) return;
  const hasIssues = !!fb.has_issues;
  const chip = h(
    'button',
    `fb-chip ${hasIssues ? 'has-issues' : 'good'}`,
    hasIssues ? '✏️ 添削を見る' : `◎ ${fb.praise_ja || 'Good!'}`,
  );
  const card = h('div', 'fb-card');
  card.hidden = true;

  if (hasIssues && fb.corrected) {
    const row = h('div', 'fb-row');
    row.append(h('span', 'fb-label', '✅ 修正版'), h('div', 'fb-corrected', fb.corrected));
    card.append(row);
  }
  if (hasIssues && Array.isArray(fb.points) && fb.points.length) {
    const row = h('div', 'fb-row');
    row.append(h('span', 'fb-label', '📝 ポイント'));
    for (const p of fb.points) {
      const pt = h('div', 'fb-point');
      pt.append(h('span', 'fb-point-type', p.type || '指摘'), h('span', '', p.ja_explanation || ''));
      row.append(pt);
    }
    card.append(row);
  }
  if (fb.natural_alternative) {
    const row = h('div', 'fb-row');
    row.append(h('span', 'fb-label', '💡 ネイティブならこう言う'), h('div', 'fb-natural', `"${fb.natural_alternative}"`));
    card.append(row);
  }

  if (!card.children.length && !hasIssues) {
    // 指摘ゼロならチップのみ表示（カード不要）
    userMsg.append(chip);
    chip.style.pointerEvents = 'none';
    return;
  }

  chip.addEventListener('click', () => {
    card.hidden = !card.hidden;
    scrollLog();
  });
  userMsg.append(chip, card);
  scrollLog();
}

function addTyping() {
  const msg = h('div', 'msg ai');
  msg.id = 'typing-msg';
  const bubble = h('div', 'bubble');
  const dots = h('span', 'typing');
  dots.append(h('span'), h('span'), h('span'));
  bubble.append(dots);
  msg.append(bubble);
  $('chat-log').append(msg);
  scrollLog();
}

function removeTyping() {
  const el = $('typing-msg');
  if (el) el.remove();
}

function startSession(scenarioId) {
  if (!MOCK && !store.getApiKey()) {
    showScreen('screen-keyguide');
    return;
  }
  speech.unlockTTS(); // iOS対策: タップ起点で読み上げを解錠

  const scenario = getScenario(scenarioId);
  session = { scenario, history: [], busy: false };

  $('chat-log').textContent = '';
  $('chat-scenario-name').textContent = scenario.id === 'free' ? '· 自由会話' : `· ${scenario.title}`;
  $('interim-text').hidden = true;

  // 音声入力が使えない環境ならテキスト入力を初期表示
  const voiceRow = $('composer-voice');
  const textRow = $('composer-text');
  if (speech.sttSupported || speech.recorderSupported) {
    voiceRow.hidden = false;
    textRow.hidden = true;
  } else {
    voiceRow.hidden = true;
    textRow.hidden = false;
  }

  hideMicBanner();
  showScreen('screen-chat');

  // マイクがすでにブロック済みなら、最初から案内を出しておく
  if (navigator.permissions && navigator.permissions.query) {
    navigator.permissions
      .query({ name: 'microphone' })
      .then((st) => {
        if (st.state === 'denied') showMicBanner(micPermissionHelp());
      })
      .catch(() => {});
  }

  session.history.push({ role: 'ai', text: scenario.opening });
  addAiBubble(scenario.opening, scenario.openingJa);
  speakAndAnimate(scenario.opening);
}

async function sendUserMessage(text) {
  if (!session || session.busy || !text.trim()) return;
  const clean = text.trim();
  session.busy = true;
  $('btn-mic').disabled = true;

  hideMicBanner();
  const userMsg = addUserBubble(clean);
  session.history.push({ role: 'user', text: clean });
  setStatus('考えています…', 'thinking');
  addTyping();

  try {
    const result = await chatTurn({
      apiKey: store.getApiKey(),
      level: settings.level,
      feedbackDetail: settings.feedbackDetail,
      scenario: session.scenario,
      history: session.history,
    });
    removeTyping();
    session.history.push({ role: 'ai', text: result.reply });
    addAiBubble(result.reply);
    attachFeedback(userMsg, result.feedback);
    speakAndAnimate(result.reply);
  } catch (err) {
    removeTyping();
    setStatus('あなたの番です！', '');
    const message = err instanceof GeminiError ? err.message : `エラー: ${err?.message || err}`;
    // エラーは消えないバナーに全文表示（原因の切り分けができるように）
    showMicBanner(message);
    if (err instanceof GeminiError && err.code === 'invalid_key') {
      showScreen('screen-settings');
      loadSettingsUI();
    }
    // 失敗したユーザー発言は履歴から取り除き、再送できるようにする
    session.history.pop();
  } finally {
    session.busy = false;
    $('btn-mic').disabled = false;
  }
}

// ---- 会話画面の常設バナー（トーストと違い消えないので、対処法やエラー全文の表示に使う） ----
function showMicBanner(text) {
  $('mic-banner-text').textContent = text;
  $('mic-banner').hidden = false;
}

function hideMicBanner() {
  $('mic-banner').hidden = true;
}

function micPermissionHelp() {
  return speech.isIOS
    ? 'マイクがブロックされています。\n【なおし方】アドレスバーの「ぁあ」→「Webサイトの設定」→「マイク」を『許可』にして、ページを再読み込みしてください。\n(出てこない場合: iPhoneの設定アプリ→アプリ→Safari→マイク→許可)'
    : 'マイクがブロックされています。\n【なおし方】アドレスバー横の鍵マーク🔒→「権限」→「マイク」を『許可』にして、ページを再読み込みしてください。';
}

// ---- 音声入力 ----
// stt: ブラウザ標準の音声認識（Android Chrome等で高速）
// recorder: 録音してGeminiで文字起こし（iOSなど標準認識が不安定な端末向け）
let micMode = speech.isIOS || !speech.sttSupported ? 'recorder' : 'stt';
let audioRecorder = null;
let sttGotResult = false;
let sttFailCount = 0;

function switchToRecorderMode() {
  if (micMode === 'recorder' || !speech.recorderSupported) return;
  micMode = 'recorder';
  toast('音声認識を録音方式に切り替えました。もう一度話してみてください。');
}

function setupRecognizer() {
  recognizer = speech.createRecognizer({
    onInterim: (text) => {
      const el = $('interim-text');
      el.textContent = `🎤 ${text}`;
      el.hidden = false;
    },
    onResult: (text) => {
      sttGotResult = true;
      sttFailCount = 0;
      $('interim-text').hidden = true;
      sendUserMessage(text);
    },
    onEnd: () => {
      recording = false;
      updateMicUI();
      $('interim-text').hidden = true;
      if (!sttGotResult) {
        sttFailCount++;
        if (sttFailCount >= 2 && speech.recorderSupported) {
          switchToRecorderMode();
        } else {
          toast('聞き取れませんでした。もう一度はっきり話してみてください。');
        }
      }
    },
    onError: (code) => {
      recording = false;
      updateMicUI();
      $('interim-text').hidden = true;
      if (code === 'not-allowed' || code === 'service-not-allowed') {
        showMicBanner(micPermissionHelp());
      } else if (code !== 'aborted') {
        // no-speech / network など: 失敗としてカウントし、続くなら録音方式へ
        sttFailCount++;
        if (sttFailCount >= 2 && speech.recorderSupported) {
          switchToRecorderMode();
        } else if (code !== 'no-speech') {
          toast('音声認識でエラーが発生しました。もう一度どうぞ。');
        } else {
          toast('聞き取れませんでした。もう一度はっきり話してみてください。');
        }
      }
    },
  });
}

function updateMicUI() {
  const btn = $('btn-mic');
  btn.classList.toggle('recording', recording);
  $('mic-label').textContent = recording ? '聞いています… タップで確定' : 'タップして話す';
}

// 録音をそのままAIへ渡し、文字起こし+返答+添削を1リクエストで受け取る（高速化）
async function sendUserAudio(blob, mimeType) {
  if (!session || session.busy) return;
  session.busy = true;
  $('btn-mic').disabled = true;

  hideMicBanner();
  const userMsg = addUserBubble('🎤 …');
  setStatus('聞き取って返事を考えています…', 'thinking');
  addTyping();

  try {
    const base64 = await speech.blobToBase64(blob);
    const result = await chatTurn({
      apiKey: store.getApiKey(),
      level: settings.level,
      feedbackDetail: settings.feedbackDetail,
      scenario: session.scenario,
      history: session.history,
      audio: { base64, mimeType },
    });
    const transcript = (result.transcript || '').trim();
    removeTyping();
    if (!transcript) {
      userMsg.remove();
      setStatus('あなたの番です！', '');
      toast('聞き取れませんでした。もう一度はっきり話してみてください。');
      return;
    }
    userMsg.querySelector('.bubble').textContent = transcript;
    session.history.push({ role: 'user', text: transcript });
    session.history.push({ role: 'ai', text: result.reply });
    addAiBubble(result.reply);
    attachFeedback(userMsg, result.feedback);
    speakAndAnimate(result.reply);
  } catch (err) {
    removeTyping();
    userMsg.remove();
    setStatus('あなたの番です！', '');
    showMicBanner(err instanceof GeminiError ? err.message : `エラー: ${err?.message || err}`);
  } finally {
    session.busy = false;
    $('btn-mic').disabled = false;
  }
}

async function toggleRecorder() {
  if (audioRecorder) {
    // 録音停止 → そのままAIへ
    const rec = audioRecorder;
    audioRecorder = null;
    recording = false;
    updateMicUI();
    const blob = await rec.stop();
    if (blob.size < 1500) {
      setStatus('あなたの番です！', '');
      toast('短すぎて聞き取れませんでした。もう少し長く話してみてください。');
      return;
    }
    sendUserAudio(blob, rec.mimeType);
  } else {
    // 録音開始
    speech.stopSpeaking();
    try {
      audioRecorder = await speech.createAudioRecorder();
    } catch (err) {
      if (err && (err.name === 'NotAllowedError' || err.name === 'SecurityError')) {
        showMicBanner(micPermissionHelp());
      } else if (err && err.name === 'NotFoundError') {
        showMicBanner('マイクが見つかりませんでした。端末にマイクがあるか確認してください。');
      } else {
        showMicBanner(`マイクを開始できませんでした(${err?.name || 'エラー'})。ページを再読み込みして、もう一度お試しください。`);
      }
      return;
    }
    hideMicBanner();
    recording = true;
    updateMicUI();
    setStatus('🔴 録音中… 話し終えたらもう一度🎤をタップ', '');
  }
}

function toggleRecording() {
  if (session && session.busy) return;
  if (micMode === 'recorder') {
    if (!speech.recorderSupported) {
      toast('このブラウザは音声入力に対応していません。キーボードをご利用ください。');
      return;
    }
    toggleRecorder();
    return;
  }
  if (!recognizer) setupRecognizer();
  if (!recognizer) {
    toast('このブラウザは音声入力に対応していません。キーボードをご利用ください。');
    return;
  }
  speech.stopSpeaking();
  if (recording) {
    recognizer.stop();
  } else {
    sttGotResult = false;
    recording = true;
    updateMicUI();
    recognizer.start();
    setStatus('🔴 聞いています… 話し終えたらもう一度🎤をタップ', '');
  }
}

// ---- セッション終了・レビュー ----
async function endSession() {
  speech.stopSpeaking();
  if (recognizer && recording) recognizer.abort();
  if (audioRecorder) {
    audioRecorder.cancel();
    audioRecorder = null;
  }
  recording = false;

  const userTurns = session ? session.history.filter((m) => m.role === 'user').length : 0;
  if (!session || userTurns === 0) {
    session = null;
    showScreen('screen-home');
    return;
  }

  const body = $('review-body');
  body.textContent = '';
  body.append(h('div', 'review-loading', 'エマ先生がふりかえりを書いています…'));
  showScreen('screen-review');

  try {
    const review = await sessionReview({
      apiKey: store.getApiKey(),
      level: settings.level,
      scenario: session.scenario,
      history: session.history,
    });
    renderReview(review);
    store.addNotes(review.key_phrases || []);
    store.addSession({
      scenarioId: session.scenario.id,
      scenarioTitle: session.scenario.title,
      userTurns,
    });
    renderNotesCount();
  } catch (err) {
    body.textContent = '';
    const message = err instanceof GeminiError ? err.message : 'ふりかえりの作成に失敗しました。';
    body.append(h('div', 'empty-state', message));
    const back = h('button', 'primary-btn', 'ホームへ戻る');
    back.addEventListener('click', () => showScreen('screen-home'));
    body.append(back);
  }
  session = null;
}

function renderReview(review) {
  const body = $('review-body');
  body.textContent = '';

  const enc = h('div', 'encouragement');
  const img = document.createElement('img');
  img.src = 'assets/avatar.png';
  img.alt = '';
  enc.append(img, h('div', '', review.encouragement_ja || 'おつかれさまでした！'));
  body.append(enc);

  if (review.good_points?.length) {
    const card = h('div', 'review-card');
    card.append(h('h3', '', '🌟 良かったところ'));
    const ul = h('ul');
    review.good_points.forEach((p) => ul.append(h('li', '', p)));
    card.append(ul);
    body.append(card);
  }

  if (review.mistakes?.length) {
    const card = h('div', 'review-card');
    card.append(h('h3', '', '✏️ 直したいポイント'));
    for (const m of review.mistakes) {
      const item = h('div', 'review-mistake');
      item.append(h('div', 'rm-wrong', m.you_said), h('div', 'rm-right', m.better), h('div', 'rm-ja', m.ja_explanation));
      card.append(item);
    }
    body.append(card);
  }

  if (review.key_phrases?.length) {
    const card = h('div', 'review-card');
    card.append(h('h3', '', '📒 覚えたいフレーズ（復習ノートに保存済み）'));
    for (const p of review.key_phrases) {
      const item = h('div', 'phrase-item');
      item.append(h('div', 'phrase-en', p.en), h('div', 'phrase-ja', p.ja));
      card.append(item);
    }
    body.append(card);
  }

  const back = h('button', 'primary-btn', 'ホームへ戻る');
  back.addEventListener('click', () => showScreen('screen-home'));
  body.append(back);
}

// ---- 復習ノート ----
function renderNotes() {
  const body = $('notes-body');
  body.textContent = '';
  const notes = store.getNotes();
  if (!notes.length) {
    body.append(h('div', 'empty-state', 'まだフレーズがありません。\n会話を終了すると、覚えたいフレーズが自動でここに貯まります。'));
    return;
  }
  for (const n of notes) {
    const item = h('div', 'note-item');
    const text = h('div', 'note-text');
    text.append(h('div', 'phrase-en', n.en), h('div', 'phrase-ja', n.ja));
    const play = h('button', 'note-play', '🔊');
    play.addEventListener('click', () => {
      speech.unlockTTS();
      speech.speak(n.en, { rate: settings.rate, voiceName: settings.voiceName });
    });
    const del = h('button', 'note-del', '✕');
    del.addEventListener('click', () => {
      store.removeNote(n.en);
      renderNotes();
      renderNotesCount();
    });
    item.append(text, play, del);
    body.append(item);
  }
}

// ---- 設定 ----
function loadSettingsUI() {
  $('setting-api-key').value = store.getApiKey();
  $('setting-rate').value = settings.rate;
  $('rate-value').textContent = `×${Number(settings.rate).toFixed(2)}`;
  document.querySelectorAll('#feedback-toggle .seg-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.detail === settings.feedbackDetail);
  });

  const select = $('setting-voice');
  select.textContent = '';
  const auto = h('option', '', '自動選択');
  auto.value = '';
  select.append(auto);
  for (const v of speech.getEnglishVoices()) {
    const opt = h('option', '', `${v.name} (${v.lang})`);
    opt.value = v.name;
    select.append(opt);
  }
  select.value = settings.voiceName || '';
}

function saveSettingsUI() {
  const key = $('setting-api-key').value.trim();
  if (key) store.setApiKey(key);
  const detailBtn = document.querySelector('#feedback-toggle .seg-btn.active');
  store.saveSettings({
    rate: parseFloat($('setting-rate').value),
    voiceName: $('setting-voice').value,
    feedbackDetail: detailBtn ? detailBtn.dataset.detail : 'thorough',
  });
  settings = store.getSettings();
  toast('保存しました');
  showScreen('screen-home');
}

// ---- イベント登録 ----
function wireEvents() {
  // ホーム
  $('btn-free-talk').addEventListener('click', () => startSession('free'));
  $('btn-settings').addEventListener('click', () => {
    loadSettingsUI();
    showScreen('screen-settings');
  });
  $('btn-notes').addEventListener('click', () => {
    renderNotes();
    showScreen('screen-notes');
  });
  $('level-toggle').addEventListener('click', (e) => {
    const btn = e.target.closest('.seg-btn');
    if (!btn) return;
    settings.level = btn.dataset.level;
    store.saveSettings({ level: settings.level });
    setLevelUI();
  });

  // キーガイド
  $('btn-keyguide-back').addEventListener('click', () => showScreen('screen-home'));
  $('btn-keyguide-save').addEventListener('click', () => {
    const key = $('keyguide-input').value.trim();
    if (!key) {
      toast('APIキーを入力してください');
      return;
    }
    store.setApiKey(key);
    $('keyguide-input').value = '';
    toast('設定しました！さっそく話してみましょう');
    showScreen('screen-home');
  });

  // 会話
  $('btn-chat-back').addEventListener('click', endSession);
  $('btn-end-session').addEventListener('click', endSession);
  $('btn-mic').addEventListener('click', toggleRecording);
  $('btn-stop-speak').addEventListener('click', () => speech.stopSpeaking());
  $('btn-show-keyboard').addEventListener('click', () => {
    $('composer-voice').hidden = true;
    $('composer-text').hidden = false;
    $('text-input').focus();
  });
  $('btn-show-mic').addEventListener('click', () => {
    if (!speech.sttSupported && !speech.recorderSupported) {
      toast('このブラウザは音声入力に対応していません');
      return;
    }
    $('composer-text').hidden = true;
    $('composer-voice').hidden = false;
  });
  $('composer-text').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('text-input');
    const text = input.value;
    input.value = '';
    sendUserMessage(text);
  });

  $('mic-banner-close').addEventListener('click', hideMicBanner);

  // ノート・設定
  $('btn-notes-back').addEventListener('click', () => showScreen('screen-home'));
  $('btn-settings-back').addEventListener('click', () => showScreen('screen-home'));
  $('btn-save-settings').addEventListener('click', saveSettingsUI);
  $('setting-rate').addEventListener('input', (e) => {
    $('rate-value').textContent = `×${Number(e.target.value).toFixed(2)}`;
  });
  $('btn-toggle-key').addEventListener('click', () => {
    const input = $('setting-api-key');
    input.type = input.type === 'password' ? 'text' : 'password';
  });
  $('feedback-toggle').addEventListener('click', (e) => {
    const btn = e.target.closest('.seg-btn');
    if (!btn) return;
    document.querySelectorAll('#feedback-toggle .seg-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
  });
}

// ---- 起動 ----
function init() {
  renderScenarioGrid();
  renderNotesCount();
  setLevelUI();
  wireEvents();
  $('home-version').textContent = `v${APP_VERSION}`;
  $('settings-version').textContent = `AI英会話チューター v${APP_VERSION}`;

  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    // 新しいバージョンが有効になったら自動で読み込み直す（更新の取りこぼし防止）
    const hadController = !!navigator.serviceWorker.controller;
    let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController || reloaded) return;
      reloaded = true;
      location.reload();
    });
    navigator.serviceWorker.register('sw.js').then((reg) => reg.update()).catch(() => {});
  }
}

init();
