-- CreateEnum
CREATE TYPE "EnergyEquationReference" AS ENUM ('MALE', 'FEMALE', 'UNSPECIFIED');

-- CreateEnum
CREATE TYPE "FitnessDisplaySex" AS ENUM ('MALE', 'FEMALE', 'OTHER', 'PREFER_NOT_TO_SAY');

-- CreateEnum
CREATE TYPE "ActivityLevel" AS ENUM ('SEDENTARY', 'LIGHT', 'MODERATE', 'HIGH');

-- CreateEnum
CREATE TYPE "EligibilityStatus" AS ENUM ('ELIGIBLE', 'NEEDS_MEDICAL_CLEARANCE', 'URGENT_ACTION', 'TEMPORARY_HOLD', 'OUT_OF_SCOPE');

-- CreateEnum
CREATE TYPE "FitnessGoalStatus" AS ENUM ('ACTIVE', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "FitnessPlanStatus" AS ENUM ('DRAFT', 'ACTIVE', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "InitialLoadSource" AS ENUM ('APP_HISTORY', 'USER_REPORTED', 'CALIBRATION');

-- AlterTable
ALTER TABLE "ProgramExercise" ADD COLUMN     "initialLoadKg" DOUBLE PRECISION,
ADD COLUMN     "initialLoadSource" "InitialLoadSource",
ADD COLUMN     "introEndsAt" TIMESTAMP(3),
ADD COLUMN     "introTargetRIR" INTEGER,
ADD COLUMN     "progressionRuleVersion" TEXT;

-- AlterTable
ALTER TABLE "User" ADD COLUMN "fitnessOnboardingRequired" BOOLEAN NOT NULL DEFAULT true;
UPDATE "User" SET "fitnessOnboardingRequired" = false;

-- CreateTable
CREATE TABLE "FitnessProfile" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "ageYears" INTEGER NOT NULL,
    "displaySex" "FitnessDisplaySex" NOT NULL,
    "energyEquationReference" "EnergyEquationReference" NOT NULL,
    "bodyFatPct" DOUBLE PRECISION,
    "trainingAgeMonths" INTEGER NOT NULL,
    "weeklyFrequency" INTEGER NOT NULL,
    "availableWeekdays" INTEGER[],
    "sessionDurationMin" INTEGER NOT NULL,
    "equipmentTypes" "EquipmentType"[],
    "recentMainLifts" JSONB NOT NULL,
    "activityLevel" "ActivityLevel" NOT NULL,
    "avgDailySteps" INTEGER,
    "currentModerateActivityMin" INTEGER NOT NULL,
    "habitualSleepMin" INTEGER NOT NULL,
    "bedtimeMin" INTEGER NOT NULL,
    "wakeTimeMin" INTEGER NOT NULL,
    "timeZone" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FitnessProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HealthScreening" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "screeningVersion" TEXT NOT NULL,
    "rulesVersion" TEXT NOT NULL,
    "answers" JSONB NOT NULL,
    "status" "EligibilityStatus" NOT NULL,
    "reasonCodes" TEXT[],
    "attestedAt" TIMESTAMP(3) NOT NULL,
    "clearanceDate" TIMESTAMP(3),
    "clearanceUnrestricted" BOOLEAN,
    "clearanceRestrictions" TEXT,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HealthScreening_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FitnessGoal" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "TrainingGoal" NOT NULL,
    "desiredWeeklyRatePct" DOUBLE PRECISION NOT NULL,
    "targetWeightKg" DOUBLE PRECISION,
    "targetDate" TIMESTAMP(3),
    "status" "FitnessGoalStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "supersededAt" TIMESTAMP(3),

    CONSTRAINT "FitnessGoal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FitnessPlanVersion" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "healthScreeningId" TEXT NOT NULL,
    "goalId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "FitnessPlanStatus" NOT NULL DEFAULT 'DRAFT',
    "rulesVersion" TEXT NOT NULL,
    "inputHash" TEXT NOT NULL,
    "profileUpdatedAt" TIMESTAMP(3) NOT NULL,
    "input" JSONB NOT NULL,
    "content" JSONB NOT NULL,
    "programId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "activatedAt" TIMESTAMP(3),

    CONSTRAINT "FitnessPlanVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FitnessPlanActivation" (
    "userId" TEXT NOT NULL,
    "planVersionId" TEXT,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "activatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FitnessPlanActivation_pkey" PRIMARY KEY ("userId")
);

-- AddUniqueConstraint
ALTER TABLE "FitnessProfile" ADD CONSTRAINT "FitnessProfile_userId_key" UNIQUE ("userId");

-- CreateIndex
CREATE INDEX "HealthScreening_userId_createdAt_idx" ON "HealthScreening"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "FitnessGoal_userId_status_createdAt_idx" ON "FitnessGoal"("userId", "status", "createdAt");

-- AddUniqueConstraint
ALTER TABLE "FitnessPlanVersion" ADD CONSTRAINT "FitnessPlanVersion_programId_key" UNIQUE ("programId");

-- CreateIndex
CREATE INDEX "FitnessPlanVersion_userId_status_createdAt_idx" ON "FitnessPlanVersion"("userId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "FitnessPlanVersion_userId_inputHash_idx" ON "FitnessPlanVersion"("userId", "inputHash");

-- AddUniqueConstraint
ALTER TABLE "FitnessPlanVersion" ADD CONSTRAINT "FitnessPlanVersion_userId_version_key" UNIQUE ("userId", "version");

-- AddUniqueConstraint
ALTER TABLE "FitnessPlanActivation" ADD CONSTRAINT "FitnessPlanActivation_planVersionId_key" UNIQUE ("planVersionId");

-- AddForeignKey
ALTER TABLE "FitnessProfile" ADD CONSTRAINT "FitnessProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HealthScreening" ADD CONSTRAINT "HealthScreening_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FitnessGoal" ADD CONSTRAINT "FitnessGoal_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FitnessPlanVersion" ADD CONSTRAINT "FitnessPlanVersion_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FitnessPlanVersion" ADD CONSTRAINT "FitnessPlanVersion_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "FitnessProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FitnessPlanVersion" ADD CONSTRAINT "FitnessPlanVersion_healthScreeningId_fkey" FOREIGN KEY ("healthScreeningId") REFERENCES "HealthScreening"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FitnessPlanVersion" ADD CONSTRAINT "FitnessPlanVersion_goalId_fkey" FOREIGN KEY ("goalId") REFERENCES "FitnessGoal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FitnessPlanVersion" ADD CONSTRAINT "FitnessPlanVersion_programId_fkey" FOREIGN KEY ("programId") REFERENCES "Program"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FitnessPlanActivation" ADD CONSTRAINT "FitnessPlanActivation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FitnessPlanActivation" ADD CONSTRAINT "FitnessPlanActivation_planVersionId_fkey" FOREIGN KEY ("planVersionId") REFERENCES "FitnessPlanVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
