# Getting StudyBuddy running

Ordered, start to finish. Steps 1–4 get it running on your laptop. Steps 5–7
put it on the internet. Step 8 is optional (your GPU).

Budget: about 20 minutes to local, another 15 to deployed.

---

## 1. Database (5 min) — this is the only hard blocker

You need Postgres with the `pgvector` extension.

1. Go to **https://neon.tech** and sign up (free tier is plenty).
2. Create a project. Name it `studybuddy`, pick the region closest to you.
3. On the dashboard, find **Connection string** and choose the **Pooled
   connection** option.
4. Copy it. It looks like:
   `postgresql://neondb_owner:XXXX@ep-something-123456-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require`

> Take the **pooled** string, not the direct one. Serverless opens and drops
> connections constantly and the direct endpoint will run out.

Open `.env.local` and replace the `DATABASE_URL` line with it.

You do **not** need to create tables or enable pgvector by hand — step 3 does
both.

---

## 2. Secrets (1 min)

`.env.local` ships with working development values, so you can skip this to get
running locally. **Do it before deploying**, though — those defaults are in the
repo's history and are not secret.

```bash
npm run gen:secrets
```

Paste the three lines it prints over the matching lines in `.env.local`.

While you're in there, set your real admin emails:

```
ADMIN_EMAILS="your@email.com,avya@email.com"
```

Admin is granted at login by matching the **verified** email against this list.
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
| `db:migrate` | Enables pgvector, creates 19 tables |
| `db:seed` | Loads 290 topics (233 classifiable leaves) |
| `db:embed` | Computes topic embeddings — auto-classification needs these |

`db:embed` downloads a ~23MB model on first run and takes a minute or two.

---

## 4. Run it

```bash
npm run dev
```

Open http://localhost:3000 and create an account.

**Verifying your email locally:** with no email provider configured, the
verification link is printed to the terminal running `npm run dev`. Look for a
line starting `[mail]` and open the URL in it.

That's a working app. Everything below is deployment and extras.

---

## 5. Put it on GitHub (5 min)

The repo is already initialised and committed locally. You just need a remote.

1. Go to **https://github.com/new**
2. Name it `studybuddy`. **Private** unless you want it public.
3. Do **not** tick "Add a README", ".gitignore", or a licence — the repo
   already has them and it will conflict.
4. Create it, then run what GitHub shows you, which will be:

```bash
git remote add origin https://github.com/YOUR-USERNAME/studybuddy.git
git branch -M main
git push -u origin main
```

`.env.local` is gitignored, so your secrets do not go up. Worth confirming
once:

```bash
git ls-files | Select-String "env"
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
| `NEXT_PUBLIC_APP_URL` | `https://your-project.vercel.app` |
| `ENABLE_MOCK_AI` | `false` |

5. Deploy.

### 6a. File storage — required in production

Page images are written to local disk when `BLOB_READ_WRITE_TOKEN` is empty.
That works locally and **silently loses every image on Vercel**, because
serverless filesystems are ephemeral.

In your Vercel project: **Storage → Create → Blob**. Vercel injects
`BLOB_READ_WRITE_TOKEN` automatically. Redeploy after creating it.

### 6b. Point the app at its real URL

Once you know the deployed URL, set `NEXT_PUBLIC_APP_URL` to it and redeploy.
Email links and the GPU worker both use this value.

---

## 7. Optional extras

### Google sign-in and sign-up

Email/password works without this. "Continue with Google" appears on both
`/signin` and `/signup` — it's the same button either way, since Google never
distinguishes the two: a first-time click creates the account automatically.

1. **https://console.cloud.google.com/apis/credentials**
2. If prompted, configure the **OAuth consent screen** first (External, app
   name, your support email). While it's in **Testing** status, only accounts
   you add under **Test users** can complete the flow — everyone else sees an
   "app not verified" block screen. Either add test users or click
   **Publish App** once you're ready for real users (personal-use Google
   accounts do not require Google's verification review for a small app like
   this).
3. Create OAuth client ID → Web application
4. Authorised redirect URIs — add both:
   - `http://localhost:3000/api/auth/callback/google`
   - `https://your-project.vercel.app/api/auth/callback/google`
5. Put the client ID and secret into `AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET`,
   locally and on Vercel. `auth.ts` sets `trustHost: true`, so nothing else
   (like an `AUTH_URL`) is needed for Vercel to compute the right callback URL.

### Real verification emails

Without this, links print to the server console — fine locally, not fine for
real users.

1. **https://resend.com** → sign up, verify a domain
2. Set `RESEND_API_KEY` and `EMAIL_FROM` on Vercel

---

## 8. Your GPU (optional — powers the free trial)

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

### Hiding your home IP (spec §3.3.1)

Your worker's outbound requests reveal your home IP to Vercel and the blob
host — not to users, but it is in their logs. If that matters, route the
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

## Things that will bite you

**Nothing works and every page 500s.** `DATABASE_URL` is wrong or migrations
never ran. Check the Vercel function logs.

**Uploads work, images are blank.** No `BLOB_READ_WRITE_TOKEN` in production.

**Signup succeeds but you cannot sign in.** Email is unverified. Locally the
link is in the terminal; in production you need Resend.

**Admin link never appears.** The email must be verified *and* in
`ADMIN_EMAILS`. Sign out and back in — the role is computed at login.

**Uploads sit at "Working on It" forever.** No GPU worker is running. Either
start it, or let the trial run out and it falls through to the manual editor.

**Auto-classification tags everything coarsely.** You skipped `npm run db:embed`.

---

## Known gaps

- **Trial explanations don't work.** The job-stage enum has an `'explain'`
  value for running this asynchronously on the operator GPU, same as
  extraction, but nothing enqueues or processes one — the endpoint calls the
  provider synchronously, and a trial account resolves to a placeholder
  provider that always refuses. A trial student asking for an explanation
  gets "No AI is set up for your account," which is wrong.
- **Accepting a topic proposal in the admin queue is a no-op.** It flips the
  proposal's status; nothing reads that status to actually add the topic to
  the tree. The review UI is real, the effect isn't.
- **Tier C (student's own Ollama) is not wired.** Settings saves the config and
  the provider exists, but the browser does not yet drive extraction through
  it; those uploads land in the manual editor.
- **No abuse controls anywhere** — no rate limiting on signup, upload, or any
  other endpoint.
- **AI-generated practice questions** are deferred to v2 by design (spec §9).
