# StudyBuddy — Product & Technical Spec

**Status:** Draft v1, agreed via requirements interview
**Date:** 2026-07-31

---

## 1. What this is

A web app where a student uploads practice worksheets (PDFs, scans, phone photos), the system extracts every question into a structured database, the student marks which ones they got wrong and what they answered, and the app then categorizes every question into a subject → topic → subtopic tree, generates explanations, schedules spaced-repetition review, and shows a dashboard of which topics they're actually weak in.

### Goals

- Turn a pile of finished worksheets into a durable, searchable record of what the student knows and doesn't.
- Make "what should I study next" answerable with data instead of vibes.
- Be genuinely usable with **zero cost to the operator** — every AI-powered path is funded by the user's own API key or their own local GPU.

### Non-goals (v1)

- Grading a worksheet automatically from a photo of the student's marked-up answers. The student self-reports.
- Being a content library. We never ship question banks; all content originates from the student's own uploads.
- Classroom/roster management, teacher accounts, parent accounts. **Explicitly dropped.** The student shows their own dashboard to whoever they want.
- Payments/billing. Deferred to v2.

---

## 2. Users & accounts

Two roles: **student** (everyone) and **admin** (the two operators). Public signup.

- **Age gate:** 13+ only, enforced at signup (date-of-birth entry, not a checkbox). This keeps us out of COPPA entirely. Users under 13 are refused.
- **Auth:** Auth.js (NextAuth v5) with two providers:
  - Google OAuth (primary — one tap, most students have an account)
  - Email + password (fallback for school-blocked Google)
- Email verification required for password accounts.
- No parent/teacher/observer roles exist in the data model. If sharing is ever wanted, it comes back as a read-only public dashboard link, not an account type.

### 2.1 Admin accounts

Two admins: **Vedant** and **Avya**.

**Provisioning:** driven by an env var, never hardcoded and never self-assignable.

```
ADMIN_EMAILS=vedant@example.com,avya@example.com
```

On login, if the verified email matches the list, `users.role` is set to `admin`. Removing an email demotes on next login. There is no UI to grant admin — that would be a privilege-escalation surface for zero benefit at this scale.

**Admin capabilities:**

| Capability | Detail |
|---|---|
| **Unlimited upload length** | The 40-page per-upload cap does not apply. |
| **No trial quota** | Trial page/explanation limits bypassed entirely. |
| **Topic proposal queue** | Review, merge, promote, or reject proposed topics (§7.2). |
| **Canonical tree editing** | Add/rename/reparent topics. |
| **Worker + queue console** | GPU heartbeat, queue depth, stuck jobs, requeue/cancel. |
| **Usage visibility** | Aggregate `usage_events`, per-user quota state. |

**Limits that still apply to admins**, deliberately:

- Per-page file size and image dimension caps — these are crash/abuse guards, not quotas, and bypassing them buys nothing.
- **Admin GPU jobs default to a low-priority lane.** An unlimited-length upload is exactly the thing that would stall every trial user behind it, so admin bulk jobs yield to Tier 0 jobs unless explicitly marked `priority=high`. This is the whole reason `processing_jobs.priority` exists.
- Admins cannot read other users' questions, uploads, or answers. Admin is an *operations* role, not a superuser over student data. The proposal queue shows the proposed topic name and the source question text only.

**Practical note:** "unlimited" still consumes real blob storage and real GPU minutes. A 400-page upload is ~400 page images and potentially hours of 7B inference. Uncapped by policy, bounded by physics.

---

## 3. The AI provider model — the core architectural constraint

The operator pays for no metered AI. Cloud LLM/vision calls are funded entirely by the user. The one exception is a **fixed-size trial** run on operator-owned hardware (an RTX 5080), whose only marginal cost is electricity — it cannot scale into a surprise bill.

This produces **four operating tiers**, and the entire app must work in all of them.

| Feature | **0 — Trial** (operator GPU) | **A — Free** (after trial) | **B — Cloud key** | **C — Ollama** |
|---|---|---|---|---|
| Requirement | none | none | Anthropic/OpenAI key | Ollama installed |
| Cost to student | free | free | their API bill | free (their GPU) |
| Cost to operator | electricity, capped | $0 | $0 | $0 |
| Auto question extraction | ✅ Qwen2.5-VL 7B | ❌ manual editor | ✅ best quality | ✅ their model |
| Reads diagrams / figures | ✅ | ❌ | ✅ | ⚠️ vision model only |
| Phone photos & scans | ⚠️ decent | ⚠️ OCR only | ✅ | ⚠️ model-dependent |
| Auto topic tagging | ✅ | ❌ pick from tree | ✅ | ✅ |
| AI explanations | ✅ 20 total | ❌ | ✅ unlimited | ✅ unlimited |
| Solves unkeyed questions | ✅ badged | ❌ | ✅ badged | ✅ badged |
| Embeddings | ✅ free | ✅ free | ✅ free | ✅ free |
| **FSRS review** | ✅ | ✅ | ✅ | ✅ |
| **Weakness dashboard** | ✅ | ✅ | ✅ | ✅ |
| **Attempt history** | ✅ | ✅ | ✅ | ✅ |
| Can close the tab | ✅ queued | ❌ | ✅ queued | ❌ must stay open |
| Works when operator PC is off | ⚠️ queues | ✅ | ✅ | ✅ |
| Setup effort | none | none | paste a key | install + CORS config |
| Limit | 3 worksheets / 20 explanations, **lifetime** | none | their wallet | none |
| Where AI runs | operator GPU worker | nowhere | server | browser |

