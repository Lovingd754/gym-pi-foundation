import { NextResponse } from 'next/server';
import { z } from 'zod';
import { handleApiError, parseJsonBody, requireApiUserId } from '@/lib/api';
import {
  LlmChoiceError,
  clearUserLlmChoice,
  deploymentChoice,
  isSupportedProvider,
  listProviderOptions,
  resolveLlmChoice,
  setUserLlmChoice,
  toChoiceView,
} from '@/lib/llm/settings';

// The model name and the endpoint are free text on purpose: a relay or a local
// server serves models this app has never heard of, and a closed list would make
// the setting useless for exactly the case it exists for.
const bodySchema = z.object({
  // null = follow the deployment default again.
  provider: z.string().min(1).nullable(),
  model: z.string().max(200).nullable().optional(),
  baseUrl: z.string().max(500).nullable().optional(),
  // Omitted keeps whatever is stored; null clears it. The stored key is never
  // read back out, so a form that does not touch the field must not erase it.
  apiKey: z.string().max(500).nullable().optional(),
});

export async function GET() {
  try {
    const userId = await requireApiUserId();
    const [choice, deployment] = await Promise.all([
      resolveLlmChoice(userId),
      Promise.resolve(deploymentChoice()),
    ]);
    return NextResponse.json({
      providers: listProviderOptions(),
      current: toChoiceView(choice),
      deployment: { provider: deployment.provider },
    });
  } catch (err) {
    return handleApiError(err);
  }
}

export async function PUT(req: Request) {
  try {
    const userId = await requireApiUserId();
    const body = await parseJsonBody(req, bodySchema, { maxBytes: 4096 });

    if (body.provider === null) {
      await clearUserLlmChoice(userId);
    } else {
      if (!isSupportedProvider(body.provider)) {
        return NextResponse.json({ error: 'UNKNOWN_PROVIDER' }, { status: 400 });
      }
      await setUserLlmChoice(userId, {
        provider: body.provider,
        model: body.model ?? null,
        baseUrl: body.baseUrl ?? null,
        ...(body.apiKey === undefined ? {} : { apiKey: body.apiKey }),
      });
    }

    const [choice, deployment] = await Promise.all([
      resolveLlmChoice(userId),
      Promise.resolve(deploymentChoice()),
    ]);
    return NextResponse.json({
      current: toChoiceView(choice),
      deployment: { provider: deployment.provider },
    });
  } catch (err) {
    if (err instanceof LlmChoiceError) {
      return NextResponse.json({ error: err.code }, { status: 400 });
    }
    return handleApiError(err);
  }
}
