# Devlog

Working notes on StudyBuddy: what changed, why, and what the numbers actually
said. Newest first.

---

## 2026-08-03 → 2026-08-05 — Benchmarking extraction, then fixing what it found

47 files, +5,337 / −296, eleven commits. The benchmark was meant to answer one
question — *is a bigger model worth it* — and instead exposed a class of bug the
pipeline could not see.

### The question

Extraction runs a vision model over each page of an uploaded worksheet. It was
running `qwen2.5vl:7b` because that is what was pulled first, not because
anything had been measured. Bigger models were available. Nobody knew whether
they were better.

### The benchmark

Nine vision-capable models, discovered automatically by asking Ollama's
`/api/show` which ones report a `vision` capability rather than hardcoding a
list — so a model that finished downloading mid-run got picked up, and a
text-only model could not silently score zero for a reason unrelated to its
quality.

The paper: a real 58-page SHSAT practice test, 114 questions. Scored on
**extraction fidelity only** — did the questions come off the page intact.

Ground truth came free. Every printed number 1–114 should appear exactly once
across the paper, which makes the sequence self-validating and made 58 pages
gradeable without labelling any of them by hand.

Pages were rendered at the same DPI, edge cap, and encoding the browser pipeline
uses, then converted to PNG before inference — because the real worker does
exactly that, and Ollama rejects WebP with a 400. An earlier version of the
harness fed WebP and got 400s on every page. Matching production was not
optional.

### Results

| model | recall | missed | blank pages | rows | ms/page | tok/s |
|---|---|---|---|---|---|---|
| **qwen2.5vl:7b** | **99.1%** | 1 | **0** | 114 | **7,811** | 78.9 |
| qwen3-vl:8b | 95.6% | 5 | 1 | 110 | 30,840 | 81.7 |
| qwen3.6:27b *(offloaded)* | 93.0% | 8 | 2 | 106 | 136,095 | 9.2 |
| gemma4:12b | 87.7% | 14 | 4 | 100 | 42,811 | 62.8 |
| qwen3.5:9b | 63.2% | 42 | 12 | 73 | 41,993 | 96.1 |
| deepseek-ocr | 61.4% | 44 | 4 | **464** | 17,970 | 249.5 |
| qwen3.5:4b | 57.0% | 49 | 14 | 71 | 40,488 | 111.8 |

**The model already in production won.** It was the only one that never returned
an empty page, and it was 4× faster per page than anything else. Its single miss
was not even a miss — it extracted question 2 but numbered it `1`, an off-by-one
on page 3.

`qwen3.6:27b`, at nearly four times the size, scored six points *worse* and took
**183 seconds per page against 7.8**. Re-graded on the math section alone
(pages 42–58, questions 58–114) it tied the 7b at a perfect 57/57 — so the
ceiling was already reached, and the two larger models still queued could only
match it or lose. They were cancelled rather than run overnight for nothing.

`deepseek-ocr` failed in the most interesting way: 464 rows for a 114-question
paper, and **0/57 on the math section**. It was transcribing text blocks, not
identifying questions.

### The finding that mattered more than the ranking

Every single missed question, across every model, traced to a page that returned
an **empty response** — not to a question the model misread.

| model | pages returning nothing | misses from actual misreading |
|---|---|---|
| qwen3.5:4b | 14 of 58 | ~0 |
| qwen3.5:9b | 12 of 58 | 3 |
| qwen3-vl:8b | 1 | **0** |
| qwen2.5vl:7b | 0 | 1 (an off-by-one) |

`qwen3-vl:8b` made **zero extraction errors** on the 57 pages it processed. Its
95.6% was one page returning nothing. The whole apparent quality gap between it
and the winner was a single empty reply.

The `qwen3.5` family — general models that merely *report* a vision capability —
blanked on roughly a quarter of pages. Scaling 4b → 9b did not help (14 → 12 is
noise). "Can see an image" and "can reliably transcribe a dense exam page" turn
out to be very different properties.

**And the pipeline had no retry for this.** An empty reply yields zero questions
and no error, so the audit — which only reads printed numbering — saw nothing to
report. On the live app, one empty response silently dropped an entire page while
the worksheet still reported success.

Fixed in `2181169`. Up to three attempts, with temperature raised above zero on
retries: a greedy call that already chose to emit nothing will make the same
choice again given the same input. Confirmed live later the same day, when
`qwen3.5:4b` blanked during a review test and the retry fired twice and logged
before giving up.

### Checking that questions arrived *whole*

The audit reads printed numbering, so a page that produced a question for every
number it owed looked perfect even when those questions were fragments, were
missing options, or carried the choices from the question above. Measured at
about **one row in ten** on the best model.

Three layers, in `1e3bbdf`:

