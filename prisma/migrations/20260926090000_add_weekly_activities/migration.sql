CREATE TABLE "FitnessWeeklyActivities" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "weekStart" TEXT NOT NULL,
  "activities" JSONB NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "FitnessWeeklyActivities_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "FitnessWeeklyActivities_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "FitnessWeeklyActivities_userId_weekStart_key" ON "FitnessWeeklyActivities"("userId", "weekStart");
