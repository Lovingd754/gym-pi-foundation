import { db } from '@/lib/db';
import { requireSession } from '@/lib/auth';
import { getLlmProvider } from '@/lib/llm';
import {
  listAgentConversations,
  loadAgentMessages,
  type AgentChatMessage,
} from '@/lib/agent/conversations';
import { getAgentModelRequest } from '@/lib/agent/models';
import { prismaAgentMemoryStore } from '@/lib/agent/memory-store';
import { prismaPlanProposalStore } from '@/lib/agent/plan-proposals';
import { prismaLogProposalStore } from '@/lib/agent/log-proposals';
import {
  AgentChat,
  type AgentLogProposal,
  type AgentPlanChange,
  type AgentConversationSummary,
  type AgentMemoryProposal,
} from '@/components/agent/agent-chat';

interface SearchParams {
  sessionId?: string;
}

export default async function ChatPage(props: { searchParams: Promise<SearchParams> }) {
  const auth = await requireSession();
  const searchParams = await props.searchParams;

  // A live workout can be attached to the conversation. Only an id that
  // belongs to the caller is forwarded; anything else degrades to a normal
  // chat (the API re-checks ownership anyway).
  let sessionId: string | null = null;
  if (searchParams.sessionId) {
    const owned = await db.session.findFirst({
      where: { id: searchParams.sessionId, userId: auth.userId },
      select: { id: true },
    });
    sessionId = owned?.id ?? null;
  }

  const conversations = await listAgentConversations(auth.userId);
  const active = conversations[0] ?? null;
  let initialMessages: AgentChatMessage[] = [];
  let contextCompressed = false;
  if (active) {
    initialMessages = await loadAgentMessages(auth.userId, active.id).catch(() => []);
    const row = await db.agentConversation.findFirst({
      where: { id: active.id, userId: auth.userId },
      select: { contextSummary: true },
    });
    contextCompressed = Boolean(row?.contextSummary);
  }

  const provider = getLlmProvider();
  const request = await getAgentModelRequest(auth.userId);
  const initialConversations: AgentConversationSummary[] = conversations;
  const pending = await prismaAgentMemoryStore.list(auth.userId, 'PENDING');
  const initialPendingMemories: AgentMemoryProposal[] = pending.map((memory) => ({
    id: memory.id,
    content: memory.content,
  }));
  const pendingChanges = await prismaPlanProposalStore.list(auth.userId, 'PENDING');
  const initialPlanChanges: AgentPlanChange[] = pendingChanges.map((change) => ({
    id: change.id,
    kind: change.kind,
    diff: change.diff,
  }));
  const pendingLogs = await prismaLogProposalStore.list(auth.userId, 'PENDING');
  const initialLogProposals: AgentLogProposal[] = pendingLogs.map((proposal) => ({
    id: proposal.id,
    summary: proposal.summary,
  }));

  return (
    <main className="flex-1 px-4 py-6">
      <div className="mx-auto flex max-w-3xl flex-col">
        <AgentChat
          initialConversations={initialConversations}
          initialActiveId={active?.id ?? null}
          initialMessages={initialMessages}
          providerLabel={provider.label}
          modelLabel={request.model}
          isDemo={provider.id === 'demo'}
          sessionId={sessionId}
          initialPendingMemories={initialPendingMemories}
          initialPlanChanges={initialPlanChanges}
          initialLogProposals={initialLogProposals}
          contextCompressed={contextCompressed}
        />
      </div>
    </main>
  );
}
