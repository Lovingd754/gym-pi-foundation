import { describe, expect, it } from 'vitest';
import {
  assessmentResponseSchema,
  clearanceSignalSchema,
  clearanceSignalValues,
  createAssessmentInputSchema,
  healthAnswersSchema,
  planActivationRequestSchema,
  planPreviewRequestSchema,
  scopeSignalSchema,
  scopeSignalValues,
  temporarySignalSchema,
  temporarySignalValues,
  urgentSignalSchema,
  urgentSignalValues,
  type AssessmentResponse,
} from './schemas';
import { evaluateEligibility } from './eligibility';
import {
  exerciseCatalogKeys,
  exerciseRequiredEquipment,
  supportedAssessmentEquipmentValues,
} from './exercise-keys';

const NOW = new Date('2026-09-14T00:00:00.000Z');

const baseInput = {
  profile: {
    displayName: '  Ada  ',
    ageYears: 30,
    displaySex: 'FEMALE',
    energyEquationReference: 'FEMALE',
    heightCm: 170,
    weightKg: 70,
    trainingAgeMonths: 12,
  },
  goal: {
    type: 'RECOMP',
    desiredWeeklyRatePct: 0,
  },
  schedule: {
    weeklyFrequency: 3,
    availableWeekdays: [1, 3, 5],
    sessionDurationMin: 60,
    equipmentTypes: ['DUMBBELL', 'BODYWEIGHT'],
    recentMainLifts: [],
  },
  lifestyle: {
    activityLevel: 'MODERATE',
    currentModerateActivityMin: 120,
    habitualSleepMin: 480,
    bedtimeMin: 1380,
    wakeTimeMin: 420,
    timeZone: 'UTC',
  },
  health: {
    urgentSignals: [],
    clearanceSignals: [],
    temporarySignals: [],
    scopeSignals: [],
    healthChangedSinceClearance: false,
    attested: true,
  },
};

type MutableInput = Record<string, unknown> & {
  profile: Record<string, unknown> & {
    displayName?: string;
    ageYears: number;
    heightCm: number;
    weightKg: number;
  };
  goal: Record<string, unknown> & {
    type: string;
    desiredWeeklyRatePct: number;
    targetWeightKg?: number;
    targetDate?: string;
  };
  schedule: Record<string, unknown> & {
    weeklyFrequency: number;
    availableWeekdays: number[];
    equipmentTypes: string[];
    recentMainLifts: Array<{
      catalogKey: string;
      weightKg: number;
      reps: number;
      rir: number;
    }>;
  };
  lifestyle: Record<string, unknown> & {
    activityLevel: string;
    timeZone: string;
  };
  health: Record<string, unknown> & {
    urgentSignals: string[];
    clearanceSignals: string[];
    temporarySignals: string[];
    scopeSignals: string[];
    healthChangedSinceClearance: boolean;
    clearance?: {
      date: string;
      unrestricted: boolean;
      restrictions?: string;
    };
  };
};

function inputWith(change?: (input: MutableInput) => void, now = NOW) {
  const input = structuredClone(baseInput) as MutableInput;
  change?.(input);
  return createAssessmentInputSchema(now).parse(input);
}

function decisionWith(change?: (input: MutableInput) => void, now = NOW) {
  const input = inputWith(change, now);
  return evaluateEligibility(input, now);
}

function normalizedAssessment() {
  const input = inputWith();
  return {
    profile: {
      ...input.profile,
      displayName: input.profile.displayName ?? null,
      waistCm: input.profile.waistCm ?? null,
      bodyFatPct: input.profile.bodyFatPct ?? null,
    },
    goal: {
      ...input.goal,
      targetWeightKg: input.goal.targetWeightKg ?? null,
      targetDate: input.goal.targetDate ?? null,
    },
    schedule: input.schedule,
    lifestyle: {
      ...input.lifestyle,
      avgDailySteps: input.lifestyle.avgDailySteps ?? null,
    },
    health: {
      ...input.health,
      clearance: input.health.clearance ?? null,
    },
    eligibility: {
      status: 'ELIGIBLE' as const,
      reasonCodes: ['ELIGIBLE_GENERAL_POPULATION'] as const,
      clearanceExpiresAt: null,
    },
  };
}

