# StudyBuddy

Upload a worksheet you have already done, mark the questions you got wrong, and
get back a record of what you actually know.

**[trystudybuddy.vercel.app](https://trystudybuddy.vercel.app)**

## What it does

1. You upload a worksheet or practice test as a PDF.
2. A model reads every question and its options off the pages, and files each
   one under a topic.
3. You check what it read, then mark which ones you got wrong.
4. The dashboard ranks your topics across every worksheet you have ever
   uploaded, and a review queue brings the missed questions back on an FSRS
   schedule, the spaced-repetition algorithm Anki uses.

The point is the ranking. One worksheet tells you "12 wrong"; five tell you
"ratios", with the papers to back it up.

Reading runs on OpenRouter's free models, so it costs nothing to run and
nothing to use. A whole worksheet is a handful of requests: one to read the
pages, one or two to sort the questions, one to work out the answer key. Three
worksheets are read for free per account. After that it stays free: you add
questions yourself, or add your own API key in settings and there is no limit.
The three sample worksheets on the upload page never touch a model, so they
work even on a day the free allowance has run out, and the homepage says when
that day is.

## Running it locally

Needs Node 20+ and a Postgres database with pgvector.

```
cp .env.example .env.local     # fill in DATABASE_URL and AUTH_SECRET
npm install
npm run db:migrate             # creates 23 tables
npm run db:seed                # loads the topic list
npm run dev
```

`npm run gen:secrets` prints values for `AUTH_SECRET` and `CREDENTIALS_ENC_KEY`.
Everything else in `.env.example` is optional; unset features turn themselves
off rather than erroring.

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Development server |
| `npm run build` | Production build |
| `npm run check` | Typecheck, lint, and the figures quoted in this file |
| `npm run db:studio` | Browse the database |

## Built with

Next.js 16, React 19, Drizzle ORM over Postgres with pgvector, Auth.js v5,
ts-fsrs for review scheduling, and Tailwind. Questions are read by OpenRouter
on the operator's key for the free trial, or by a student's own Anthropic,
OpenAI, OpenRouter or Google key. Topics are shortlisted with a small
embedding model that runs on the server and picked by the reading model.

A PDF with a text layer is read from that layer; only a scanned one goes
through OCR, in the browser, before anything is uploaded. The page image still
goes to the model alongside the text, because question numbers, choice letters
and where a diagram sits are layout, and the text layer alone loses them.

## What it does not do

- It cannot read handwriting, so your own working is not picked up.
- Diagrams are noted but not interpreted; a question that depends on one is
  extracted with its text only.
- Marking is manual. It does not grade your answers, it records which ones you
  got wrong.
- There is no mobile app.

MIT licensed.
