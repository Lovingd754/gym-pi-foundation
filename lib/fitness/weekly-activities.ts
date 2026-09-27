import { z } from 'zod';
import { supportedAssessmentEquipmentValues, type EquipmentType } from './exercise-keys';

export const weeklyActivitySchema = z
  .object({
    dayOfWeek: z.number().int().min(1).max(7),
    description: z.string().trim().max(500),
    unavailable: z.boolean(),
    availableMinutes: z.number().int().min(0).max(180).optional(),
    equipmentTypes: z.array(z.enum(supportedAssessmentEquipmentValues)).max(5).optional(),
  })
  .strict();
export type WeeklyActivity = z.infer<typeof weeklyActivitySchema>;
export const weeklyActivitiesRequestSchema = z
  .object({
    weekStart: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    activities: z.array(weeklyActivitySchema).max(14),
  })
  .strict();

export function weeklyConstraints(
  days: readonly number[],
  equipment: readonly EquipmentType[],
  activities: readonly WeeklyActivity[],
) {
  const availableWeekdays = [...new Set(days)].filter(
    (day) =>
      !activities.some(
        (a) =>
          a.dayOfWeek === day &&
          (a.unavailable || (a.availableMinutes !== undefined && a.availableMinutes < 20)),
      ),
  );
  const applicable = activities.filter((a) => availableWeekdays.includes(a.dayOfWeek));
  const equipmentTypes = equipment.filter((e) =>
    applicable.every((a) => a.equipmentTypes === undefined || a.equipmentTypes.includes(e)),
  );
  const durations = applicable.flatMap((a) =>
    a.availableMinutes === undefined ? [] : [a.availableMinutes],
  );
  return {
    availableWeekdays,
    equipmentTypes,
    sessionDurationMin: durations.length ? Math.min(...durations) : null,
  };
}