describe('evaluateEligibility', () => {
  it('rejects an invalid assessment calculation time', () => {
    expect(() => evaluateEligibility(inputWith(), new Date(Number.NaN))).toThrow(
      new RangeError('Invalid assessment calculation time'),
    );
  });

  it.each([18, 64])('accepts a general-population adult aged %i', (ageYears) => {
    expect(
      decisionWith((input) => {
        input.profile.ageYears = ageYears;
      }),
    ).toEqual({
      status: 'ELIGIBLE',
      reasonCodes: ['ELIGIBLE_GENERAL_POPULATION'],
      clearanceExpiresAt: null,
    });
  });

  it.each([
    ['sedentary activity', (input: MutableInput) => (input.lifestyle.activityLevel = 'SEDENTARY')],
    [
      'a high derived BMI',
      (input: MutableInput) => {
        input.profile.heightCm = 150;
        input.profile.weightKg = 150;
      },
    ],
  ])('does not invent a medical warning from %s', (_label, change) => {
    expect(decisionWith(change).status).toBe('ELIGIBLE');
  });

  it.each([17, 65])('places age %i outside the supported population', (ageYears) => {
    expect(
      decisionWith((input) => {
        input.profile.ageYears = ageYears;
      }),
    ).toMatchObject({
      status: 'OUT_OF_SCOPE',
      reasonCodes: ['SCOPE_AGE_OUTSIDE_RANGE'],
    });
  });

  it.each([
    ['PREGNANT_OR_POSTPARTUM', 'SCOPE_PREGNANT_OR_POSTPARTUM'],
    ['ACTIVE_EATING_DISORDER_TREATMENT', 'SCOPE_EATING_DISORDER_TREATMENT'],
    ['DISEASE_SPECIFIC_EXERCISE_OR_NUTRITION_CARE', 'SCOPE_DISEASE_SPECIFIC_CARE'],
    ['POSTOPERATIVE_OR_DISEASE_SPECIFIC_REHABILITATION', 'SCOPE_DISEASE_SPECIFIC_CARE'],
  ] as const)('maps scope signal %s to %s', (signal, reason) => {
    expect(
      decisionWith((input) => {
        input.health.scopeSignals = [signal];
      }),
    ).toMatchObject({ status: 'OUT_OF_SCOPE', reasonCodes: [reason] });
  });

  it.each([
    ['FEVER_OR_ACUTE_INFECTION', 'HOLD_ACUTE_ILLNESS'],
    ['NEW_UNEVALUATED_INJURY_OR_ABNORMAL_PAIN', 'HOLD_ACUTE_INJURY'],
    ['RECENT_SURGERY_WITHOUT_RETURN_CLEARANCE', 'HOLD_RECENT_SURGERY'],
    ['MAJOR_RECENT_HEALTH_OR_MEDICATION_CHANGE', 'HOLD_ACUTE_ILLNESS'],
  ] as const)('maps temporary signal %s to %s', (signal, reason) => {
    expect(
      decisionWith((input) => {
        input.health.temporarySignals = [signal];
      }),
    ).toMatchObject({ status: 'TEMPORARY_HOLD', reasonCodes: [reason] });
  });

  it.each([
    ['CURRENT_CHEST_PRESSURE_OR_PAIN', 'URGENT_CHEST_PAIN_AT_REST'],
    ['SEVERE_BREATHING_DIFFICULTY', 'URGENT_SEVERE_BREATHING_DIFFICULTY'],
    ['CURRENT_LOSS_OF_CONSCIOUSNESS', 'URGENT_FAINTING_WITHOUT_EXPLANATION'],
    ['CHEST_DISCOMFORT_WITH_SYSTEMIC_SIGNS', 'URGENT_CHEST_PAIN_AT_REST'],
  ] as const)('maps urgent signal %s to %s', (signal, reason) => {
    expect(
      decisionWith((input) => {
        input.health.urgentSignals = [signal];
      }),
    ).toMatchObject({ status: 'URGENT_ACTION', reasonCodes: [reason] });
  });

  it.each([
    ['KNOWN_CARDIOVASCULAR_CONDITION', 'CLEARANCE_CARDIOVASCULAR_CONCERN'],
    ['KNOWN_DIABETES_OR_RENAL_CONDITION', 'CLEARANCE_METABOLIC_OR_RENAL_CONCERN'],
    ['UNEXPLAINED_CHEST_NECK_JAW_ARM_SYMPTOM', 'CLEARANCE_EXERCISE_SYMPTOM'],
    ['UNUSUAL_SHORTNESS_OF_BREATH', 'CLEARANCE_EXERCISE_SYMPTOM'],
    ['DIZZINESS_FAINTING_OR_NEAR_FAINTING', 'CLEARANCE_EXERCISE_SYMPTOM'],
    ['ORTHOPNEA_OR_NOCTURNAL_BREATHING_DIFFICULTY', 'CLEARANCE_EXERCISE_SYMPTOM'],
    ['UNEXPLAINED_ANKLE_EDEMA', 'CLEARANCE_EXERCISE_SYMPTOM'],
    ['RECURRENT_PALPITATION_OR_IRREGULAR_RHYTHM', 'CLEARANCE_EXERCISE_SYMPTOM'],
    ['EXERTIONAL_LEG_PAIN_RELIEVED_BY_REST', 'CLEARANCE_EXERCISE_SYMPTOM'],
    ['KNOWN_HEART_MURMUR', 'CLEARANCE_EXERCISE_SYMPTOM'],
    ['UNUSUAL_FATIGUE_DURING_DAILY_ACTIVITY', 'CLEARANCE_EXERCISE_SYMPTOM'],
    ['UNCONTROLLED_HYPERTENSION_OR_LIFTING_RESTRICTION', 'CLEARANCE_EXERCISE_SYMPTOM'],
  ] as const)('requires clearance for %s', (signal, reason) => {
    expect(
      decisionWith((input) => {
        input.health.clearanceSignals = [signal];
      }),
    ).toMatchObject({ status: 'NEEDS_MEDICAL_CLEARANCE', reasonCodes: [reason] });
  });

  it('accepts known-condition clearance on the exact 12-calendar-month boundary', () => {
    expect(
      decisionWith((input) => {
        input.health.clearanceSignals = ['KNOWN_CARDIOVASCULAR_CONDITION'];
        input.health.clearance = { date: '2025-09-14', unrestricted: true };
      }),
    ).toEqual({
      status: 'ELIGIBLE',
      reasonCodes: ['ELIGIBLE_GENERAL_POPULATION'],
      clearanceExpiresAt: new Date('2026-09-14T23:59:59.999Z'),
    });
  });

  it('clamps a Feb 29 clearance expiry to Feb 28 in the next non-leap year', () => {
    const now = new Date('2025-02-28T12:00:00.000Z');
    expect(
      decisionWith((input) => {
        input.health.clearanceSignals = ['KNOWN_DIABETES_OR_RENAL_CONDITION'];
        input.health.clearance = { date: '2024-02-29', unrestricted: true };
      }, now),
    ).toEqual({
      status: 'ELIGIBLE',
      reasonCodes: ['ELIGIBLE_GENERAL_POPULATION'],
      clearanceExpiresAt: new Date('2025-02-28T23:59:59.999Z'),
    });
  });

  it('does not let older unrestricted clearance dismiss a current warning symptom', () => {
    expect(
      decisionWith((input) => {
        input.health.clearanceSignals = ['UNUSUAL_SHORTNESS_OF_BREATH'];
        input.health.clearance = { date: '2026-01-10', unrestricted: true };
      }),
    ).toEqual({
      status: 'NEEDS_MEDICAL_CLEARANCE',
      reasonCodes: ['CLEARANCE_EXERCISE_SYMPTOM'],
      clearanceExpiresAt: new Date('2027-01-10T23:59:59.999Z'),
    });
  });

  it('reports expired known-condition clearance', () => {
    expect(
      decisionWith((input) => {
        input.health.clearanceSignals = ['KNOWN_CARDIOVASCULAR_CONDITION'];
        input.health.clearance = { date: '2025-09-13', unrestricted: true };
      }),
    ).toEqual({
      status: 'NEEDS_MEDICAL_CLEARANCE',
      reasonCodes: ['CLEARANCE_CARDIOVASCULAR_CONCERN', 'CLEARANCE_EXPIRED'],
      clearanceExpiresAt: new Date('2026-09-13T23:59:59.999Z'),
    });
  });

  it('reports a health change since known-condition clearance', () => {
    expect(
      decisionWith((input) => {
        input.health.clearanceSignals = ['KNOWN_DIABETES_OR_RENAL_CONDITION'];
        input.health.clearance = { date: '2026-01-10', unrestricted: true };
        input.health.healthChangedSinceClearance = true;
      }),
    ).toEqual({
      status: 'NEEDS_MEDICAL_CLEARANCE',
      reasonCodes: ['CLEARANCE_METABOLIC_OR_RENAL_CONCERN', 'CLEARANCE_HEALTH_CHANGED'],
      clearanceExpiresAt: new Date('2027-01-10T23:59:59.999Z'),
    });
  });

  it('requires rescreening when health changed after clearance with no signals selected', () => {
    expect(
      decisionWith((input) => {
        input.health.clearance = { date: '2026-01-10', unrestricted: true };
        input.health.healthChangedSinceClearance = true;
      }),
    ).toEqual({
      status: 'NEEDS_MEDICAL_CLEARANCE',
      reasonCodes: ['CLEARANCE_HEALTH_CHANGED'],
      clearanceExpiresAt: new Date('2027-01-10T23:59:59.999Z'),
    });
  });

  it('places restricted clearance outside scope even without a clearance signal', () => {
    expect(
      decisionWith((input) => {
        input.health.clearance = {
          date: '2026-01-10',
          unrestricted: false,
          restrictions: 'No loaded spinal flexion',
        };
      }),
    ).toMatchObject({
      status: 'OUT_OF_SCOPE',
      reasonCodes: ['SCOPE_RESTRICTED_CLEARANCE'],
    });
  });

  it('returns only sorted urgent-tier reasons when lower tiers also match', () => {
    expect(
      decisionWith((input) => {
        input.health.urgentSignals = [
          'SEVERE_BREATHING_DIFFICULTY',
          'CURRENT_CHEST_PRESSURE_OR_PAIN',
        ];
        input.health.scopeSignals = ['PREGNANT_OR_POSTPARTUM'];
        input.health.temporarySignals = ['FEVER_OR_ACUTE_INFECTION'];
      }),
    ).toMatchObject({
      status: 'URGENT_ACTION',
      reasonCodes: ['URGENT_CHEST_PAIN_AT_REST', 'URGENT_SEVERE_BREATHING_DIFFICULTY'],
    });
  });

  it('returns only out-of-scope reasons when a temporary hold also matches', () => {
    expect(
      decisionWith((input) => {
        input.profile.ageYears = 70;
        input.health.scopeSignals = ['ACTIVE_EATING_DISORDER_TREATMENT'];
        input.health.temporarySignals = ['NEW_UNEVALUATED_INJURY_OR_ABNORMAL_PAIN'];
      }),
    ).toMatchObject({
      status: 'OUT_OF_SCOPE',
      reasonCodes: ['SCOPE_AGE_OUTSIDE_RANGE', 'SCOPE_EATING_DISORDER_TREATMENT'],
    });
  });

  it('returns only temporary-hold reasons when a clearance signal also matches', () => {
    expect(
      decisionWith((input) => {
        input.health.temporarySignals = ['FEVER_OR_ACUTE_INFECTION'];
        input.health.clearanceSignals = ['KNOWN_CARDIOVASCULAR_CONDITION'];
      }),
    ).toMatchObject({
      status: 'TEMPORARY_HOLD',
      reasonCodes: ['HOLD_ACUTE_ILLNESS'],
    });
  });
});

