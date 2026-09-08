# Backfill report: DMR-2025-fall

Last run 90a70aa1-02ea-455e-a3c7-743ee7f12cd7 (2026-09-05T06:41:50.263Z .. 2026-09-05T06:43:08.855Z), range 2025-07-18..2026-08-30, engine lean-1.1, template lean, bankroll $200.00 / min $5.00.

## Summary

- Days: 14 - queued 2, saved 12
- Cross-source (dmtc vs Equibase): 0 day(s) checked, 0 ticket disagreement(s)
- Regression line: 0 unexplained difference(s)
- Calendars NOT archived: 2026-01, 2026-02, 2026-03, 2026-04, 2026-05, 2026-06 (fetch with --what calendar)

### Warnings by type

- finish_order_conflict: 1
- foreign_program (blocking): 2
- incomplete_entry: 15
- index_renumbered: 15
- owner_trainer_fused: 4
- program_ml_disagreement: 22
- unrecognized_mutuel: 28

### P/L by completeness bucket (never pooled)

| bucket | days | wagered | effective | returned | P/L | ROI | eff. ROI |
| --- | --- | --- | --- | --- | --- | --- | --- |
| PROGRAM_ONLY | 12 | $2400.00 | $2288.00 | $1909.30 | -$490.70 | -20.4% | -21.4% |

## Days

| date | status | races cal/parsed/results | warnings block/non | completeness | results | cross | engine | wagered | effective | returned | P/L | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 2025-10-31 | queued | -/10/10 | 1 / 4 | - | - | - | - | - | - | - | - | 1 blocking warning(s): the program is a foreign publication (not a Del Mar program) - the day would save sheet-only |
| 2025-11-01 | queued | -/12/12 | 1 / 3 | - | - | - | - | - | - | - | - | 1 blocking warning(s): the program is a foreign publication (not a Del Mar program) - the day would save sheet-only |
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

- 2025-10-31: queued - 1 blocking warning(s): the program is a foreign publication (not a Del Mar program) - the day would save sheet-only [foreign_program]
- 2025-11-01: queued - 1 blocking warning(s): the program is a foreign publication (not a Del Mar program) - the day would save sheet-only [foreign_program]
