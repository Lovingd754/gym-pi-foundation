'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  ArrowUp,
  ArrowRight,
  BrainCircuit,
  Check,
  CircleAlert,
  ClipboardCheck,
  GitCompareArrows,
  Info,
  Loader2,
  Plus,
  Sparkles,
  Square,
  Wrench,
  X,
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

export interface AgentConversationSummary {
  id: string;
  title: string;
  updatedAt: string;
}

export interface AgentChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface AgentMemoryProposal {
  id: string;
  content: string;
}

export interface AgentPlanChange {
  id: string;
  kind: string;
  diff: { label: string; before: string; after: string }[];
}

export interface AgentLogProposal {
  id: string;
  summary: { label: string; value: string }[];
}

type StopReason =
  | 'completed'
  | 'cancelled'
  | 'timeout'
  | 'model-limit'
  | 'tool-limit'
  | 'safety-stop'
  | 'error';

type ToolStatus = 'running' | 'done' | 'failed' | 'blocked';

type ThreadItem =
  | { kind: 'message'; id: string; role: 'user' | 'assistant'; content: string }
  | { kind: 'intent'; id: string; skill: string }
  | { kind: 'tool'; id: string; name: string; status: ToolStatus }
  | { kind: 'notice'; id: string; text: string }
  | { kind: 'stop'; id: string; reason: StopReason };

interface Props {
  initialConversations: AgentConversationSummary[];
  initialActiveId: string | null;
  initialMessages: AgentChatMessage[];
  providerLabel: string;
  modelLabel: string;
  isDemo: boolean;
  // Live workout attached from the session runner, or null for a normal chat.
  sessionId?: string | null;
  initialPendingMemories: AgentMemoryProposal[];
  initialPlanChanges: AgentPlanChange[];
  initialLogProposals: AgentLogProposal[];
  // True when this thread has already been compacted, so the notice is visible
  // from the first render rather than only right after a compaction.
  contextCompressed?: boolean;
}

let itemSeq = 0;
function nextId(prefix: string): string {
  itemSeq += 1;
  return `${prefix}-${itemSeq}`;
}