describe('createAssessmentInputSchema', () => {
  it('rejects an invalid assessment calculation time before creating the schema', () => {
    expect(() => createAssessmentInputSchema(new Date(Number.NaN))).toThrow(
      new RangeError('Invalid assessment calculation time'),
    );
  });

  const acceptedProfileBoundaries: Array<[string, (input: MutableInput) => void]> = [
    ['age 0', (input) => (input.profile.ageYears = 0)],
    ['age 120', (input) => (input.profile.ageYears = 120)],
    ['height 120', (input) => (input.profile.heightCm = 120)],
    ['height 230', (input) => (input.profile.heightCm = 230)],
    ['weight 35', (input) => (input.profile.weightKg = 35)],
    ['weight 300', (input) => (input.profile.weightKg = 300)],
    ['waist 40', (input) => (input.profile.waistCm = 40)],
    ['waist 220', (input) => (input.profile.waistCm = 220)],
    ['body fat 3', (input) => (input.profile.bodyFatPct = 3)],
    ['body fat 70', (input) => (input.profile.bodyFatPct = 70)],
    ['training age 0', (input) => (input.profile.trainingAgeMonths = 0)],
    ['training age 600', (input) => (input.profile.trainingAgeMonths = 600)],
  ];

  it.each(acceptedProfileBoundaries)('accepts profile boundary %s', (_label, change) => {
    expect(() => inputWith(change)).not.toThrow();
  });

  const rejectedProfileBoundaries: Array<[string, (input: MutableInput) => void]> = [
    ['age -1', (input) => (input.profile.ageYears = -1)],
    ['age 121', (input) => (input.profile.ageYears = 121)],
    ['height 119.99', (input) => (input.profile.heightCm = 119.99)],
    ['height 230.01', (input) => (input.profile.heightCm = 230.01)],
    ['fractional height', (input) => (input.profile.heightCm = 170.5)],
    ['weight 34.99', (input) => (input.profile.weightKg = 34.99)],
    ['weight 300.01', (input) => (input.profile.weightKg = 300.01)],
    ['waist 39.99', (input) => (input.profile.waistCm = 39.99)],
    ['waist 220.01', (input) => (input.profile.waistCm = 220.01)],
    ['body fat 2.99', (input) => (input.profile.bodyFatPct = 2.99)],
    ['body fat 70.01', (input) => (input.profile.bodyFatPct = 70.01)],
    ['training age -1', (input) => (input.profile.trainingAgeMonths = -1)],
    ['training age 601', (input) => (input.profile.trainingAgeMonths = 601)],
  ];

  it.each(rejectedProfileBoundaries)('rejects profile boundary %s', (_label, change) => {
    expect(() => inputWith(change)).toThrow();
  });

  it('trims and accepts a 100-character display name', () => {
    const name = 'x'.repeat(100);
    expect(
      inputWith((input) => {
        input.profile.displayName = `  ${name}  `;
      }).profile.displayName,
    ).toBe(name);
  });

  it('rejects a 101-character display name', () => {
    expect(() =>
      inputWith((input) => {
        input.profile.displayName = 'x'.repeat(101);
      }),
    ).toThrow();
  });

  it.each([
    ['FAT_LOSS', -0.75],
    ['FAT_LOSS', -0.25],
    ['HYPERTROPHY', 0.1],
    ['HYPERTROPHY', 0.25],
    ['RECOMP', -0.25],
    ['RECOMP', 0.25],
  ] as const)('accepts %s rate boundary %s', (type, rate) => {
    expect(() =>
      inputWith((input) => {
        input.goal.type = type;
        input.goal.desiredWeeklyRatePct = rate;
      }),
    ).not.toThrow();
  });

  it.each([
    ['FAT_LOSS', -0.751],
    ['FAT_LOSS', -0.249],
    ['HYPERTROPHY', 0.099],
    ['HYPERTROPHY', 0.251],
    ['RECOMP', -0.251],
    ['RECOMP', 0.251],
  ] as const)('rejects %s rate outside boundary %s', (type, rate) => {
    expect(() =>
      inputWith((input) => {
        input.goal.type = type;
        input.goal.desiredWeeklyRatePct = rate;
      }),
    ).toThrow();
  });

  it.each([
    ['fat-loss minimum', 'FAT_LOSS', -0.5, 35],
    ['hypertrophy maximum', 'HYPERTROPHY', 0.2, 300],
  ] as const)('accepts target-weight boundary %s', (_label, type, rate, targetWeightKg) => {
    expect(() =>
      inputWith((input) => {
        input.goal = {
          type,
          desiredWeeklyRatePct: rate,
          targetWeightKg,
          targetDate: '2027-09-14',
        };
      }),
    ).not.toThrow();
  });

  it.each([
    ['below minimum', 'FAT_LOSS', -0.5, 34.99],
    ['above maximum', 'HYPERTROPHY', 0.2, 300.01],
  ] as const)('rejects target weight %s', (_label, type, rate, targetWeightKg) => {
    expect(() =>
      inputWith((input) => {
        input.goal = {
          type,
          desiredWeeklyRatePct: rate,
          targetWeightKg,
          targetDate: '2027-09-14',
        };
      }),
    ).toThrow();
  });

  it.each([2, 3, 4, 5] as const)('accepts weekly frequency %s', (weeklyFrequency) => {
    expect(() =>
      inputWith((input) => {
        input.schedule.weeklyFrequency = weeklyFrequency;
        input.schedule.availableWeekdays = [1, 2, 3, 4, 5];
      }),
    ).not.toThrow();
  });

  it.each([1, 6])('rejects weekly frequency %s', (weeklyFrequency) => {
    expect(() =>
      inputWith((input) => {
        input.schedule.weeklyFrequency = weeklyFrequency;
      }),
    ).toThrow();
  });

  it.each([
    ['weekday 1', [1, 3, 5]],
    ['weekday 7', [2, 4, 7]],
  ] as const)('accepts %s', (_label, availableWeekdays) => {
    expect(() =>
      inputWith((input) => {
        input.schedule.availableWeekdays = [...availableWeekdays];
      }),
    ).not.toThrow();
  });

  it.each([
    ['weekday 0', [0, 3, 5]],
    ['weekday 8', [1, 3, 8]],
  ] as const)('rejects %s', (_label, availableWeekdays) => {
    expect(() =>
      inputWith((input) => {
        input.schedule.availableWeekdays = [...availableWeekdays];
      }),
    ).toThrow();
  });

  it.each([30, 120])('accepts session duration %s', (sessionDurationMin) => {
    expect(() =>
      inputWith((input) => {
        input.schedule.sessionDurationMin = sessionDurationMin;
      }),
    ).not.toThrow();
  });

  it.each([29, 31, 121])('rejects session duration %s', (sessionDurationMin) => {
    expect(() =>
      inputWith((input) => {
        input.schedule.sessionDurationMin = sessionDurationMin;
      }),
    ).toThrow();
  });

  it('accepts every supported equipment type', () => {
    expect(() =>
      inputWith((input) => {
        input.schedule.equipmentTypes = ['DUMBBELL', 'BARBELL', 'MACHINE', 'CABLE', 'BODYWEIGHT'];
      }),
    ).not.toThrow();
  });

  it('exports the single ordered supported assessment equipment tuple', () => {
    expect(supportedAssessmentEquipmentValues).toEqual([
      'DUMBBELL',
      'BARBELL',
      'MACHINE',
      'CABLE',
      'BODYWEIGHT',
    ]);
  });

  it.each([
    ['empty equipment', []],
    ['unknown equipment', ['DUMBBELL', 'KETTLEBELL']],
    ['duplicate equipment', ['DUMBBELL', 'DUMBBELL']],
  ])('rejects %s', (_label, equipmentTypes) => {
    expect(() =>
      inputWith((input) => {
        input.schedule.equipmentTypes = equipmentTypes;
      }),
    ).toThrow();
  });

  const sixRecentLifts = [
    { catalogKey: 'goblet_squat', weightKg: 20, reps: 10, rir: 2 },
    { catalogKey: 'dumbbell_romanian_deadlift', weightKg: 20, reps: 10, rir: 2 },
    { catalogKey: 'dumbbell_bench_press', weightKg: 20, reps: 10, rir: 2 },
    { catalogKey: 'one_arm_dumbbell_row', weightKg: 20, reps: 10, rir: 2 },
    { catalogKey: 'dumbbell_shoulder_press', weightKg: 20, reps: 10, rir: 2 },
    { catalogKey: 'dumbbell_lateral_raise', weightKg: 10, reps: 10, rir: 2 },
  ];

  it.each([
    ['zero recent lifts', []],
    ['six recent lifts', sixRecentLifts],
  ])('accepts %s', (_label, recentMainLifts) => {
    expect(() =>
      inputWith((input) => {
        input.schedule.recentMainLifts = recentMainLifts;
      }),
    ).not.toThrow();
  });

  it.each([
    ['loaded weight 1000', { catalogKey: 'goblet_squat', weightKg: 1000, reps: 10, rir: 2 }],
    ['reps 1', { catalogKey: 'goblet_squat', weightKg: 20, reps: 1, rir: 2 }],
    ['reps 30', { catalogKey: 'goblet_squat', weightKg: 20, reps: 30, rir: 2 }],
    ['RIR 0', { catalogKey: 'goblet_squat', weightKg: 20, reps: 10, rir: 0 }],
    ['RIR 5', { catalogKey: 'goblet_squat', weightKg: 20, reps: 10, rir: 5 }],
  ])('accepts recent-lift boundary %s', (_label, recentLift) => {
    expect(() =>
      inputWith((input) => {
        input.schedule.recentMainLifts = [recentLift];
      }),
    ).not.toThrow();
  });

  it.each([
    ['weight above 1000', { catalogKey: 'goblet_squat', weightKg: 1000.01, reps: 10, rir: 2 }],
    ['reps below 1', { catalogKey: 'goblet_squat', weightKg: 20, reps: 0, rir: 2 }],
    ['reps above 30', { catalogKey: 'goblet_squat', weightKg: 20, reps: 31, rir: 2 }],
    ['RIR below 0', { catalogKey: 'goblet_squat', weightKg: 20, reps: 10, rir: -1 }],
    ['RIR above 5', { catalogKey: 'goblet_squat', weightKg: 20, reps: 10, rir: 6 }],
  ])('rejects recent-lift boundary %s', (_label, recentLift) => {
    expect(() =>
      inputWith((input) => {
        input.schedule.recentMainLifts = [recentLift];
      }),
    ).toThrow();
  });

  const acceptedLifestyleBoundaries: Array<[string, (input: MutableInput) => void]> = [
    ['daily steps 0', (input) => (input.lifestyle.avgDailySteps = 0)],
    ['daily steps 100000', (input) => (input.lifestyle.avgDailySteps = 100000)],
    ['moderate activity 0', (input) => (input.lifestyle.currentModerateActivityMin = 0)],
    ['moderate activity 2000', (input) => (input.lifestyle.currentModerateActivityMin = 2000)],
    ['sleep 180', (input) => (input.lifestyle.habitualSleepMin = 180)],
    ['sleep 900', (input) => (input.lifestyle.habitualSleepMin = 900)],
    ['bedtime 0', (input) => (input.lifestyle.bedtimeMin = 0)],
    ['bedtime 1439', (input) => (input.lifestyle.bedtimeMin = 1439)],
    ['wake time 0', (input) => (input.lifestyle.wakeTimeMin = 0)],
    ['wake time 1439', (input) => (input.lifestyle.wakeTimeMin = 1439)],
  ];

  it.each(acceptedLifestyleBoundaries)('accepts lifestyle boundary %s', (_label, change) => {
    expect(() => inputWith(change)).not.toThrow();
  });

  const rejectedLifestyleBoundaries: Array<[string, (input: MutableInput) => void]> = [
    ['daily steps -1', (input) => (input.lifestyle.avgDailySteps = -1)],
    ['daily steps 100001', (input) => (input.lifestyle.avgDailySteps = 100001)],
    ['moderate activity -1', (input) => (input.lifestyle.currentModerateActivityMin = -1)],
    ['moderate activity 2001', (input) => (input.lifestyle.currentModerateActivityMin = 2001)],
    ['sleep 179', (input) => (input.lifestyle.habitualSleepMin = 179)],
    ['sleep 901', (input) => (input.lifestyle.habitualSleepMin = 901)],
    ['bedtime -1', (input) => (input.lifestyle.bedtimeMin = -1)],
    ['bedtime 1440', (input) => (input.lifestyle.bedtimeMin = 1440)],
    ['wake time -1', (input) => (input.lifestyle.wakeTimeMin = -1)],
    ['wake time 1440', (input) => (input.lifestyle.wakeTimeMin = 1440)],
  ];

  it.each(rejectedLifestyleBoundaries)('rejects lifestyle boundary %s', (_label, change) => {
    expect(() => inputWith(change)).toThrow();
  });

  it('trims and accepts a valid IANA time zone', () => {
    expect(
      inputWith((input) => {
        input.lifestyle.timeZone = '  Asia/Shanghai  ';
      }).lifestyle.timeZone,
    ).toBe('Asia/Shanghai');
  });

  it.each([
    ['blank', '   '],
    ['100-character invalid value', 'x'.repeat(100)],
    ['101-character value', 'x'.repeat(101)],
    ['invalid IANA value', 'Mars/Olympus_Mons'],
  ])('rejects %s time zone', (_label, timeZone) => {
    expect(() =>
      inputWith((input) => {
        input.lifestyle.timeZone = timeZone;
      }),
    ).toThrow();
  });

  it('accepts a trimmed 500-character restriction summary', () => {
    const restrictions = 'x'.repeat(500);
    expect(
      inputWith((input) => {
        input.health.clearance = {
          date: '2026-01-10',
          unrestricted: false,
          restrictions: `  ${restrictions}  `,
        };
      }).health.clearance?.restrictions,
    ).toBe(restrictions);
  });

  it('normalizes request clearance restrictions to a required string-or-null output', () => {
    const restricted = inputWith((input) => {
      input.health.clearance = {
        date: '2026-01-10',
        unrestricted: false,
        restrictions: '  Avoid loaded flexion  ',
      };
    }).health.clearance;
    if (!restricted) throw new Error('Expected clearance');
    const restrictions: string | null = restricted.restrictions;
    expect(restrictions).toBe('Avoid loaded flexion');
  });

  it('rejects a 501-character restriction summary', () => {
    expect(() =>
      inputWith((input) => {
        input.health.clearance = {
          date: '2026-01-10',
          unrestricted: false,
          restrictions: 'x'.repeat(501),
        };
      }),
    ).toThrow();
  });

  it('accepts a valid leap-day clearance date', () => {
    expect(
      inputWith((input) => {
        input.health.clearance = { date: '2024-02-29', unrestricted: true };
      }).health.clearance?.date,
    ).toBe('2024-02-29');
  });

  it.each(['2025-02-29', '2026-02-30', '2026-2-01'])('rejects invalid calendar date %s', (date) => {
    expect(() =>
      inputWith((input) => {
        input.health.clearance = { date, unrestricted: true };
      }),
    ).toThrow();
  });

  it('requires attested to be literal true', () => {
    expect(() =>
      inputWith((input) => {
        input.health.attested = false;
      }),
    ).toThrow();
  });

  const nestedStrictnessCases: Array<[string, (input: MutableInput) => void]> = [
    ['profile', (input) => (input.profile.unexpected = true)],
    ['goal', (input) => (input.goal.unexpected = true)],
    ['schedule', (input) => (input.schedule.unexpected = true)],
    ['lifestyle', (input) => (input.lifestyle.unexpected = true)],
    [
      'clearance',
      (input) => {
        input.health.clearance = {
          date: '2026-01-10',
          unrestricted: true,
        };
        (input.health.clearance as typeof input.health.clearance & Record<string, unknown>)[
          'unexpected'
        ] = true;
      },
    ],
    [
      'recent lift',
      (input) => {
        input.schedule.recentMainLifts = [
          {
            catalogKey: 'goblet_squat',
            weightKg: 20,
            reps: 10,
            rir: 2,
            unexpected: true,
          } as MutableInput['schedule']['recentMainLifts'][number] & Record<string, unknown>,
        ];
      },
    ],
  ];

  it.each(nestedStrictnessCases)('rejects unknown keys in %s objects', (_label, change) => {
    expect(() => inputWith(change)).toThrow();
  });

  it('exports the complete ordered signal tuples', () => {
    expect(urgentSignalValues).toHaveLength(4);
    expect(clearanceSignalValues).toHaveLength(12);
    expect(temporarySignalValues).toHaveLength(4);
    expect(scopeSignalValues).toHaveLength(4);
  });

  it('derives reusable signal schemas from the exported tuples', () => {
    expect(urgentSignalSchema.parse(urgentSignalValues[0])).toBe(urgentSignalValues[0]);
    expect(clearanceSignalSchema.parse(clearanceSignalValues[0])).toBe(clearanceSignalValues[0]);
    expect(temporarySignalSchema.parse(temporarySignalValues[0])).toBe(temporarySignalValues[0]);
    expect(scopeSignalSchema.parse(scopeSignalValues[0])).toBe(scopeSignalValues[0]);
  });

  it.each([
    ['urgentSignals', 'CURRENT_CHEST_PRESSURE_OR_PAIN'],
    ['clearanceSignals', 'KNOWN_CARDIOVASCULAR_CONDITION'],
    ['temporarySignals', 'FEVER_OR_ACUTE_INFECTION'],
    ['scopeSignals', 'PREGNANT_OR_POSTPARTUM'],
  ] as const)('rejects duplicate %s', (field, signal) => {
    expect(() =>
      inputWith((input) => {
        input.health[field] = [signal, signal];
      }),
    ).toThrow();
  });

  it.each(['urgentSignals', 'clearanceSignals', 'temporarySignals', 'scopeSignals'] as const)(
    'rejects unknown values in %s',
    (field) => {
      expect(() =>
        inputWith((input) => {
          input.health[field] = ['NOT_A_REAL_SIGNAL'];
        }),
      ).toThrow();
    },
  );

  it('rejects an invalid IANA time zone', () => {
    expect(() =>
      inputWith((input) => {
        input.lifestyle.timeZone = 'Mars/Olympus_Mons';
      }),
    ).toThrow();
  });

  it('rejects fewer distinct weekdays than the weekly frequency', () => {
    expect(() =>
      inputWith((input) => {
        input.schedule.weeklyFrequency = 4;
        input.schedule.availableWeekdays = [1, 2, 3];
      }),
    ).toThrow();
  });

  it('rejects duplicate weekdays', () => {
    expect(() =>
      inputWith((input) => {
        input.schedule.availableWeekdays = [1, 1, 3];
      }),
    ).toThrow();
  });

  it.each([
    ['FAT_LOSS', -0.8],
    ['HYPERTROPHY', 0.3],
    ['RECOMP', 0.3],
  ] as const)('rejects an out-of-range %s weekly rate', (type, rate) => {
    expect(() =>
      inputWith((input) => {
        input.goal.type = type;
        input.goal.desiredWeeklyRatePct = rate;
      }),
    ).toThrow();
  });

  it('accepts a paired lower fat-loss target and future date', () => {
    expect(
      inputWith((input) => {
        input.goal = {
          type: 'FAT_LOSS',
          desiredWeeklyRatePct: -0.5,
          targetWeightKg: 65,
          targetDate: '2027-01-15',
        };
      }).goal,
    ).toMatchObject({ targetWeightKg: 65, targetDate: '2027-01-15' });
  });

  it('accepts a paired higher hypertrophy target and future date', () => {
    expect(
      inputWith((input) => {
        input.goal = {
          type: 'HYPERTROPHY',
          desiredWeeklyRatePct: 0.2,
          targetWeightKg: 75,
          targetDate: '2027-01-15',
        };
      }).goal,
    ).toMatchObject({ targetWeightKg: 75, targetDate: '2027-01-15' });
  });

  it.each([
    [
      'a target weight without a date',
      (input: MutableInput) => {
        input.goal = { type: 'FAT_LOSS', desiredWeeklyRatePct: -0.5, targetWeightKg: 65 };
      },
    ],
    [
      'a target date without a weight',
      (input: MutableInput) => {
        input.goal = {
          type: 'HYPERTROPHY',
          desiredWeeklyRatePct: 0.2,
          targetDate: '2027-01-15',
        };
      },
    ],
    [
      'a fat-loss target above current weight',
      (input: MutableInput) => {
        input.goal = {
          type: 'FAT_LOSS',
          desiredWeeklyRatePct: -0.5,
          targetWeightKg: 75,
          targetDate: '2027-01-15',
        };
      },
    ],
    [
      'a hypertrophy target below current weight',
      (input: MutableInput) => {
        input.goal = {
          type: 'HYPERTROPHY',
          desiredWeeklyRatePct: 0.2,
          targetWeightKg: 65,
          targetDate: '2027-01-15',
        };
      },
    ],
  ])('rejects %s', (_label, change) => {
    expect(() => inputWith(change)).toThrow();
  });

  it('rejects recomp target weight', () => {
    expect(() =>
      inputWith((input) => {
        input.goal.targetWeightKg = 70;
      }),
    ).toThrow();
  });

  it('accepts an optional future recomp milestone date', () => {
    expect(
      inputWith((input) => {
        input.goal.targetDate = '2027-01-15';
      }).goal.targetDate,
    ).toBe('2027-01-15');
  });

  it('rejects a target date that is not in the future', () => {
    expect(() =>
      inputWith((input) => {
        input.goal.targetDate = '2026-09-14';
      }),
    ).toThrow();
  });

  it('exports a known catalog with an equipment requirement for every key', () => {
    expect(exerciseCatalogKeys.length).toBeGreaterThan(0);
    expect(exerciseCatalogKeys.every((key) => exerciseRequiredEquipment[key])).toBe(true);
  });

  it.each([
    [
      'a duplicate catalog key',
      [
        { catalogKey: 'goblet_squat', weightKg: 20, reps: 10, rir: 2 },
        { catalogKey: 'goblet_squat', weightKg: 22, reps: 8, rir: 2 },
      ],
    ],
    ['an unknown catalog key', [{ catalogKey: 'moon_press', weightKg: 20, reps: 10, rir: 2 }]],
    ['a negative load', [{ catalogKey: 'goblet_squat', weightKg: -1, reps: 10, rir: 2 }]],
    [
      'zero load on loaded equipment',
      [{ catalogKey: 'goblet_squat', weightKg: 0, reps: 10, rir: 2 }],
    ],
    ['invalid reps', [{ catalogKey: 'goblet_squat', weightKg: 20, reps: 31, rir: 2 }]],
    ['invalid RIR', [{ catalogKey: 'goblet_squat', weightKg: 20, reps: 10, rir: 6 }]],
    [
      'more than six lifts',
      [
        { catalogKey: 'goblet_squat', weightKg: 20, reps: 10, rir: 2 },
        { catalogKey: 'dumbbell_romanian_deadlift', weightKg: 20, reps: 10, rir: 2 },
        { catalogKey: 'dumbbell_bench_press', weightKg: 20, reps: 10, rir: 2 },
        { catalogKey: 'one_arm_dumbbell_row', weightKg: 20, reps: 10, rir: 2 },
        { catalogKey: 'dumbbell_shoulder_press', weightKg: 20, reps: 10, rir: 2 },
        { catalogKey: 'dumbbell_lateral_raise', weightKg: 10, reps: 10, rir: 2 },
        { catalogKey: 'dumbbell_curl', weightKg: 10, reps: 10, rir: 2 },
      ],
    ],
  ])('rejects recent lifts with %s', (_label, recentMainLifts) => {
    expect(() =>
      inputWith((input) => {
        input.schedule.recentMainLifts = recentMainLifts;
      }),
    ).toThrow();
  });

  it('accepts zero load for a bodyweight catalog entry', () => {
    expect(
      inputWith((input) => {
        input.schedule.recentMainLifts = [{ catalogKey: 'push_up', weightKg: 0, reps: 12, rir: 2 }];
      }).schedule.recentMainLifts,
    ).toHaveLength(1);
  });

  it('rejects a recent lift requiring unselected equipment', () => {
    expect(() =>
      inputWith((input) => {
        input.schedule.recentMainLifts = [
          { catalogKey: 'bench_press', weightKg: 60, reps: 8, rir: 2 },
        ];
      }),
    ).toThrow();
  });

  it('rejects a clearance date after the submitted-zone calendar date', () => {
    expect(() =>
      inputWith((input) => {
        input.health.clearance = { date: '2026-09-15', unrestricted: true };
      }),
    ).toThrow();
  });

  it('uses the submitted zone when checking a clearance date', () => {
    const nearMidnight = new Date('2026-09-14T23:30:00.000Z');
    expect(
      inputWith((input) => {
        input.lifestyle.timeZone = 'Asia/Shanghai';
        input.health.clearance = { date: '2026-09-15', unrestricted: true };
      }, nearMidnight).health.clearance?.date,
    ).toBe('2026-09-15');
  });

  it('requires a nonblank restriction summary for restricted clearance', () => {
    expect(() =>
      inputWith((input) => {
        input.health.clearance = {
          date: '2026-01-10',
          unrestricted: false,
          restrictions: '   ',
        };
      }),
    ).toThrow();
  });

  it.each([undefined, '   '])(
    'normalizes unrestricted clearance restrictions %s to null',
    (restrictions) => {
      expect(
        inputWith((input) => {
          input.health.clearance = {
            date: '2026-01-10',
            unrestricted: true,
            ...(restrictions === undefined ? {} : { restrictions }),
          };
        }).health.clearance?.restrictions,
      ).toBeNull();
    },
  );

  it('trims a display name and removes a blank one', () => {
    expect(inputWith().profile.displayName).toBe('Ada');
    expect(
      inputWith((input) => {
        input.profile.displayName = '   ';
      }).profile.displayName,
    ).toBeUndefined();
  });

  it('rejects unknown root and nested object properties', () => {
    expect(() =>
      inputWith((input) => {
        input.unexpected = true;
      }),
    ).toThrow();
    expect(() =>
      inputWith((input) => {
        (input.health as typeof input.health & { diagnosis?: string }).diagnosis = 'private';
      }),
    ).toThrow();
  });
});

