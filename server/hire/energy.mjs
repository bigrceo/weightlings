// A finished hire feeds the creature that did it. sim.mjs has no export for live energy, so this reaches the live map through
// its existing exports (L, events, saveState) and touches only the creature's live energy, its faint timer and its action.
// It never touches this hour's counts (rd), lifetime counts (st), frozen counts (fz) or anything the round reads:
// energy is not in the committed snapshot. It can only help a creature indirectly (fewer faints, different foraging),
// through counts that are frozen and hashed at the seal like any other.
import * as sim from '../sim.mjs';

export const HIRE_ENERGY = 34; // the same as one berry (FOOD_E in sim.mjs)

/** Add n energy to a living creature (cap 100). A fainted creature wakes; its faint stays counted. Returns null if it is not alive. */
export function addEnergy(id, n, why = '') {
  const b = sim.L.get(Number(id));
  if (!b) return null;
  const woke = b.down > 0, before = woke ? 0 : b.e;
  if (woke) { b.down = 0; b.act = 'wander'; b.e = Math.min(100, n); }
  else b.e = Math.min(100, b.e + n);
  sim.events.unshift({ at: Date.now(), kind: 'hire', text: `${b.nick} (${b.m.name} brain) finished a hire${why ? ': ' + why : ''} and gained energy`, who: [b.id] });
  if (sim.events.length > 120) sim.events.pop();
  try { sim.saveState(); } catch {}
  return { before: +before.toFixed(2), after: +b.e.toFixed(2), woke };
}