**The bolded rows are the product.** Review, the dashboard, and attempt history are identical on every tier. AI only affects *how questions get in* and *whether explanations exist*. A Tier A user who hand-enters 200 questions gets the complete experience — which is what makes the free tier a real product rather than a paywall.

Trial output is permanent: worksheets spent on Tier 0 leave behind questions, topics, and explanations that persist forever, long after the allowance is gone.

Topic-proposal embeddings are the exception to the whole tier system — they run **in the student's browser on every tier** (§7.3), so they work when the operator GPU is offline *and* the user has no key.

### 3.1 Tier 0 — the trial, on operator hardware

Every new account gets **3 worksheets of real AI extraction, once — a lifetime allowance, not monthly.** The point is that a student sees the entire loop work (extract → mark → explain → review → dashboard) before being asked to set up a key or install Ollama. It is the single biggest conversion lever in the funnel.

**The unit is a worksheet, not a page.** This was originally metered in pages, at 10. That was wrong for the actual material: a real SHSAT or SAT practice form is over 100 pages, so a page allowance was exhausted inside a fraction of one upload and the student never reached the part of the product that sells it. A worksheet costs one unit whether it has 1 page or 75, and the per-upload page cap (§4) is what bounds the operator's exposure instead.

- **Allowance:** 3 worksheets of extraction + classification, plus **20 AI explanations**, per account, ever.
- Consumed content is permanent: extracted questions, assigned topics, and generated explanations all persist after the trial is exhausted. Review and the dashboard keep working forever with no AI at all.
- When exhausted, the account drops to Tier A until they configure a key or Ollama.
- Counted in `usage_events` and enforced server-side at job creation, never client-side.

### 3.2 Tier A — free tier after the trial

Not a paywall screen. A real, complete product minus AI:

1. Browser rasterizes the PDF (pdf.js) into page PNGs.
2. Tesseract.js OCRs each page **client-side** — files never leave the device for this step.
3. Student uses a **manual question editor**: drag-select regions of the page image / text to define question boundaries, type or accept the OCR'd prompt, add answer choices, mark the correct answer.
4. Student assigns a topic from the canonical tree via a searchable dropdown.
5. **Everything downstream still works:** attempts, FSRS scheduling, review sessions, the weakness dashboard.

What they don't get: automatic extraction, automatic topic classification, and AI explanations.

### 3.3 The operator GPU worker

The 5080 sits on a home machine behind a residential connection. It is **never exposed to the internet** — no tunnel, no port forwarding, no inbound surface. It uses a **pull model**:

```
1. App enqueues a job row (status='pending', executor='operator_gpu')
2. Worker on the home machine polls the queue over an outbound HTTPS connection
3. Worker claims a job (atomic UPDATE ... RETURNING), fetches page images via signed URL
4. Runs Qwen2.5-VL 7B locally, writes structured questions back, marks job complete
5. Heartbeats every 30s so the app knows whether the GPU is alive
```

**When the GPU is offline** (PC asleep, rebooting, gaming, internet down): jobs **queue rather than fail**. The student is told their worksheet is queued and gets an in-app + email notification when processing finishes. No user is ever hard-blocked by the operator's machine being off — the trade is latency, not availability.

The UI shows a live worker-status indicator and a rough ETA derived from queue depth. If the GPU has been down beyond a threshold, the upload screen offers "process it manually instead" as an escape hatch into the Tier A editor.

**Model:** Qwen2.5-VL 7B, quantized, comfortably within 16GB VRAM. It is meaningfully worse than Claude or GPT vision on skewed phone photos and dense multi-column layouts — the extraction review step (§4, Stage 5) absorbs that, and trial-tier UI should set expectations honestly rather than implying frontier quality.

**Scaling path:** the same pull-worker architecture runs unchanged against a rented GPU box (Runpod/Vast) if volume outgrows one card. Nothing in the app couples to the hardware being in a bedroom.

#### 3.3.1 Egress protection — hiding the home IP

The pull model means nothing connects *in*. But the worker still connects *out* to the job API and the blob host, and both see a residential IP in their logs. Users never see it; Vercel, the blob CDN, and anyone with access to those logs do.

**Solution: route all worker egress through a $5/mo VPS acting as a Tailscale exit node.**

```
Home PC (worker container)
   │  WireGuard / Tailscale — the container's ONLY route
   ▼
VPS exit node (static IP you own)
   │  outbound HTTPS
   ▼
Job API  +  Blob host        ← these only ever see the VPS IP
```

Requirements:

- The worker container's network namespace has **exactly one route: the tunnel.** No split tunneling.
- **Fail closed.** If the tunnel drops, the worker loses all connectivity and stops claiming jobs. It must never fall back to the home interface — that's the failure mode that silently leaks the IP you set this up to hide.
- **DNS through the tunnel too**, or resolution leaks the destinations even when traffic doesn't.
- Jobs queue during an outage exactly as they do when the PC is off. No new failure mode.

**The real payoff is not privacy — it's a static IP you control.** Once egress is pinned to one address, the job API can **IP-allowlist the worker credential**. That upgrades the stolen-credential threat from "attacker claims jobs and reads student uploads" to "attacker has a credential that only works from a machine they don't have." Defense in depth, not just masking.

**Alternatives considered:**

| Option | Verdict |
|---|---|
| Commercial VPN with a dedicated IP (Mullvad etc.) | Works, ~$5–10/mo, no VPS to maintain. But static IPs aren't always guaranteed, which breaks the allowlist payoff. |
| Cloudflare Zero Trust dedicated egress IP | Clean and managed, but a paid Zero Trust tier for one worker is overkill. |
| Cloudflare Tunnel | **Wrong tool.** Tunnels solve inbound exposure; we have none. Adds surface without benefit. |
| Do nothing | Defensible — only your own providers see it, never users. But it costs $5/mo to remove the question entirely and gain IP allowlisting. |
| Rented GPU box | Solves it completely and defeats the point of using the 5080. This is the v2 path anyway. |

