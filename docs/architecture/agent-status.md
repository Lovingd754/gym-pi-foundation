# Agent mechanism status (2026-09-27)

## Already implemented before this change

- Confirmed long-term memories are persisted, proposed as PENDING, become ACTIVE only after user confirmation and are injected into every run. Memory management supports dismissal/deletion and identical-text deduplication. There is no typed memory taxonomy, expiry policy or semantic conflict resolution.
- Conversation messages are persisted in full. Compaction triggers after more than 30 uncompressed COMPLETE messages, retains the newest 12 verbatim, and stores a digest of at most 1,200 characters plus a boundary timestamp. This is message-count-based, NOT a strict token-budget trigger. Failed model summarization uses a deterministic digest fallback. Context loads all completed messages beyond the boundary, excluding the exact current message ID.
- Business facts (plan, recent training and memories) are retrieved with scoped tools. This is relational retrieval, not vector RAG.
- Week-specific commitments have their own calendar-week storage and do not become permanent memories. Strength candidates are model-generated and validated; proposal/version confirmation remains authoritative.

## Implemented in this change

- Conversation-local structured task state persists independently of the digest: task kind, COLLECTING/PENDING_CONFIRMATION/NEEDS_REVISION phase, filled fields, missing fields, current pending proposal reference and the latest correction.
- Common explicit training slots (limited exercise-name patterns, unit-bearing weight, reps and sets) merge across turns. Explicit new log requests reset old slots. Slot-only continuations and unambiguous correction phrases can reuse the task skill rather than being misrouted as a new topic. This does NOT add a general natural-language slot extractor.
- Successful proposal tool results provide actual proposal references; text claiming a proposal exists is not accepted as evidence. At the next run, proposal status is checked with user and conversation ownership; confirmed, dismissed, deleted or active-memory references clear the task hint.
- Current task is injected as bounded application context. Corrections remain NEEDS_REVISION until a successful new proposal tool result. It is not a confirmed memory and cannot activate, confirm or cancel data.
- Revision-checked writes prevent stale concurrent overwrites; conflict stops the run rather than silently replacing newer task state. This is not a full per-conversation execution lock.
- No extra model call is used. Only chat runtime conversations are tracked; injected synthetic runtimes can opt in with a TaskStateStore. Existing evaluation reports predate this feature and do not measure its improvement.

Migration: `prisma/migrations/20260927090000_add_agent_task_state/migration.sql`. Prisma client generated; database migration and real DB integration remain pending while Postgres is unavailable.

Verification checkpoint: 764 related tests passed across 56 files, TypeScript passed, and production build passed (one existing unused-function lint warning). No real-model or database evaluation of the new task-state feature has been claimed.

## Not implemented / optional next steps

- Memory categories, TTL/expiry, replacement links, semantic deduplication and conflict resolution.
- True token-budget-driven compaction; task-boundary-aware retention instead of the fixed 12-message tail.
- Vector or hybrid retrieval for large free-text histories. Current structured business data does not require it.
- Generic model-based slot extraction, multiple simultaneous tasks, exhaustive ambiguity resolution, automatic superseding of older proposal cards, or persisted tool transcripts. Existing confirmation endpoints retain their current behavior; this task-context layer alone does not prohibit confirming an older pending proposal.
- Production metric improvement or a new full 200/100/30 evaluation after task-state integration. Such claims require another measured run.
