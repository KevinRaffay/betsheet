import React from 'react';

// FAQ (D412): the questions a first-time reader of this app asks, answered in
// a few sentences each. READ-ONLY and STATIC - no fetch, no state, nothing
// here is derived from the corpus. Every answer is sourced from README.md and
// CLAUDE.md's invariants and house rules; when one of those changes, the
// matching entry here changes in the same commit, or this page becomes a
// second, staler copy of the rule (the exact drift CLAUDE.md's own trims were
// spent undoing). The list is data rather than JSX per item so a new question
// is one object, not a new block of markup.

const FAQ = [
  {
    q: 'What is BetSheet?',
    a: (
      <>
        <p>
          A local-only betting simulator and strategy analyzer for horse racing. You ingest a race day
          cheaply, capture betting cards from several sources with clean labels, grade them against
          uploaded results, and analyze the graded cards across every dimension that might matter.
        </p>
        <p>
          The thesis is that strategy emerges from volume, not from design: as many graded cards as
          possible, from as many tracks, sources and models as possible, each labelled cleanly enough
          that patterns become visible when sliced any way you like. The one rule everything else serves
          is <strong>benchmark first, bet later</strong>.
        </p>
      </>
    ),
  },
  {
    q: 'Where do the cards come from?',
    a: (
      <>
        <p>Three producers, each writing its own tickets and each kept in its own reporting bucket:</p>
        <ul>
          <li><strong>Equibase &ldquo;Off to the Races&rdquo;</strong> &mdash; the free at-track sheet, its printed tickets taken verbatim (<code>EQB_OTR</code>).</li>
          <li><strong>An LLM</strong> &mdash; generated one race at a time from the entries, the tip sheets and analyst notes on file (<code>LLM_GENERATED</code>). Open a race day and click <em>Generate Card from LLM</em>.</li>
          <li><strong>You</strong> &mdash; typed as teller strings or built in the ticket builder (<code>HUMAN</code>). Open a race day and click <em>Build card by hand</em>.</li>
        </ul>
        <p>Nothing generates a card from rules any more. The consensus engine that used to was removed on 2026-09-05; its corpus is frozen, readable and still graded.</p>
      </>
    ),
  },
  {
    q: 'How do I add a race day?',
    a: (
      <>
        <p>
          Click <em>New race day</em> on the home page, set the track, date and bankroll, then choose a
          source: paste the markup of the track&rsquo;s Equibase entries page (view source, or save it as HTML),
          upload one zip of saved entries pages to create every race day it holds, or run a live Apify pull.
        </p>
        <p>
          Every path shows a read-only preview first, warnings at the top, and nothing is written until
          you confirm it. A correction is made at the source (fix the pasted text and re-parse), never by
          hand-editing the preview.
        </p>
      </>
    ),
  },
  {
    q: 'How do results get in, and when does grading happen?',
    a: (
      <>
        <p>
          Open the race day, expand <em>Results</em>, and paste the Equibase chart text, upload the chart
          PDF, or run the Apify results pull. Every card on the day is graded automatically the moment
          results land, and a graded result is immutable per card and engine version: a regrade under the
          same version replaces its set, a newer version appends one, and older sets stay readable.
        </p>
      </>
    ),
  },
  {
    q: 'Why doesn’t it fetch entries and results from Equibase on its own?',
    a: (
      <>
        <p>
          Equibase blocks scripted fetching, so BetSheet never sends it a request. Every source of data is
          a file a person chose to paste or upload. The one exception is the on-demand Apify pull, which
          runs a scraper on infrastructure you pay for, one call at a time, when you press the button or run
          the pull script. There is no scheduling of any kind, and each call costs real money, so the UI
          says so before it runs.
        </p>
      </>
    ),
  },
  {
    q: 'Why don’t the P/L and distribution totals add up across buckets?',
    a: (
      <>
        <p>
          Because completeness buckets never pool. Every card records the level of the sources that
          actually contributed (<code>HUMAN</code>, <code>LLM_GENERATED</code>, <code>EQB_OTR</code>, and
          the engine-era levels on the frozen corpus), and every P/L, simulation and distribution figure is
          reported per bucket and per engine version. A human card and an LLM card never share an
          aggregate, and P/L never pools across versions unless you explicitly choose &ldquo;all
          versions&rdquo;.
        </p>
      </>
    ),
  },
  {
    q: 'What does the n beside every figure mean?',
    a: (
      <>
        <p>
          The number of cards, tickets or races behind it. The house discipline is <strong>label
          everything, conclude nothing until n is stated</strong>: no P/L figure is reported without its n,
          a rate prints as <code>hits/n</code>, and a dash at n=0 is deliberate rather than a zero. The
          project&rsquo;s own motivating anecdote once turned out to rest on one card and three graded
          tickets, which is why.
        </p>
      </>
    ),
  },
  {
    q: 'What is Replay?',
    a: (
      <>
        <p>
          A way to play a stored race day blind, one race at a time, and be scored honestly against the
          results that were already on file. You lock your picks for a race before its result is revealed,
          and whether a played day counts as pre-commit, sequential or non-blind is computed from the lock
          and reveal timestamps, never from a flag anyone sets. The standing table on the Replay page
          reports human P/L by that derived blindness.
        </p>
      </>
    ),
  },
  {
    q: 'What is the difference between deleting a race day and replacing it?',
    a: (
      <>
        <p>
          <em>Delete race day</em> is soft: it hides the day from every list and aggregate, and
          <em> Show deleted</em> on the home page restores it. Saving a day over an existing one with
          <em> replace</em> is a hard delete of the old day and every card and ticket on it, with no undo,
          before the replacement is saved under a fresh id. Check what is on a day before replacing it.
        </p>
      </>
    ),
  },
  {
    q: 'What does Wipe everything in the Danger zone do?',
    a: (
      <>
        <p>
          A factory reset. It deletes every stored record and every log file together and restarts the id
          sequence. There is no undo. Experiment on a separate scratch clone instead; the README describes
          how to set one up so the main corpus cannot be reached by mistake.
        </p>
      </>
    ),
  },
  {
    q: 'Can I open this on my phone?',
    a: (
      <>
        <p>
          Not this app. The server binds the loopback address only, so it is reachable from this machine
          and nowhere else, and the desktop layout is the only one it supports. The phone surface is the
          static at-track viewer published to GitHub Pages: <em>Publish snapshot</em> on the home page
          builds its payload from the race days, cards and grades already stored here.
        </p>
        <p>
          A Pages site is publicly readable even from a private repository. The payload carries entries,
          morning lines, cards and grades, and never anything about the person who built it.
        </p>
      </>
    ),
  },
  {
    q: 'Where do the live odds come from?',
    a: (
      <>
        <p>
          You type them, per race, at post time. Equibase does not publish the tote board in any form this
          app can read: the entries page has the column, but it is filled by a script in a live browser and
          is empty in every saved copy and in the Apify output alike. The morning line is the only price
          that arrives with the entries.
        </p>
      </>
    ),
  },
  {
    q: 'What do the steam and drift tags on a horse mean?',
    a: (
      <>
        <p>
          A move between the morning line and the typed board, measured after both books have been
          normalised over the same runners so a scratch or a fat book cannot forge one. A tag is a label,
          never a recommendation: whether to follow the steam or take the drifter is exactly the kind of
          question the corpus exists to answer with an n attached.
        </p>
      </>
    ),
  },
  {
    q: 'What does Generate Card from LLM need?',
    a: (
      <>
        <p>
          An <code>ANTHROPIC_API_KEY</code> in the <code>.env</code> file. Without one the preview shows a
          visible error and nothing is called or saved. Generation is one race at a time, the model&rsquo;s
          reasoning is kept with the card, and any line the model writes that the track does not sell is
          refused and logged while the legal tickets from the same race are saved.
        </p>
      </>
    ),
  },
  {
    q: 'Why do the times not match my clock?',
    a: (
      <>
        <p>
          Every timestamp is stored in UTC and shown in Pacific Time, whatever zone the browser is in. Post
          times on the calendar are converted from each track&rsquo;s own zone for the same reason, so two
          tracks on one date line up on one grid.
        </p>
      </>
    ),
  },
  {
    q: 'Is this a betting tip service?',
    a: (
      <>
        <p>
          No. BetSheet is an entertainment-wagering planning tool built around pre-committed budgets and no
          mid-card increases. It warns when planned bets exceed the stated bankroll, and every figure it
          reports is a measurement of what happened, not advice about what will.
        </p>
      </>
    ),
  },
];

export default function FaqView({ onBack }) {
  return (
    <section className="faq">
      <div className="pagehead">
        <h2>FAQ</h2>
        <div className="btnrow">
          <button className="btn" onClick={onBack}>Back</button>
        </div>
      </div>

      <p className="dim">
        Short answers to the questions this app gets asked first. The working notes in the repository
        (<code>README.md</code> and <code>CLAUDE.md</code>) are the record these are taken from.
      </p>

      <ol className="faq__list">
        {FAQ.map((item) => (
          <li key={item.q} className="faq__item">
            <h3 className="faq__q">{item.q}</h3>
            <div className="faq__a">{item.a}</div>
          </li>
        ))}
      </ol>
    </section>
  );
}
