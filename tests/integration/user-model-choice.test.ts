import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { getCurrentUserId } from '@/lib/auth';
import { getAgentModelRequest } from '@/lib/agent/models';
import { resolveLlmChoice, setUserLlmChoice } from '@/lib/llm/settings';

vi.mock('@/lib/auth', () => ({ getCurrentUserId: vi.fn() }));
const mockUserId = vi.mocked(getCurrentUserId);

import { GET as getModelSettings, PUT as putModelSettings } from '@/app/api/settings/model/route';

function jsonRequest(body: unknown): Request {
  return new Request('http://test.local/api/settings/model', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function seed(suffix: string) {
  const user = await db.user.create({
    data: { email: `${suffix}@model.test`, passwordHash: 'test-password-hash' },
  });
  mockUserId.mockResolvedValue(user.id);
  return user;
}

beforeEach(() => {
  mockUserId.mockReset();
  vi.unstubAllEnvs();
});

describe('per-user model choice', () => {
  it('starts on the deployment default', async () => {
    vi.stubEnv('LLM_PROVIDER', 'demo');
    const user = await seed('model-default');

    expect(await resolveLlmChoice(user.id)).toEqual({
      provider: 'demo',
      model: null,
      baseUrl: null,
      apiKey: null,
      source: 'DEPLOYMENT',
    });
  });

  it('overrides the deployment for that account only', async () => {
    vi.stubEnv('LLM_PROVIDER', 'demo');
    const owner = await seed('model-owner');
    const other = await db.user.create({
      data: { email: 'model-other@model.test', passwordHash: 'test-password-hash' },
    });

    await setUserLlmChoice(owner.id, {
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      baseUrl: null,
    });

    expect(await resolveLlmChoice(owner.id)).toEqual({
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      baseUrl: null,
      apiKey: null,
      source: 'USER',
    });
    // Everyone else keeps the install default.
    expect((await resolveLlmChoice(other.id)).source).toBe('DEPLOYMENT');
  });

  it('changes what the agent will actually use', async () => {
    vi.stubEnv('LLM_PROVIDER', 'demo');
    const user = await seed('model-agent');

    expect(await getAgentModelRequest(user.id)).toEqual({
      provider: 'demo',
      model: 'demo-agent',
    });

    await setUserLlmChoice(user.id, {
      provider: 'deepseek',
      model: 'deepseek-v4-pro',
      baseUrl: null,
    });

    expect(await getAgentModelRequest(user.id)).toEqual({
      provider: 'deepseek',
      model: 'deepseek-v4-pro',
    });
  });

  it('routes the agent to a trainee-supplied endpoint and model name', async () => {
    vi.stubEnv('LLM_PROVIDER', 'demo');
    const user = await seed('model-custom');

    // The model name is one the app has never heard of: that is the point.
    await setUserLlmChoice(user.id, {
      provider: 'custom',
      model: 'relay-special-9000',
      baseUrl: 'https://relay.example.com/v1',
      apiKey: 'sk-stored',
    });

    expect(await getAgentModelRequest(user.id)).toEqual({
      provider: 'custom',
      model: 'relay-special-9000',
    });
    const stored = await db.user.findUniqueOrThrow({
      where: { id: user.id },
      select: { llmBaseUrl: true, llmApiKey: true },
    });
    expect(stored.llmBaseUrl).toBe('https://relay.example.com/v1');
    expect(stored.llmApiKey).toBe('sk-stored');
  });

  it('refuses a custom endpoint with no address, and a url that is not http', async () => {
    const user = await seed('model-invalid');

    await expect(
      setUserLlmChoice(user.id, { provider: 'custom', model: 'x', baseUrl: null }),
    ).rejects.toThrow('ENDPOINT_REQUIRED');
    await expect(
      setUserLlmChoice(user.id, { provider: 'custom', model: 'x', baseUrl: 'ftp://relay' }),
    ).rejects.toThrow('INVALID_ENDPOINT');
    // Nothing was stored by either attempt.
    expect((await resolveLlmChoice(user.id)).source).toBe('DEPLOYMENT');
  });

  it('keeps a stored key when the form leaves the field blank', async () => {
    const user = await seed('model-keep-key');
    await setUserLlmChoice(user.id, {
      provider: 'custom',
      model: 'a',
      baseUrl: 'https://relay.example.com/v1',
      apiKey: 'sk-first',
    });

    // apiKey omitted: the settings form only sends it when the trainee types one.
    const response = await putModelSettings(
      jsonRequest({
        provider: 'custom',
        model: 'a',
        baseUrl: 'https://relay.example.com/v1',
      }),
    );

    expect(response.status).toBe(200);
    const stored = await db.user.findUniqueOrThrow({
      where: { id: user.id },
      select: { llmApiKey: true },
    });
    expect(stored.llmApiKey).toBe('sk-first');
  });

  it('goes back to the deployment default when cleared', async () => {
    vi.stubEnv('LLM_PROVIDER', 'demo');
    const user = await seed('model-reset');
    await setUserLlmChoice(user.id, { provider: 'deepseek', model: null, baseUrl: null });

    const response = await putModelSettings(jsonRequest({ provider: null }));

    expect(response.status).toBe(200);
    expect(await resolveLlmChoice(user.id)).toEqual({
      provider: 'demo',
      model: null,
      baseUrl: null,
      apiKey: null,
      source: 'DEPLOYMENT',
    });
  });

  it('lists the options and never sends the stored key back', async () => {
    vi.stubEnv('LLM_PROVIDER', 'demo');
    const user = await seed('model-api');
    await setUserLlmChoice(user.id, {
      provider: 'custom',
      model: 'relay-special-9000',
      baseUrl: 'https://relay.example.com/v1',
      apiKey: 'sk-secret',
    });

    const response = await getModelSettings();
    const body = (await response.json()) as {
      providers: { provider: string }[];
      current: Record<string, unknown>;
    };

    expect(response.status).toBe(200);
    expect(body.providers.map((entry) => entry.provider)).toEqual(
      expect.arrayContaining(['deepseek', 'openai', 'custom']),
    );
    expect(body.current).toEqual({
      provider: 'custom',
      model: 'relay-special-9000',
      baseUrl: 'https://relay.example.com/v1',
      hasKey: true,
      source: 'USER',
    });
    // The secret is write-only: it must never appear anywhere in the payload.
    expect(JSON.stringify(body)).not.toContain('sk-secret');
  });
});
