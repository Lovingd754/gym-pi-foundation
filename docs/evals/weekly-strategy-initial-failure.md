# Initial weekly strategy smoke failure

This first live run passed 0/2 synthetic cases in 26.136 seconds and cost $0.004317786. Both returned `WEEKLY_MODEL_UNAVAILABLE`, so the plan application stage was not reached. The unchanged wire usage and errors are in `weekly-strategy-initial-failure.json`.

The travel/recovery response spent all 3,000 output tokens on reasoning, with no answer tokens. The no-evidence response spent 2,491 of 2,893 output tokens on reasoning. Raw answer text was not captured in this first run. A separate diagnostic retry captures it to identify the cause; that does not replace these initial results.

This is separate from the completed baseline evaluation. A successful Vitest harness means the report was generated, not that the model cases passed.
