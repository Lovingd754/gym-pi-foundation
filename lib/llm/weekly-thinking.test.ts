import { afterEach, expect, it, vi } from 'vitest';
import { OpenAiCompatibleProvider } from './openai-compatible';
afterEach(() => vi.unstubAllGlobals());
it('forwards explicit thinking mode only to DeepSeek and keeps other calls unchanged', async () => {
  const fetchMock = vi
    .fn()
    .mockImplementation(
      async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }), {
          status: 200,
        }),
    );
  vi.stubGlobal('fetch', fetchMock);
  const options = {
    label: 'test',
    apiKeyEnvVar: 'TEST_KEY',
    apiKey: undefined,
    baseUrl: 'http://localhost',
    model: 'test',
  };
  await new OpenAiCompatibleProvider({ ...options, id: 'deepseek' }).complete({
    system: 'S',
    messages: [],
    thinking: false,
  });
  expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toMatchObject({
    thinking: { type: 'disabled' },
  });
  await new OpenAiCompatibleProvider({ ...options, id: 'deepseek' }).complete({
    system: 'S',
    messages: [],
  });
  expect(JSON.parse(fetchMock.mock.calls[1]![1].body)).not.toHaveProperty('thinking');
  await new OpenAiCompatibleProvider({ ...options, id: 'custom' }).complete({
    system: 'S',
    messages: [],
    thinking: false,
  });
  expect(JSON.parse(fetchMock.mock.calls[2]![1].body)).not.toHaveProperty('thinking');
});
