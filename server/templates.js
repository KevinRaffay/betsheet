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
