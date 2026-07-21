// Gemini API 呼び出し（会話+添削を1リクエストでJSON取得）

const BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const MODELS_STORE_KEY = 'eikaiwa.models';
const THINK_STORE_KEY = 'eikaiwa.thinkcfg';

// 利用可能なモデルはGoogle側で入れ替わるため、固定名にせず一覧APIから自動選択する
// 混雑(503)に備えて上位候補を複数保持し、自動で切り替える
let modelsCache = null;

function scoreModel(m) {
  const name = (m.name || '').replace(/^models\//, '');
  const lower = name.toLowerCase();
  // テキスト会話に使えないモデルは除外
  if (/(embedding|imagen|veo|tts|audio|live|image|robotics|aqa|gemma)/.test(lower)) return -1;
  const methods = m.supportedGenerationMethods || m.supportedActions || [];
  if (methods.length && !methods.includes('generateContent')) return -1;
  if (!/gemini/.test(lower)) return -1;

  let score = 0;
  const ver = lower.match(/gemini-(\d+(?:\.\d+)?)/);
  if (ver) score += parseFloat(ver[1]) * 10; // 新しい世代を優先
  if (lower.includes('flash')) score += 100; // 無料枠が広く高速なflash系を最優先
  if (lower.includes('lite')) score += 8; // 同世代ならより高速で混雑しにくいliteを優先
  if (/(preview|exp)/.test(lower)) score -= 30; // 安定版を優先
  if (lower.includes('pro')) score += 50;
  return score;
}

async function discoverModel(apiKey) {
  let res;
  try {
    res = await fetch(`${BASE}?key=${encodeURIComponent(apiKey)}&pageSize=200`);
  } catch {
    throw new GeminiError('network', '通信エラー。電波状況を確認してください。');
  }
  if (!res.ok) {
    let apiMsg = '';
    try {
      apiMsg = (await res.json())?.error?.message || '';
    } catch {
      /* noop */
    }
    if (/api key not valid|api_key_invalid|api key expired/i.test(apiMsg) || res.status === 403 || res.status === 400) {
      throw new GeminiError('invalid_key', 'APIキーが正しくないようです。設定画面でキーを確認してください。');
    }
    throw new GeminiError('bad_response', `AIモデル一覧の取得に失敗しました(${res.status})。`);
  }
  const data = await res.json();
  const ranked = (data.models || [])
    .map((m) => ({ name: (m.name || '').replace(/^models\//, ''), score: scoreModel(m) }))
    .filter((m) => m.score >= 0)
    .sort((a, b) => b.score - a.score)
    .map((m) => m.name)
    .slice(0, 4);
  if (!ranked.length) {
    throw new GeminiError('bad_response', '利用できるAIモデルが見つかりませんでした。');
  }
  console.info('[Gemini] models selected:', ranked.join(', '));
  modelsCache = ranked;
  try {
    localStorage.setItem(MODELS_STORE_KEY, JSON.stringify(ranked));
  } catch {
    /* noop */
  }
  return ranked;
}

async function resolveModels(apiKey) {
  if (modelsCache) return modelsCache;
  try {
    const stored = JSON.parse(localStorage.getItem(MODELS_STORE_KEY) || 'null');
    if (Array.isArray(stored) && stored.length) {
      modelsCache = stored;
      return stored;
    }
  } catch {
    /* noop */
  }
  return discoverModel(apiKey);
}

function clearModelCache() {
  modelsCache = null;
  try {
    localStorage.removeItem(MODELS_STORE_KEY);
  } catch {
    /* noop */
  }
}

// URLに ?mock=1 を付けるとAPIを呼ばずダミー応答で動く（UI確認用）
const MOCK = new URLSearchParams(location.search).has('mock');

export class GeminiError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code; // 'invalid_key' | 'quota' | 'network' | 'bad_response'
  }
}

function levelInstruction(level) {
  return level === 'intermediate'
    ? 'The learner is an intermediate English learner. Use natural everyday vocabulary, but avoid rare idioms.'
    : 'The learner is a beginner. Use simple, common words and short sentences (middle-school level English).';
}

function feedbackInstruction(detail) {
  return detail === 'light'
    ? 'Only point out clear grammar or vocabulary mistakes. Ignore minor unnaturalness.'
    : 'Point out grammar and vocabulary mistakes AND unnatural phrasing, even small ones, but pick at most the 3 most useful points.';
}

const CHAT_SCHEMA = {
  type: 'OBJECT',
  properties: {
    transcript: { type: 'STRING' },
    reply: { type: 'STRING' },
    feedback: {
      type: 'OBJECT',
      properties: {
        has_issues: { type: 'BOOLEAN' },
        corrected: { type: 'STRING' },
        points: {
          type: 'ARRAY',
          items: {
            type: 'OBJECT',
            properties: {
              type: { type: 'STRING' },
              ja_explanation: { type: 'STRING' },
            },
            required: ['type', 'ja_explanation'],
          },
        },
        natural_alternative: { type: 'STRING' },
        praise_ja: { type: 'STRING' },
      },
      required: ['has_issues'],
    },
  },
  required: ['reply', 'feedback'],
};

const REVIEW_SCHEMA = {
  type: 'OBJECT',
  properties: {
    good_points: { type: 'ARRAY', items: { type: 'STRING' } },
    mistakes: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          you_said: { type: 'STRING' },
          better: { type: 'STRING' },
          ja_explanation: { type: 'STRING' },
        },
        required: ['you_said', 'better', 'ja_explanation'],
      },
    },
    key_phrases: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: { en: { type: 'STRING' }, ja: { type: 'STRING' } },
        required: ['en', 'ja'],
      },
    },
    encouragement_ja: { type: 'STRING' },
  },
  required: ['good_points', 'mistakes', 'key_phrases', 'encouragement_ja'],
};

