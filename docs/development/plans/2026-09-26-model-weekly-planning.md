# Model Weekly Planning Implementation Plan

> **For agentic workers:** Use subagent-driven-development for independent implementation and review. Work in the current feature worktree; preserve the existing context fixes and untracked handoff.

**Goal:** Generate a user-confirmed weekly plan using last week's evidence, current constraints and this week's activities; execute a full, bounded evaluation and report observed usage.

**Architecture:** A weekly activity input is stored per user and calendar week in a separate record. A model proposes structured scheduling and exercise strategy from the active plan, training/recovery evidence, confirmed memories and current activities. Rules validate feasible dates/equipment and calculate prescriptions. Persist a draft with model rationale and strategy, then use the existing confirmation/activation flow. Model failure is explicit; no silent rules-only success.

**Tech Stack:** Next.js, Prisma/PostgreSQL, existing LLM provider, Vitest, pi-agent.

### Task 1: Weekly planning backend

- [ ] Add a bounded weekly activity schema and authenticated GET/PUT endpoint with per-week storage; add Prisma model and migration.
- [ ] Write failing tests for blocked dates, short windows, model response validation, missing evidence, infeasible weeks and model failure.
- [ ] Add a structured model weekly strategy request using current plan, last seven days, confirmed memories and week activities; validate dates/equipment and recovery spacing. Preserve model rationale and source.
- [ ] Integrate into weekly-review generation. Do not rewrite permanent profile availability. Never activate through the automatic browser runner; publish drafts for review.
- [ ] Support temporary reduced training availability without inventing sessions; handle zero/one feasible day explicitly and safely.
- [ ] Verify focused tests and typecheck; inspect activation freshness and version races.

### Task 2: Weekly activity UI

- [ ] Add component tests for saving activities and generating after saving.
- [ ] Render this week's dated activities, including event description, unavailable days, limited time and equipment information, on the managed plan page even when a review is not yet due.
- [ ] Save through the endpoint and allow an explicit regenerate action; show loading/errors and model rationale on preview.
- [ ] Update translations in English and Chinese and verify accessibility.

### Task 3: Full evaluation

- [ ] Freeze 200 labeled routing inputs, 100 single-turn scenarios and 30 tasks averaging three turns. Use production classifier prompt and actual tools; keep test state separate from user data.
- [ ] Add quality assertions for tool parameters, missing-input clarification, pending versus confirmed memory, unsupported actions, corrections, and plan-confirmation safety.
- [ ] Run with the currently configured live model; capture classifier and agent token usage, cache and elapsed time, errors and failed cases. Bound time, retries and spend; report a partial run only if externally blocked.
- [ ] Save machine-readable results and Markdown report, including fixtures/database boundaries. Do not report print-only script completion as all scenarios passing.

### Task 4: Review and verification

- [ ] Independently review requirement compliance, then quality and safety; fix material findings.
- [ ] Run relevant unit/component tests, typecheck, lint and production build; run DB/browser tests when services are available.
- [ ] Report feature behavior, observed evaluation scores and usage, limitations, and explain model/rule composition with one example.
