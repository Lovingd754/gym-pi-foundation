CREATE TYPE "AgentRunKind" AS ENUM ('CHAT', 'WEEKLY_REVIEW');
CREATE TYPE "AgentRunStatus" AS ENUM ('RUNNING', 'COMPLETED', 'DEGRADED', 'CANCELLED', 'FAILED');
CREATE TYPE "AgentStopReason" AS ENUM ('COMPLETED', 'CANCELLED', 'TIMEOUT', 'MODEL_LIMIT', 'TOOL_LIMIT', 'SAFETY_STOP', 'ERROR');
CREATE TYPE "ToolInvocationStatus" AS ENUM ('STARTED', 'SUCCEEDED', 'FAILED', 'BLOCKED');
CREATE TYPE "AgentMessageRole" AS ENUM ('USER', 'ASSISTANT');
CREATE TYPE "AgentMessageStatus" AS ENUM ('COMPLETE', 'INCOMPLETE');

CREATE TABLE "AgentConversation" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "title" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AgentConversation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AgentMessage" (
  "id" TEXT NOT NULL,
  "conversationId" TEXT NOT NULL,
  "role" "AgentMessageRole" NOT NULL,
  "status" "AgentMessageStatus" NOT NULL DEFAULT 'COMPLETE',
  "content" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AgentMessage_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AgentRun" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "conversationId" TEXT,
  "kind" "AgentRunKind" NOT NULL,
  "status" "AgentRunStatus" NOT NULL DEFAULT 'RUNNING',
  "stopReason" "AgentStopReason",
  "runtimeVersion" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "model" TEXT NOT NULL,
  "inputHash" TEXT NOT NULL,
  "modelTurns" INTEGER NOT NULL DEFAULT 0,
  "toolCalls" INTEGER NOT NULL DEFAULT 0,
  "errorCode" TEXT,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finishedAt" TIMESTAMP(3),
  CONSTRAINT "AgentRun_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ToolInvocation" (
  "id" TEXT NOT NULL,
  "runId" TEXT NOT NULL,
  "toolCallId" TEXT NOT NULL,
  "toolName" TEXT NOT NULL,
  "argsHash" TEXT NOT NULL,
  "resultHash" TEXT,
  "authorizationAllowed" BOOLEAN NOT NULL,
  "status" "ToolInvocationStatus" NOT NULL DEFAULT 'STARTED',
  "durationMs" INTEGER,
  "errorCode" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ToolInvocation_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AgentConversation_userId_updatedAt_idx" ON "AgentConversation"("userId", "updatedAt");
CREATE INDEX "AgentMessage_conversationId_createdAt_idx" ON "AgentMessage"("conversationId", "createdAt");
CREATE INDEX "AgentRun_userId_startedAt_idx" ON "AgentRun"("userId", "startedAt");
CREATE INDEX "AgentRun_conversationId_startedAt_idx" ON "AgentRun"("conversationId", "startedAt");
CREATE UNIQUE INDEX "ToolInvocation_runId_toolCallId_key" ON "ToolInvocation"("runId", "toolCallId");
CREATE INDEX "ToolInvocation_runId_createdAt_idx" ON "ToolInvocation"("runId", "createdAt");

ALTER TABLE "AgentConversation"
  ADD CONSTRAINT "AgentConversation_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AgentMessage"
  ADD CONSTRAINT "AgentMessage_conversationId_fkey"
  FOREIGN KEY ("conversationId") REFERENCES "AgentConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AgentRun"
  ADD CONSTRAINT "AgentRun_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AgentRun"
  ADD CONSTRAINT "AgentRun_conversationId_fkey"
  FOREIGN KEY ("conversationId") REFERENCES "AgentConversation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "ToolInvocation"
  ADD CONSTRAINT "ToolInvocation_runId_fkey"
  FOREIGN KEY ("runId") REFERENCES "AgentRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
