# Getting StudyBuddy running

Ordered, start to finish. Steps 1–4 get it running on your laptop. Steps 5–7
put it on the internet. Step 8 is optional (your GPU).

Budget: about 20 minutes to local, another 15 to deployed.

---

## 1. Database (5 min): this is the only hard blocker

You need Postgres with the `pgvector` extension.

1. Go to **https://neon.tech** and sign up (free tier is plenty).
2. Create a project. Name it `studybuddy`, pick the region closest to you.
3. On the dashboard, find **Connection string** and choose the **Pooled
   connection** option.
4. Copy it. It looks like:
   `postgresql://neondb_owner:XXXX@ep-something-123456-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require`

> Take the **pooled** string, not the direct one. Serverless opens and drops
> connections constantly and the direct endpoint will run out.

`.env.local` does not exist in a fresh clone: it is gitignored and nothing
creates it, so make it first.

```bash
cp .env.example .env.local
```

Then open it and replace the `DATABASE_URL` line with the string above.

You do **not** need to create tables or enable pgvector by hand; step 3 does
both.

---

## 2. Secrets (1 min)

`.env.example` is the only `.env` file in the repo, and the copy you made in
step 1 ships `AUTH_SECRET`, `CREDENTIALS_ENC_KEY` and `WORKER_API_TOKEN` as
empty strings. Generate your own. Never commit the result.

```bash
npm run gen:secrets
```

Paste the three lines it prints over the matching lines in `.env.local`.

While you're in there, set your real admin emails:

```
ADMIN_EMAILS="your@email.com,avya@email.com"
```

Admin is granted at login by matching the signed-in email against this list.
It gives you unlimited upload length and the topic-proposal queue at
`/admin/topics`. There is deliberately no way to grant it from the UI.

---

## 3. Create the schema and load the topic tree (2 min)

```bash
npm install
npm run db:migrate
npm run db:seed
npm run db:embed
```

What each does:

| Command | Effect |
|---|---|
| `db:migrate` | Enables pgvector, creates 23 tables |
| `db:seed` | Loads 341 topics (276 classifiable leaves) |
| `db:embed` | Computes topic embeddings; auto-classification needs these |

`db:embed` downloads a ~23MB model on first run and takes a minute or two.

---

## 4. Run it

```bash
npm run dev
```

Open http://localhost:3000 and create an account.

That's a working app. Everything below is deployment and extras.

---

## 5. Put it on GitHub (5 min)

The repo is already initialised and committed locally. You just need a remote.

1. Go to **https://github.com/new**
2. Name it `studybuddy`. **Private** unless you want it public.
3. Do **not** tick "Add a README", ".gitignore", or a licence, because the repo
   already has them and it will conflict.
4. Create it, then run what GitHub shows you, which will be:

```bash
git remote add origin https://github.com/YOUR-USERNAME/studybuddy.git
git branch -M main
git push -u origin main
```

`.env.local` is gitignored, so your secrets do not go up. Worth confirming
once:

```powershell
git ls-files | Select-String "env"
```

or, on a POSIX shell:

```bash
git ls-files | grep env
```

Should print only `.env.example`.

---

## 6. Deploy to Vercel (5 min)

1. **https://vercel.com** → sign in with GitHub.
2. **Add New → Project** → import `studybuddy`.
3. Framework auto-detects as Next.js. Do not change the build settings.
4. Before clicking Deploy, open **Environment Variables** and add:

| Name | Value |
|---|---|
| `DATABASE_URL` | your Neon pooled string |
| `AUTH_SECRET` | from `npm run gen:secrets` |
| `CREDENTIALS_ENC_KEY` | from `npm run gen:secrets` |
| `ADMIN_EMAILS` | your emails, comma-separated |
| `WORKER_API_TOKEN` | from `npm run gen:secrets` |
| `CRON_SECRET` | from `npm run gen:secrets` |
| `NEXT_PUBLIC_APP_URL` | `https://your-project.vercel.app` |
| `ENABLE_MOCK_AI` | leave empty |

