# StudyBuddy

Upload a worksheet you have already done, mark the questions you got wrong, and
get back a record of what you actually know.

**[trystudybuddy.vercel.app](https://trystudybuddy.vercel.app)**

## What it does

1. You upload a worksheet as a PDF or as photos of the pages.
2. A vision model pulls out each question and its options.
3. You check what it read, then mark which ones you missed.
4. The dashboard shows accuracy by topic, and a review queue schedules the ones
   you got wrong.

Three worksheets are free. After that you add your own API key in settings, or
point it at an Ollama instance on your own machine.

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
| `npm run worker` | Runs extraction on a local GPU instead of a cloud model |
| `npm run db:studio` | Browse the database |

## Built with

Next.js 16, React 19, Drizzle ORM over Postgres with pgvector, Auth.js v5,
ts-fsrs for review scheduling, and Tailwind. Questions are extracted by
whichever model you configure: Anthropic, OpenAI, OpenRouter, Google, or a local
Ollama.

## What it does not do

- It cannot read handwriting, so your own working is not picked up.
- Diagrams are noted but not interpreted; a question that depends on one is
  extracted with its text only.
- Marking is manual. It does not grade your answers, it records which ones you
  got wrong.
- There is no mobile app.

MIT licensed.
