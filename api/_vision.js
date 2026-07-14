// api/_vision.js
// Claude(Anthropic) / GPT(OpenAI) を切り替えてビジョンJSON照合を行う共通層。
// box-detect / die-align-verify / material-match が共有する。
// parts: 順序付き配列。各要素は { text } または { image:{ mime, data(base64) } }。
// 返り値: モデル出力テキストから抽出した JSON オブジェクト。
//
// ※ モデルIDはここの MODELS で一元管理。OpenAI の正式な公開IDが異なる場合は
//   'gpt-5.6-sol' の id を実際のIDに直すだけでよい。
//   （'gpt-5.6' エイリアスも Sol にルーティングされるが、明示IDで固定する）

export const MODELS = {
  'claude-opus-4-8': { provider: 'anthropic', id: 'claude-opus-4-8', label: 'Claude Opus 4.8' },
  'gpt-5.6-sol':     { provider: 'openai',    id: 'gpt-5.6-sol',     label: 'GPT-5.6 Sol' },
};
export const DEFAULT_MODEL = 'claude-opus-4-8';

export function resolveModel(key) {
  return MODELS[key] || MODELS[DEFAULT_MODEL];
}

function extractJson(raw) {
  const t = String(raw || '');
  try { return JSON.parse(t); }
  catch {
    const m = t.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]);
    throw new Error('AI応答をJSONとして解釈できません');
  }
}

async function callAnthropic(modelId, system, parts, maxTokens) {
  const apiKey = process.env.ANTHROPIC_API_KEY || '';
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is missing');
  const content = parts.map(p =>
    p.image
      ? { type: 'image', source: { type: 'base64', media_type: p.image.mime, data: p.image.data } }
      : { type: 'text', text: p.text }
  );
  const body = { model: modelId, max_tokens: maxTokens, messages: [{ role: 'user', content }] };
  if (system) body.system = system;
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`anthropic ${r.status} ${(await r.text()).slice(0, 300)}`);
  const j = await r.json();
  if (j.stop_reason === 'refusal') throw new Error('AIがポリシーにより応答を拒否しました');
  const textBlock = (j.content || []).find(b => b.type === 'text');
  if (!textBlock) throw new Error('AI応答に本文がありません');
  return textBlock.text || '';
}

async function callOpenAI(modelId, system, parts, maxTokens) {
  const apiKey = process.env.OPENAI_API_KEY || '';
  if (!apiKey) throw new Error('OPENAI_API_KEY is missing');
  const content = parts.map(p =>
    p.image
      ? { type: 'image_url', image_url: { url: `data:${p.image.mime};base64,${p.image.data}` } }
      : { type: 'text', text: p.text }
  );
  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content });
  const body = {
    model: modelId,
    messages,
    // 上限値（モデルは必要分だけ消費）。推論トークンで枯渇しないよう余裕を持たせる。
    max_completion_tokens: Math.max(maxTokens, 4096),
  };
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'authorization': `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`openai ${r.status} ${(await r.text()).slice(0, 300)}`);
  const j = await r.json();
  const msg = j.choices?.[0]?.message?.content || '';
  if (!msg) throw new Error('AI応答に本文がありません');
  return msg;
}

// modelKey: クライアントから渡されたモデルキー（未知/未指定なら既定=Claude）
export async function callVisionJSON({ modelKey, system = '', parts = [], maxTokens = 1024 }) {
  const m = resolveModel(modelKey);
  const raw = m.provider === 'openai'
    ? await callOpenAI(m.id, system, parts, maxTokens)
    : await callAnthropic(m.id, system, parts, maxTokens);
  return extractJson(raw);
}
