import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';
import { createGymPiMcpServer, GYMPI_MCP_INSTRUCTIONS } from './server';

const openServers: Array<ReturnType<typeof createGymPiMcpServer>> = [];
const openClients: Client[] = [];

afterEach(async () => {
  await Promise.allSettled(openClients.splice(0).map((client) => client.close()));
  await Promise.allSettled(openServers.splice(0).map((server) => server.close()));
});

describe('GymPi MCP server', () => {
  it('advertises only user-scoped read tools', async () => {
    const server = createGymPiMcpServer({
      principal: {
        tokenId: 'token-1',
        userId: 'user-1',
        canWrite: true,
      },
      baseUrl: 'https://gympi.example',
    });
    const client = new Client({
      name: 'gympi-test',
      version: '1.0.0',
    });
    openServers.push(server);
    openClients.push(client);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
      'get_program',
      'get_training_context',
      'list_exercises',
      'list_programs',
    ]);
    for (const tool of tools.tools) {
      expect(tool.annotations?.readOnlyHint).toBe(true);
    }

    const resources = await client.listResources();
    expect(resources.resources.map((resource) => resource.uri)).toContain(
      'gympi://instructions/agent',
    );
    const prompts = await client.listPrompts();
    expect(prompts.prompts.map((prompt) => prompt.name)).toContain('build-training-program');
    const prompt = await client.getPrompt({
      name: 'build-training-program',
      arguments: { goal: 'Build a three-day hypertrophy draft' },
    });
    expect(JSON.stringify(prompt)).not.toContain('create_program');

    const instructions = await client.readResource({
      uri: 'gympi://instructions/agent',
    });
    expect(instructions.contents[0]).toMatchObject({
      text: GYMPI_MCP_INSTRUCTIONS,
    });
    expect(GYMPI_MCP_INSTRUCTIONS).toContain('This server is read-only');
  });
});