5. Deploy.

`vercel.json` registers a cron job that hits `/api/cron/drain-server-queue`
every 5 minutes: the drain for worksheets processed against a student's own
cloud key (Tier B), which otherwise only ran piggybacked on whichever upload
request happened to enqueue it. Vercel adds the `Authorization: Bearer
$CRON_SECRET` header to its own cron requests automatically once that
variable is set; nothing else needs configuring.

### 6a. File storage: required in production

Page images are written to local disk when `BLOB_READ_WRITE_TOKEN` is empty.
That works locally and **silently loses every image on Vercel**, because
serverless filesystems are ephemeral.

In your Vercel project: **Storage → Create → Blob**. Vercel injects
`BLOB_READ_WRITE_TOKEN` automatically. Redeploy after creating it.

### 6b. Point the app at its real URL

Once you know the deployed URL, set `NEXT_PUBLIC_APP_URL` to it and redeploy.
The GPU worker uses this value, as do the OAuth callbacks.

---

## 7. Optional extras

### Google sign-in and sign-up

**Set this up.** It is the recommended way in and the only one that proves a
user owns their address. See "Why there is no email set-up step" below.
"Continue with Google" leads on both
`/signin` and `/signup`: it's the same button either way, since Google never
distinguishes the two: a first-time click creates the account automatically.

1. **https://console.cloud.google.com/apis/credentials**
2. If prompted, configure the **OAuth consent screen** first (External, app
   name, your support email). While it's in **Testing** status, only accounts
   you add under **Test users** can complete the flow; everyone else sees an
   "app not verified" block screen. Either add test users or click
   **Publish App** once you're ready for real users (personal-use Google
   accounts do not require Google's verification review for a small app like
   this).
3. Create OAuth client ID → Web application
4. Authorised redirect URIs. Add both:
   - `http://localhost:3000/api/auth/callback/google`
   - `https://your-project.vercel.app/api/auth/callback/google`
5. Put the client ID and secret into `AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET`,
   locally and on Vercel. `auth.ts` sets `trustHost: true`, so nothing else
   (like an `AUTH_URL`) is needed for Vercel to compute the right callback URL.

### Why there is no email set-up step

There is no email at all. Sending to arbitrary addresses needs a domain you
own, so that SPF and DKIM records can be published for it, and a free
`*.vercel.app` subdomain cannot carry those records, and no provider will accept
it. Rather than ship a signup flow that only works for one inbox, the app does
without.

The consequence: **Google is the only way to prove an address**, so it is the
recommended way in. A password account is created ready to use and is stamped
`email_verified` at creation without any proof of ownership, which is worth
knowing before you read that column and believe it. It also means there is no
password reset; nothing can send one.

---

## 8. Your GPU (optional; powers the free trial)

This is what makes Tier 0 work: new accounts get 3 full worksheets of real AI
extraction without any setup on their side.

```bash
ollama pull qwen2.5vl:7b
npm run benchmark:ollama    # sanity check before committing to it
npm run worker
```

The worker only ever dials **out**. There is no inbound port, no tunnel, and
nothing listening on your home network. If the worker is not running, uploads
queue instead of failing.

For it to serve your deployed site rather than localhost, set in `.env.local`:

```
NEXT_PUBLIC_APP_URL="https://your-project.vercel.app"
WORKER_API_TOKEN="<the same value you put in Vercel>"
```

The token must match exactly, or every claim returns 401.

### Reading pages one at a time

Pages are read one at a time. Parallel reads were tried and removed.

They were 1.7x faster on a 59 page packet and cost nothing in extraction
accuracy, but a question's ordinal was assigned as its row was written, so
pages finishing out of order handed lower numbers to later pages and two pages
saving at the same moment claimed the same number. The student opened a
worksheet listed out of order, labelled with numbers matching nothing on the
page, with a value used twice.

Ordinals are now assigned from the page and position after reading finishes,
so that particular objection is gone. The code is not, and bringing it back
means writing it again deliberately rather than flipping a switch.

