CREATE TYPE "AgentPlanChangeKind" AS ENUM ('SWAP_EXERCISE', 'MOVE_TRAINING_DAY', 'SET_CARDIO_MINUTES');
CREATE TYPE "AgentPlanProposalStatus" AS ENUM ('PENDING', 'APPLIED', 'DISMISSED');

CREATE TABLE "AgentPlanProposal" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "conversationId" TEXT,
  "kind" "AgentPlanChangeKind" NOT NULL,
  "basePlanId" TEXT NOT NULL,
  "diff" JSONB NOT NULL,
  "change" JSONB NOT NULL,
  "status" "AgentPlanProposalStatus" NOT NULL DEFAULT 'PENDING',
  "resultPlanId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "decidedAt" TIMESTAMP(3),
  CONSTRAINT "AgentPlanProposal_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AgentPlanProposal_userId_status_createdAt_idx" ON "AgentPlanProposal"("userId", "status", "createdAt");

ALTER TABLE "AgentPlanProposal"
  ADD CONSTRAINT "AgentPlanProposal_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AgentPlanProposal"
  ADD CONSTRAINT "AgentPlanProposal_conversationId_fkey"
  FOREIGN KEY ("conversationId") REFERENCES "AgentConversation"("id") ON DELETE SET NULL ON UPDATE CASCADE;
