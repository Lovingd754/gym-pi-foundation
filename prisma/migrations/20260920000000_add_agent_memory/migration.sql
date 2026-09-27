CREATE TYPE "AgentMemoryStatus" AS ENUM ('PENDING', 'ACTIVE');

CREATE TABLE "AgentMemory" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "content" TEXT NOT NULL,
  "status" "AgentMemoryStatus" NOT NULL DEFAULT 'PENDING',
  "sourceConversationId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "decidedAt" TIMESTAMP(3),
  CONSTRAINT "AgentMemory_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AgentMemory_userId_status_createdAt_idx" ON "AgentMemory"("userId", "status", "createdAt");

ALTER TABLE "AgentMemory"
  ADD CONSTRAINT "AgentMemory_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AgentMemory"
  ADD CONSTRAINT "AgentMemory_sourceConversationId_fkey"
  FOREIGN KEY ("sourceConversationId") REFERENCES "AgentConversation"("id") ON DELETE SET NULL ON UPDATE CASCADE;
