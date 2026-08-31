# Milestone report — Phase 7: statements

**Dates**: 2026-08-30 → 2026-08-31
**Phase goal**: bank statements become transactions — Tier 0 CSV and Tier 1 PDF.
**Outcome**: shipped-with-deviations — all four tasks are built and tested; the
rule sets are checked against synthetic fixtures because real statements are
personal documents and stay out of the repository.

## Tasks

| Task | Status | Evidence |
|---|---|---|
| 7.1 CSV import with column mapping, dedupe | done | 50 package tests; through the screen, re-importing a file previews "0 to import, 3 already in your ledger" |
| 7.2 PDF text-layer extraction | done | a PDF built byte by byte in the test, read by the real pdf.js in a real browser, producing the same table a CSV would |
| 7.3 Per-bank rule sets, versioned, a fixture each | done, with synthetic fixtures | 13 tests; a rule set without a fixture fails the suite |
| 7.4 Bulk confirm for imported rows | done | imported rows arrive unconfirmed and count toward nothing until accepted |

## Test evidence

491 node tests and 64 browser tests at phase close.

The shape worth noting: a PDF is turned into the same `CsvTable` a CSV import
produces, so one mapping, one row reader and one dedupe serve both. The import
screen needed almost nothing to accept PDFs, and every rule the CSV path was
tested against applies to the PDF path for free.

Rule sets are data — no functions, no compiled behaviour — which is what lets a
fix ship as an over-the-air update rather than an app-store round trip. A test
asserts that by round-tripping each one through JSON.

## Deviations from plan

**The fixtures are synthetic.** The plan asks for a fixture PDF per rule set,
and the corpus of real statements is gitignored by design. What is committed is
the *layout* — the same coordinates, column positions and header wording, with
invented amounts and merchants — which is the part a rule set depends on. The
two shipped rule sets are examples, not real banks.

**Statement import is web-only.** The plan does not say where it lives; the
browser is where files are handled comfortably and where the screens are under
test. The phone can still receive the rows through a backup.

## What this cannot do

- **A scanned statement.** There is no text layer to read, and the screen says
  exactly that rather than showing an empty table. OCR for PDFs is Tier 2 work
  and is not in this phase.
- **A bank whose layout changed.** A rule set that matches the letterhead but
  not the table declines rather than reading the wrong columns — the fallback
  is the same mapping screen every other file gets.
- **Anything the user has not looked at.** Nothing is written until a preview
  has been seen, and imported rows are unconfirmed until accepted.

## Risks carried forward

- **The rule sets have never met a real statement.** The machinery is exercised;
  the specific rules are not. The first real file is likely to need a third rule
  set and to find something about the layout code.
- **Column detection is a heuristic.** A gap recurring on most lines is a
  column, which is right for tabular statements and wrong for one that uses
  ruled boxes or wraps a description across lines. Both exist.
- **Dedupe matches on amount, day and description similarity.** Two identical
  amounts to the same merchant on the same day are treated as one payment plus
  one new row, which is right for a re-download and wrong for someone who really
  did buy two identical coffees and imports twice.

## Next

Phase 8 is voice capture. Before that, the rule-set format is the cheapest thing
to improve with a real file in hand — it is data, so a new bank costs one entry
and one fixture.
