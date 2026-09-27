import { buildBaselinePlan, type BaselinePlanInput } from './baseline-plan';
import { parseFitnessPlanContent } from './plan-schema';
import type { WeeklyStrategy, WeeklyStrategyConstraints } from './weekly-strategy';
import { ApiError } from '@/lib/api';
import { estimateWorkoutDurationMin, StrengthPlanConstraintError } from './strength-plan';

export function applyWeeklyStrategy(
  input: BaselinePlanInput,
  strategy: WeeklyStrategy,
  constraints: WeeklyStrategyConstraints,
) {
  const duration =
    Math.floor(
      Math.min(
        input.assessment.schedule.sessionDurationMin,
        constraints.sessionDurationMin ?? 120,
      ) / 5,
    ) * 5;
  if (duration < 30 || constraints.equipmentTypes.length === 0)
    throw new ApiError(409, 'WEEKLY_SCHEDULE_INFEASIBLE', {
      message:
        'The selected days need at least 30 minutes and compatible strength equipment. Increase the available time or update equipment for this week.',
    });
  if (
    strategy.recovery === 'REDUCED' &&
    strategy.weekdays.length > input.assessment.schedule.weeklyFrequency
  )
    throw new ApiError(502, 'WEEKLY_MODEL_UNAVAILABLE', {
      message:
        'The weekly strategy increased training frequency despite a recovery reduction. Please retry.',
    });
  const assessment = {
    ...input.assessment,
    schedule: {
      ...input.assessment.schedule,
      weeklyFrequency: strategy.weekdays.length as 2 | 3 | 4 | 5,
      availableWeekdays: strategy.weekdays,
      equipmentTypes: constraints.equipmentTypes,
      sessionDurationMin: duration,
    },
  };
  let content;
  try {
    content = buildBaselinePlan({ ...input, assessment, strategy });
  } catch (error) {
    if (error instanceof StrengthPlanConstraintError)
      throw new ApiError(409, 'WEEKLY_SCHEDULE_INFEASIBLE', {
        minimumDurationMin: error.minimumDurationMin,
        message:
          'The selected exercises do not fit this week. Increase available time or update equipment.',
      });
    throw error;
  }
  if (strategy.recovery === 'REDUCED') {
    content.strength.achievedSetsByMuscleGroup = {};
    for (const day of content.strength.days)
      for (const exercise of day.exercises) {
        exercise.targetSets = Math.max(1, exercise.targetSets - 1);
        exercise.targetRIR = Math.max(3, exercise.targetRIR);
        content.strength.achievedSetsByMuscleGroup[exercise.muscleGroup] =
          (content.strength.achievedSetsByMuscleGroup[exercise.muscleGroup] ?? 0) +
          exercise.targetSets;
      }
    for (const day of content.strength.days)
      day.estimatedDurationMin = estimateWorkoutDurationMin(day);
  }
  // Keep the bounded generator's cardio sessions only where this week's explicit
  // availability and time budget allow them. Never move cardio onto a blocked day.
  content.cardio.sessions = content.cardio.sessions
    .filter((s) => constraints.availableWeekdays.includes(s.dayOfWeek))
    .flatMap((s) => {
      const strength = content.strength.days.find((d) => d.dayOfWeek === s.dayOfWeek);
      const activityBudgets =
        constraints.activities
          ?.filter((a) => a.dayOfWeek === s.dayOfWeek)
          .flatMap((a) => (a.availableMinutes === undefined ? [] : [a.availableMinutes])) ?? [];
      const dayBudget = activityBudgets.length
        ? Math.min(...activityBudgets)
        : constraints.sessionDurationMin;
      const cap =
        dayBudget === null
          ? s.durationMin
          : Math.max(0, dayBudget - (strength?.estimatedDurationMin ?? 0));
      const durationMin = Math.min(s.durationMin, cap);
      return durationMin > 0 ? [{ ...s, durationMin }] : [];
    });
  if (strategy.recovery === 'REDUCED' && constraints.previousCardioMin !== undefined) {
    let remaining = constraints.previousCardioMin;
    content.cardio.sessions = content.cardio.sessions.flatMap((s) => {
      const durationMin = Math.min(s.durationMin, remaining);
      remaining -= durationMin;
      return durationMin > 0 ? [{ ...s, durationMin }] : [];
    });
  }
  content.cardio.additionalWeeklyMin = content.cardio.sessions.reduce(
    (sum, s) => sum + s.durationMin,
    0,
  );
  for (const day of content.schedule.days) {
    day.cardioMin = content.cardio.sessions
      .filter((s) => s.dayOfWeek === day.dayOfWeek)
      .reduce((sum, s) => sum + s.durationMin, 0);
    day.kind =
      day.strengthDayIndex === null
        ? day.cardioMin
          ? 'CARDIO'
          : 'REST'
        : day.cardioMin
          ? 'STRENGTH_AND_CARDIO'
          : 'STRENGTH';
  }
  return { assessment, content: parseFitnessPlanContent(content) };
}