### 3.4 Tier C — Ollama, and its honest constraint

The server **cannot reach** a user's `localhost:11434`. Only their browser can. Consequences we accept and must design around:

- Ollama-mode AI calls are made **from the browser** via `fetch` to `http://localhost:11434`.
- The user must set `OLLAMA_ORIGINS=https://<our-domain>` (we ship a copy-paste setup guide with a live connection test).
- HTTPS → `http://localhost` is permitted by browsers (localhost is a potentially-trustworthy origin), but Chrome's Private Network Access may require a preflight; the setup check must detect and explain failure clearly.
- **Processing cannot continue in the background.** The tab must stay open for the duration. The UI must say this plainly, show progress, and checkpoint after every page so a closed tab resumes rather than restarts.

### 3.5 Provider abstraction

One interface, four implementations. Built in v1 so it never has to be retrofitted.

```
interface AIProvider {
  extractQuestions(pageImage, pageText): Promise<ExtractedQuestion[]>
  classifyTopic(question, candidateTopics): Promise<TopicAssignment>
  explain(question, studentAnswer, correctAnswer): Promise<Explanation>
  supportsVision: boolean
  executionSite: 'server' | 'browser' | 'operator_gpu'
}
```

- `AnthropicProvider` / `OpenAIProvider` — server-side, key from encrypted store.
- `OllamaProvider` — browser-side, base URL + model name from user settings.
- `OperatorGpuProvider` — Tier 0. Enqueues rather than calls; resolves when the pull-worker writes results back. Quota-checked before enqueue.
- `NullProvider` — Tier A. Every method throws `ProviderUnavailable`, and the UI routes to manual flows instead. Not an error state — a supported mode.

The **pipeline definition is shared**; only the executor differs. Server jobs, browser-orchestrated jobs, and operator-GPU jobs run the same stage sequence against the same DB.

### 3.6 API key handling

Background jobs need the key server-side, so client-only storage is not viable for Tier B.

- Keys are encrypted at rest with AES-256-GCM under a server-held master key (env var / KMS), per-row IV.
- Keys are **never** returned to the client after save — settings shows `sk-ant-…4f2a` only.
- Never logged, never included in error reports or traces.
- User can revoke/replace at any time; revoking wipes the ciphertext row.
- Ollama base URLs are stored in plaintext (not a secret) but validated against a localhost/private-range allowlist to prevent using us as an SSRF proxy — and since Ollama calls run in the browser anyway, the server never dials them.

---

## 4. Processing pipeline

All tiers share stages 1–2. Stages 3+ diverge by tier.

**Stage 1 — Ingest & rasterize (browser, all tiers)**
PDF or image in → pdf.js rasterizes to page PNGs at ~150 DPI → upload page images to Vercel Blob → create `worksheet` + `worksheet_pages` rows.
Per-upload cap: **75 pages** — enough for a full practice form, since that is the material this exists for. Rejected above that with a clear message; anything larger gets split, which is also better for the queue. Admins exempt (§2.1).

**Stage 2 — Text layer (all tiers)**
- Born-digital PDF: extract the embedded text layer (free, exact).
- Scanned/photo: Tesseract.js in-browser OCR.
- Tier B/C with a vision model: OCR text is still captured as a cheap prior, but the vision model reads the page image directly for better results on figures and messy photos.

**Stage 3 — Question segmentation**
- Tier 0: job enqueued; operator GPU worker runs Qwen2.5-VL 7B against the page images and writes structured questions back.
- Tier B: server job sends page image + OCR text to the vision model, returns structured questions.
- Tier C: same prompt, executed browser-side against Ollama.
- Tier A: skipped — manual editor.

Output per question: prompt text, question type (`multiple_choice` / `free_response` / `true_false` / `fill_blank` / `grid_in`), answer choices with labels, bounding box on the page, and a cropped image if the question contains a figure.

**Stage 4 — Answer key resolution** (precedence order)
1. Explicit key uploaded by the student (second file or typed-in list) — `answer_source = 'user_key'`
2. Key detected inside the PDF (trailing answer page / inline key) — `answer_source = 'pdf_key'`
3. AI solves it — `answer_source = 'ai_derived'`
4. Nothing — `answer_source = 'none'`

**`ai_derived` answers are visibly badged** in the UI ("AI-derived — not from an answer key") with a "this looks wrong" report button. We do not present model output as ground truth.

**Stage 5 — Extraction review (mandatory, all tiers)**
Nothing commits to the main question set until the student confirms. They see extracted questions side-by-side with the page image and can edit text, fix choices, split a merged question, merge a split one, or delete junk. This is the quality gate that keeps garbage out of the dashboard.

**Stage 6 — Topic classification**
Every question gets a topic — not just wrong ones (see §6.1). Tier A does this manually during review; Tiers B/C do it automatically with a manual override always available.

**Stage 7 — Markup (the "which did I get wrong" flow)**
See §5.3.

**Stage 8 — Explanations**
Generated **on demand, then cached forever** — only when the student opens a question in review. Explanations are grounded in the student's *actual* answer, so they address the specific misconception rather than just re-solving the problem.

### The four AI calls

Four distinct model calls, with different costs, prompts, and failure modes. Every one goes through the provider abstraction (§3.5), so the same call works server-side, browser-side, or on the GPU worker.

