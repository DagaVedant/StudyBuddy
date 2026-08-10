<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes: APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Looks dead, is not

Every item below has been flagged as unused by a dead-code scan at least once,
and every one is live. Check against this list before deleting anything that
looks unreferenced, and if you find something genuinely dead, add the reasoning
here rather than only removing the code.

The four blind spots that produce nearly all of it:

1. **Root-level files are outside `app/`, `lib/` and `components/`.** `auth.ts`,
   `proxy.ts`, `drizzle.config.ts`, `next.config.ts` and `playwright.config.ts`
   sit in the repo root, and a scan aimed at the source directories misses every
   import they make.
2. **Relative imports do not match an `@/`-prefixed grep.** Searching for
   `@/components/mark` finds nothing; the import reads `./mark`.
3. **`scripts/` is a real consumer.** 26 operator scripts, none in
   `package.json`, several of them the only caller of a `lib/` module.
4. **Raw SQL does not import the table.** A `db.execute(sql\`…\`)` naming a table
   never references the Drizzle object for it.

| Item | Why it looks dead | Why it is live |
|---|---|---|
| `lib/ai/ollama.ts`, `lib/worker/audit.ts` | Unreachable from `app/` | The only callers are `scripts/gpu-worker.ts` and the benchmark scripts, which are wired to `npm run worker` and documented in SETUP.md. `lib/worker/review.ts` used to belong here too and no longer does: the job route imports `planPageReplacement`. |
| `components/mark.tsx`, `components/nav-links.tsx` | No `@/components/...` import anywhere | Imported relatively from `app-topbar.tsx` and `hero.tsx`. `app/opengraph-image.tsx` also reimplements `mark.tsx` as flexbox, because Satori cannot render the component, so the two have to be changed together. |
| `sessions`, `verificationTokens` in `lib/db/schema.ts` | No reference in `app/`, `lib/` or `components/` | Both are passed to the Drizzle adapter in the root `auth.ts`. `verificationTokens` in particular is required by the adapter contract even though the email verification flow was deleted: dropping the table breaks Auth.js. |
| `rateLimits` in `lib/db/schema.ts` | The identifier appears nowhere but its own definition | `lib/rate-limit.ts` reaches the table through raw SQL, because the upsert needs a `CASE` in its `DO UPDATE`. The table is live on every upload. |
| The 20 `pgEnum` declarations | Never imported by name | Consumed inside `schema.ts` itself by the column definitions. |
| `mockEnabled`, `cloudProvider` in `lib/ai/resolve.ts` | No external callers | Used further down the same file. |
| The scripts in `scripts/` | Not in `package.json`, invoked by hand | Deliberately ad-hoc `npx tsx` tools. They are listed in SETUP.md under "Operator scripts", and nine of them write to the database behind the guards in `scripts/_confirm.ts`. |
| `sharp` | Not imported anywhere under `app/` or `lib/` | Used by `scripts/gpu-worker.ts`, `scripts/try-prompt.ts` and the three benchmark scripts. It arguably *should* also be used server-side for image re-encoding; that is a missing use, not an unused dependency. |

Separately verified and worth not re-auditing: no file under `lib/` or
`components/` is unimported, no build artifact is tracked, and every deleted
feature (parallel page reading, the mail module, the verification route) took
its tests and helpers with it. There are no stranded test files and no dangling
imports.