async function postGenerate(apiKey, model, body) {
  try {
    return await fetch(`${BASE}/${model}:generateContent?key=${encodeURIComponent(apiKey)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new GeminiError('network', '通信エラー。電波状況を確認してください。');
  }
}

async function callGemini(apiKey, body) {
  let models = await resolveModels(apiKey);
  let mi = 0; // 現在試しているモデルの候補番号
  // 「思考モード」オフ指定で応答を高速化（未対応モデルでは400になるため自動で外して記憶）
  let sendThinkOff = localStorage.getItem(THINK_STORE_KEY) !== 'unsupported';
  let rediscovered = false;
  let retried503 = false;

  for (let attempt = 0; attempt < 5; attempt++) {
    const model = models[Math.min(mi, models.length - 1)];
    const finalBody = sendThinkOff
      ? { ...body, generationConfig: { ...body.generationConfig, thinkingConfig: { thinkingBudget: 0 } } }
      : body;
    const res = await postGenerate(apiKey, model, finalBody);

    if (res.ok) {
      const data = await res.json();
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) {
        throw new GeminiError('bad_response', 'AIの応答を読み取れませんでした。もう一度試してください。');
      }
      try {
        return JSON.parse(text);
      } catch {
        throw new GeminiError('bad_response', 'AIの応答を読み取れませんでした。もう一度試してください。');
      }
    }

    let apiMsg = '';
    try {
      apiMsg = (await res.json())?.error?.message || '';
    } catch {
      /* 本文なし */
    }
    console.error('[Gemini]', model, res.status, apiMsg);

    // モデル廃止 → 一覧を取り直して先頭からやり直し（1回だけ）
    if (res.status === 404 && !rediscovered) {
      rediscovered = true;
      clearModelCache();
      models = await discoverModel(apiKey);
      mi = 0;
      continue;
    }
    // 思考モード指定が未対応 → 外して再試行し、以後は送らない
    if (res.status === 400 && sendThinkOff && /think|budget/i.test(apiMsg)) {
      sendThinkOff = false;
      try {
        localStorage.setItem(THINK_STORE_KEY, 'unsupported');
      } catch {
        /* noop */
      }
      continue;
    }
    // 混雑 → 少し待って再試行 → まだ混雑なら次の候補モデルへ自動切替
    if (res.status === 503 || res.status === 500) {
      if (!retried503) {
        retried503 = true;
        await delay(800);
        continue;
      }
      if (mi < models.length - 1) {
        mi++;
        retried503 = false;
        continue;
      }
      throw new GeminiError('bad_response', 'AIが混み合っています。少し時間をおいてもう一度お試しください。');
    }
    if (res.status === 429) {
      throw new GeminiError('quota', '今日の無料枠を使い切りました。明日また練習しましょう！');
    }
    if (/api key not valid|api_key_invalid|api key expired/i.test(apiMsg)) {
      throw new GeminiError('invalid_key', 'APIキーが正しくないようです。設定画面でキーを確認してください（前後の空白や写し間違いがないか）。');
    }
    if (res.status === 403) {
      throw new GeminiError('invalid_key', `アクセスが拒否されました。APIキーを確認してください。詳細: ${apiMsg.slice(0, 160)}`);
    }
    throw new GeminiError('bad_response', `AIエラー(${res.status}): ${apiMsg.slice(0, 160) || 'もう一度試してください。'}`);
  }
  throw new GeminiError('bad_response', 'AIが混み合っています。少し時間をおいてもう一度お試しください。');
}

// 会話履歴 [{role:'user'|'ai', text}] をGemini形式に変換
function toContents(history) {
  return history.map((m) => ({
    role: m.role === 'user' ? 'user' : 'model',
    parts: [{ text: m.text }],
  }));
}

// audio: {base64, mimeType} を渡すと、最後のユーザー発話として録音を直接理解させる
// （文字起こし+返答+添削を1リクエストで行い、待ち時間を半減する）
export async function chatTurn({ apiKey, level, feedbackDetail, scenario, history, audio }) {
  if (MOCK) return mockChatTurn(history, audio);

  const system = [
    'You are "Emma", a warm and encouraging English conversation tutor in a language learning app for Japanese learners.',
    `ROLE-PLAY: ${scenario.aiRole}`,
    levelInstruction(level),
    'Rules for "reply": Respond naturally IN ENGLISH ONLY to the learner\'s last message, staying in character. Keep it short (1-3 sentences). Usually end with a question to keep the conversation going. Never correct mistakes inside the reply itself — the conversation should flow naturally.',
    'Rules for "feedback": Analyze ONLY the learner\'s LAST message.',
    feedbackInstruction(feedbackDetail),
    'If there are issues: has_issues=true, "corrected" = the corrected version of their sentence, "points" = each issue with type (one of: 文法 / 語彙 / 自然さ) and a concise Japanese explanation (ja_explanation), and "natural_alternative" = how a native speaker would naturally say it.',
    'If the message is fine: has_issues=false, and set "praise_ja" to a short Japanese praise comment. You may still set "natural_alternative" if there is a more natural phrasing worth learning.',
    'All explanations (ja_explanation, praise_ja) must be in Japanese. "reply", "corrected", "natural_alternative" must be in English.',
  ];
  if (audio) {
    system.push(
      'AUDIO INPUT: The learner\'s last message is an audio recording of their spoken English. First transcribe it exactly as spoken into "transcript" (English text only). Then treat that transcript as their message: reply to it and give feedback on it. If the audio contains no clear speech, set "transcript" to an empty string and leave the other fields minimal.',
    );
  }

  const contents = toContents(history);
  if (audio) {
    contents.push({
      role: 'user',
      parts: [{ inlineData: { mimeType: audio.mimeType, data: audio.base64 } }],
    });
  }

  return callGemini(apiKey, {
    systemInstruction: { parts: [{ text: system.join('\n') }] },
    contents,
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: CHAT_SCHEMA,
      temperature: 0.8,
    },
  });
}

export async function sessionReview({ apiKey, level, scenario, history }) {
  if (MOCK) return mockReview();

  const transcript = history
    .map((m) => `${m.role === 'user' ? 'Learner' : 'Emma'}: ${m.text}`)
    .join('\n');

  const system = [
    'You are an English tutor writing a session review for a Japanese learner.',
    levelInstruction(level),
    `The conversation was a role-play: ${scenario.aiRole}`,
    'Based on the transcript, produce:',
    '- good_points: 1-3 things the learner did well (in Japanese)',
    '- mistakes: up to 5 notable mistakes: you_said (their English), better (corrected English), ja_explanation (concise Japanese)',
    '- key_phrases: 3-5 useful English phrases from or related to this conversation worth memorizing, with Japanese meaning',
    '- encouragement_ja: a warm, short encouragement message in Japanese',
  ].join('\n');

  return callGemini(apiKey, {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts: [{ text: `Transcript:\n${transcript}` }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: REVIEW_SCHEMA,
      temperature: 0.4,
    },
  });
}

// ---- モック（?mock=1 でのUI確認用） ----

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function mockChatTurn(history, audio) {
  await delay(900);
  if (audio) {
    return {
      transcript: 'I want to go to the station.',
      reply: 'Sure! The station is just around the corner. Are you taking the train downtown?',
      feedback: {
        has_issues: false,
        praise_ja: '伝わる言い方です！',
        natural_alternative: 'Could you tell me how to get to the station?',
      },
    };
  }
  const n = history.filter((m) => m.role === 'user').length;
  if (n % 2 === 1) {
    return {
      reply: "That sounds great! What kind of food do you like the most?",
      feedback: {
        has_issues: true,
        corrected: 'I went to the beach yesterday.',
        points: [
          { type: '文法', ja_explanation: '過去の話なので go は went（過去形）にします。' },
          { type: '自然さ', ja_explanation: '「the beach」のように the を付けるのが自然です。' },
        ],
        natural_alternative: 'I hit the beach yesterday.',
      },
    };
  }
  return {
    reply: "Nice! I love sushi too. Have you ever tried making it at home?",
    feedback: {
      has_issues: false,
      praise_ja: '完璧です！自然な言い方ができています。',
      natural_alternative: "I'm really into sushi.",
    },
  };
}

async function mockReview() {
  await delay(1200);
  return {
    good_points: ['自分から質問を返せていました', '過去形を正しく使えた場面が多かったです'],
    mistakes: [
      {
        you_said: 'I go to beach yesterday.',
        better: 'I went to the beach yesterday.',
        ja_explanation: '過去の出来事なので went。場所には the を付けます。',
      },
    ],
    key_phrases: [
      { en: 'Could I get the check, please?', ja: 'お会計をお願いできますか？' },
      { en: "I'm just looking, thanks.", ja: '見ているだけです、ありがとう。' },
      { en: 'Could you say that again more slowly?', ja: 'もう一度ゆっくり言ってもらえますか？' },
    ],
    encouragement_ja: '今日もよく頑張りました！質問を返す力がついてきています。この調子で毎日少しずつ続けましょう。',
  };
}