1. **No model needed** — empty stem, no options, an option count below what the
   rest of the paper uses (derived from the worksheet itself), repeated option
   text or labels, options echoed inside the stem.
2. **A small model** on whatever the cheap checks cleared, asked one thing: did
   this come out whole.
3. **Re-read** of doubtful pages by the vision model.

Two safeguards. A doubted question is **only replaced if the second read
actually returns that number** — so a review can never turn a damaged question
into a missing one. And at most 30% of a worksheet's pages are re-read; past
that the extraction is wrong throughout and the student is better served
reaching the review screen than waiting twice as long for the same mistakes.

Flag rates once tuned: 10% on `qwen2.5vl:7b`, 2% on `gemma4:12b`, **52% on
`deepseek-ocr`** — it correctly identifies the model that was not extracting
questions at all.

Reviewer choice measurably matters:

| reviewer | caught | false alarms |
|---|---|---|
| **gpt-oss:20b** | 7/11 | **0** |
| qwen2.5vl:7b (default) | 6/11 | 2/12 |
| qwen3.5:4b | — | returned nothing |

#### A wrong turn worth recording

The first truncation heuristic flagged any stem without closing punctuation.
It fired on **25 of 114 rows of a clean extraction** — all false. They were
ordinary SHSAT stems ending in "by", "through", "that", completed by their own
answer options. Narrowing it to real cut markers (trailing comma, dash, unclosed
quote) removed every false positive and **changed zero re-read decisions**. The
rule had been pure noise.

The 7B reviewer model makes the identical mistake — its two false alarms were
those same sentence-completion stems, despite the prompt explicitly warning
against it. A regex and a 7B model failing the same way on the same input was
the clearest argument for naming a better reviewer in the docs.

---

## 2026-08-04 — Pre-launch pass

### Rate limiting (`5222d1f`)

There was none, anywhere. Counters live in Postgres because the app runs on
serverless functions — an in-process counter resets whenever a new instance
starts, so it limits nothing. Each check is a single upsert, which is what stops
two concurrent requests both reading the same count and both deciding they are
under the limit. The test fires ten at once; exactly three get through.

Signup is keyed by IP (no account exists yet). Upload and explain are keyed by
account, so a shared school connection does not let one student lock out
everyone behind it.

This later broke the E2E suite, which signs up far more than five times an hour
from localhost — the limit throttled the tests long before it would throttle
anyone real. Now switchable via `DISABLE_RATE_LIMITS`, set only in the Playwright
config so a deployment cannot lose protection by omission.

### Topic proposals and trial explanations (`37e7a2f`)

Accepting a topic proposal only flipped its status, and nothing read that status.
The tree never changed, so the next question that did not fit raised the same
proposal again. Accepting now creates the topic under its suggested parent,
carries the proposal's embedding over so it is matchable immediately, clears the
parent's leaf flag, and tags the question that raised it.

Trial explanations returned *"No AI is set up for your account"*, which was never
true. A trial account's model **is** the operator's GPU — and that GPU dials out
and accepts nothing, so the server could not call it. Now queued for the worker
exactly as extraction is, with the client polling a GET so waiting neither spends
the hourly request budget nor re-charges the trial quota.

### Dropping email entirely (`5a25b91`)

Resend rejected `trystudybuddy.vercel.app` with *"We don't allow free public
domains."* Sending to arbitrary addresses requires publishing SPF and DKIM
records, and a free `*.vercel.app` subdomain cannot carry them — no provider will
accept it.

Google already sidestepped all of it: the `signIn` callback marks an account
verified when Google confirms the address, so a Google user never touched Resend.
It is now the primary button on both screens.

The tradeoff is real and written into SETUP: a password account is created ready
to use and never verified, so someone can register an address they do not own,
and since nothing can send mail there is no password reset either. Google is the
only path that proves anything.

The password form was briefly folded into a `<details>` disclosure. Backed out —
hiding a login form behind a click is friction for no gain, and it made the
fields genuinely invisible to the tests. Both forms stay visible; Google carries
the emphasis through styling instead.

### A real bug surfaced by a 422

Debugging that Resend error turned up verification links pointing at
`https://host//verify?token=…`. The deployed base URL ends in a slash and the
path was joined straight onto it. A path beginning with two slashes is not the
same route, and a host that redirects to tidy it is free to drop the query string
on the way — taking the token with it. The worker already stripped trailing
slashes; three other readers did not. Fixed in `2e0cd28`.

The same request body appeared to be missing its line breaks. It was not — the
source has `\n\n` and the capture tool collapsed them. Worth verifying before
claiming a bug.

### E2E: 2 → 7 of 9 (`58b564e`)

None of the five failures were app bugs:

