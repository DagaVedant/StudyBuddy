# StudyBuddy

Upload the practice worksheets you have already done. StudyBuddy extracts every
question, tracks which ones you got wrong, and schedules what to study next on a
spaced-repetition plan.

Built with Next.js 16, React 19, Postgres with pgvector, Drizzle ORM and
Auth.js v5.

## Requirements

- Node.js 20 or later
- Postgres with the `pgvector` extension ([Neon](https://neon.tech) works on its
  free tier; use the pooled connection string)

## Quickstart

```bash
cp .env.example .env.local
npm install
npm run gen:secrets
```

Put the generated secrets and your `DATABASE_URL` into `.env.local`, then set up
the database and start the app:

```bash
npm run db:migrate
npm run db:seed
npm run db:embed
npm run dev
```

The app runs at http://localhost:3000.

| Command | Effect |
|---|---|
| `db:migrate` | Enables pgvector and creates 25 tables |
| `db:seed` | Loads 341 topics, 276 of them classifiable leaves |
| `db:embed` | Computes topic embeddings, required for auto-classification |

## Environment

| Name | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | yes | Postgres pooled connection string |
| `AUTH_SECRET` | yes | Auth.js session signing |
| `CREDENTIALS_ENC_KEY` | yes | Encrypts stored provider API keys |
| `ADMIN_EMAILS` | yes | Comma-separated; admin is granted at login by match |
| `NEXT_PUBLIC_APP_URL` | yes | Deployed URL, used by OAuth callbacks and the worker |
| `WORKER_API_TOKEN` | GPU worker | Authenticates the worker to the app |
| `WORKER_ALLOWED_IPS` | GPU worker | Address allowlist, or `*`. Empty is refused |
| `CRON_SECRET` | production | Authorizes the scheduled queue drain |
| `BLOB_READ_WRITE_TOKEN` | production | Page image storage. Without it images are written to local disk and lost on serverless |
| `AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET` | Google sign-in | OAuth client credentials |
| `NEXT_PUBLIC_VAPID_PUBLIC_KEY` and VAPID keys | web push | From `npm run gen:vapid`. Unset disables push cleanly |
| `OLLAMA_VISION_MODEL` | GPU worker | Extraction model, `qwen2.5vl:7b` |
| `OLLAMA_REVIEW_MODEL` | optional | Second-pass reviewer, `gpt-oss:20b` |

## Tiers

Review, spaced repetition and the dashboard are identical across tiers. The tier
only determines how questions come off the page.

| Tier | Requires | Extraction | Explanations | Practice questions |
|---|---|---|---|---|
| 0 (Trial) | nothing | Operator GPU, 3 worksheets lifetime | 20 | no |
| A (Free) | nothing | Manual editor and browser OCR | none | no |
| B (Cloud key) | Anthropic or OpenAI key | Server-side vision model | unlimited | 12 batches a day |
| C (Ollama) | Ollama running locally | Student's own GPU, in-browser | Student's own GPU, in-browser | no |

Tier C runs in the browser against `localhost:11434`, so the tab must stay open.
Extraction, the derived answer key, explanations and topic lessons all go the
same way. Reading is checkpointed per page and the answer pass asks the server
what is still unsolved, so both resume rather than restart. Ollama requires
`OLLAMA_ORIGINS` set to the app's URL; the settings screen provides the command
and a connection test.

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Development server |
| `npm run build` | Production build |
| `npm run check` | Typecheck, lint and tests |
| `npm test` | Vitest suite against PGlite |
| `npm run test:e2e` | Playwright against a production build |
| `npm run worker` | Operator GPU pull-worker |
| `npm run benchmark:ollama` | Benchmark the local vision model |
| `npm run gen:secrets` | Generate server secrets |
| `npm run gen:vapid` | Generate the web push keypair |
| `npm run db:studio` | Browse the database |

Tests run against PGlite, Postgres compiled to WASM, so migrations and queries
are exercised without Docker or a live database.

## Deployment

Import the repository on Vercel. It is detected as Next.js and needs no build
setting changes. Add the environment variables above, then create a Blob store
under Storage and redeploy.

Migrations do not run from the build: `prebuild` skips them on Vercel so that a
preview deployment cannot migrate production. Run `npm run db:migrate` against
production before deploying.

Because the build will not do it for you, pushing `main` with an unapplied
migration serves code against a schema that cannot answer it. A `pre-push` hook
refuses that push. It runs only for `main`, it reads the database and never
writes, and it stays out of the way otherwise: a push to any other branch skips
it, and so does a database it cannot reach, since an unreachable database is no
evidence of a problem. `SKIP_MIGRATION_CHECK=1 git push` overrides it.

The hook lives in `.githooks/` and `npm install` points `core.hooksPath` there.
Run `npm run prepare` to wire it up without a full install.

`vercel.json` registers a daily cron on `/api/cron/drain-server-queue`, which
drains worksheets processed against a student's own cloud key. The schedule is
daily because the Hobby plan permits no finer interval.

For Google sign-in, create an OAuth web client at
https://console.cloud.google.com/apis/credentials and register both redirect
URIs:

```
http://localhost:3000/api/auth/callback/google
https://your-project.vercel.app/api/auth/callback/google
```

There is no email provider configured, so Google is the only way to verify an
address and there is no password reset.

## Sorting into topics

Topic accuracy, the weakness ranking and the topic tree all need every question
tagged with a leaf topic. Tagging takes two things: a 384d MiniLM embedding of
the question, and one small model call to pick from the 25 nearest leaves.

Only the embedding needs the model. The shortlist is a pgvector query and the
pick is a text call, so both stay on the server, and the vector is the one piece
that can be computed anywhere.

- Tier 0 and the operator GPU embed in the worker process.
- Tier B embeds in the student's browser. The extraction pass tries the server
  first and falls back when the runtime will not load the model there, which is
  the case on serverless. `POST /api/worksheets/:id/classify` takes the vectors,
  shortlists against them and spends the student's own key on the pick. The key
  never leaves the server.
- Tier A and Tier C are untagged. Topics can still be set by hand in the editor.

The browser model is MiniLM under WebAssembly, about 23MB, fetched once from the
Hugging Face hub and then cached by the browser, the same way Tier A's OCR
fetches its own weights. Sorting is resumable: an already-tagged question is not
offered again, so closing the tab costs only the batch in flight.

## GPU worker

The worker powers Tier 0. It dials out only: no inbound port and nothing
listening on the host network. When it is not running, uploads queue rather than
fail.

```bash
ollama pull qwen2.5vl:7b
npm run benchmark:ollama
npm run worker
```

`WORKER_API_TOKEN` must match the value deployed to the app or every claim
returns 401. `WORKER_ALLOWED_IPS` restricts where that token may be used from.

After pages are read, a review pass checks each question for fragmented stems,
missing options and mismatched choices, and re-reads anything doubtful. Setting
`OLLAMA_REVIEW_MODEL` to a larger text model reduces false alarms. The pass runs
either way.

`deploy/worker/` contains a container definition and egress rules restricting the
worker to this app, Ollama and DNS.

## Architecture

```
app/                    routes; api/worker/* is the GPU worker's only surface
lib/ai/                 provider abstraction (Anthropic, OpenAI, Ollama, mock, null)
lib/queue/              Postgres queue, FOR UPDATE SKIP LOCKED
lib/embeddings/         MiniLM 384d, runs in browser, server and worker
lib/classify/           shortlist, classify, propose
lib/review/             FSRS scheduling and the due queue
lib/practice/           generated questions, and the validator that sifts them
lib/dashboard/          Wilson-bounded weakness ranking
lib/notifications/      in-app bell and web push
lib/taxonomy/           the canonical topic tree
scripts/gpu-worker.ts   the operator pull-worker
scripts/inspect/        read-only checks, safe against production
scripts/repair/         writers, gated by scripts/_confirm.ts
deploy/worker/          container and egress rules for the worker
```

Prompts are fixed and schema-validated. Users supply images, never instructions:
there is no passthrough and no chat endpoint. Page text is interpolated into the
prompt as data, with delimiters stripped so content cannot close the block that
contains it. The same holds for the topic name and the sample questions sent
when writing practice. Both halves are in `lib/ai/prompts.ts`.

## Practice questions

Everything else in StudyBuddy comes off a paper the student uploaded. A topic
page also offers to write new questions on that topic, so there is something to
practise on once they have worked through their own.

They are stored as ordinary questions, marked `origin = 'generated'`, in a
per-account worksheet that never appears in the library. They enter the FSRS
queue as new cards due immediately, and are reviewed, explained and scheduled by
the same code as everything else.

What they are kept out of is the measured record: topic accuracy, account
accuracy, the accuracy chart, the distractor patterns, the uploaded-worksheet
and tracked-question counts, and the Blooket export. The answer key came from a
model, not from a paper, so letting a wrong answer on one push a topic further
up the weakness ranking would close a loop between the ranking and the questions
it generates. They still count as practice done, so the streak includes them.

Each batch is sifted before anything is stored. `lib/practice/validate.ts`
refuses a question with no defensible single answer, four options that are not
A to D, an answer printed in the stem or given away by being much the longest,
an option about the other options, a reference to a figure that does not exist,
LaTeX, no working, or a stem that duplicates one in the batch or one the student
already owns. A batch where nothing survives is a 422, not a silent success.

## Operator scripts

Ad-hoc tools run with `npx tsx` against the `DATABASE_URL` in `.env.local`.

| Directory | |
|---|---|
| `scripts/inspect/` | Read-only, safe against production |
| `scripts/repair/` | Writers, gated |
| `scripts/benchmark/` | Measurement, requires Ollama |

Every writer refuses to run unless `DATABASE_URL` points at the local machine,
naming the host it rejected. `ALLOW_PROD=1` overrides. Past that, each writer
prints what it will change and waits for confirmation; `--yes` skips the prompt
and a script with no terminal aborts rather than hanging.

| Script | What it does |
|---|---|
| `inspect/ground-truth.ts` | Diffs stored data against each paper's own answer key |
| `inspect/audit-worksheets.ts [id]` | Checks for gaps, duplicates, out-of-order ordinals, unrendered maths |
| `inspect/diagnose-worksheet.ts` | Recent worksheets with page, text and question counts |
| `inspect/tally-questions.ts <prefix>` | Question counts per matching worksheet |
| `inspect/peek-page.ts <prefix> [page]` | Dumps a page's stored OCR text |
| `inspect/check-migrations.ts` | Migrations on disk that the database has not applied |
| `inspect/topic-gaps.ts` | Tagging coverage and classifier reach |
| `inspect/check-account.ts` | Roles, verification state and trial usage |
| `inspect/check-worksheet-attempts.ts <title>` | Attempts recorded against a worksheet |
| `repair/repair-missing-options.ts [prefix] [--apply]` | Restores answer options from stored page text |
| `repair/purge-answer-page-rows.ts [prefix] [--apply]` | Removes questions read off answer-key pages |
| `repair/repair-choice-labels.ts [--write]` | Reduces labels that arrived with the option attached |
| `repair/backfill-answer-keys.ts [prefix]` | Applies answer keys to older extractions |
| `repair/reextract-worksheet.ts <id>` | Deletes extracted questions and re-reads the pages |
| `repair/reclassify-worksheet.ts <id>` | Drops topic tags and re-runs classification |
| `repair/requeue-worksheet.ts [id\|--all]` | Re-enqueues processing |
| `repair/reset-trial.ts <email>` | Resets an account's trial counters |
| `benchmark/try-prompt.ts <prefix> [page]` | Runs a page through Ollama directly |
| `benchmark/extraction.ts` | Scores a model against the benchmark corpus |

## Limitations

- Tier C questions are not sorted into topics. Everything else it produces is
  the same as the other tiers.
- Tier B classification is not automatic on serverless. The embedding model
  requires a native runtime the host does not have, so the extraction pass
  leaves the worksheet untagged and the student sorts it from the dashboard or
  the check screen with one click. See "Sorting into topics" below.
- Rate limiting covers signup, sign-in, upload, and every session-authenticated
  route that writes, spends money at a provider, or runs an expensive query.
  Reads that a screen polls are deliberately left unbounded: the notification
  bell, the browser-job queue Tier C drives, and page images.
- Trial explanations are queued and require the GPU worker to be running. When
  it is not, the review screen says so before and after the ask rather than
  spinning.
- Practice questions are written for Tier B only. Tier 0 has no synchronous
  model: its work goes through the operator GPU as a queued job, and that path
  is a worker stage this repository cannot exercise, since the worker runs
  against the deployed app. Tier A has no model and Tier C cannot write prose.
