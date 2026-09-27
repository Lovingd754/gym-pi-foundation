import { Prisma } from '@/prisma/generated/client';
import { db } from '@/lib/db';
import { ApiError } from '@/lib/api';
import { isoWeekStartDate } from './time-zone';
import { weeklyActivitiesRequestSchema, weeklyActivitySchema } from './weekly-activities';
import { lockFitnessUser } from './user-lock';

export async function getWeeklyActivities(userId: string, now: Date = new Date()) {
  const profile = await db.fitnessProfile.findUnique({
    where: { userId },
    select: { timeZone: true },
  });
  const weekStart = isoWeekStartDate(now, profile?.timeZone ?? 'UTC');
  const row = await db.fitnessWeeklyActivities.findUnique({
    where: { userId_weekStart: { userId, weekStart } },
  });
  return {
    weekStart,
    activities: weeklyActivitySchema
      .array()
      .max(14)
      .parse(row?.activities ?? []),
  };
}
export async function saveWeeklyActivities(userId: string, raw: unknown, now: Date = new Date()) {
  const body = weeklyActivitiesRequestSchema.parse(raw);
  return db.$transaction(async (tx) => {
    await lockFitnessUser(tx, userId);
    const profile = await tx.fitnessProfile.findUnique({
      where: { userId },
      select: { timeZone: true },
    });
    const weekStart = isoWeekStartDate(now, profile?.timeZone ?? 'UTC');
    if (body.weekStart !== undefined && body.weekStart !== weekStart)
      throw new ApiError(409, 'WEEKLY_ACTIVITIES_STALE', { weekStart });
    await tx.fitnessWeeklyActivities.upsert({
      where: { userId_weekStart: { userId, weekStart } },
      create: { userId, weekStart, activities: body.activities as Prisma.InputJsonValue },
      update: { activities: body.activities as Prisma.InputJsonValue },
    });
    return { weekStart, activities: body.activities };
  });
}