#### Call 1 — Extraction (vision)

**In:** page PNG + OCR text as a hint.
**Out:** schema-validated JSON, rejected on mismatch.

```json
[{
  "ordinal": 7,
  "prompt_text": "In triangle ABC, angle A = 40° and angle B = 65°...",
  "question_type": "multiple_choice",
  "choices": [{"label":"A","text":"75°"}, {"label":"B","text":"105°"}],
  "bbox": [102, 445, 610, 612],
  "has_figure": true
}]
```

`bbox` is load-bearing: it's how we crop the geometry diagram out of the page and attach it to the question. Without it, figure-based questions are unreadable in review.

*Failure mode:* merging two questions into one, or wrongly splitting a multi-part question. Worst on dense two-column layouts. Absorbed by extraction review (Stage 5).

#### Call 2 — Answer derivation

Only fires when no answer key exists. Result is stored with `answer_source='ai_derived'` — provenance lives on the row, not just in one rendered badge.

*Failure mode:* confidently wrong on multi-step math. Mitigated by visible badging and a report button, not by pretending the problem is solved. A v1.5 upgrade is self-consistency: solve 3×, surface only when runs agree.

#### Call 3 — Topic classification

The model **never names a topic.** It picks from a shortlist:

1. Embed the question with MiniLM (384-dim, §7.3)
2. Vector search the canonical tree → top ~15 candidate leaves, narrowed by subject hint
3. Model receives the question plus those candidates
4. Returns a **leaf ID** or explicitly **abstains**

```json
{ "topic_id": "geo.triangles.angle-sum", "confidence": 0.91 }
{ "topic_id": null, "abstain": true, "suggested_name": "Law of Cosines" }
```

On abstain or low confidence: the question is tagged to the nearest **ancestor** so it still appears on the dashboard at a coarser level, and a `topic_proposal` is written for admin review.

*Why this shape:* a model free to invent names produces "Triangles", "Triangle Properties", and "Geometry: Triangles" across three uploads, and the weakness ranking becomes silently meaningless. Forced-choice plus explicit abstain is what keeps the taxonomy stable.

#### Call 4 — Explanation

On demand, cached forever. Fires the first time a student opens the question in review — so we only spend on questions actually studied.

**In:** the question, the correct answer, **and the answer the student actually gave.**
**Out:** markdown explanation targeting that specific error.

> You picked **B, 105°**. That's the exterior angle at C, not the interior one. Angle C = 180 − 40 − 65 = **75°**…

This is why Stage 7 captures the chosen answer rather than a bare checkbox. "Explain this problem" is a textbook; "you picked B because you found the supplementary angle" is tutoring.

### Job execution

- **Tier 0:** durable queue → operator GPU pull-worker. Student can navigate away and close the tab entirely. Notified on completion. Queues rather than fails when the worker is offline.
- **Tier B:** durable queue → server-side background worker, live progress via polling or SSE. Student can navigate away. (Vercel function timeouts make this mandatory, not optional.)
- **Tier A/C:** browser-orchestrated, per-page checkpointing, resumable. UI states clearly that the tab must stay open.

Tiers 0 and B share one queue with an `executor` discriminator; the operator worker only claims `executor='operator_gpu'` rows.

---

## 5. Screens & flows

### 5.1 Onboarding
Signup → age gate → straight into the **trial**. No AI configuration is asked for up front — the fastest path to a first upload is the point of Tier 0. The account starts on Tier 0 with 3 worksheets available.

AI setup ("Choose how StudyBuddy thinks" — Cloud key / Ollama / stay free) surfaces at two moments instead: when the trial runs low (1 worksheet left), and any time from settings. Each option carries an honest description of what works and what doesn't, with a live connection test.

### 5.2 Upload — full walkthrough

Mobile-first; phone photos are a primary input.

**Step 1 — Pick files.** Camera capture on mobile, drag-drop on desktop, multi-page batching. Optional subject hint ("SAT Math") that narrows the classifier's candidate shortlist later.

**Step 2 — Browser rasterizes.** `pdf.js` converts each page to a ~150 DPI PNG, client-side, on every tier. This is a security decision as much as a performance one: **the server and the GPU worker never touch a raw PDF**, which removes the entire PDF-parser attack surface from the operator's home machine. Cap: 75 pages per upload (admins exempt, §2.1).

**Optional page range.** The upload screen takes an optional first/last page. Practice material routinely bundles a test with its answer key and a full explanations section — one real SHSAT form is 59 pages of test followed by 53 pages of rationales, and extracting all 112 produced 81 items that were not questions. Filtering afterwards cannot recover that cost, since the pages have already been rendered, uploaded, read, and sent to the GPU. So the range is applied **before rasterization**: an excluded page is never decoded, never drawn to a canvas, never encoded, never uploaded, and never processed. Page numbers are document-wide, so a range means the same thing whether the student picked one PDF or several files, and pages keep their **original** numbering — extracting pages 60–112 stores them as 60–112, not 1–53.

**Step 3 — Page images upload** to blob storage via signed URLs. `worksheet` + `worksheet_pages` rows created.

**Step 4 — Text layer.** Born-digital → embedded text extraction (exact, free). Scan/photo → `tesseract.js` in-browser OCR. On vision tiers the OCR text is kept as a cheap prior while the model reads the image directly.

**Step 5 — Extraction**, per tier:

| Tier | Behavior |
|---|---|
| **0** | Job enqueued. Screen shows queue depth, worker status, ETA. **Tab can be closed.** Notified on completion. Worker offline → queues, doesn't fail. |
| **B** | Server background job with live progress. Tab can be closed. |
| **C** | Browser drives `localhost:11434` page by page. **Tab must stay open**; checkpointed so closing resumes rather than restarts. |
| **A** | Skipped → manual editor. |

**Step 6 — Answer key resolution** via the precedence chain (Stage 4). AI-derived answers get the `ai_derived` badge and a report button.

**Step 7 — Extraction review.** Mandatory on every tier. Questions shown beside the page image; student fixes text, corrects choices, splits merged questions, merges split ones, deletes junk. Nothing commits until confirmed. This gate is what makes a 7B model acceptable on the trial tier.

**Step 8 — Markup** (§5.3): outcome per question, then answer capture for the wrong ones.

**Step 9 — Cards created.** Every question gets an FSRS `review_card`. Wrong → due immediately. Unsure → short interval. Correct → long interval.

**Tier-specific state on this screen:**
- **Tier 0:** remaining trial pages, GPU worker status, queue depth + ETA, processing-location disclosure (§8).
- **Tier 0, worker offline:** "queued — we'll notify you," plus a "do it manually instead" escape hatch.
- **Tier A:** manual-editor path, with a prompt to add a key or Ollama.
- **Tier C:** "keep this tab open" warning.

### 5.3 Markup — "which ones did you get wrong?"
Per the agreed flow, marking happens in two steps:

**Step 1 — outcome, per question:** `Correct` / `Unsure` (got it right but guessed) / `Wrong`. Fast, one tap each, designed to fly through 40 questions.

**Step 2 — answer capture:** for every question marked `Wrong` (and optionally `Unsure`), prompt for the answer they actually gave — tap the choice for multiple-choice, short text field otherwise.

`Unsure` is tracked as a distinct outcome, not folded into correct. It's a leading indicator of a weak topic and feeds both the dashboard and FSRS scheduling.

### 5.4 Review
FSRS-scheduled queue of due questions, plus free browsing by topic. Each card shows the question (with figure image if present), the student's original answer, the correct answer with its provenance badge, and the cached AI explanation. Student rates recall (Again / Hard / Good / Easy) → FSRS reschedules.

### 5.5 Dashboard

Three questions it must answer: *What am I bad at? What should I do right now? Am I improving?*

**Top strip**
- **Due for review** — the primary CTA
- Questions tracked / worksheets uploaded
- Study streak
- Trial pages remaining (Tier 0) or AI status (other tiers)

**Panel 1 — Weakest topics** *(the centerpiece)*

Ranked rows: topic path, accuracy, attempt count, unsure rate, trend arrow, "Review these" button.

> `Geometry › Triangles › Angle Relationships` — **38%** (8/21) ↓ · 4 unsure

Ranking math, with two guards:
- **Minimum 5 attempts** before a topic is eligible to be called a weakness.
- Rank by **Wilson score lower bound** of the error rate, not raw percentage.

Without both, "1 wrong out of 1" outranks "12 wrong out of 40" and the dashboard confidently sends the student to study something they've seen once. Topics below the floor render in a distinct "not enough data yet" state — never green, never red.

**Panel 2 — Subject drilldown.** Expandable tree, `Math → Geometry → Triangles → Angle Relationships`, accuracy at every level rolled up from children. Color-coded with an explicit neutral state for low-n.

**Panel 3 — Accuracy over time.** Weekly line chart, toggleable overall vs. per-subject. Answers "is any of this working."

**Panel 4 — Unsure rate.** Tracked as its own signal. A topic at 85% accuracy with a 40% unsure rate is *fragile*, not strong — the student is guessing correctly. This is the signal most study tools discard by collapsing "unsure" into "correct."

**Panel 5 — Review forecast.** Cards due today / this week, broken down by topic. FSRS-driven.

**Panel 6 — Recent worksheets.** Score, date, topic breakdown, resume link. Includes anything currently sitting in the GPU queue.

**Panel 7 — Distractor patterns** *(nice-to-have, v1 if cheap).* Which wrong answers the student gravitates toward. "You pick the supplementary angle in 6 of 9 misses" is more actionable than any topic-level score, and it falls out of the `selected_choice_id` data we already capture.

---

## 6. Data model

Postgres (Neon) + pgvector. Drizzle ORM.

### 6.1 Key decision: one question table, attempts on top

The original design had a separate "wrong questions" database. **We're not doing that**, because the dashboard needs a denominator — "Triangles: 8 wrong" is meaningless without knowing whether it's 8 of 10 or 8 of 60, and a wrong-only table systematically ranks *frequently-appearing* topics as weaknesses.

Instead: **every question is stored and topic-tagged; an `attempt` row records the outcome.** "Wrong questions" is a filtered view, not a table.

### 6.2 Tables