- The confirm button had been renamed to "Looks Right, Mark N Question" during
  the copy pass; the spec still asked for "Confirm N Question".
- An unscoped `getByRole('option')` matched the question-type `<select>`, whose
  native options a browser reports as hidden.
- A bare text match for `'105'` found the question stem, which quotes every
  option, before it found the option.
- The topic assertion matched both places a chosen topic is displayed.

A note in my own earlier summary claimed `journey.spec.ts:44` was failing. It
was not — the drag test passes, and the failure had moved. Stale notes are worse
than no notes.

**The ninth is a genuine product question, left failing on purpose.** FSRS puts
a missed card on a one-minute learning step, so `/review` correctly reports
nothing due. The test asserts a student who just marked a worksheet can review
misses *now*. Either the scheduler wins and the test changes, or the review query
gets a learning-ahead window (what Anki does). Not a call to make silently.

---

## 2026-08-05 — Concurrency

Question: would reading pages in parallel be worth it? Answered from the
benchmark data rather than intuition.

| phase | time | share |
|---|---|---|
| Decode | 266 s | **59%** |
| Prefill | 171 s | 38% |
| Model load | 15 s | 3% |

Decode at one request in flight is bandwidth-bound and leaves the card idle
between token reads, so overlapping it is nearly free. Prefill — 3,566 prompt
tokens per page, 9.8 prefill tokens per generated token, all image patches — is
compute-bound and already saturates. Amdahl's law with 59% parallelisable caps
the gain near **1.7×** however many slots are opened.

Shipped in `c351b67`: packets over 15 pages or 30 questions read two pages at a
time; short worksheets stay sequential, where the saving is seconds and the
memory is better spent keeping a long packet inside VRAM.

**A correction I had to make to my own advice.** I first said the context
reservation was mostly waste — "using ~3,900 tokens against 32,768". That was
the *mean*. The densest page measured wanted 10,182 prompt tokens and hit the
full 8,192 output cap: **18,374 worst case**. Sizing `num_ctx` off the average
would have truncated exactly the pages carrying the most questions. Settled at
24,576, which still frees enough for a second slot.

**Resume had to change with it.** The checkpoint recorded a high-water page
number, and *"everything up to N is done"* stops being true the moment pages
finish out of order — a crash would have silently skipped whatever was still
running below N, leaving a gap the audit would then chase as a model failure. It
now records the set of finished pages. Shipping concurrency without this would
have traded ninety seconds for silent data loss.

### Why not the NPU

The machine has one — `Intel(R) AI Boost` on a Core Ultra 9 275HX. Two reasons
it is unused, and the second settles it.

Ollama is llama.cpp underneath; its backends are CUDA, ROCm, Metal, Vulkan,
SYCL and CPU. There is no NPU backend, and Intel's NPU is only reachable through
OpenVINO or DirectML. There is no switch to flip.

And it would be a large downgrade regardless. That NPU is around 13 TOPS against
an RTX 5080 Laptop in the hundreds — roughly a 30–70× cut in compute for the
one phase that is compute-bound. The memory picture is as lopsided: NPUs share
system RAM at roughly 100 GB/s where the 5080 has GDDR7 near a terabyte per
second. A split design would also have to ship a ~3,500-token embedding tensor
across PCIe every page.

---

## Open

- **Tier B uploads land untagged.** Needs a hosted embedding API or routing Tier
  B through a worker, plus recomputing all 290 topic embeddings — vectors from
  different models are not comparable.
- **Tier C (student's own Ollama) is not wired.**
- **The review-window question above** — scheduler or test, someone has to pick.
- **Rate limiting covers four endpoints.** Rating a card, editing a question and
  saving credentials are unbounded; all need a session and touch only the
  caller's own rows, so the exposure is small but not zero.
- **VRAM headroom.** `nvidia-smi` showed 13 GB of 16 GB occupied with Ollama
  stopped. Two slots at 24,576 context need ~11 GB on top of the 5.6 GB model.
  Worth checking before a large run: overflowing is not a gentle slowdown but a
  drop from 79 tok/s to 9.2.

## Standing lessons

- **Verify before asserting.** The PID logging that found the connection bug, the
  rendered swatches for colour, the live DB query for page 3, the dry run of the
  merge planner — every one changed the conclusion.
- **Measure the distribution, not the average.** The `num_ctx` mistake and the
  truncation heuristic were the same error twice.
- **A rule that fires often is not necessarily a rule that works.** 25 flags, all
  wrong, zero effect on outcomes.
- **Flag, do not delete.** Dedupe, the review pass and the audit all decline to
  destroy a student's data on a guess. Page 4 of one worksheet proved numeric
  labels can be legitimate; a label-only dedup rule would have deleted a real
  question.
