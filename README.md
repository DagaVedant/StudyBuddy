# StudyBuddy

Upload the practice worksheets you've already done. StudyBuddy pulls out every
question, tracks which ones you got wrong, and tells you what to study next,
with a spaced-repetition schedule that actually sticks.

Full product and technical spec: [`spec.md`](./spec.md).

---

## Getting it running

### 1. Database (the only thing that blocks you)

You need Postgres with `pgvector`. [Neon](https://neon.tech) has a free tier and
takes about two minutes. Put the **pooled** connection string in `.env.local` as
`DATABASE_URL`. Everything else in that file already has a working default.

```bash
npm install
npm run db:migrate
npm run db:seed
npm run db:embed
npm run dev
```

`db:migrate` creates 20 tables and enables pgvector. `db:seed` loads 341 topics
(233 classifiable leaves). `db:embed` fills in topic embeddings, which
auto-classification needs to build its candidate shortlist.

### 2. Optional: your own GPU

The operator GPU worker powers the free trial. It only ever dials **out**: no
inbound port, no tunnel, nothing listening on your network.

```bash
ollama pull qwen2.5vl:7b
npm run worker
```

Check it's worth running first:

```bash
npm run benchmark:ollama
```

---

## The four tiers

Review, spaced repetition, and the dashboard work identically on all of them.
The tier only changes how questions get off the page.

| Tier | Requires | Extraction | Explanations |
|---|---|---|---|
| **0 (Trial)** | nothing | operator GPU, 3 worksheets lifetime | 20 |
| **A (Free)** | nothing | manual editor + browser OCR | none |
| **B (Cloud key)** | Anthropic/OpenAI key | server-side vision model | unlimited |
| **C (Ollama)** | Ollama running | student's own GPU, in-browser | unlimited |

Tier C runs in the browser because a server cannot reach a student's
`localhost`, which also means the tab has to stay open. That's a permanent
constraint of the design, not a bug.

---

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Development server |
| `npm run check` | Typecheck + lint + tests |
| `npm test` | 415 tests (Vitest, embedded Postgres via PGlite) |
| `npm run worker` | Operator GPU pull-worker |
| `npm run benchmark:ollama` | Benchmark the local vision model |
| `npm run db:studio` | Browse the database |

Tests run against **PGlite**, real Postgres compiled to WASM, so the full
migration and every query is exercised without Docker or a live database.

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
lib/taxonomy/           the canonical topic tree
scripts/gpu-worker.ts   the pull-worker that runs on the 5080
```

---

## Two things worth knowing before changing anything

**Users never control the template.** They upload an image; the worker applies
a fixed prompt with a schema-validated output. There is no passthrough, no chat
endpoint and no way to supply an instruction, which is what stops the GPU being
repurposed as a general-purpose LLM, and there are tests asserting it.

They do control what goes *inside* the template, though, and this used to read
as if they did not. The page's own text layer is interpolated into the prompt,
so the fixed part is the fence and not the contents. Both halves of that fence
are in `lib/ai/prompts.ts`: the system prompts say the content is data and must
never be followed, and the delimiters are stripped from anything placed inside
them so the content cannot close the block it is in.

**Every question is stored and topic-tagged, not just the wrong ones.** The
weakness dashboard needs a denominator: "8 wrong" means nothing without
knowing whether it's 8 of 10 or 8 of 60.
