# StudyBuddy

Turn the worksheets you have already done into a record of what you actually
know: every question pulled off the page, every miss tracked, and a revision
schedule built from the ones you got wrong.

![StudyBuddy](https://trystudybuddy.vercel.app/opengraph-image)

**[Try it at trystudybuddy.vercel.app](https://trystudybuddy.vercel.app)**

## Quick start

Open the link. Sign in with Google or an email and a password, then:

1. **Upload a worksheet** you have already done, as a PDF or photos of the
   pages. The free trial reads three of them on a GPU we run.
2. **Check what it read.** Each question sits beside the page image it came
   from, so a misread is one click to fix.
3. **Mark what you missed.** That is the only input the rest of the app needs.
4. **Open the dashboard** for accuracy by topic, a weakness ranking, and a
   review queue that schedules itself.

No card and no setup. Bringing your own AI key or your own Ollama removes the
trial limit, and the Ollama route runs every model on your machine.

## Features

- **Reads a worksheet you photographed.** PDFs are rasterized in your browser
  and never uploaded; the page images are, and a vision model pulls out each
  question, its options and its answer key.
- **Four ways to run the models**, and the tier only changes where the work
  happens: our GPU on the free trial, your cloud API key, your own Ollama, or
  no model at all and you type the questions in yourself.
- **Sorts questions into 87 topics** across SAT Math, SAT Reading and Writing,
  and competition maths, using a 384d embedding and a pgvector shortlist.
- **Schedules revision with FSRS**, the algorithm behind Anki's modern
  scheduler, so a question you missed comes back before you forget it again.
- **Ranks your weakest topics by confidence, not percentage**, using a Wilson
  lower bound, so two unlucky answers cannot fake a weakness.
- **Writes practice questions on a topic you are weak at**, sifted before
  anything is stored: no missing answer, no four options that are not A to D,
  no stem that gives the answer away.
- **Exports to Blooket** so the questions you missed become a game you can play
  against somebody.

## How it works

**The models run wherever the student's data should be.** The interesting
constraint is that a student with their own GPU should never send their
homework to us, and a student with nothing should still get something. So the
same pipeline has four execution sites, and the tier picks one: an operator GPU
pulling jobs from a Postgres queue, a server-side call against the student's own
API key, a browser-side call against their own `localhost:11434`, or a manual
editor. Extraction is checkpointed per page and the answer pass asks the server
what is still unsolved, so closing the tab costs the page in flight rather than
the paper.

**Tagging splits into the part that needs a model and the part that does not.**
Sorting a question into a topic takes a 384d MiniLM embedding and one small
model call to choose from the nearest leaves. Only the embedding needs a model,
and the shortlist is a pgvector query, so the vector can be computed anywhere:
in the worker process, in the browser under WebAssembly, or on the server. That
is what lets a student with no API key still get topic tagging, and what keeps
question text on their machine when they have Ollama.

**Nothing a model wrote is trusted on the way in.** Every provider response is
parsed against a Zod schema before it reaches the database, generated practice
is sifted by a validator that refuses thirteen specific failure modes, and
prompts are fixed with page text interpolated as data rather than instructions.
Generated questions are kept out of the measured record entirely, because
letting a model-written answer key push a topic up the weakness ranking would
close a loop between the ranking and the questions it generates.

**The queue is Postgres, not a broker.** `FOR UPDATE SKIP LOCKED` with a claim
TTL, per-stage jobs, and a reaper for workers that stop answering. It is less
machinery than a queue service and it survives the thing a hobby project
actually hits, which is the worker being switched off for a day.

## Running it locally

Node 20 or later, and Postgres with the `pgvector` extension. [Neon](https://neon.tech)
works on its free tier; use the pooled connection string.

```bash
cp .env.example .env.local
npm install && npm run gen:secrets
```

Put the generated secrets and your `DATABASE_URL` into `.env.local`, then:

```bash
npm run db:migrate && npm run db:seed && npm run db:embed
npm run dev
```

The app runs at http://localhost:3000. Set `ENABLE_MOCK_AI="true"` and every
tier is clickable end to end with no key, no GPU and no worker running.

| Command | Effect |
|---|---|
| `db:migrate` | Enables pgvector and creates 26 tables |
| `db:seed` | Loads 106 topics, 87 of them classifiable leaves |
| `db:embed` | Computes topic embeddings, required for auto-classification |

| Command | What it does |
|---|---|
| `npm run dev` | Development server |
| `npm run build` | Production build |
| `npm run check` | Typecheck, lint, and the figures quoted in this file |
| `npm run worker` | Operator GPU pull-worker |
| `npm run benchmark:ollama` | Benchmark the local vision model |
| `npm run gen:secrets` | Generate server secrets |
| `npm run gen:vapid` | Generate the web push keypair |
| `npm run db:studio` | Browse the database |

## Built with

[Next.js 16](https://nextjs.org) and React 19, [Drizzle ORM](https://orm.drizzle.team)
over Postgres with [pgvector](https://github.com/pgvector/pgvector),
[Auth.js v5](https://authjs.dev), [ts-fsrs](https://github.com/open-spaced-repetition/ts-fsrs)
for scheduling, [transformers.js](https://huggingface.co/docs/transformers.js)
running MiniLM in the browser, [tesseract.js](https://tesseract.projectnaptha.com)
for browser OCR, [pdf.js](https://mozilla.github.io/pdf.js/) for rasterizing
PDFs, [Ollama](https://ollama.com) with `qwen2.5vl:7b` on the operator GPU, and
[sharp](https://sharp.pixelplumbing.com) for page images.

The taxonomy follows the College Board's published SAT domains and the topic
lists AMC 8 and MATHCOUNTS problems are usually indexed by.

---

The rest of this file is operator detail: configuration, the tiers in full, how
sorting and the worker actually behave, and the scripts for running it.

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
| `MAIL_FROM` and `SMTP_PASSWORD` | password reset | Sender address and SMTP password, a Gmail app password by default. Unset disables reset cleanly |
| `CONTACT_EMAIL` | public launch | Address printed on the privacy and terms pages. Unset, they say no address is set rather than publishing one nobody chose |
| `TRIAL_DAILY_WORKSHEETS` | optional | Trial extractions allowed per rolling day across everybody. Default 25, `0` closes the trial, `unlimited` removes the ceiling |
| `SIGNUP_INVITE_CODE` | optional | Set it and sign-ups ask for it. Unset, sign-ups are open |
| `ALERT_EMAIL` | optional | Server errors are emailed here, over the mail already configured for password reset |
| `ERROR_WEBHOOK_URL` | optional | Server errors are posted here as `{text}`, which Slack and Discord both accept |
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
| C (Ollama) | Ollama running locally | Student's own GPU, in-browser | Student's own GPU, in-browser | Student's own GPU, in-browser |

Tier C runs in the browser against `localhost:11434`, so the tab must stay open.
Extraction, the derived answer key, explanations, topic lessons, practice
questions and the topic pick all go the same way. Reading is checkpointed per page and the answer pass asks the server
what is still unsolved, so both resume rather than restart. Ollama requires
`OLLAMA_ORIGINS` set to the app's URL; the settings screen provides the command
and a connection test.

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Development server |
| `npm run build` | Production build |
| `npm run check` | Typecheck, lint, and the figures quoted in this file |
| `npm run worker` | Operator GPU pull-worker |
| `npm run benchmark:ollama` | Benchmark the local vision model |
| `npm run gen:secrets` | Generate server secrets |
| `npm run gen:vapid` | Generate the web push keypair |
| `npm run db:studio` | Browse the database |

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

## Costs, and who can spend them

Trial worksheets are read on hardware the operator pays for and stored in a
blob store the operator pays for, so there are two ceilings rather than one.
Each account gets 3 trial worksheets, and `TRIAL_DAILY_WORKSHEETS` caps how many
the whole service will start in a rolling day. Past that ceiling an upload is
not refused: it falls through to the manual editor, and the student's own trial
credits are left unspent, so they lose nothing but the automation.

`SIGNUP_INVITE_CODE` closes sign-ups when set. Together the two settings cover a
quiet launch: invite-only while you watch it, then open with a ceiling.

The upload screen says when the trial reader is offline, and how many papers are
queued ahead, rather than letting a student watch a spinner and guess.

## Errors

`instrumentation.ts` catches server errors and logs one line per error. Set
`ALERT_EMAIL`, `ERROR_WEBHOOK_URL`, or both, and the same line is sent on, so
somebody hears about a 500 without reading platform logs. Email needs no new
account: it goes out over the SMTP already configured for password reset.

Alerts are throttled, because a channel that floods is a channel nobody reads:
the same message repeats at most once every ten minutes, and no more than a
dozen leave per hour. The counters are per server instance, so on serverless the
hourly ceiling is per instance rather than global.

Reporting never throws. A failure to report is logged and swallowed.

## Password reset

Mail goes out over plain SMTP, so there is no provider to sign up with, no
domain to own and no sender address to get verified by anybody. A Gmail app
password is enough:

1. Turn on 2-step verification on the Google account.
2. Generate an app password at https://myaccount.google.com/apppasswords.
3. Set `MAIL_FROM` to that Gmail address and `SMTP_PASSWORD` to the 16
   characters it gave you.

`SMTP_HOST` and `SMTP_PORT` default to `smtp.gmail.com` and 465, and `SMTP_USER`
defaults to `MAIL_FROM`, so any other host takes the same four variables. Port
465 connects over TLS immediately; every other port must offer STARTTLS or the
send is refused rather than sent in the clear.

Leave `MAIL_FROM` or `SMTP_PASSWORD` unset and the reset screen says the
deployment cannot send email, rather than promising a link that will never
arrive. Google sign-in still works, and so does every account that has a
password already.

Any account can be sent one, including an account that has only ever signed in
with Google: the link reaches whoever holds the inbox, and that person can
already sign in with Google, so it adds a password rather than a way in.

A link is a 32-byte token, stored only as a SHA-256 hash, good for one hour and
one use. Spending one deletes every other outstanding link for that account, and
sets `email_verified`, since reading the mail proves the address. Requests are
limited per address and per connection, and the reply is the same sentence
whether or not the address has an account.

## Topics

The tree covers what actually gets uploaded here: SAT Math, SAT Reading and
Writing, and competition maths, meaning AMC 8 and 10, MATHCOUNTS and the SHSAT
maths section. 106 nodes, 87 of them classifiable leaves.

Competition maths is grouped the way contest solutions talk about themselves,
by technique rather than by the school year a topic is taught in, because a
student working through a paper is looking for the method.

The general school-maths spine and the ELA tree were removed once it was clear
nothing was arriving for them. `lib/taxonomy/remap.ts` records where every
topic that carried data went, and `scripts/repair/remap-topics.ts` applies it.

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
- Tier B also queues the worksheet for the operator GPU when the server cannot
  embed, so a student who never opens the dashboard still gets topics. Whichever
  runs first wins: an already-tagged question is not offered to the other.
  Embedding cannot happen where the question text is not, so that route reads
  the worksheet on the operator machine, and the notice on the worksheet says
  so. Sorting in the browser keeps it on the student's own machine.
- Tier C embeds in the student's browser and picks there too, against their own
  Ollama. The server only ever runs the pgvector shortlist, so no key is needed
  and no question text leaves the machine for a provider.
- Tier A is untagged. Topics can still be set by hand in the editor.

The browser model is MiniLM under WebAssembly, about 23MB, fetched once from the
Hugging Face hub and then cached by the browser, the same way Tier A's OCR
fetches its own weights. Sorting is resumable: an already-tagged question is not
offered again, so closing the tab costs only the batch in flight.

## GPU worker

The worker powers Tier 0, and sorts the Tier B worksheets the server could not
embed. It dials out only: no inbound port and nothing listening on the host
network. When it is not running, uploads queue rather than fail.

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

Tier B writes on the server. Tier C writes in the browser: `POST` hands back the
topic, its path and up to six of the student's own questions on it, the model
runs against `localhost:11434`, and `PUT` takes the batch back. The sift runs on
the way in either way, because what a question has to clear before it is stored
is not something the machine that wrote it gets to decide.

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
| `repair/remap-topics.ts [--apply]` | Moves tags and lessons onto the current taxonomy, then deletes what nothing points at |
| `repair/sort-untagged.ts [--apply] [--limit=N]` | Tags whatever is still untagged, embedding and picking against the local Ollama |
| `repair/reset-trial.ts <email>` | Resets an account's trial counters |
| `benchmark/try-prompt.ts <prefix> [page]` | Runs a page through Ollama directly |
| `benchmark/extraction.ts` | Scores a model against the benchmark corpus |

## Limitations

- Tier B classification does not finish on the server. The embedding model
  requires a native runtime the host does not have, so the extraction pass
  leaves the worksheet untagged, queues it for the operator GPU, and offers the
  student a one-click sort from the dashboard or the check screen. If the worker
  is not running, the browser is the only route. See "Sorting into topics".
- Rate limiting covers signup, sign-in, upload, and every session-authenticated
  route that writes, spends money at a provider, or runs an expensive query.
  Reads that a screen polls are deliberately left unbounded: the notification
  bell, the browser-job queue Tier C drives, and page images.
- Trial explanations are queued and require the GPU worker to be running. When
  it is not, the review screen says so before and after the ask rather than
  spinning.
- Practice questions are written for Tier B and Tier C. Tier 0 has no
  synchronous model: its work goes through the operator GPU as a queued job, and
  that path is a worker stage this repository cannot exercise, since the worker
  runs against the deployed app. Tier A has no model at all.