describe('supporting fitness API schemas', () => {
  it('parses persisted health answers using the same strict contract', () => {
    expect(healthAnswersSchema.parse(baseInput.health)).toEqual(baseInput.health);
    expect(() => healthAnswersSchema.parse({ ...baseInput.health, extra: true })).toThrow();
  });

  it('parses the canonical null restriction stored for unrestricted clearance', () => {
    const parsed = inputWith((input) => {
      input.health.clearance = { date: '2026-01-10', unrestricted: true };
    });
    expect(healthAnswersSchema.parse(parsed.health)).toEqual(parsed.health);
  });

  it('accepts only an empty plan-preview request', () => {
    expect(planPreviewRequestSchema.parse({})).toEqual({});
    expect(() => planPreviewRequestSchema.parse({ force: true })).toThrow();
  });

  it('accepts only a nonnegative integer activation revision', () => {
    expect(planActivationRequestSchema.parse({ expectedRevision: 0 })).toEqual({
      expectedRevision: 0,
    });
    expect(() => planActivationRequestSchema.parse({ expectedRevision: -1 })).toThrow();
    expect(() => planActivationRequestSchema.parse({ expectedRevision: 1, force: true })).toThrow();
  });

  it('accepts the exact first-GET null assessment envelope', () => {
    const response: AssessmentResponse = assessmentResponseSchema.parse({
      assessment: null,
      activationRevision: 0,
      onboardingRequired: true,
      unit: 'KG',
    });
    expect(response).toEqual({
      assessment: null,
      activationRevision: 0,
      onboardingRequired: true,
      unit: 'KG',
    });
  });

  it('accepts a populated normalized eligible assessment envelope', () => {
    const response = {
      assessment: normalizedAssessment(),
      activationRevision: 3,
      onboardingRequired: false,
      unit: 'LB',
    };
    expect(assessmentResponseSchema.parse(response)).toEqual(response);
  });

  it.each([
    [
      'unknown envelope field',
      {
        assessment: null,
        activationRevision: 0,
        onboardingRequired: true,
        unit: 'KG',
        unexpected: true,
      },
    ],
    [
      'negative activation revision',
      {
        assessment: null,
        activationRevision: -1,
        onboardingRequired: true,
        unit: 'KG',
      },
    ],
    [
      'unknown unit',
      {
        assessment: null,
        activationRevision: 0,
        onboardingRequired: true,
        unit: 'STONE',
      },
    ],
    [
      'missing envelope field',
      {
        assessment: null,
        activationRevision: 0,
        onboardingRequired: true,
      },
    ],
  ])('rejects an envelope with %s', (_label, response) => {
    expect(() => assessmentResponseSchema.parse(response)).toThrow();
  });

  it('rejects a populated assessment without eligibility', () => {
    const { eligibility: _eligibility, ...assessment } = normalizedAssessment();
    expect(() =>
      assessmentResponseSchema.parse({
        assessment,
        activationRevision: 1,
        onboardingRequired: false,
        unit: 'KG',
      }),
    ).toThrow();
  });

  it.each([
    ['profile', 'displayName'],
    ['profile', 'waistCm'],
    ['profile', 'bodyFatPct'],
    ['goal', 'targetWeightKg'],
    ['goal', 'targetDate'],
    ['lifestyle', 'avgDailySteps'],
    ['health', 'clearance'],
  ] as const)('rejects omitted normalized nullable key %s.%s', (section, key) => {
    const assessment = structuredClone(normalizedAssessment());
    const target = assessment[section] as unknown as Record<string, unknown>;
    delete target[key];
    expect(() =>
      assessmentResponseSchema.parse({
        assessment,
        activationRevision: 1,
        onboardingRequired: false,
        unit: 'KG',
      }),
    ).toThrow();
  });

  it('rejects undefined instead of null for normalized optional values', () => {
    const assessment = normalizedAssessment();
    Object.assign(assessment.profile, { displayName: undefined });
    expect(() =>
      assessmentResponseSchema.parse({
        assessment,
        activationRevision: 1,
        onboardingRequired: false,
        unit: 'KG',
      }),
    ).toThrow();
  });
});
