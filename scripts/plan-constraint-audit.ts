/**
 * Constraint audit for the plan generator (a resume/QA artifact, not part of
 * the test suite).
 *
 * Generates a plan for hundreds of randomized but schema-valid profiles and
 * checks every plan against the constraints the trainee actually stated. It
 * answers two questions with numbers instead of adjectives:
 *
 *   1. How often does the rules engine produce a plan at all, and does it
 *      refuse an impossible week with a typed error rather than a bad plan?
 *   2. Of the plans it produces, how many violate an input constraint
 *      (equipment, available weekdays, session length, the cardio total)?
 *
 * Deterministic: same seed, same profiles, same numbers.
 *
 *   npx tsx scripts/plan-constraint-audit.ts [profiles]
 */
import { buildBaselinePlan } from '@/lib/fitness/baseline-plan';
import { NutritionConstraintError } from '@/lib/fitness/energy';
import { evaluateEligibility } from '@/lib/fitness/eligibility';
import { STRENGTH_EXERCISE_CATALOG } from '@/lib/fitness/exercise-catalog';
import { PACE_RATES, PACE_ORDER } from '@/lib/fitness/pace';
import { createAssessmentInputSchema, type AssessmentInput } from '@/lib/fitness/schemas';
import {
  StrengthPlanConstraintError,
  estimateWorkoutDurationMin,
} from '@/lib/fitness/strength-plan';

const NOW = new Date('2026-09-22T04:00:00.000Z');
const PROFILES = Number(process.argv[2] ?? 500);

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rng = mulberry32(20260922);
const between = (min: number, max: number) => min + Math.floor(rng() * (max - min + 1));
// Several lifestyle fields are validated in five-minute increments, so the
// sampler generates them in those units rather than rounding afterwards.
const minutesBetween = (min: number, max: number) => between(min / 5, max / 5) * 5;
const pick = <T>(values: readonly T[]): T => values[Math.floor(rng() * values.length)]!;
const sample = <T>(values: readonly T[], count: number): T[] => {
  const pool = [...values];
  const chosen: T[] = [];
  while (chosen.length < count && pool.length > 0) {
    chosen.push(pool.splice(Math.floor(rng() * pool.length), 1)[0]!);
  }
  return chosen.sort((left, right) => String(left).localeCompare(String(right)));
};

const allEquipment = ['DUMBBELL', 'BARBELL', 'MACHINE', 'CABLE', 'BODYWEIGHT'] as const;
const health = {
  urgentSignals: [],
  clearanceSignals: [],
  temporarySignals: [],
  scopeSignals: [],
  healthChangedSinceClearance: false,
  attested: true,
};

function randomProfile(): AssessmentInput {
  const goalType = pick(['HYPERTROPHY', 'FAT_LOSS', 'RECOMP'] as const);
  const weeklyFrequency = between(2, 5);
  const availableWeekdays = sample(
    [1, 2, 3, 4, 5, 6, 7],
    Math.min(7, weeklyFrequency + between(0, 3)),
  );
  const equipmentTypes = sample(allEquipment, between(1, allEquipment.length));
  return createAssessmentInputSchema(NOW).parse({
    profile: {
      ageYears: between(18, 60),
      displaySex: pick(['MALE', 'FEMALE', 'PREFER_NOT_TO_SAY'] as const),
      energyEquationReference: 'UNSPECIFIED',
      heightCm: between(150, 200),
      weightKg: between(50, 120),
      trainingAgeMonths: between(0, 120),
    },
    goal: {
      type: goalType,
      desiredWeeklyRatePct: PACE_RATES[goalType][pick(PACE_ORDER)],
    },
    schedule: {
      weeklyFrequency,
      availableWeekdays,
      sessionDurationMin: minutesBetween(30, 120),
      equipmentTypes,
      recentMainLifts: [],
    },
    lifestyle: {
      activityLevel: pick(['SEDENTARY', 'LIGHT', 'MODERATE', 'HIGH'] as const),
      currentModerateActivityMin: minutesBetween(0, 300),
      habitualSleepMin: minutesBetween(300, 540),
      bedtimeMin: 1380,
      wakeTimeMin: 420,
      timeZone: 'Asia/Shanghai',
    },
    health,
  } as AssessmentInput);
}

const loadGuidance = STRENGTH_EXERCISE_CATALOG.map((entry) => ({
  catalogKey: entry.key,
  source: 'CALIBRATION' as const,
  initialLoadKg: null,
}));
const catalogByKey = new Map(STRENGTH_EXERCISE_CATALOG.map((entry) => [entry.key, entry]));

let generated = 0;
let rejected = 0;
let notEligible = 0;
const rejections = new Map<string, number>();
const violations: string[] = [];