```
users                 id, email, name, image, dob, ai_tier, created_at,
                      role('student'|'admin'), trial_worksheets_used,
                      trial_explanations_used
                      (trial_pages_used survives from the page-metered
                       design and is no longer read)
accounts/sessions     (Auth.js standard)

user_ai_credentials   user_id, provider('anthropic'|'openai'|'ollama'),
                      encrypted_key, key_iv, key_last4,
                      ollama_base_url, model_name, vision_model_name,
                      verified_at, updated_at

worksheets            id, user_id, title, source_type, page_count,
                      subject_hint, status, tier_used, created_at
worksheet_pages       id, worksheet_id, page_number, image_url,
                      width, height, ocr_text, ocr_engine

questions             id, user_id, worksheet_id, page_id, ordinal,
                      prompt_text, question_type, bbox jsonb,
                      figure_image_url, correct_answer,
                      answer_source('user_key'|'pdf_key'|'ai_derived'|'none'),
                      extraction_confidence, user_verified, content_hash,
                      created_at
answer_choices        id, question_id, label, text, is_correct

topics                id, parent_id, slug, name, depth, subject_root,
                      is_canonical, embedding vector(384), created_at
question_topics       question_id, topic_id, confidence,
                      assigned_by('ai'|'user'), is_primary

topic_proposals       id, proposed_name, suggested_parent_id, source_question_id,
                      user_id, embedding vector(384),
                      status('pending'|'merged'|'accepted'|'rejected'),
                      merged_into_topic_id, created_at

attempts              id, user_id, question_id,
                      outcome('correct'|'unsure'|'wrong'),
                      selected_choice_id, free_text_answer,
                      source('markup'|'review'), created_at

explanations          id, question_id, attempt_id, body_md, misconception_note,
                      provider, model, generated_at, reported_wrong

review_cards          id, user_id, question_id, fsrs_state jsonb,
                      due_at, stability, difficulty, reps, lapses, state
review_logs           id, card_id, rating, reviewed_at, elapsed_days

processing_jobs       id, worksheet_id, stage, status, progress,
                      executor('server'|'browser'|'operator_gpu'),
                      priority('high'|'normal'|'low'),
                      claimed_by, claimed_at, attempts, error, checkpoint jsonb
usage_events          id, user_id, kind, provider, tokens_in, tokens_out, created_at

gpu_workers           id, name, last_heartbeat_at, model_name,
                      status('online'|'offline'|'draining'), jobs_in_flight
```

### 6.3 Duplicate questions

Same question appearing across two worksheets is common (practice books repeat). Dedup **within a single user's data**:
- Exact: normalized `content_hash` (lowercased, whitespace/punctuation-collapsed prompt + choices).
- Near: embedding cosine similarity above a threshold → offer to merge during extraction review, never auto-merge silently.

Merged questions keep one `review_card` and accumulate attempts — which is exactly right, since repeated exposure to the same problem is signal.

---

## 7. Topic taxonomy

**Model: hybrid — fixed canonical tree, AI maps onto it, unmapped questions go to a review queue.**

Free-form AI topic naming was rejected: it produces "Triangles", "Triangle Properties", and "Geometry: Triangles" as three topics across three uploads, which silently destroys the dashboard.

### 7.1 Seeded trees (v1)

1. **SAT Math** — College Board's published domains/skills (Algebra, Advanced Math, Problem-Solving & Data Analysis, Geometry & Trigonometry).
2. **SAT Reading & Writing** — Information & Ideas, Craft & Structure, Expression of Ideas, Standard English Conventions.
3. **HS Math** — Algebra 1 → Geometry → Algebra 2 → Precalculus, ~150 leaves.
4. **ELA** — grammar/mechanics, rhetoric, reading comprehension skills.

Science (Bio/Chem/Physics) and AP frameworks are deferred — largest authoring effort, most diagram-dependent.

### 7.2 Classification

Classifier is given the question plus a **shortlist** of candidate leaves (narrowed by subject hint and vector similarity), not the entire tree. It must return an existing leaf ID or explicitly abstain.

- Abstain, or confidence below threshold → write a `topic_proposal` and tag the question with the nearest ancestor so it still appears on the dashboard at a coarser level.
- Proposals are deduped by embedding similarity against existing topics and other pending proposals before surfacing.
- An admin (you) reviews the proposal queue and either merges into an existing leaf or promotes it into the canonical tree.

### 7.3 Embeddings — resolved

Two things need vectors: narrowing the candidate-leaf shortlist for the classifier, and deduping topic proposals against existing topics.

**Decision: `Xenova/all-MiniLM-L6-v2` (384-dim, ~23MB quantized ONNX) via `@huggingface/transformers`, everywhere.** No embedding API is ever called.

Embeddings are computed **wherever the question is created**, using that same model so vectors stay interchangeable across tiers:

| Tier | Where embeddings run |
|---|---|
| 0 | Operator GPU worker (already has the hardware) |
| A / C | Student's browser (WASM, WebGPU if available) |
| B | Server-side in the job worker (Node) |

Why this and not a cloud embedding model:

- **Zero cost, permanently** — no metered API on any tier.
- **Closes a real hole:** Anthropic has no embeddings API, so a Tier B user with an Anthropic key would otherwise have had no embedding source at all.
- **Runs on terrible hardware.** WASM+SIMD, tens of milliseconds for a short string on a low-end Chromebook; one-time 23MB download cached in IndexedDB. WebGPU used automatically when present.
- **Works when the operator GPU is offline** and the user has no key — the one AI-adjacent capability with no external dependency.

384 dimensions is weaker than a frontier embedding model, but the task is distinguishing "Triangles" from "Triangle Similarity" within a curated tree of a few hundred leaves. That's well within its range.

---

## 8. Non-functional requirements

**Security**
- API keys encrypted at rest (AES-256-GCM), never returned to client, never logged.
- All queries scoped by `user_id`; row-level authorization enforced in the data layer, not just the UI.
- Signed, short-lived URLs for blob access — page images are user schoolwork and must not be publicly enumerable.
- Rate limits per user on upload and job creation to protect our own storage/DB even though AI is user-funded.
- Operator GPU worker authenticates with a dedicated service credential over outbound HTTPS only. **No inbound ports, no tunnel, no public endpoint on the home network.** Credential is rotatable and scoped to queue-claim + result-write.
- Trial quota is enforced **server-side at enqueue time**. A client cannot mint free GPU jobs.

