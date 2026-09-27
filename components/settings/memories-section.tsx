'use client';

import { useState } from 'react';
import { BrainCircuit, Trash2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export interface MemoryItem {
  id: string;
  content: string;
}

// What the coach remembers. Read-only here except for deletion: new notes only
// ever arrive through the trainee accepting a proposal in the chat.
export function MemoriesSection({ initialMemories }: { initialMemories: MemoryItem[] }) {
  const t = useTranslations('agent.memory.settings');
  const [memories, setMemories] = useState(initialMemories);

  async function remove(id: string) {
    try {
      const res = await fetch(`/api/agent/memories/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setMemories((prev) => prev.filter((memory) => memory.id !== id));
      toast.success(t('deleted'));
    } catch {
      toast.error(t('failed'));
    }
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <BrainCircuit className="size-4" />
          {t('title')}
        </CardTitle>
        <CardDescription>{t('description')}</CardDescription>
      </CardHeader>
      <CardContent>
        {memories.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('empty')}</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {memories.map((memory) => (
              <li
                key={memory.id}
                className="flex items-start justify-between gap-3 rounded-md border border-border px-3 py-2"
              >
                <span className="text-sm">{memory.content}</span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => void remove(memory.id)}
                  aria-label={t('delete')}
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
