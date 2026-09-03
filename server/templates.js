// Strategy-template persistence: seed the code-defined templates
// (shared/templates.js, the source of truth) into the strategy_templates
// table so cards can reference them by FK, and serve the list to the UI.
// Seeding is an upsert by name - editing a template in code updates the
// row on the next boot, and existing cards keep pointing at the same id.

import express from 'express';
import { listTemplates } from '../shared/templates.js';
import { getDb } from './db.js';

export const templatesRouter = express.Router();

export function seedTemplates(db) {
  const upsert = db.prepare(`
    INSERT INTO strategy_templates (name, description, rules)
    VALUES (?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET description = excluded.description, rules = excluded.rules
  `);
  const seed = db.transaction(() => {
    for (const t of listTemplates()) {
      upsert.run(t.name, t.description, JSON.stringify(t.rules));
    }
    // D54: 'human' is a real strategy_templates row purely for FK integrity
    // (every LEFT JOIN strategy_templates then resolves template:'human'
    // with zero query changes) - deliberately NOT in shared/templates.js's
    // TEMPLATES map, so it never appears in the live-generate dropdown,
    // resolveTemplate(), or POST /api/simulations' "run every template."
    upsert.run('human', 'Human-entered picks, replayed blind race by race (D54/D55). Not engine-generated or simulated.', '{}');
    // D63: same reasoning as 'human' above - real row for FK integrity,
    // deliberately outside shared/templates.js's TEMPLATES map so it never
    // appears in the live-generate dropdown, resolveTemplate(), or a
    // simulation run (an LLM card is manually generated race by race, not
    // something the simulator could ever replay).
    upsert.run('llm', 'LLM-generated picks, one race at a time from entries and already-fetched consensus (D63). Not engine-generated or simulated.', '{}');
    // D71: same reasoning as 'human'/'llm' above - real row for FK integrity,
    // deliberately outside shared/templates.js's TEMPLATES map so it never
    // appears in the live-generate dropdown, resolveTemplate(), or a
    // simulation run (Equibase's printed sheet is uploaded, not generated).
    upsert.run('equibase-otr', "Equibase's Off to the Races sheet, tickets taken verbatim (D71). Not engine-generated or simulated.", '{}');
  });
  seed();
}

/** Template row id for a name (post-seed, always present for known names). */
export function templateIdFor(db, name) {
  return db.prepare('SELECT id FROM strategy_templates WHERE name = ?').get(name)?.id ?? null;
}

templatesRouter.get('/templates', (_req, res) => {
  // Serve from code, not the table - the table is for FK integrity; the
  // code carries the layer map the UI and simulator need.
  res.json(listTemplates());
});
