# StudyBuddy

Upload the practice worksheets you've already done. StudyBuddy pulls out every
question, tracks which ones you got wrong, and tells you what to study next,
with a spaced-repetition schedule that actually sticks.

Full product and technical spec: [`spec.md`](./spec.md).

Everything below is setup, deployment and the things that will bite you. Steps
1 to 4 get it running on your laptop, in about twenty minutes. Steps 5 to 7 put
it on the internet, in another fifteen. Step 8 is your GPU, and is optional.

---

## 1. Database

The only thing that actually blocks you. You need Postgres with `pgvector`;
[Neon](https://neon.tech) has a free tier and takes two minutes.

Create a project, then copy the **pooled** connection string, not the direct
one. Serverless opens and drops connections constantly and the direct endpoint
runs out.

`.env.local` does not exist in a fresh clone. It is gitignored and nothing
creates it, so make it first, then put the connection string in it as
`DATABASE_URL`.

```bash
cp .env.example .env.local
```

You do not need to create tables or enable pgvector by hand. Step 3 does both.

## 2. Secrets

`.env.example` ships `AUTH_SECRET`, `CREDENTIALS_ENC_KEY` and
`WORKER_API_TOKEN` empty. Generate your own and never commit the result.

```bash
npm run gen:secrets
```

Paste the lines it prints over the matching ones in `.env.local`. While you are
in there, set your real admin emails:

```
ADMIN_EMAILS="your@email.com,someone@else.com"
```

Admin is granted at login by matching the signed-in email against that list. It
gives you unlimited upload length, the topic-proposal queue at `/admin/topics`,
and the rest of the console. There is deliberately no way to grant it from the
UI.

## 3. Schema and topic tree

```bash
npm install
npm run db:migrate
npm run db:seed
npm run db:embed
```

| Command | Effect |
|---|---|
| `db:migrate` | Enables pgvector, creates 25 tables |
| `db:seed` | Loads 341 topics (276 classifiable leaves) |
| `db:embed` | Computes topic embeddings; auto-classification needs these |

`db:embed` downloads a ~23MB model on first run and takes a minute or two.

## 4. Run it

```bash
npm run dev
```

Open http://localhost:3000 and create an account. That is a working app.

---

## 5. Put it on GitHub

The repo is already initialised and committed. You just need a remote. Create
one at https://github.com/new, named `studybuddy`, and do **not** tick "Add a
README", ".gitignore" or a licence: the repo has them and it will conflict.

```bash
git remote add origin https://github.com/YOUR-USERNAME/studybuddy.git
git branch -M main
git push -u origin main
```

`.env.local` is gitignored, so your secrets do not go up. Worth confirming once:

```bash
git ls-files | grep env
```

That should print only `.env.example`.

## 6. Deploy to Vercel

Sign in with GitHub, **Add New → Project**, import `studybuddy`. It
auto-detects as Next.js; do not change the build settings. Before deploying,
add the environment variables:

| Name | Value |
|---|---|
| `DATABASE_URL` | your Neon pooled string |
| `AUTH_SECRET` | from `npm run gen:secrets` |
| `CREDENTIALS_ENC_KEY` | from `npm run gen:secrets` |
| `ADMIN_EMAILS` | your emails, comma-separated |
| `WORKER_API_TOKEN` | from `npm run gen:secrets` |
| `WORKER_ALLOWED_IPS` | see below; `*` if you have not decided yet |
| `CRON_SECRET` | from `npm run gen:secrets` |
| `NEXT_PUBLIC_APP_URL` | `https://your-project.vercel.app` |
| `ENABLE_MOCK_AI` | leave empty |

`vercel.json` registers a cron on `/api/cron/drain-server-queue`, which is the
drain for worksheets processed against a student's own cloud key. Without it,
that work only ran piggybacked on whichever upload happened to enqueue it.
Vercel adds the `Authorization: Bearer $CRON_SECRET` header itself once that
variable is set.

The schedule is daily rather than every five minutes, because Vercel's Hobby
plan only allows daily crons and the `*/5` it shipped with was failing every
deploy at the cron step. A job that strands past its retry ceiling can wait up
to 24 hours. Put it back to `*/5` if you move to a plan that allows it.

**Migrations do not run from the build.** `prebuild` skips them on any Vercel
deployment, preview included, because a preview build reaching the same
`DATABASE_URL` migrates production before the code is live. Run
`npm run db:migrate` against production yourself, then deploy.

### File storage: required in production

Page images write to local disk when `BLOB_READ_WRITE_TOKEN` is empty. That
works locally and **silently loses every image on Vercel**, because serverless
filesystems are ephemeral.

**Storage → Create → Blob** in your Vercel project. The token is injected
automatically. Redeploy after creating it.

### Point the app at its real URL

Once you know the deployed URL, set `NEXT_PUBLIC_APP_URL` to it and redeploy.
The GPU worker uses this value, as do the OAuth callbacks.

## 7. Google sign-in

**Set this up.** It is the recommended way in and the only one that proves a
user owns their address. "Continue with Google" leads on both `/signin` and
`/signup`: it is the same button either way, since a first-time click creates
the account.

1. https://console.cloud.google.com/apis/credentials
2. Configure the **OAuth consent screen** first if prompted (External, app
   name, your support email). While it is in **Testing**, only accounts listed
   under **Test users** can complete the flow; everyone else hits an "app not
   verified" screen. Add test users, or **Publish App** when you are ready.
3. Create OAuth client ID → Web application.
4. Add both redirect URIs:
   - `http://localhost:3000/api/auth/callback/google`
   - `https://your-project.vercel.app/api/auth/callback/google`
5. Put the ID and secret into `AUTH_GOOGLE_ID` and `AUTH_GOOGLE_SECRET`, locally
   and on Vercel. `auth.ts` sets `trustHost: true`, so nothing else is needed.

### Why there is no email step

There is no email at all. Sending to arbitrary addresses needs a domain you own,
so SPF and DKIM records can be published for it, and a free `*.vercel.app`
subdomain cannot carry those records. Rather than ship a signup flow that only
works for one inbox, the app does without.

Two consequences. **Google is the only way to prove an address**, which is why
it is the recommended way in; a password account is created with
`email_verified` left null, which is the truth, and non-null means Google
reported it verified. And there is no password reset, because nothing can send
one.

---

## 8. Your GPU (optional, powers the free trial)

This is what makes Tier 0 work: new accounts get 3 full worksheets of real
extraction with no setup on their side.

```bash
ollama pull qwen2.5vl:7b
npm run benchmark:ollama    # sanity check before committing to it
npm run worker
```

The worker only ever dials **out**. No inbound port, no tunnel, nothing
listening on your home network. If it is not running, uploads queue rather than
fail.

To serve your deployed site rather than localhost, set in `.env.local`:

```
NEXT_PUBLIC_APP_URL="https://your-project.vercel.app"
WORKER_API_TOKEN="<the same value you put in Vercel>"
```

The token must match exactly or every claim returns 401.

### The review pass (recommended)

After the pages are read, the worker checks whether each question came out
whole. Not whether the numbering is complete, which the coverage audit already
covers, but whether the stem is a fragment, options are missing, or the choices
belong to a different question. Anything doubtful goes back to the vision model,
and a question is only replaced if the second read actually returns it.

Most of that is caught without a model. For the rest a second model is asked,
and which one matters:

```
OLLAMA_REVIEW_MODEL="gpt-oss:20b"
```

Measured against a real 114-question extraction, `gpt-oss:20b` raised **no**
false alarms. The default, whatever `OLLAMA_VISION_MODEL` is, called two sound
questions broken: both stems that their own answer options finish, which is
ordinary phrasing on a real test. A reviewer that cries wolf costs re-reads, so
pull the bigger one if you have the disk. It never sees an image, so it does not
need to be a vision model, and leaving it unset is safe; the pass still runs,
just noisier.

### Pages are read one at a time

Parallel reads were tried and removed. They were 1.7x faster on a 59-page packet
and cost nothing in accuracy, but a question's ordinal was assigned as its row
was written, so pages finishing out of order handed lower numbers to later pages
and two pages saving at once claimed the same number. Students opened worksheets
listed out of order, labelled with numbers matching nothing on the page.

Ordinals are assigned from the page and position after reading finishes now, so
that particular objection is gone. The code is not, and bringing it back means
writing it again deliberately rather than flipping a switch.
`OLLAMA_NUM_PARALLEL` no longer does anything for this app.

### Locking the worker credential to an address

`WORKER_ALLOWED_IPS` is required. It is the second half of the worker gate:
`WORKER_API_TOKEN` proves *what* is calling, this proves *from where*, so a
leaked token is useless from anywhere else. Two options, and you have to pick
one:

- **`WORKER_ALLOWED_IPS="*"`** allows any address. The token is then the only
  gate. Fine while it has never left your machine, and it is at least a decision
  rather than a default now.
- **A comma-separated list** of the addresses the worker calls from. If your home
  address is dynamic, route the worker's egress through a cheap VPS acting as a
  Tailscale exit node and list the VPS.

It used to be optional, and empty meant no restriction, so the ordinary outcome
was a defence that was never on. Empty is refused.

Egress itself is separate, and `deploy/worker/` containerises the worker and
denies it everything but this app, Ollama and DNS. That has never been run on a
real machine; its README says so first.

---

## Completion notifications

A student is told when a worksheet finishes, in two halves.

The **in-app bell** in the topbar needs no setup and always works. Every
completion and every permanent failure writes a row, and the bell polls once a
minute.

**Web push** is the half that reaches a closed tab, and needs a VAPID keypair:

```bash
npm run gen:vapid
```

Paste all four lines into `.env.local`. Three are server-side and one is
`NEXT_PUBLIC_`, deliberately: subscribing happens in the browser and needs the
public key there. Leave them empty and push is skipped cleanly, bell unaffected.

Do not regenerate the keypair on a deployment with real subscribers. Every
subscription was issued against the old public key, and rotating it breaks all
of them with no error anywhere.

Three things push cannot do, none of which affect the bell: it needs permission
granted, iOS only delivers it to a site installed to the home screen, and a
revoked subscription is only discovered when a send comes back 404 or 410, at
which point the row is deleted.

---

## The four tiers

Review, spaced repetition and the dashboard work identically on all of them. The
tier only changes how questions get off the page.

| Tier | Requires | Extraction | Explanations |
|---|---|---|---|
| **0 (Trial)** | nothing | operator GPU, 3 worksheets lifetime | 20 |
| **A (Free)** | nothing | manual editor + browser OCR | none |
| **B (Cloud key)** | Anthropic/OpenAI key | server-side vision model | unlimited |
| **C (Ollama)** | Ollama running | student's own GPU, in-browser | not yet |

Tier C extracts. An account with an Ollama address saved resolves to
`executor: 'browser'`, and the status page's `BrowserRunner` claims the job,
reads each page against `localhost:11434`, and posts the questions back through
`/api/browser-jobs/*`, which is the same queue and the same handlers the
operator's GPU posts through.

It runs in the browser because a server cannot reach a student's `localhost`,
which also means **the tab has to stay open**. That is a permanent constraint of
the approach, not a bug. Reading is checkpointed per page, so closing the tab
resumes from the last finished page rather than restarting. Ollama also needs
`OLLAMA_ORIGINS` set to this app's URL before the browser is allowed to call it;
settings carries the copy-paste command and a connection test.

---

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Development server |
| `npm run check` | Typecheck + lint + tests |
| `npm test` | ~1290 tests (Vitest, embedded Postgres via PGlite) |
| `npm run test:e2e` | Playwright, against a production build |
| `npm run worker` | Operator GPU pull-worker |
| `npm run benchmark:ollama` | Benchmark the local vision model |
| `npm run gen:secrets` | Generate the three server secrets |
| `npm run gen:vapid` | Generate the web push keypair |
| `npm run db:studio` | Browse the database |

Tests run against **PGlite**, real Postgres compiled to WASM, so the full
migration and every query is exercised without Docker or a live database.

---

## Operator scripts

Not in `package.json`: these are ad-hoc, run with `npx tsx` against whatever
`DATABASE_URL` is in your `.env.local`.

They are grouped by what they do to your data, so the path answers the only
question that matters before running one:

| Directory | |
|---|---|
| `scripts/inspect/` | Read-only. Safe against production, and where to look first |
| `scripts/repair/` | **Every one writes**, behind the two guards below |
| `scripts/benchmark/` | Measurement. Needs Ollama, touches no worksheet |
| `scripts/` | The ones `package.json` runs, plus `db.ts` and `_confirm.ts` |

**The two guards on every writer.** A writing script refuses outright unless
`DATABASE_URL` points at this machine, and says so, naming the host:

```
Error: Refusing to write to ep-blue-river.us-east-1.aws.neon.tech: it is not a
local database. Set ALLOW_PROD=1 if you mean it.
```

`ALLOW_PROD=1` is deliberately a second thing to type, because the failure being
prevented is running a command you have run a hundred times locally without
noticing which `.env.local` is loaded. Past that, each writer prints what it is
about to change, including the owner's email and the host, and waits for you to
type `yes`. `--yes` skips the prompt for a scripted run, and a script reaching
the prompt with no terminal aborts rather than hanging.

Read-only forms are ungated on purpose: auditing production is a normal thing to
do, and the audit is where you look before deciding to repair anything.

| Script | What it does |
|---|---|
| `inspect/ground-truth.ts` | **Start here when you doubt the data.** Reads each paper's own answer key out of the source PDFs in `~/Downloads` and diffs it against what is stored: missing questions, numbers the paper does not have, and every answer. The only check that compares against the paper rather than against the pipeline's own opinion, and what caught a repair that fixed the numbering and left the answers keyed to the old numbers. |
| `inspect/audit-worksheets.ts [<id>]` | Checks worksheets for every failure mode known to have shipped: gaps, duplicates, ordinals out of paper order, unrendered maths. Read-only, and `AUDIT_LIMIT` sets how many recent sheets it reads. `AUDIT_FIX=true` also repairs and then requires an id. |
| `inspect/diagnose-worksheet.ts` | The last 8 worksheets with their page, text and question counts. First stop when an upload looks wrong. |
| `repair/repair-missing-options.ts [prefix] [--apply]` | **Writes with `--apply`.** Puts back answer options deleted from stored questions, reading them off the page text already stored. Dry run by default. Refuses any question whose stored prompt does not match what the page prints under that number. |
| `repair/purge-answer-page-rows.ts [prefix] [--apply]` | **Writes with `--apply`.** Removes questions read off an answer key or solutions page, whose printed numbers made the coverage audit report a sheet complete while it was missing half its questions. Backs up every deleted row to JSON first, and refuses any row a student has touched. |
| `repair/repair-choice-labels.ts [--write]` | **Writes with `--write`.** Reduces an option label that arrived with its option stuck to it, `A. 60` back to `A`. Report-only by default, and skips any row where the text being dropped is not already held beside it. |
| `repair/backfill-answer-keys.ts [prefix]` | **Writes.** Applies each paper's own answer key to worksheets extracted before that pass existed. No dry form. |
| `repair/reextract-worksheet.ts <id> [--yes]` | **Writes.** Deletes the extracted questions and reads the pages again. Exact id only: it used to match on title across every account and take the newest, and `questions` cascades to attempts, review cards and explanations. |
| `repair/reclassify-worksheet.ts <id> [--yes]` | **Writes.** Drops the topic tags and re-runs classification only. Exact id only, same reason. |
| `repair/requeue-worksheet.ts [<id>\|--all] [--yes]` | **Writes.** Re-enqueues processing. Defaults to `--all`, which sweeps every account, so that form asks first. |
| `repair/reset-trial.ts <email> [--yes]` | **Writes.** Puts an account's trial counters back to zero. |
| `inspect/tally-questions.ts <title-prefix>` | Question counts per worksheet matching the prefix. |
| `inspect/peek-page.ts <title-prefix> [page…]` | Dumps a page's stored OCR text, what the model actually saw. |
| `inspect/topic-gaps.ts` | How many questions are tagged, and which topics the classifier is reaching for. |
| `inspect/check-account.ts` | Every user's role, verification state and trial usage, plus the configured `ADMIN_EMAILS`. |
| `inspect/check-worksheet-attempts.ts <title>` | The attempts recorded against one worksheet. |
| `benchmark/try-prompt.ts <title-prefix> [page…]` | Runs a page through Ollama directly, for prompt work. No database write. |
| `benchmark/extraction.ts` | Scores a model against the marked-up benchmark corpus. |

---

## Things that will bite you

**Nothing works and every page 500s.** `DATABASE_URL` is wrong, or migrations
never ran. Check the Vercel function logs.

**Uploads work, images are blank.** No `BLOB_READ_WRITE_TOKEN` in production.

**The worker gets 403 on every claim.** `WORKER_ALLOWED_IPS` is unset. Set it to
your address, or to `*`.

**Admin link never appears.** The email must be in `ADMIN_EMAILS`. Sign out and
back in; the role is computed at login.

**Uploads sit at "Working on It" forever.** No GPU worker is running. Either
start it, or let the trial run out and it falls through to the manual editor.

**Auto-classification tags everything coarsely.** You skipped `npm run db:embed`.

---

## Known gaps

- **Tier C reads pages and nothing else.** Extraction is wired end to end.
  Derived answer keys, explanations and lessons are not built for it, and the
  routes say so rather than claiming no AI is configured. Those need the tab held
  open for the better part of an hour on a long paper, which wants deciding on
  its own terms rather than inheriting extraction's.
- **Tier B uploads come back untagged.** Auto-classification needs an embedding,
  and the embedding model needs a native runtime a serverless host does not have.
  The GPU worker does its own embedding, so trial uploads classify normally. Those
  questions are saved and reviewable, they just do not land under a topic, and the
  worksheet says so on the check screen and on the dashboard. Fixing it means a
  hosted embedding API or routing Tier B through a worker, and both need the 341
  topic embeddings recomputed, since vectors from different models are not
  comparable.
- **Rate limiting covers signup, sign-in, upload, explain, reports and
  question-writes.** Everything else (rating a card, saving credentials) is
  unbounded. Those need a session and only touch the caller's own rows, so the
  exposure is small, but it is not zero.
- **A trial explanation needs the GPU worker running.** It is queued rather than
  generated on the spot, because the worker dials out and this site cannot call
  into it. With the worker down the student waits about three minutes before
  being told to come back.
- **AI-generated practice questions** are deferred to v2 by design (spec §9).

---

## Layout

```
app/                    routes; api/worker/* is the GPU worker's only surface
lib/ai/                 provider abstraction (Anthropic, OpenAI, Ollama, mock, null)
lib/queue/              Postgres queue, FOR UPDATE SKIP LOCKED
lib/embeddings/         MiniLM 384d, runs in browser, server, and worker
lib/classify/           shortlist -> classify -> propose
lib/review/             FSRS scheduling and the due queue
lib/dashboard/          Wilson-bounded weakness ranking
lib/notifications/      the bell, and web push on top of it
lib/taxonomy/           the canonical topic tree
scripts/gpu-worker.ts   the pull-worker that runs on the 5080
scripts/inspect/        read-only checks; safe against production
scripts/repair/         everything that writes, behind scripts/_confirm.ts
deploy/worker/          container and egress rules for that worker (unrun)
docs/pipeline.md        the repair passes, and why they run in that order
```

---

## Two things worth knowing before changing anything

**Users never control the template.** They upload an image; the worker applies a
fixed prompt with a schema-validated output. There is no passthrough, no chat
endpoint and no way to supply an instruction, which is what stops the GPU being
repurposed as a general-purpose LLM, and there are tests asserting it.

They do control what goes *inside* the template, though, and this used to read as
if they did not. The page's own text layer is interpolated into the prompt, so
the fixed part is the fence and not the contents. Both halves of that fence are
in `lib/ai/prompts.ts`: the system prompts say the content is data and must never
be followed, and the delimiters are stripped from anything placed inside them so
the content cannot close the block it is in.

**Every question is stored and topic-tagged, not just the wrong ones.** The
weakness dashboard needs a denominator: "8 wrong" means nothing without knowing
whether it is 8 of 10 or 8 of 60.
