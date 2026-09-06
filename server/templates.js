// Strategy-template persistence: seed the three surviving templates into the
// strategy_templates table so cards can reference them by FK.
//
// This file used to seed shared/templates.js's 12 lean rule bundles as well,
// with the three below appended as FK-only rows that were deliberately kept
// OUT of that map so they could never appear in the live-generate dropdown or
// a simulation run. D111 deleted the engine, the templates and the simulator,
// so the exception is now the whole list: the three producers that remain -
// Equibase OTR uploads, LLM generation and human entry - are exactly these
// rows, and each writes its own tickets through its own module.
//
// They are NOT renamed (the pivot's own correction: OTR never used the lean
// engine, so there is no `otr-lean` to rename anything to, and renaming would
// churn live rows on every stored card for nothing). Seeding stays an upsert
// by name, so existing cards keep pointing at the same id.
//
// `rules` is '{}' for all three: none of them is rule-driven. There is no
// rule set left to describe.

import express from 'express';
import { getDb } from './db.js';

export const templatesRouter = express.Router();

/** The three card producers, as rows. Name -> description. */
const TEMPLATE_ROWS = [
  ['human', 'Human-entered picks, typed or built race by race (D54/D55).'],
  ['llm', 'LLM-generated picks, one race at a time from entries and any notes (D63).'],
  ['equibase-otr', "Equibase's Off to the Races sheet, tickets taken verbatim (D71)."],
];

export function seedTemplates(db) {
  const upsert = db.prepare(`
    INSERT INTO strategy_templates (name, description, rules)
    VALUES (?, ?, '{}')
    ON CONFLICT(name) DO UPDATE SET description = excluded.description, rules = excluded.rules
  `);
  const seed = db.transaction(() => {
    for (const [name, description] of TEMPLATE_ROWS) upsert.run(name, description);
  });
  seed();
}

/** Template row id for a name (post-seed, always present for known names). */
export function templateIdFor(db, name) {
  return db.prepare('SELECT id FROM strategy_templates WHERE name = ?').get(name)?.id ?? null;
}

templatesRouter.get('/templates', (_req, res) => {
  // Served from the table now, not from code: with the rule bundles gone
  // there is no layer map to carry, and the rows themselves are the list.
  // Stored cards may still reference retired lean-* templates, so this
  // returns whatever is on file rather than only the three seeded above.
  res.json(getDb().prepare(
    'SELECT name, description FROM strategy_templates ORDER BY name',
  ).all());
});
