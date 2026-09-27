import { NextResponse } from 'next/server';
import { handleApiError, parseJsonBody, requireApiUserId } from '@/lib/api';
import { getWeeklyActivities, saveWeeklyActivities } from '@/lib/fitness/weekly-activities-store';
import { weeklyActivitiesRequestSchema } from '@/lib/fitness/weekly-activities';
export async function GET() {
  try {
    return NextResponse.json(await getWeeklyActivities(await requireApiUserId()));
  } catch (error) {
    return handleApiError(error);
  }
}
export async function PUT(req: Request) {
  try {
    const userId = await requireApiUserId();
    const body = await parseJsonBody(req, weeklyActivitiesRequestSchema, { maxBytes: 20_000 });
    return NextResponse.json(await saveWeeklyActivities(userId, body));
  } catch (error) {
    return handleApiError(error);
  }
}
