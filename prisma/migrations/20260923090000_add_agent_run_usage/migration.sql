-- Per-run token and cost accounting, so model spend is observable from the
-- audit trail instead of only in the provider's dashboard.
ALTER TABLE "AgentRun" ADD COLUMN "inputTokens" INTEGER,
ADD COLUMN "outputTokens" INTEGER,
ADD COLUMN "totalTokens" INTEGER,
ADD COLUMN "costMicroUsd" INTEGER;
