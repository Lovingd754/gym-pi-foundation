import type { AssessmentInput } from './schemas';

// ============================================================
// How fast the trainee wants to change
// ============================================================
// A weekly percentage of bodyweight means nothing to the person choosing it, so
// the interface asks the question people actually answer - "slow and steady, or
// push harder?" - and this module is the one place that turns that into the
// number the rules use. One direction only: choices become rates, never the
// reverse in the interface.

export type GoalPace = 'GENTLE' | 'STANDARD' | 'FAST';

type GoalType = AssessmentInput['goal']['type'];

// Exactly the ends and the middle of the range the assessment already allows,
// so a choice can never sit outside the validated band.
export const PACE_RATES = {
  FAT_LOSS: { GENTLE: -0.25, STANDARD: -0.5, FAST: -0.75 },
  HYPERTROPHY: { GENTLE: 0.1, STANDARD: 0.2, FAST: 0.25 },
  RECOMP: { GENTLE: -0.25, STANDARD: 0, FAST: 0.25 },
} as const satisfies Record<GoalType, Record<GoalPace, number>>;

export const DEFAULT_PACE: GoalPace = 'STANDARD';
export const PACE_ORDER: readonly GoalPace[] = ['GENTLE', 'STANDARD', 'FAST'];

export function paceToRate(goalType: GoalType, pace: GoalPace): number {
  return PACE_RATES[goalType][pace];
}

// The nearest choice to whatever rate is stored. Legacy rows and a hand-edited
// value both land on the closest option instead of an empty selection.
export function rateToPace(goalType: GoalType, rate: number): GoalPace {
  let best: GoalPace = DEFAULT_PACE;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const pace of PACE_ORDER) {
    const distance = Math.abs(paceToRate(goalType, pace) - rate);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = pace;
    }
  }
  return best;
}

const WEEKS_PER_MONTH = 4.345;
// 1 kg of body mass is worth roughly this many kcal; used only to turn a rate
// into a sentence, never to prescribe anything.
export const KCAL_PER_KG = 7700;

export function monthlyChangeKg(ratePct: number, weightKg: number): number {
  return (Math.abs(ratePct) / 100) * weightKg * WEEKS_PER_MONTH;
}

export interface PlainLanguageEnergy {
  direction: 'LOSE' | 'GAIN' | 'MAINTAIN';
  // Average of the maintenance and target ranges: a sentence, not a prescription.
  deficitKcal: number;
  monthlyChangeKg: number;
}

export function describeEnergy(input: {
  goalType: GoalType;
  ratePct: number;
  weightKg: number;
  maintenanceKcal: number;
  targetKcal: number;
}): PlainLanguageEnergy {
  const deficitKcal = Math.round(input.maintenanceKcal - input.targetKcal);
  const monthly = monthlyChangeKg(input.ratePct, input.weightKg);
  const direction =
    deficitKcal > 60 ? 'LOSE' : deficitKcal < -60 ? 'GAIN' : 'MAINTAIN';
  return { direction, deficitKcal, monthlyChangeKg: Math.round(monthly * 10) / 10 };
}

// The deficit in food the trainee already eats, because "360 kcal" is as
// abstract as "0.5%". Rounded to halves so the number stays honest about being
// an approximation.
const RICE_BOWL_KCAL = 230;
const CHICKEN_THIGH_KCAL = 200;

export function foodEquivalent(deficitKcal: number): { riceBowls: number; chickenThighs: number } {
  const amount = Math.abs(deficitKcal);
  const roundHalf = (value: number) => Math.max(0.5, Math.round(value * 2) / 2);
  return {
    riceBowls: roundHalf(amount / RICE_BOWL_KCAL),
    chickenThighs: roundHalf(amount / CHICKEN_THIGH_KCAL),
  };
}