`OLLAMA_NUM_PARALLEL` on the Ollama server no longer does anything for this
app and can be set back to 1.

### The review pass (recommended)

After the pages are read, the worker checks whether each question came out
whole, not whether the numbering is complete, which the audit already covers,
but whether the stem is a fragment, options are missing, or the choices belong
to a different question. Anything doubtful sends that page back to the vision
model, and a question is only replaced if the second read actually returns it.

Most of that is caught without a model. For the rest a second model is asked,
and which one matters:

```
OLLAMA_REVIEW_MODEL="gpt-oss:20b"
```

Measured against a real 114-question extraction, `gpt-oss:20b` raised **no**
false alarms. The default (whatever `OLLAMA_VISION_MODEL` is set to, normally
`qwen2.5vl:7b`) called two sound questions broken: both stems that their own
answer options finish, which is ordinary phrasing on a real test. A reviewer
that cries wolf costs re-reads, so pull the bigger one if you have the disk:

```bash
ollama pull gpt-oss:20b
```

It never sees an image, so it does not need to be a vision model. Leaving it
unset is safe; the pass still runs, just noisier. No re-read ever deletes a
question outright, and at most 30% of a worksheet's pages are re-read, so an
extraction that is wrong throughout fails fast to the review screen instead of
taking twice as long to arrive equally wrong.

### Hiding your home IP (spec §3.3.1)

Your worker's outbound requests reveal your home IP to Vercel and the blob
host, not to users, but it is in their logs. If that matters, route the
worker's egress through a cheap VPS acting as a Tailscale exit node, then set
`WORKER_ALLOWED_IPS` to that VPS's address so a stolen token is useless from
anywhere else.

Skip this for now. It matters when you have real users, not before.

---

## Order of operations, condensed

```
Neon → DATABASE_URL in .env.local
npm install && npm run db:migrate && npm run db:seed && npm run db:embed
npm run dev                          # works locally now

GitHub repo → git remote add origin … && git push -u origin main
Vercel import → env vars → deploy
Vercel Blob → redeploy
NEXT_PUBLIC_APP_URL → redeploy

npm run worker                       # optional, powers the free trial
```

---

## Operator scripts

Not in `package.json`: these are ad-hoc, run with `npx tsx` against whatever
`DATABASE_URL` is in your `.env.local`. Several of them write.

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
do, and the audit is where you look before you decide to repair anything.

