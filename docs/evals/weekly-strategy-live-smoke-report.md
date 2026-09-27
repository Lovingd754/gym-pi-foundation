# Separate live weekly strategy smoke

Latest: 2/2 passed. Model deepseek/deepseek-v4-flash. Latest cost $0.001127. Total smoke spend across 3 attempts: $0.009112. These cases are outside the 200/100/30 baseline.

Earlier attempts (preserved in history JSON): attempt 1: 0/2, $0.004318; attempt 2: 0/2, $0.003667.

```json
{
  "separateFromBaseline": true,
  "provider": "deepseek",
  "model": "deepseek-v4-flash",
  "completed": 2,
  "passed": 2,
  "elapsedMs": 3171,
  "costUsd": 0.001127286,
  "wireUsage": [
    {
      "prompt_tokens": 4905,
      "completion_tokens": 274,
      "total_tokens": 5179,
      "prompt_tokens_details": {
        "cached_tokens": 0
      },
      "prompt_cache_hit_tokens": 0,
      "prompt_cache_miss_tokens": 4905
    },
    {
      "prompt_tokens": 848,
      "completion_tokens": 292,
      "total_tokens": 1140,
      "prompt_tokens_details": {
        "cached_tokens": 512
      },
      "prompt_cache_hit_tokens": 512,
      "prompt_cache_miss_tokens": 336
    }
  ],
  "results": [
    {
      "id": "travel-recovery",
      "passed": true,
      "errors": [],
      "ms": 1635,
      "strategy": {
        "weekdays": [
          1,
          4
        ],
        "avoidCatalogKeys": [
          "back_squat",
          "leg_press",
          "romanian_deadlift",
          "cable_pull_through",
          "bench_press",
          "chest_press",
          "barbell_row",
          "seated_cable_row",
          "overhead_press",
          "machine_shoulder_press",
          "lat_pulldown",
          "cable_pulldown",
          "cable_lateral_raise",
          "machine_lateral_raise",
          "leg_extension",
          "leg_curl",
          "cable_curl",
          "barbell_curl",
          "cable_triceps_extension",
          "cable_crunch",
          "machine_calf_raise"
        ],
        "preferCatalogKeys": [
          "goblet_squat",
          "dumbbell_bench_press",
          "one_arm_dumbbell_row",
          "dumbbell_shoulder_press"
        ],
        "cardioPreference": "STANDARD",
        "recovery": "REDUCED",
        "rationale": "Travel Tue-Wed leaves only Mon/Thu accessible, so two full-body dumbbell/bodyweight sessions run Mon and Thu with rest between and across the week boundary. Sleep 5.5h with HIGH fatigue and only 2 of 3 sessions completed, so recovery is REDUCED and cardio holds at STANDARD (no increase). Most equipment is unavailable; prefer dumbbell and bodyweight movements matching past tolerance.",
        "source": "MODEL"
      },
      "generated": {
        "weekdays": [
          1,
          4
        ],
        "durations": [
          26,
          26
        ],
        "cardioMinutes": 0
      }
    },
    {
      "id": "no-evidence",
      "passed": true,
      "errors": [],
      "ms": 1536,
      "strategy": {
        "weekdays": [
          1,
          3,
          5
        ],
        "avoidCatalogKeys": [
          "back_squat",
          "romanian_deadlift",
          "bench_press",
          "barbell_row",
          "overhead_press",
          "barbell_curl",
          "leg_press",
          "chest_press",
          "lat_pulldown",
          "machine_shoulder_press",
          "machine_lateral_raise",
          "leg_extension",
          "leg_curl",
          "machine_calf_raise",
          "cable_pull_through",
          "seated_cable_row",
          "cable_pulldown",
          "cable_lateral_raise",
          "cable_curl",
          "cable_triceps_extension",
          "cable_crunch"
        ],
        "preferCatalogKeys": [
          "goblet_squat",
          "dumbbell_bench_press",
          "one_arm_dumbbell_row",
          "dumbbell_shoulder_press"
        ],
        "cardioPreference": "STANDARD",
        "recovery": "STANDARD",
        "rationale": "No prior plan, completion, load, or recovery evidence, so this week starts conservatively with three full-body sessions on the available Mon/Wed/Fri slots, each with a rest day between. Only dumbbells and bodyweight are available, so dumbbell and bodyweight movements are preferred and machine/barbell/cable options are avoided. 60 minutes is enough for full-body work. Cardio and recovery stay STANDARD given the absence of fatigue or recovery data; adjust once real evidence accrues.",
        "source": "MODEL"
      },
      "generated": {
        "weekdays": [
          1,
          3,
          5
        ],
        "durations": [
          58,
          58,
          58
        ],
        "cardioMinutes": 0
      }
    }
  ],
  "limitations": [
    "Two synthetic smoke cases, not statistical quality validation.",
    "No DB, persistence, API, confirmation UI or summarizer coverage.",
    "Actual production weekly prompt, parser and deterministic plan application used."
  ]
}
```
