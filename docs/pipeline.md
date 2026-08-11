# The repair pipeline

What happens to a question between the model reading it off a page image and a
student seeing it, and why the steps run in the order they do.

This is the most subtle logic in the system and it has already been got wrong
once: the ordering lived in four places, in four different orders, and two of
them were missing passes entirely, so a question cut in half by a page break
stayed cut in half for anyone using their own cloud key. It lives in
`lib/worker/pipeline.ts` now, as one function with one order.

Read this before changing that order, and update it if you do.

---

## Where a question comes from

A page is rasterised in the browser, uploaded as an image, and read by a vision
model one page at a time. That gives a row per question, and everything below
exists because reading a page in isolation cannot get certain things right:

- a question that starts on page 3 and finishes on page 4 is two rows
- options printed under a stem the model already returned get attached to the
  next question instead
- a solutions page at the back looks like a second copy of the paper
- LaTeX that a JSON parser ate arrives as a control character and some letters
- a number the model misread puts a question in the wrong place

Each pass repairs one of those. Each is idempotent, because the set runs more
than once: a split only becomes visible after both halves are stored, and the
re-read passes keep adding rows after the first run.

---

## The order

| # | Pass | Fixes | Must run after |
|---|---|---|---|
| 1 | `join` | A question split across a page break | nothing |
| 2 | `carried` | Options attached to the wrong question | `join` |
| 3 | `math` | LaTeX destroyed before it was stored | `carried` |
| 4 | `numbers` | A misread printed number | `math` |
| 5 | `merge` | The same question stored twice | `numbers` |
| 6 | `renumber` | Ordinals, once the row set is final | everything above |
| 7 | `answers` | Ticks from the paper's own answer key | `renumber` |

The dependencies are the point. In each case running the pass earlier produces
a wrong answer rather than a slower one.

**`join` first.** Everything downstream counts, numbers or attaches options to
rows. If a question is still in two pieces, all of them operate on halves.

**`carried` after `join`.** A question made whole from two rows already carries
the options that were on the second half. Recovering options off the page text
first would hand it the same four twice.

**`math` before anything hash-sensitive.** It rewrites mangled notation and
recomputes the content hash. Two copies of one question that differ only in
whether `\frac` survived the JSON parser hash differently until this has run, so
the merge below cannot see them as duplicates. This is why `math` is not simply
cosmetic and cannot be deferred to display time.

**`numbers` before `merge`.** A recovered printed number changes which question
a row *is*, and the merge folds by printed number among other things.

**`merge` before `renumber`.** The surviving row inherits the number the folded
one was occupying, so the numbering has to still be the paper's at that point.

**`renumber` after everything that adds, drops or moves a row.** Anything
written after it takes the next free ordinal, which is what once put a re-read
question at 135 on a 114-question paper.

**`answers` last.** The answer key matches on the printed number, so it can only
run once every pass that can change a printed number has finished.

---

## The two entry points

Both are `runRepairPasses(db, worksheetId, { only })`. `only` filters the
canonical order; it cannot reorder it, which is the reason it is a filter and
not a list.

`VERIFYING_PASSES` — `join`, `carried`, `math`, `merge`. Run while pages are
still arriving. Numbering is deliberately excluded: the coverage audit and the
review pass both still add and replace rows after this point.

`FINAL_PASSES` — all seven. Run once the last re-read is in.

Four callers, and they must stay in agreement:

| Caller | Passes | When |
|---|---|---|
| `app/api/worker/jobs/[jobId]` | verifying, then final | the GPU worker's job, per phase |
| `lib/worker/server-job.ts` | final | a cloud key, extraction on the server |
| `scripts/audit-worksheets.ts` | final | operator, repairing stored papers |
| `scripts/repair-missing-options.ts` | selected | operator, one targeted repair |

---

## What it reports

`RepairCounts` is what each pass changed, and one field that is not a count of
work at all:

`duplicateNumbers` is the printed numbers two questions still both claim after
everything has run. It is what the renumber pass could not reconcile, and in
practice it is the tell that a solutions page at the back of the paper was read
as a second copy of the questions. A non-empty list here is worth looking at by
hand; the pipeline deliberately does not guess which of the two to drop.

---

## Adding a pass

1. Write it as `(db, worksheetId) => Promise<{ ...count }>`, idempotent.
2. Put it in `ORDER` at the position its dependencies require, and say in the
   doc comment which passes it must follow and why.
3. Add its count to `RepairCounts` and `NONE`.
4. Decide whether it belongs in `VERIFYING_PASSES`: it does only if it is safe
   to run while rows are still being added.
5. Add a row to the table above.

The one rule that is not negotiable: nothing that can change a printed number
may run after `renumber`, and nothing that can change the row set may run after
`answers`.
