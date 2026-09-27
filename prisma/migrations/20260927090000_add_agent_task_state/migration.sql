ALTER TABLE "AgentConversation" ADD COLUMN "taskState" JSONB,
ADD COLUMN "taskStateRevision" INTEGER NOT NULL DEFAULT 0;