| Script | What it does |
|---|---|
| `ground-truth.ts` | **Start here when you doubt the data.** Reads each paper's own answer key out of the source PDFs in `~/Downloads` and diffs it against what is stored: missing questions, numbers the paper does not have, and every answer. It is the only check that compares against the paper rather than against the pipeline's own opinion, and it is what caught a repair that fixed the numbering and left the answers keyed to the old numbers. |
| `repair-missing-options.ts [prefix] [--apply]` | **Writes with `--apply`.** Puts back answer options that were deleted from stored questions, reading them off the page text already stored. Dry run by default. Refuses any question whose stored prompt does not match what the page prints under that number. With no prefix it covers every account. |
| `audit-worksheets.ts [<id>]` | Checks worksheets for every failure mode known to have shipped: gaps, duplicates, ordinals out of paper order, unrendered maths. Read-only, and `AUDIT_LIMIT` sets how many recent sheets it reads. `AUDIT_FIX=true` also repairs, using the same passes the job runs, and then requires a worksheet id: without one it used to mean the most recent sheets account-wide. |
| `purge-answer-page-rows.ts [prefix] [--apply]` | **Writes with `--apply`.** Removes questions that were read off an answer key or solutions page, whose printed numbers made the coverage audit report a sheet as complete while it was missing half its questions. Dry run by default, backs up every row it deletes to JSON first, and refuses any row a student has touched. |
| `diagnose-worksheet.ts` | The last 8 worksheets with their page, text and question counts. First stop when an upload looks wrong. |
| `tally-questions.ts <title-prefix>` | Question counts per worksheet matching the prefix. |
| `peek-page.ts <title-prefix> [page…]` | Dumps a page's stored OCR text, what the model actually saw. |
| `topic-gaps.ts` | How many questions are tagged, and which topics the classifier is reaching for. |
| `check-account.ts` | Every user's role, verification state and trial usage, plus the configured `ADMIN_EMAILS`. |
| `check-worksheet-attempts.ts <title>` | The attempts recorded against one worksheet. |
| `repair-choice-labels.ts [--write]` | **Writes with `--write`.** Reduces an option label that arrived with its option stuck to it, `A. 60` back to `A`. Report-only by default, and it skips any row where the text being dropped is not already held beside it. |
| `backfill-answer-keys.ts [prefix]` | **Writes.** Applies each paper's own answer key to worksheets extracted before that pass existed. There is no dry form, and with no prefix it covers every account. |
| `reset-trial.ts <email> [--yes]` | **Writes.** Puts an account's trial counters back to zero. |
| `requeue-worksheet.ts [<id>\|--all] [--yes]` | **Writes.** Re-enqueues processing. Defaults to `--all`, which sweeps every account's stranded worksheets, so that form asks first. |
| `reextract-worksheet.ts <worksheet-id> [--yes]` | **Writes.** Deletes the extracted questions and reads the pages again. Takes the exact id only: it used to match on title across every account and take the newest, and `questions` cascades to attempts, review cards and explanations. |
| `reclassify-worksheet.ts <worksheet-id> [--yes]` | **Writes.** Drops the topic tags and re-runs classification only. Exact id only, for the same reason. |
| `try-prompt.ts <title-prefix> [page…]` | Runs a page through Ollama directly, for prompt work. Needs no database write. |
| `benchmark-extraction.ts` | Scores a model against the marked-up benchmark corpus. |

---

## Things that will bite you

**Nothing works and every page 500s.** `DATABASE_URL` is wrong or migrations
never ran. Check the Vercel function logs.

**Uploads work, images are blank.** No `BLOB_READ_WRITE_TOKEN` in production.

**Admin link never appears.** The email must be in `ADMIN_EMAILS`. Sign out and
back in; the role is computed at login.

**Uploads sit at "Working on It" forever.** No GPU worker is running. Either
start it, or let the trial run out and it falls through to the manual editor.

**Auto-classification tags everything coarsely.** You skipped `npm run db:embed`.

---

## Known gaps

- **Tier C (student's own Ollama) reads pages and nothing else.** Extraction is
  wired end to end: settings saves the address and tests the connection,
  `resolveProvider` returns `executor: 'browser'`, and the status page drives
  the reading against `localhost:11434`. Derived answer keys, explanations and
  lessons are not built for it, and the routes say so rather than claiming no AI
  is configured. Two things to know before recommending it to anyone: the tab
  has to stay open for the whole read, and Ollama refuses the browser outright
  until `OLLAMA_ORIGINS` names this app's URL and Ollama has been restarted.
- **Tier B uploads come back untagged.** Auto-classification needs an
  embedding, and the embedding model needs a native runtime that a serverless
  host does not have. The GPU worker does its own embedding, so trial uploads
  are classified normally, but Tier B runs the extraction on the server,
  where there is no worker to ask. Those questions are saved and reviewable,
  they just do not land under a topic, so they do not reach the weakness
  dashboard. Fixing it means either a hosted embedding API or routing Tier B
  through a worker; both need the 341 topic embeddings recomputed with
  whatever model replaces the current one, since vectors from different
  models are not comparable.
- **Rate limiting covers signup, upload and explain only.**
  Everything else (rating a card, editing a question, saving credentials) is
  unbounded. Those all need a session and only touch the caller's own rows, so
  the exposure is small, but it is not zero.
- **A trial explanation needs the GPU worker running.** It is queued rather
  than generated on the spot, because the worker dials out and this site
  cannot call into it. With the worker down the request queues and the student
  waits about three minutes before being told to come back to it.
- **AI-generated practice questions** are deferred to v2 by design (spec §9).