export function AgentChat({
  initialConversations,
  initialActiveId,
  initialMessages,
  providerLabel,
  modelLabel,
  isDemo,
  sessionId = null,
  initialPendingMemories,
  initialPlanChanges,
  initialLogProposals,
  contextCompressed = false,
}: Props) {
  const t = useTranslations('agent');
  const [conversations, setConversations] = useState(initialConversations);
  const [activeId, setActiveId] = useState<string | null>(initialActiveId);
  const [items, setItems] = useState<ThreadItem[]>(() => [
    ...(contextCompressed
      ? [{ kind: 'notice' as const, id: nextId('notice'), text: t('notices.compressed') }]
      : []),
    ...initialMessages.map((message) => ({
      kind: 'message' as const,
      id: nextId('seed'),
      role: message.role,
      content: message.content,
    })),
  ]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [proposals, setProposals] = useState<AgentMemoryProposal[]>(initialPendingMemories);
  const [planChanges, setPlanChanges] = useState<AgentPlanChange[]>(initialPlanChanges);
  const [logProposals, setLogProposals] = useState<AgentLogProposal[]>(initialLogProposals);
  const scrollRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [items]);

  function patchItems(mutate: (draft: ThreadItem[]) => ThreadItem[]) {
    setItems((prev) => mutate([...prev]));
  }

  function appendAssistantDelta(delta: string) {
    patchItems((draft) => {
      const last = draft[draft.length - 1];
      if (last && last.kind === 'message' && last.role === 'assistant') {
        draft[draft.length - 1] = { ...last, content: last.content + delta };
      } else {
        draft.push({ kind: 'message', id: nextId('assistant'), role: 'assistant', content: delta });
      }
      return draft;
    });
  }

  function setToolStatus(toolCallId: string, status: ToolStatus) {
    patchItems((draft) => {
      const index = draft.findIndex((item) => item.kind === 'tool' && item.id === toolCallId);
      if (index >= 0)
        draft[index] = { ...(draft[index] as Extract<ThreadItem, { kind: 'tool' }>), status };
      return draft;
    });
  }

  async function send() {
    const text = input.trim();
    if (!text || streaming) return;

    setInput('');
    setStreaming(true);
    patchItems((draft) => {
      draft.push({ kind: 'message', id: nextId('user'), role: 'user', content: text });
      return draft;
    });

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await fetch('/api/agent/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversationId: activeId ?? undefined,
          message: text,
          sessionId: sessionId ?? undefined,
        }),
        signal: controller.signal,
      });

      if (!res.ok || !res.body) {
        const payload = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(payload.error ?? `HTTP ${res.status}`);
      }

      const newId = res.headers.get('X-Conversation-Id');
      if (newId && newId !== activeId) {
        setActiveId(newId);
        setConversations((prev) =>
          prev.some((conversation) => conversation.id === newId)
            ? prev
            : [
                { id: newId, title: text.slice(0, 60), updatedAt: new Date().toISOString() },
                ...prev,
              ],
        );
      }

      await readEventStream(res.body, (event) => {
        if (event.type === 'text-delta' && typeof event.delta === 'string') {
          appendAssistantDelta(event.delta);
          return;
        }
        if (event.type === 'intent' && typeof event.skill === 'string') {
          patchItems((draft) => {
            // One label per turn, at the top of that turn's items.
            draft.push({ kind: 'intent', id: nextId('intent'), skill: event.skill as string });
            return draft;
          });
          return;
        }
        if (event.type === 'tool-start' && typeof event.toolCallId === 'string') {
          patchItems((draft) => {
            draft.push({
              kind: 'tool',
              id: event.toolCallId as string,
              name: String(event.toolName ?? ''),
              status: 'running',
            });
            return draft;
          });
          return;
        }
        if (event.type === 'tool-end' && typeof event.toolCallId === 'string') {
          setToolStatus(event.toolCallId, event.isError ? 'failed' : 'done');
          return;
        }
        if (event.type === 'turn-end') {
          const reason = (event.stopReason as StopReason) ?? 'completed';
          if (Array.isArray(event.pendingMemories)) {
            setProposals(event.pendingMemories as AgentMemoryProposal[]);
          }
          if (Array.isArray(event.pendingPlanChanges)) {
            setPlanChanges(event.pendingPlanChanges as AgentPlanChange[]);
          }
          if (Array.isArray(event.pendingLogs)) {
            setLogProposals(event.pendingLogs as AgentLogProposal[]);
          }
          if (reason !== 'completed') {
            patchItems((draft) => {
              draft.push({ kind: 'stop', id: nextId('stop'), reason });
              return draft;
            });
          }
          return;
        }
        if (event.type === 'context-compacted') {
          patchItems((draft) => {
            draft.push({ kind: 'notice', id: nextId('notice'), text: t('notices.compressed') });
            return draft;
          });
          return;
        }
        if (event.type === 'error') {
          patchItems((draft) => {
            draft.push({ kind: 'stop', id: nextId('stop'), reason: 'error' });
            return draft;
          });
        }
      });
    } catch {
      if (!controller.signal.aborted) {
        patchItems((draft) => {
          draft.push({ kind: 'stop', id: nextId('stop'), reason: 'error' });
          return draft;
        });
      }
    } finally {
      abortRef.current = null;
      setStreaming(false);
    }
  }

  function stop() {
    abortRef.current?.abort();
    patchItems((draft) => {
      draft.push({ kind: 'stop', id: nextId('stop'), reason: 'cancelled' });
      return draft;
    });
  }

  // The trainee's decision is the only path that turns a proposal into a
  // memory, which is why this call lives in the interface and not in a tool.
  async function decideMemory(id: string, action: 'confirm' | 'dismiss') {
    try {
      const res = await fetch(`/api/agent/memories/${id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setProposals((prev) => prev.filter((proposal) => proposal.id !== id));
      toast.success(t(action === 'confirm' ? 'memory.card.accepted' : 'memory.card.dismissed'));
    } catch {
      toast.error(t('memory.card.failed'));
    }
  }

  // Applying is the trainee's decision and the app's arithmetic; the agent only
  // ever sees that a proposal exists.
  async function decidePlanChange(id: string, action: 'apply' | 'dismiss') {
    try {
      const res = await fetch(`/api/agent/plan-proposals/${id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      if (!res.ok) {
        const payload = (await res.json().catch(() => ({}))) as { error?: string };
        setPlanChanges((prev) => prev.filter((change) => change.id !== id));
        toast.error(
          payload.error === 'PLAN_PROPOSAL_STALE'
            ? t('change.card.stale')
            : t('change.card.failed'),
        );
        return;
      }
      setPlanChanges((prev) => prev.filter((change) => change.id !== id));
      toast.success(t(action === 'apply' ? 'change.card.applied' : 'change.card.dismissed'));
    } catch {
      toast.error(t('change.card.failed'));
    }
  }

  async function decideLog(id: string, action: 'log' | 'dismiss') {
    try {
      const res = await fetch(`/api/agent/log-proposals/${id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setLogProposals((prev) => prev.filter((proposal) => proposal.id !== id));
      toast.success(t(action === 'log' ? 'log.card.applied' : 'log.card.dismissed'));
    } catch {
      toast.error(t('log.card.failed'));
    }
  }

  function reset() {
    if (streaming) return;
    setActiveId(null);
    setItems([]);
  }

  async function openConversation(id: string) {
    if (streaming || id === activeId) return;
    setActiveId(id);
    try {
      const res = await fetch(`/api/agent/conversations/${id}`);
      if (!res.ok) throw new Error('load failed');
      const payload = (await res.json()) as {
        messages: AgentChatMessage[];
        contextCompressed?: boolean;
      };
      setItems([
        ...(payload.contextCompressed
          ? [{ kind: 'notice' as const, id: nextId('notice'), text: t('notices.compressed') }]
          : []),
        ...payload.messages.map((message) => ({
          kind: 'message' as const,
          id: nextId('seed'),
          role: message.role,
          content: message.content,
        })),
      ]);
      const proposalsRes = await fetch('/api/agent/plan-proposals');
      if (proposalsRes.ok) {
        const body = (await proposalsRes.json()) as { pending: AgentPlanChange[] };
        setPlanChanges(body.pending);
      }
      const logsRes = await fetch('/api/agent/log-proposals');
      if (logsRes.ok) {
        const body = (await logsRes.json()) as { pending: AgentLogProposal[] };
        setLogProposals(body.pending);
      }
    } catch {
      patchItems((draft) => {
        draft.push({ kind: 'stop', id: nextId('stop'), reason: 'error' });
        return draft;
      });
    }
  }

  return (
    <div className="flex h-[calc(100dvh-11rem)] min-h-[26rem] flex-col overflow-hidden rounded-xl border border-border bg-card">
      <header className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">{t('title')}</p>
          <p className="truncate text-xs text-muted-foreground">
            {isDemo ? t('model.demo') : `${providerLabel} · ${modelLabel}`}
          </p>
        </div>
        {/* Quick log has its own place in the navigation, so the header keeps
            only what belongs to this screen. */}
        <Button variant="outline" size="sm" onClick={reset} disabled={streaming}>
          <Plus className="mr-1 size-4" />
          {t('newChat')}
        </Button>
      </header>

      {conversations.length > 1 ? (
        <div className="flex gap-2 overflow-x-auto border-b border-border px-4 py-2">
          {conversations.slice(0, 8).map((conversation) => (
            <button
              key={conversation.id}
              type="button"
              onClick={() => void openConversation(conversation.id)}
              className={cn(
                'shrink-0 rounded-full border border-border px-3 py-1 text-xs transition-colors',
                conversation.id === activeId
                  ? 'bg-secondary text-secondary-foreground'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {conversation.title}
            </button>
          ))}
        </div>
      ) : null}

      <div
        ref={scrollRef}
        data-testid="agent-thread"
        className="flex-1 space-y-3 overflow-y-auto px-4 py-4"
      >
        {items.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border p-4">
            <p className="text-sm font-medium">{t('empty.title')}</p>
            <p className="mt-2 text-sm text-muted-foreground">{t('empty.body')}</p>
            <p className="mt-3 flex items-start gap-2 text-xs text-muted-foreground">
              <Info className="mt-0.5 size-3.5 shrink-0" />
              {t('empty.hint')}
            </p>
          </div>
        ) : null}

        {items.map((item) => {
          if (item.kind === 'message') {
            return (
              <div
                key={item.id}
                data-testid="agent-message"
                className={cn('flex', item.role === 'user' ? 'justify-end' : 'justify-start')}
              >
                <div
                  className={cn(
                    'max-w-[85%] rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed',
                    item.role === 'user'
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-secondary text-secondary-foreground',
                  )}
                >
                  {item.role === 'assistant' ? (
                    <div className="prose prose-sm max-w-none dark:prose-invert [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
                      <ReactMarkdown>{item.content}</ReactMarkdown>
                    </div>
                  ) : (
                    <p className="whitespace-pre-wrap">{item.content}</p>
                  )}
                </div>
              </div>
            );
          }

          if (item.kind === 'tool') {
            const nameKey = `tool.names.${item.name}`;
            const known = [
              'get_current_plan',
              'get_recent_training',
              'get_memories',
              'propose_memory',
              'propose_plan_change',
              'log_workout',
            ].includes(item.name);
            return (
              <div
                key={item.id}
                className="flex items-center gap-2 rounded-lg border border-border/70 bg-muted/40 px-3 py-2 text-xs text-muted-foreground"
              >
                <Wrench className="size-3.5 shrink-0" />
                <span className="truncate">
                  {t('tool.running')} ·{' '}
                  {known ? t(nameKey as 'tool.names.get_current_plan') : item.name}
                </span>
                {item.status === 'running' ? (
                  <Loader2 className="ml-auto size-3.5 animate-spin" />
                ) : (
                  <span className="ml-auto flex items-center gap-1">
                    <Check className="size-3.5" />
                    {t(
                      `tool.${item.status === 'done' ? 'done' : item.status === 'blocked' ? 'blocked' : 'failed'}`,
                    )}
                  </span>
                )}
              </div>
            );
          }

          if (item.kind === 'intent') {
            const known = ['log', 'plan', 'review', 'general'].includes(item.skill);
            return (
              <p
                key={item.id}
                data-testid="agent-intent"
                className="flex items-center gap-2 text-xs text-muted-foreground"
              >
                <Sparkles className="size-3.5 shrink-0" />
                <span>
                  {t('intent.label')}：
                  {known ? t(`intent.${item.skill}` as 'intent.general') : item.skill}
                </span>
              </p>
            );
          }

          if (item.kind === 'notice') {
            return (
              <p
                key={item.id}
                data-testid="agent-notice"
                className="flex items-center justify-center gap-2 text-center text-xs text-muted-foreground"
              >
                <Info className="size-3.5" />
                {item.text}
              </p>
            );
          }

          const message = t(`stopReasons.${item.reason}`);
          if (!message) return null;
          return (
            <p
              key={item.id}
              className="flex items-center justify-center gap-2 text-center text-xs text-muted-foreground"
            >
              <CircleAlert className="size-3.5" />
              {message}
            </p>
          );
        })}
      </div>

      <div className="border-t border-border px-3 py-3">
        {logProposals.length > 0 ? (
          <div className="mb-2 space-y-2" data-testid="log-proposal-card">
            {logProposals.slice(0, 2).map((proposal) => (
              <div
                key={proposal.id}
                className="rounded-lg border border-border bg-muted/40 px-3 py-2.5"
              >
                <p className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                  <ClipboardCheck className="size-3.5" />
                  {t('log.card.title')}
                </p>
                <dl className="mt-1.5 space-y-0.5">
                  {proposal.summary.map((row) => (
                    <div key={`${row.label}-${row.value}`} className="flex gap-2 text-sm">
                      <dt className="text-xs text-muted-foreground">{row.label}</dt>
                      <dd className="font-medium">{row.value}</dd>
                    </div>
                  ))}
                </dl>
                <div className="mt-2 flex gap-2">
                  <Button size="sm" onClick={() => void decideLog(proposal.id, 'log')}>
                    <Check className="mr-1 size-3.5" />
                    {t('log.card.apply')}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void decideLog(proposal.id, 'dismiss')}
                  >
                    <X className="mr-1 size-3.5" />
                    {t('log.card.dismiss')}
                  </Button>
                </div>
              </div>
            ))}
          </div>
        ) : null}
        {planChanges.length > 0 ? (
          <div className="mb-2 space-y-2" data-testid="plan-change-card">
            {planChanges.slice(0, 2).map((change) => (
              <div
                key={change.id}
                className="rounded-lg border border-border bg-muted/40 px-3 py-2.5"
              >
                <p className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                  <GitCompareArrows className="size-3.5" />
                  {t('change.card.title')}
                </p>
                <ul className="mt-1.5 space-y-1">
                  {change.diff.map((row) => (
                    <li key={`${row.label}-${row.before}-${row.after}`} className="text-sm">
                      <span className="text-xs text-muted-foreground">{row.label}</span>
                      <span className="mt-0.5 flex flex-wrap items-center gap-1.5">
                        <span className="text-muted-foreground line-through">{row.before}</span>
                        <ArrowRight className="size-3.5 text-muted-foreground" />
                        <span className="font-medium">{row.after}</span>
                      </span>
                    </li>
                  ))}
                </ul>
                <div className="mt-2 flex gap-2">
                  <Button size="sm" onClick={() => void decidePlanChange(change.id, 'apply')}>
                    <Check className="mr-1 size-3.5" />
                    {t('change.card.apply')}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void decidePlanChange(change.id, 'dismiss')}
                  >
                    <X className="mr-1 size-3.5" />
                    {t('change.card.dismiss')}
                  </Button>
                </div>
              </div>
            ))}
          </div>
        ) : null}
        {proposals.length > 0 ? (
          <div className="mb-2 space-y-2">
            {proposals.slice(0, 3).map((proposal) => (
              <div
                key={proposal.id}
                className="rounded-lg border border-border bg-muted/40 px-3 py-2.5"
              >
                <p className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                  <BrainCircuit className="size-3.5" />
                  {t('memory.card.title')}
                </p>
                <p className="mt-1.5 text-sm">{proposal.content}</p>
                <div className="mt-2 flex gap-2">
                  <Button size="sm" onClick={() => void decideMemory(proposal.id, 'confirm')}>
                    <Check className="mr-1 size-3.5" />
                    {t('memory.card.accept')}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void decideMemory(proposal.id, 'dismiss')}
                  >
                    <X className="mr-1 size-3.5" />
                    {t('memory.card.dismiss')}
                  </Button>
                </div>
              </div>
            ))}
          </div>
        ) : null}
        <div className="flex items-end gap-2">
          <Textarea
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                void send();
              }
            }}
            rows={1}
            placeholder={t('composer.placeholder')}
            className="min-h-[2.5rem] resize-none"
            aria-label={t('composer.placeholder')}
          />
          {streaming ? (
            <Button
              type="button"
              variant="outline"
              size="icon"
              onClick={stop}
              title={t('composer.stop')}
            >
              <Square className="size-4" />
            </Button>
          ) : (
            <Button
              type="button"
              size="icon"
              onClick={() => void send()}
              disabled={input.trim() === ''}
              title={t('composer.send')}
            >
              <ArrowUp className="size-4" />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

// Reads `data: {json}` frames from the SSE response and hands each one to the
// caller in order.
async function readEventStream(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: Record<string, unknown>) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let boundary = buffer.indexOf('\n\n');
    while (boundary >= 0) {
      const raw = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const line = raw.split('\n').find((candidate) => candidate.startsWith('data:'));
      if (line) {
        try {
          onEvent(JSON.parse(line.slice(5).trim()) as Record<string, unknown>);
        } catch {
          // A malformed frame is dropped rather than killing the turn.
        }
      }
      boundary = buffer.indexOf('\n\n');
    }
  }
}
