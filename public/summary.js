// The round summary, counted from a record: what the round pages, the slips, the gene board and the market print.
// One function shared by the server (server/sim.mjs, when it stores the summary) and /verify (which recounts it from the recomputed result).
// It is bookkeeping, not a rule: nothing here decides who lives.
//
//   summaryOf(snapshot, result) -> { population, died, born, reborn, mutations, models: [{ id, start, died, born, rate }], dominant }
//     snapshot  the frozen creatures of the record: [{ id, model, … }]
//     result    { ranked, dead, births } as stored in the record
//     dominant  the id of the brain with the most survivors among brains that entered with 2 or more creatures (ties: higher survival
//               rate, then first met in the ranking); with no such brain, the first brain met
export function summaryOf(snapshot, result) {
  const S = {}; for (const c of snapshot) S[c.id] = c;
  const per = {}, P = (id) => (per[id] ||= { start: 0, died: 0, born: 0 });
  for (const id of result.ranked) P(S[id].model).start++;
  for (const id of result.dead) P(S[id].model).died++;
  for (const c of result.births) P(c.model).born++;
  const models = Object.entries(per).map(([id, v]) => ({ id, start: v.start, died: v.died, born: v.born, rate: v.start ? (v.start - v.died) / v.start : null }));
  const dom = [...models].filter((m) => m.start >= 2).sort((a, z) => (z.start - z.died) - (a.start - a.died) || z.rate - a.rate)[0] || models[0] || null;
  return { population: result.ranked.length, died: result.dead.length, born: result.births.length, reborn: result.births.filter((x) => x.reborn).length,
    mutations: result.births.filter((x) => x.mutated).length, models, dominant: dom ? dom.id : null };
}
