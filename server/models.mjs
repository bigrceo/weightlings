// The brains. Real open-weight models: total parameters (B), active parameters for MoE (B),
// MMLU as published on the model card or paper (5-shot unless noted), context window (k tokens), release year.
// Everything a creature does in the simulation derives from these numbers.
export const MODELS = [
  { id: 'qwen2.5-0.5b', name: 'Qwen2.5 0.5B', lab: 'Alibaba', params: 0.49, mmlu: 47.5, ctx: 32, year: 2024 },
  { id: 'llama-3.2-1b', name: 'Llama 3.2 1B', lab: 'Meta', params: 1.24, mmlu: 49.3, ctx: 128, year: 2024 },
  { id: 'gemma-2-2b', name: 'Gemma 2 2B', lab: 'Google', params: 2.6, mmlu: 51.3, ctx: 8, year: 2024 },
  { id: 'qwen2.5-1.5b', name: 'Qwen2.5 1.5B', lab: 'Alibaba', params: 1.54, mmlu: 60.9, ctx: 32, year: 2024 },
  { id: 'mistral-7b', name: 'Mistral 7B', lab: 'Mistral AI', params: 7.3, mmlu: 60.1, ctx: 8, year: 2023 },
  { id: 'llama-3.2-3b', name: 'Llama 3.2 3B', lab: 'Meta', params: 3.21, mmlu: 63.4, ctx: 128, year: 2024 },
  { id: 'qwen2.5-3b', name: 'Qwen2.5 3B', lab: 'Alibaba', params: 3.09, mmlu: 65.6, ctx: 32, year: 2024 },
  { id: 'phi-3-mini', name: 'Phi-3 Mini', lab: 'Microsoft', params: 3.8, mmlu: 68.8, ctx: 128, year: 2024 },
  { id: 'llama-3.1-8b', name: 'Llama 3.1 8B', lab: 'Meta', params: 8.03, mmlu: 69.4, ctx: 128, year: 2024 },
  { id: 'mixtral-8x7b', name: 'Mixtral 8x7B', lab: 'Mistral AI', params: 46.7, active: 12.9, mmlu: 70.6, ctx: 32, year: 2023 },
  { id: 'gemma-2-9b', name: 'Gemma 2 9B', lab: 'Google', params: 9.24, mmlu: 71.3, ctx: 8, year: 2024 },
  { id: 'qwen2.5-7b', name: 'Qwen2.5 7B', lab: 'Alibaba', params: 7.62, mmlu: 74.2, ctx: 128, year: 2024 },
  { id: 'gemma-2-27b', name: 'Gemma 2 27B', lab: 'Google', params: 27.2, mmlu: 75.2, ctx: 8, year: 2024 },
  { id: 'mixtral-8x22b', name: 'Mixtral 8x22B', lab: 'Mistral AI', params: 141, active: 39, mmlu: 77.8, ctx: 64, year: 2024 },
  { id: 'phi-3-medium', name: 'Phi-3 Medium', lab: 'Microsoft', params: 14, mmlu: 78.0, ctx: 128, year: 2024 },
  { id: 'qwen2.5-14b', name: 'Qwen2.5 14B', lab: 'Alibaba', params: 14.7, mmlu: 79.7, ctx: 128, year: 2024 },
  { id: 'qwen2.5-32b', name: 'Qwen2.5 32B', lab: 'Alibaba', params: 32.5, mmlu: 83.3, ctx: 128, year: 2024 },
  { id: 'llama-3.1-70b', name: 'Llama 3.1 70B', lab: 'Meta', params: 70.6, mmlu: 86.0, ctx: 128, year: 2024 },
  { id: 'qwen2.5-72b', name: 'Qwen2.5 72B', lab: 'Alibaba', params: 72.7, mmlu: 86.1, ctx: 128, year: 2024 },
  { id: 'llama-3.1-405b', name: 'Llama 3.1 405B', lab: 'Meta', params: 405, mmlu: 88.6, ctx: 128, year: 2024 },
  { id: 'deepseek-v3', name: 'DeepSeek V3', lab: 'DeepSeek', params: 671, active: 37, mmlu: 88.5, ctx: 128, year: 2024 },
  { id: 'deepseek-r1', name: 'DeepSeek R1', lab: 'DeepSeek', params: 671, active: 37, mmlu: 90.8, ctx: 128, year: 2025 },
];

// Power: benchmark weighs most, scale second. Tier cut-offs on power.
export const TIERS = [
  { key: 'legendary', name: 'Legendary', stars: 5, color: '#ffb81f', min: 0.86, odds: 0.03 },
  { key: 'epic', name: 'Epic', stars: 4, color: '#b056ff', min: 0.72, odds: 0.08 },
  { key: 'rare', name: 'Rare', stars: 3, color: '#2a7bff', min: 0.58, odds: 0.17 },
  { key: 'uncommon', name: 'Uncommon', stars: 2, color: '#2fc46b', min: 0.42, odds: 0.30 },
  { key: 'common', name: 'Common', stars: 1, color: '#b9bcc4', min: 0, odds: 0.42 },
];
const LOGO = { Meta: 'meta', Alibaba: 'qwen', Google: 'gemma', 'Mistral AI': 'mistral', Microsoft: 'microsoft', DeepSeek: 'deepseek' };
const lg = (x) => Math.log10(x);
for (const m of MODELS) {
  m.logo = `https://cdn.jsdelivr.net/npm/@lobehub/icons-static-svg@1.45.0/icons/${LOGO[m.lab]}-color.svg`;
  const bench = (m.mmlu - 45) / 46; // 45 → 0, 91 → 1
  const scale = (lg(m.params) - lg(0.4)) / (lg(700) - lg(0.4));
  m.power = +(bench * 0.7 + scale * 0.3).toFixed(3);
  m.tier = TIERS.find((t) => m.power >= t.min).key;
  // simulation stats, 0..1, all from the card numbers
  m.stats = {
    perception: +(0.25 + 0.75 * bench).toFixed(3), // how far it notices food and danger
    judgement: +(0.35 + 0.65 * bench).toFixed(3), // chance to pick the best move instead of a random one
    memory: +Math.min(1, lg(m.ctx) / lg(128)).toFixed(3), // remembers food spots longer (context window)
    strength: +(0.3 + 0.7 * scale).toFixed(3), // contest weight
    metabolism: +(0.6 + 0.4 * ((lg(m.active || m.params) - lg(0.4)) / (lg(405) - lg(0.4)))).toFixed(3), // bigger dense brains burn more energy; MoE only pays for active experts
    cooperation: +(0.2 + 0.8 * bench).toFixed(3),
  };
}
export const byId = Object.fromEntries(MODELS.map((m) => [m.id, m]));
export const tierOf = (k) => TIERS.find((t) => t.key === k);

/** A wallet hatches one brain: tier drawn by its hash against the odds, then a model of that tier. Deterministic. */
export function brainFor(wallet) {
  let h = 2166136261;
  for (const c of wallet.toLowerCase()) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
  const u = (h % 100000) / 100000, v = ((h >>> 7) % 9973) / 9973;
  let acc = 0, tier = 'common';
  for (const t of TIERS) { acc += t.odds; if (u < acc) { tier = t.key; break; } }
  const pool = MODELS.filter((m) => m.tier === tier);
  return (pool.length ? pool : MODELS)[Math.floor(v * pool.length)].id;
}
