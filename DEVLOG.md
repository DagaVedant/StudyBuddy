# Devlog posts

Ready to paste, one per chunk of work. Each is 3 to 6 sentences with a visual.
Post them in order as you log the matching hours.

**Visual status:** `devlog/media/benchmark.png` is generated and ready. The rest
need a screenshot or a 20 second screen recording, noted under each post. Grab
them before you post; reconstructing later is how devlogs get skipped.

---

## 1. Redesigned the whole app around soft pastels

**Visual:** before/after screenshot of the dashboard, side by side.

The app worked but looked like a database admin panel, so I redesigned it around
a soft pastel palette that suits a study tool for students. I built four mockup
directions first instead of jumping straight into code, which saved me from
redoing it twice. The annoying part was contrast: my first muted text colour
measured 4.0:1 against the pastel tiles and WCAG wants 4.5:1, so I had to darken
it and recheck every tint. Then my new accent and danger colours drifted so close
together that a delete button read as a normal one, and I only caught it by
rendering the actual RGB swatches side by side instead of trusting the numbers.

---

## 2. Spent an afternoon on a 500 error that was three separate bugs

**Visual:** screenshot of the 500 error page, or the terminal stack trace.

Upload finished, then died with a 500. I assumed one bug and found three stacked
on top of each other. Vercel Blob needed `access: 'private'` and a different read
path than the one I had written; the embeddings library was being imported at the
top of a module, which dragged a native ONNX runtime into a serverless function
that has no such thing, killing the route before any of my code ran; and signup
had a dead end where a failed email left the account created but unreachable.
The lesson was that "it worked locally" and "it works on serverless" are barely
related claims.

---

## 3. Cancel now actually cancels

**Visual:** short screen recording of hitting cancel mid-upload and it stopping
instantly.

Pressing cancel during an upload used to finish the current page first, which
could mean waiting several seconds while the UI said it had stopped. Now an
AbortSignal is threaded all the way down through PDF rasterization and the OCR
worker, so the render task is cancelled and the worker terminated the moment you
click. The subtle bit was cleanup: I had the listener removal inside a `.finally()`
and a test caught it lingering an extra microtask, which is exactly the kind of
thing that becomes a memory leak nobody can reproduce.

---

## 4. Found a question that got split in two, and did not trust the obvious fix

**Visual:** screenshot of the two duplicate rows in the database or the review
screen.

The AI read question 1 on page 3 as two separate questions, which inflated the
count and pushed every following number off by one. The obvious fix is to delete
rows whose label style looks wrong, so I checked that against the real worksheet
first: page 4 has legitimate numeric labels, and a label only rule would have
deleted a real question. One false positive out of two. So the merge rule now
requires the answer choices of one row to be contained inside the other, and it
only ever merges pairs. I would much rather show one question too many than
silently delete someone's homework.

---

## 5. Benchmarked 9 vision models and the one I was already using won

**Visual:** `devlog/media/benchmark.png` (ready to attach)

![benchmark](devlog/media/benchmark.png)

I had picked `qwen2.5vl:7b` because it was the first thing I pulled, so I built a
harness to actually measure it: 9 models, a real 58 page SHSAT paper, 114
questions, scored on whether the questions came off the page intact. Ground truth
was free because every printed number 1 to 114 should appear exactly once, which
makes the paper grade itself. The 7b won at 99.1% and was 4x faster per page than
anything else. The 27b model, at nearly four times the size, scored six points
worse and took 183 seconds per page against 7.8.

---

## 6. Every single miss was the same bug, and it was mine

**Visual:** screenshot of the miss table, or the terminal showing
`generated nothing on attempt 1, asking again`.

Digging into the benchmark results, every missed question across every model
traced to a page that returned an empty response, not to a question the model
misread. One model blanked on 14 of 58 pages. The worst part was realising my
pipeline had no retry for it: an empty reply produces zero questions and no
error, so the audit saw nothing wrong and the worksheet still reported success
while an entire page silently vanished. One retry with the temperature nudged
above zero fixes it, because a greedy call that already chose to emit nothing
will make the same choice again given identical input.

---

## 7. Taught the app to notice when a question arrives broken

**Visual:** screenshot of the worker log showing
`review: N of M questions look wrong, re-reading X pages`.

The audit only checked that the numbering had no gaps, so a page that produced a
question for every number it owed looked perfect even when those questions were
fragments or missing half their answer choices. That was about one row in ten.
My first truncation rule flagged any stem that did not end in punctuation, and it
fired on 25 of 114 rows of a clean run, every one of them wrong: real test
questions routinely end with "by" or "through" and are finished by their own
answer options. Narrowing it to real cut markers removed every false positive and
changed exactly zero decisions, so the rule had been pure noise the whole time.

---

## 8. Killed my email provider and made Google the front door

**Visual:** screenshot of the Resend error, "We don't allow free public domains."

Signup was broken for everyone except me, because sending email to real addresses
needs a domain you own so SPF and DKIM records can be published, and a free
`.vercel.app` subdomain cannot carry those. Resend rejected it outright and so
would anyone else. Rather than pay for a domain I deleted the entire email path,
which turned out to be easy because Google sign-in already skipped it: the OAuth
callback marks the address verified, so those users never touched email at all.
274 lines deleted and signup works for real people now.

---

## 9. Added rate limiting, then it immediately blocked my own tests

**Visual:** screenshot of the test run going red, then green.

There was no rate limiting anywhere, so I added it: counters in Postgres rather
than memory, because serverless spins up new processes constantly and an
in-process counter would reset before it ever limited anything. The whole check
is a single upsert so two simultaneous requests cannot both read the same count
and both decide they are under the limit, which a test with ten concurrent
requests confirms. Then my end to end suite went red, because it signs up far
more than five times an hour from localhost and my own limit was throttling it.
Now it is switchable, and only the test config switches it off.

---

## 10. Made long packets read pages in parallel, for a smaller win than I expected

**Visual:** screenshot of the worker log showing `reading 2 pages at a time`, or a
timing comparison.

I wanted to know if parallel page reads were worth it, so I checked the benchmark
timings instead of guessing: 59% of the time is decode and 38% is prefill.
Decode is bandwidth bound and overlaps almost for free, but prefill already
saturates the GPU, which caps the whole thing at about 1.7x no matter how many
pages I run at once. I also had to walk back my own advice on context size after
checking the distribution: I said the reservation was mostly wasted based on the
3,900 token average, but the densest page wanted 18,374, and sizing on the
average would have truncated exactly the pages carrying the most questions.
The sneaky part was resume, which tracked a high water page number, and "done up
to N" stops being true the second pages finish out of order.

---

## Posts still to write

These are chunks from earlier in the project that I do not have visuals for. If
you have old screenshots, they are worth writing up:

- Building the browser side PDF rasterizer and Tesseract OCR pipeline
- FSRS scheduling and the review session
- The weakness dashboard and how topics get ranked
- Moving classification onto the GPU worker
- The extraction review editor and drag to create a question
