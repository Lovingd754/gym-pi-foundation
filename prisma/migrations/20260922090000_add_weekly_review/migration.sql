-- The weekly review: the auto-replan preference, and the record of the last
-- review that ran for the plan in use.
ALTER TABLE "User" ADD COLUMN "weeklyAutoReplan" BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE "FitnessPlanActivation" ADD COLUMN "lastReviewWeek" TEXT,
ADD COLUMN "lastReviewedAt" TIMESTAMP(3),
ADD COLUMN "lastReviewSummary" JSONB;
