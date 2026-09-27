CREATE TYPE "AgentLogProposalStatus" AS ENUM ('PENDING', 'APPLIED', 'DISMISSED');

CREATE TABLE "AgentLogProposal" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "conversationId" TEXT,
  "exerciseId" TEXT NOT NULL,
  "summary" JSONB NOT NULL,
  "entry" JSONB NOT NULL,
  "status" "AgentLogProposalStatus" NOT NULL DEFAULT 'PENDING',
  "resultSessionId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "decidedAt" TIMESTAMP(3),
  CONSTRAINT "AgentLogProposal_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AgentLogProposal_userId_status_createdAt_idx" ON "AgentLogProposal"("userId", "status", "createdAt");

ALTER TABLE "AgentLogProposal"
  ADD CONSTRAINT "AgentLogProposal_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AgentLogProposal"
  ADD CONSTRAINT "AgentLogProposal_conversationId_fkey"
  FOREIGN KEY ("conversationId") REFERENCES "AgentConversation"("id") ON DELETE SET NULL ON UPDATE CASCADE;
