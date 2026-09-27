# Agent budget pilot - 2026-09-26

Command: `npx --yes --package=node@22.19.0 node node_modules/vitest/vitest.mjs run --config vitest.agent-eval.config.ts scripts/agent-budget-pilot.eval.ts`

## Scope

Real deployed model (`deepseek-v4-flash` request ID), production runtime and five production tools; synthetic assessment, plan and training history; in-memory proposals and audit. No database writes. No plan-change tool, weekly planning, long-thread compaction or multi-turn task scoring. The classifier uses a shortened prompt, so routing scores are exploratory and not directly comparable to the original production benchmark. The script checks tool selection and absence of a logging write on missing-data input, not full answer quality.

## Results

- Routing: 11/12. Seven rules, five model classifications. Failure: a request to replace an unwanted movement was routed to review by a question rule.
- Agent tool-selection checks: 8/8. Actual proposed training entry: bench, 60 kg, 8 repetitions, 3 sets, no inferred RIR. One pending memory proposed.
- Agent input cache misses: 6,113 tokens; cache hits: 14,080; output: 1,097; total: 21,290.
- Six classifier calls, including one during the agent sample: 488 input and 496 output tokens; total 984. Five of these belong to the separate router sample.
- Combined observed usage: 22,274 tokens.
- Agent elapsed times: 5.896, 1.941, 1.617, 1.627, 2.094, 1.350, 1.608 and 0.455 seconds. Mean: 2.074 seconds.
- Model classification elapsed times in the route sample: 1.306, 1.229, 1.028, 0.767 and 1.071 seconds.

## Pricing

Official page checked on the run date: https://api-docs.deepseek.com/quick_start/pricing/

Legacy `deepseek-v4-flash` requests are served by V4.1 Flash. Off-peak USD prices per million tokens: input cache miss 0.15, input cache hit 0.003, output 0.6. Peak: 0.3, 0.006, 1.2. Weekend rates are off-peak.

Repriced pilot usage: USD 0.00198819. Hypothetical peak with all input treated as uncached: USD 0.0081159. These are calculated estimates, not a retrieved billing statement. SDK price metadata may differ from the current official tariff.

## Proposed next evaluation

200 route inputs, 100 single-turn cases and 30 multi-turn tasks averaging three turns. Stratify by explicit inputs, ambiguous wording, missing fields, corrections, mixed intents, and confirmation safety. Keep full evaluation pending the user's budget choice. Week-planning evaluation should be priced separately after its model-backed implementation exists.

Expected dialogue usage at this pilot mean: about 506,000 tokens for 190 turns, before longer multi-turn contexts and failures. Conservative planning allowance: 0.6-1.2 million total tokens for the baseline suite. Allow USD 1 for a single-model run; USD 2 for two-model comparison or repeated runs. These allowances include headroom and are not hard limits implemented by the harness.
