# Model-led weekly planning

The weekly review now asks the user's configured model for a fresh strategy instead of reusing the original plan's strategy. Inputs include the active plan, assessment, previous week's training/cardio and body evidence, recent load evidence, readiness check-ins, up to 20 active memories and current-week commitments.

## Workflow

1. Edit this week's commitments in the weekly review card. Each ISO weekday can specify a note, unavailability, minutes and equipment. Saving is scoped to the user's timezone calendar week, not the permanent assessment.
2. Save commitments before requesting a draft. The model chooses training weekdays, exercise preferences/avoidance, cardio preference and recovery level, with a rationale.
3. Strict validation rejects invented days, incompatible preferred equipment, duplicate days, contradictory recovery and consecutive full-body sessions. Invalid model output fails explicitly; it is not silently replaced by a default strategy.
4. Deterministic generators calculate exercise sets, durations, starting loads, energy and cardio. Recovery reduction decreases sets and increases the repetitions-in-reserve target. Final plan schema validation must pass.
5. Manual and automatic UI reviews create a draft. The trainee previews and confirms activation. Changing assessment data, weekly commitments or calendar week invalidates the draft at activation.

## Current boundaries

- Supported strength schedules remain 2–5 sessions/week. Fewer than two feasible days, an adjacent-only pair (including Sunday/Monday), or insufficient session time produce an actionable refusal, not fabricated training days. Sessions below 30 minutes cannot produce the supported strength template.
- The common equipment intersection and shortest time budget across selected strength days are used conservatively. This is not yet a per-day heterogeneous exercise-template engine.
- The model controls strategy; numerical calorie adjustments still use the existing bounded body-trend rules. This is not free-form model-written medical or nutrition advice.
- Model rationale is persisted and shown on the draft preview and review card. Weekly commitments are not stored as permanent memories.
- New table migration: `prisma/migrations/20260926090000_add_weekly_activities/migration.sql`. Database deployment and real database integration must be verified when Postgres is available. Do not reset an existing database.

## Verification

Focused fitness, Agent, fitness UI and model tests: 749 passed across 53 files at the final integrated test checkpoint. Typecheck passed after the final adjacent-day guard; production build passed before that small guard. Live weekly strategy smoke passed 2/2 after a scoped DeepSeek thinking-mode fix and explicit output bounds; the earlier two failed attempts are preserved in the report. Full real-model Agent evaluation is recorded separately under `docs/evals`; its synthetic stores do not verify database persistence or activation UI. Database integration and application of the migration remain unverified because the local database and Docker daemon are unavailable.

The main evaluation used 684,406 tokens and cost an estimated $0.044523267 at the verified weekend rates. Including all three weekly smoke attempts, estimated model spend was $0.053635317. The raw baseline scores remain routing 187/200, single-turn 95/100 and three-turn tasks 16/30; correlated variants and manual scorer adjudication are described in the report. No model-quality failures were hidden or fixed during the baseline run.