**Privacy**
- Tier A/C: page content never leaves the device for OCR (browser-side Tesseract) or embeddings.
- **Tier 0 disclosure (required):** trial uploads are transmitted to and processed on **operator-controlled hardware**. The privacy policy must state this plainly — that page images are sent to a machine we operate, retained only for the duration of the job, processed by a local model, and **never used for training**. This must be visible at the point of upload, not buried in the policy.
- Operator worker deletes its local copy of page images immediately on job completion; no local retention.
- Original PDFs are **deleted after processing**; we retain page images and per-question figure crops (required for geometry/graph questions on the review page).
- Full account deletion wipes blobs and rows.

**Performance**
- Markup screen must handle a 40-question worksheet without lag; virtualize long lists.
- Dashboard aggregates precomputed or materialized — no per-page-load full scans of `attempts`.
- Mobile-first; usable on a phone in a school hallway.

**Operator GPU threat model**

The single most important property: **users never control the prompt.** They upload an image; the worker applies the operator's own fixed prompt template with a strict output schema. There is no passthrough, no chat endpoint, no system-prompt override. The GPU cannot be repurposed as a free LLM — it can only extract questions from images.

| Threat | Mitigation |
|---|---|
| Sybil accounts farming 10 free pages each | Email verification required; Google OAuth preferred; disposable-domain blocklist; per-IP signup rate limit; trial tied to verified email, not session |
| Flooding the enqueue endpoint | Auth required; quota checked server-side at enqueue; per-user rate limit; **max 1 in-flight GPU job per user** |
| Using the GPU as a general-purpose LLM | Fixed prompt template, no user-supplied instructions, schema-validated output, no tool use, no network access from the model |
| Prompt injection inside worksheet content ("ignore instructions and…") | Page content is treated strictly as data; structured output schema is validated and rejected on mismatch; worker has no tools, no filesystem writes outside its temp dir, no outbound calls except the job API |
| Malicious/malformed files crashing the worker | **The worker never parses a PDF.** The browser rasterizes to PNG before upload, so the home machine only ever sees app-produced images. Size, dimension, and page caps enforced; images re-encoded server-side |
| Stolen worker credential | Credential scoped to `claim job` + `write result` only; rotatable; signed image URLs scoped to the specific claimed job and short-lived, so a stolen credential cannot enumerate other users' uploads |
| Resource exhaustion by one job | Per-job wall-clock timeout, max output tokens, worker concurrency of 1, automatic requeue with attempt cap |
| Lateral movement into the home network | Worker runs containerized, egress-restricted to the job API and blob host, no LAN access, non-root |
| **Home IP visible to blob host / job API logs** | All worker egress routed through a VPS exit node (§3.3.1), fail-closed. Providers see only the VPS IP; the static address then enables IP-allowlisting the worker credential |
| **Admin upload stalling every trial user** | Admin bulk jobs default to the `low` priority lane and yield to Tier 0 jobs (§2.1) |
| **Privilege escalation to admin** | Role derived from a verified email against an env-var allowlist; no UI grants admin. Admins cannot read other users' questions or answers |
| Student data sitting on a home machine | Page images fetched to a temp dir, deleted on job completion or failure; full-disk encryption assumed; no logs containing page content |

**Cost to operator**
- **No metered AI spend.** The only AI cost is electricity on the 5080, bounded by a hard 10-page lifetime trial per account — spend cannot scale unexpectedly with signups, only queue latency can.
- Bounded storage via the delete-PDF policy and a per-upload page cap.
- Embeddings cost nothing on any tier (§7.3).

---

## 9. Scope

### v1 — the complete core loop

- Auth (Google + email/password), 13+ age gate
- Upload → rasterize → OCR/vision extract → **extraction review** → commit
- **All four tiers**, including **Ollama in v1** (it's the free AI path, so it can't be deferred)
- **Operator GPU pull-worker** + durable queue + heartbeat/status UI + completion notifications
- 10-page / 20-explanation lifetime trial quota, enforced server-side
- Manual question editor for Tier A
- Browser/server/GPU embeddings via MiniLM (§7.3)
- Answer-key precedence chain with `ai_derived` badging
- Markup flow (outcome, then answer capture)
- Topic classification onto seeded SAT / HS Math / ELA trees + proposal queue
- On-demand cached explanations grounded in the student's actual answer
- FSRS review (via `ts-fsrs`)
- Weakness dashboard with volume floor
- Tier 0 privacy disclosure at point of upload

### v2

- AI-generated practice questions **with verification** — generate, then independently re-solve (plus symbolic/numeric check for math) and only surface questions where the runs agree. Deferred deliberately: unverified generated math is wrong often enough to actively harm a student.
- Pricing/billing on the platform
- Science and AP taxonomies
- Chat-with-tutor on a specific question
- Shareable read-only dashboard link
- Move the GPU worker to rented hardware (Runpod/Vast) if queue latency becomes the limiting factor — no app changes required, same pull-worker contract
- Multiple GPU workers claiming from one queue (the schema already supports it via `claimed_by`)

---

## 10. Stack

- **Next.js** (App Router) on **Vercel**
- **Postgres** (Neon) + **pgvector**, **Drizzle** ORM
- **Vercel Blob** for page images
- **Auth.js v5**
- **pdf.js** (rasterization) + **tesseract.js** (browser OCR)
- **ts-fsrs** (scheduling)
- **@huggingface/transformers** + `Xenova/all-MiniLM-L6-v2` (embeddings, browser + Node)
- Durable queue for Tier 0/B background jobs (Vercel Queue / QStash / Inngest — decide at build time; must support an external pull-worker, or fall back to a Postgres-backed queue with `SELECT ... FOR UPDATE SKIP LOCKED`)
- **Operator worker:** Node script + Ollama (or vLLM) running **Qwen2.5-VL 7B** on an RTX 5080, containerized
- **Egress:** Tailscale (or raw WireGuard) from the worker container to a ~$5/mo VPS exit node with a static IP (§3.3.1)
- **Resend** (or similar) for job-completion email
- **Tailwind + shadcn/ui**