for (let index = 0; index < PROFILES; index += 1) {
  const assessment = randomProfile();
  const eligibility = evaluateEligibility(assessment, NOW);
  if (eligibility.status !== 'ELIGIBLE') {
    notEligible += 1;
    continue;
  }

  let content;
  try {
    content = buildBaselinePlan({
      assessment,
      eligibility,
      gymConstraints: { unavailableExerciseNames: [] },
      loadGuidance,
      now: NOW,
    });
  } catch (error) {
    if (error instanceof StrengthPlanConstraintError || error instanceof NutritionConstraintError) {
      rejected += 1;
      const reason = `${error.code} (${error.constructor.name})`;
      rejections.set(reason, (rejections.get(reason) ?? 0) + 1);
      continue;
    }
    throw error;
  }
  generated += 1;

  const note = `profile ${index}`;
  // 1. The week that was asked for.
  if (content.strength.days.length !== assessment.schedule.weeklyFrequency) {
    violations.push(
      `${note}: ${content.strength.days.length} training days for a ${assessment.schedule.weeklyFrequency}-day week`,
    );
  }
  for (const day of content.strength.days) {
    const weekday = day.dayOfWeek;
    if (
      weekday === null ||
      weekday === undefined ||
      !assessment.schedule.availableWeekdays.includes(weekday)
    ) {
      violations.push(`${note}: trained on an unavailable weekday (${day.dayOfWeek})`);
    }
    const duration = estimateWorkoutDurationMin(day);
    if (duration > assessment.schedule.sessionDurationMin) {
      violations.push(
        `${note}: session of ${duration} min for a ${assessment.schedule.sessionDurationMin} min slot`,
      );
    }
    for (const exercise of day.exercises) {
      const key = exercise.notes?.startsWith('catalog:') ? exercise.notes.slice(8) : null;
      const entry = key ? catalogByKey.get(key as never) : undefined;
      // A bodyweight movement needs no equipment, which is why the generator
      // treats BODYWEIGHT as always available (strength-plan.ts). Only the
      // movements that need something the trainee does not have are violations.
      if (
        entry &&
        entry.equipmentType !== 'BODYWEIGHT' &&
        !assessment.schedule.equipmentTypes.includes(entry.equipmentType)
      ) {
        violations.push(`${note}: prescribed ${entry.name} without the ${entry.equipmentType}`);
      }
    }
  }

  // 2. The cardio total is the sum of its sessions, and the seven days agree.
  const cardioTotal = content.cardio.sessions.reduce(
    (sum, session) => sum + session.durationMin,
    0,
  );
  if (cardioTotal !== content.cardio.additionalWeeklyMin) {
    violations.push(
      `${note}: cardio total ${content.cardio.additionalWeeklyMin} != ${cardioTotal}`,
    );
  }
  const scheduledCardio = content.schedule.days.reduce((sum, day) => sum + day.cardioMin, 0);
  if (scheduledCardio !== content.cardio.additionalWeeklyMin) {
    violations.push(
      `${note}: scheduled cardio ${scheduledCardio} != ${content.cardio.additionalWeeklyMin}`,
    );
  }

  // 3. Energy: a positive target that can hold the protein and fat minimums.
  const { caloriesKcal, proteinG, fatG } = content.nutrition;
  if (caloriesKcal.min <= 0 || caloriesKcal.min > caloriesKcal.max) {
    violations.push(`${note}: calorie target ${caloriesKcal.min}-${caloriesKcal.max}`);
  }
  const minimumKcal = proteinG.min * 4 + fatG.min * 9;
  if (minimumKcal > caloriesKcal.max) {
    violations.push(
      `${note}: ${minimumKcal} kcal of protein and fat in a ${caloriesKcal.max} kcal day`,
    );
  }

  // 4. Sleep never asks a short sleeper for less than they already get (it adds
  // 30 minutes at a time) and never asks anyone for more than nine hours. The
  // only slack allowed is the quarter-hour rounding of the target itself, and an
  // extreme sleeper above nine hours is capped down on purpose.
  const sleepFloor = Math.min(assessment.lifestyle.habitualSleepMin, 420) - 15;
  if (content.sleep.initialTargetMin < sleepFloor || content.sleep.initialTargetMax > 540) {
    violations.push(
      `${note}: sleep target ${content.sleep.initialTargetMin}-${content.sleep.initialTargetMax}`,
    );
  }
}

const rate = (value: number) => `${((value / PROFILES) * 100).toFixed(1)}%`;
console.log(`profiles            ${PROFILES}`);
console.log(`eligible            ${PROFILES - notEligible} (${rate(PROFILES - notEligible)})`);
console.log(`plans generated     ${generated} (${rate(generated)})`);
console.log(`refused as infeasible ${rejected} (${rate(rejected)})`);
for (const [reason, count] of [...rejections].sort((left, right) => right[1] - left[1])) {
  console.log(`  - ${reason}: ${count}`);
}
console.log(`constraint violations ${violations.length}`);
for (const violation of violations.slice(0, 20)) console.log(`  - ${violation}`);
