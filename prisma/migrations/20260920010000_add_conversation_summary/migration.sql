ALTER TABLE "AgentConversation"
  ADD COLUMN "contextSummary" TEXT,
  ADD COLUMN "summarizedThrough" TIMESTAMP(3),
  ADD COLUMN "summaryUpdatedAt" TIMESTAMP(3);