---

## 11. Risks

| Risk | Severity | Mitigation |
|---|---|---|
| Extraction quality on phone photos is the make-or-break variable | **High** | Mandatory extraction review; build and iterate this stage first against real worksheets |
| `ai_derived` answers are confidently wrong; student memorizes the error | **High** | Visible provenance badge + report button; self-consistency check as a v1.5 upgrade |
| ~~**The trial runs the weakest model on the first impression**~~ — **benchmarked 2026-07-31 and cleared.** Qwen2.5-VL 7B on the RTX 5080: **5/5 questions extracted in 6.0s** on a synthetic geometry/algebra page, **4/4 topics classified correctly** (~0.9s each), and a misconception-targeted explanation in 1.5s. Re-benchmark on real scanned and phone-photo pages before launch — the synthetic page is clean, which is the easy case | Low–Medium | `npm run benchmark:ollama` re-runs it; extraction review still absorbs errors |
| Signup spike floods one GPU; trial users wait hours | Medium | Queue depth shown with honest ETA; per-user concurrency limit of 1 job; rented-GPU path is a config change |
| Operator PC/internet down for an extended period | Medium | Jobs queue rather than fail; heartbeat drives status UI; manual-editor escape hatch after a threshold |
| Ollama tab-must-stay-open UX feels broken | Medium | Explicit messaging, per-page checkpointing, resumable jobs |
| Ollama CORS/PNA setup defeats non-technical students | Medium | Guided setup with a live connection test and exact copy-paste commands |
| Topic tree fragments despite the hybrid model | Medium | Shortlisted candidates + forced abstain + embedding dedup on proposals |
| Small local models extract questions poorly vs. frontier models | Medium | Set a minimum recommended model; surface a quality warning for known-weak models |
| Zero-revenue model means storage cost grows with no offset | Low | PDF deletion, page cap, retention policy on inactive accounts |

---

## 12. Assumptions I made — flag any you disagree with

1. **Mobile-first** design, since phone photos are a primary input.
2. Dedup is **within a single user's data only** — no cross-user question pooling (avoids a copyright and privacy surface).
3. `Unsure` is a first-class outcome distinct from correct/wrong, feeding both dashboard and scheduling.
4. Per-upload cap of **75 pages** — a full practice form fits in one upload.
5. The admin topic-proposal queue is **you**, via a simple internal page — not a public moderation system.
6. Answer-key extraction from inside a PDF requires an AI tier; Tier A users must type keys manually or skip them.
7. **The trial bundles 20 AI explanations alongside the 3 worksheets.** You specified "10 pages once" — but extraction alone doesn't show the payoff, and explanations are the thing that sells the product. Adjust the number if you disagree.
8. The trial is a **lifetime** allowance, not monthly — otherwise it's a free tier with a rate limit, and your GPU carries the product forever.
9. Trial worksheets are consumed at **enqueue**, not on success. Failed jobs are refunded automatically; this prevents quota-farming via deliberate failures.
10. Completion notifications are **in-app + email**. Email needs a transactional provider (Resend) — small addition, not previously discussed.
11. **I need Vedant's and Avya's actual email addresses** to populate `ADMIN_EMAILS`. Spec'd as config so this doesn't block anything — placeholders for now.
12. "Unlimited upload length" for admins bypasses the **page-count cap only** — per-page size and dimension caps still apply, since those are crash guards rather than quotas.
13. Admin is an operations role, **not** a superuser over student data. Admins see the proposal queue and worker console, not other people's questions or answers. Say so if you wanted otherwise.
14. Egress protection assumes you're willing to run a ~$5/mo VPS. If not, the fallback is a commercial VPN with a dedicated IP, or accepting that your own providers see your home IP (users never do).

---

## 13. Build order

1. Schema + auth (incl. admin role from `ADMIN_EMAILS`) + seeded topic trees
2. Upload → rasterize → page images → OCR (Tier A end-to-end, no AI at all)
3. Manual question editor + extraction review UI
4. Markup flow + attempts
5. FSRS review + dashboard — **at this point Tier A is a shippable product**
6. Provider abstraction + durable queue + Tier B (cloud keys, server jobs)
7. **Operator GPU worker + Tier 0 trial** (pull-worker, heartbeat, quota, priority lanes, notifications) — reuses the queue from step 6. Set up the VPS exit node and IP allowlist here, before the worker ever runs unprotected.
8. Tier C (Ollama, browser execution) on the same abstraction
9. MiniLM embeddings (browser + Node + worker)
10. Automatic topic classification + proposal queue
11. Explanations
12. Polish, retention jobs, privacy disclosures

**Benchmark gate (step 7): PASSED on 2026-07-31.** `scripts/benchmark-ollama.ts` ran Qwen2.5-VL 7B against a synthetic worksheet page on the RTX 5080 — 5/5 questions extracted in 6.0s, 4/4 topics classified correctly, misconception-aware explanation generated. Tier 0 is viable; proceed with the queue.

Caveat: the benchmark page is clean, machine-rendered text. **Re-run against a real scan and a real phone photo before launch** — that is where a 7B model actually struggles, and the result there is what decides whether the trial helps or hurts.
