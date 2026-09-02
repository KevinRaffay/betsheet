# Backfill report: DMR-2025-fall

Last run 51ef7e28-cd24-4e82-80e2-96ecd86262bd (2026-09-02T13:28:39.372Z .. 2026-09-02T13:28:39.522Z), range 2025-10-31..2025-11-30, engine lean-1.1, template lean, bankroll $200.00 / min $5.00.

## Summary

- Days: 14 - resolved 2, saved 12
- Cross-source (dmtc vs Equibase): 0 day(s) checked, 0 ticket disagreement(s)
- Regression line: 0 unexplained difference(s)

### Warnings by type

- finish_order_conflict: 1
- foreign_program (blocking): 2
- incomplete_entry: 15
- index_renumbered: 15
- owner_trainer_fused: 4
- program_ml_disagreement: 22
- unrecognized_mutuel: 21

### P/L by completeness bucket (never pooled)

| bucket | days | wagered | effective | returned | P/L | ROI | eff. ROI |
| --- | --- | --- | --- | --- | --- | --- | --- |
| PROGRAM_ONLY | 12 | $2400.00 | $2288.00 | $1909.30 | -$490.70 | -20.4% | -21.4% |

## Days

| date | status | races cal/parsed/results | warnings block/non | completeness | results | cross | engine | wagered | effective | returned | P/L | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 2025-10-31 | resolved | -/-/- | 1 / 0 | - | - | - | - | - | - | - | - | confirmed from the queue 2026-09-02T13:14:12Z - Breeders Cup day: the program URL serves the BC official program (foreign); saved sheet-only, ODDS_ONLY tier - no program analysis exists for this card; the saved day was later deleted - left out |
| 2025-11-01 | resolved | -/-/- | 1 / 0 | - | - | - | - | - | - | - | - | confirmed from the queue 2026-09-02T13:14:23Z - Breeders Cup day: the program URL serves the BC official program (foreign); saved sheet-only, ODDS_ONLY tier - no program analysis exists for this card; the saved day was later deleted - left out |
| 2025-11-02 | saved | -/9/9 | 0 / 5 | PROGRAM_ONLY | dmtc_html | - | lean-1.1 | $200.00 | $199.00 | $211.70 | $11.70 | 5 non-blocking warning(s) |
| 2025-11-07 | saved | -/8/8 | 0 / 6 | PROGRAM_ONLY | dmtc_html | - | lean-1.1 | $200.00 | $189.00 | $198.10 | -$1.90 | 6 non-blocking warning(s) |
| 2025-11-08 | saved | -/9/9 | 0 / 7 | PROGRAM_ONLY | dmtc_html | - | lean-1.1 | $200.00 | $200.00 | $232.90 | $32.90 | 7 non-blocking warning(s) |
| 2025-11-09 | saved | -/9/9 | 0 / 6 | PROGRAM_ONLY | dmtc_html | - | lean-1.1 | $200.00 | $160.00 | $105.20 | -$94.80 | 6 non-blocking warning(s) |
| 2025-11-14 | saved | -/8/8 | 0 / 1 | PROGRAM_ONLY | dmtc_html | - | lean-1.1 | $200.00 | $199.00 | $136.50 | -$63.50 | 1 non-blocking warning(s) |
| 2025-11-16 | saved | -/9/9 | 0 / 9 | PROGRAM_ONLY | dmtc_html | - | lean-1.1 | $200.00 | $191.00 | $363.70 | $163.70 | 9 non-blocking warning(s) |
| 2025-11-22 | saved | -/9/9 | 0 / 0 | PROGRAM_ONLY | dmtc_html | - | lean-1.1 | $200.00 | $200.00 | $86.40 | -$113.60 | clean parse |
| 2025-11-23 | saved | -/9/9 | 0 / 6 | PROGRAM_ONLY | dmtc_html | - | lean-1.1 | $200.00 | $191.00 | $144.70 | -$55.30 | 6 non-blocking warning(s) |
| 2025-11-24 | saved | -/9/9 | 0 / 5 | PROGRAM_ONLY | dmtc_html | - | lean-1.1 | $200.00 | $177.00 | $97.30 | -$102.70 | 5 non-blocking warning(s) |
| 2025-11-28 | saved | -/9/9 | 0 / 6 | PROGRAM_ONLY | dmtc_html | - | lean-1.1 | $200.00 | $200.00 | $42.00 | -$158.00 | 6 non-blocking warning(s) |
| 2025-11-29 | saved | -/11/11 | 0 / 10 | PROGRAM_ONLY | dmtc_html | - | lean-1.1 | $200.00 | $182.00 | $169.60 | -$30.40 | 10 non-blocking warning(s) |
| 2025-11-30 | saved | -/9/9 | 0 / 17 | PROGRAM_ONLY | dmtc_html | - | lean-1.1 | $200.00 | $200.00 | $121.20 | -$78.80 | 17 non-blocking warning(s) |

## Backfill queue

- 2025-10-31: resolved - confirmed from the queue 2026-09-02T13:14:12Z - Breeders Cup day: the program URL serves the BC official program (foreign); saved sheet-only, ODDS_ONLY tier - no program analysis exists for this card; the saved day was later deleted - left out [foreign_program]
- 2025-11-01: resolved - confirmed from the queue 2026-09-02T13:14:23Z - Breeders Cup day: the program URL serves the BC official program (foreign); saved sheet-only, ODDS_ONLY tier - no program analysis exists for this card; the saved day was later deleted - left out [foreign_program]
