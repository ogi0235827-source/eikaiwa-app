// Gemini API 呼び出し（会話+添削を1リクエストでJSON取得）

const MODEL = 'gemini-2.5-flash';
const BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

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

async function callGemini(apiKey, body) {
  let res;
  try {
    res = await fetch(`${BASE}/${MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new GeminiError('network', '通信エラー。電波状況を確認してください。');
  }
  if (res.status === 429) {
    throw new GeminiError('quota', '今日の無料枠を使い切りました。明日また練習しましょう！');
  }
  if (res.status === 400 || res.status === 403) {
    throw new GeminiError('invalid_key', 'APIキーが正しくないようです。設定画面で確認してください。');
  }
  if (!res.ok) {
    throw new GeminiError('bad_response', `AIの応答エラーが発生しました (${res.status})。もう一度試してください。`);
  }
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

// 会話履歴 [{role:'user'|'ai', text}] をGemini形式に変換
function toContents(history) {
  return history.map((m) => ({
    role: m.role === 'user' ? 'user' : 'model',
    parts: [{ text: m.text }],
  }));
}

export async function chatTurn({ apiKey, level, feedbackDetail, scenario, history }) {
  if (MOCK) return mockChatTurn(history);

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
  ].join('\n');

  return callGemini(apiKey, {
    systemInstruction: { parts: [{ text: system }] },
    contents: toContents(history),
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

// 録音音声の文字起こし（SpeechRecognition非対応・不安定端末向けフォールバック）
export async function transcribeAudio({ apiKey, base64, mimeType }) {
  if (MOCK) {
    await delay(700);
    return 'I want to go to the station.';
  }
  const data = await callGemini(apiKey, {
    contents: [
      {
        role: 'user',
        parts: [
          { inlineData: { mimeType, data: base64 } },
          {
            text: 'Transcribe this English speech exactly as spoken. Return ONLY the transcribed English text, nothing else. If there is no clear speech, return an empty string.',
          },
        ],
      },
    ],
    generationConfig: { temperature: 0, responseMimeType: 'application/json', responseSchema: { type: 'OBJECT', properties: { text: { type: 'STRING' } }, required: ['text'] } },
  });
  return (data.text || '').trim();
}

// ---- モック（?mock=1 でのUI確認用） ----

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function mockChatTurn(history) {
  await delay(900);
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
