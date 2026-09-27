import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { db } from '@/lib/db';
import { buildCoachPayload } from '@/lib/coach';
import type { McpPrincipal } from '@/lib/mcp/auth';

export const GYMPI_MCP_INSTRUCTIONS = `GymPi stores the trainee's profile, gyms, equipment, programs, workout history, sets, RIR, goals and recovery signals.

This server is read-only. Use read tools before making recommendations. Ground every recommendation in returned GymPi data and never invent completed sets, available equipment, records or injuries. Respect the active gym's equipment constraints. Use the trainee's language.

You may explain a draft or proposed adjustment, but never claim that GymPi data changed or that a proposal is active. The trainee must review and confirm changes inside the GymPi application.`;

interface ServerOptions {
  principal: McpPrincipal;
  baseUrl: string;
}

function result(data: Record<string, unknown>) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
    structuredContent: data,
  };
}

async function getOwnedProgram(userId: string, programId?: string) {
  const program = programId
    ? await db.program.findFirst({
        where: { id: programId, userId },
        select: { id: true },
      })
    : await db.program.findFirst({
        where: { userId, isActive: true },
        select: { id: true },
      });
  if (!program) {
    throw new Error(programId ? 'Program not found.' : 'No active program.');
  }
  return program.id;
}

export function createGymPiMcpServer({ principal, baseUrl }: ServerOptions): McpServer {
  const server = new McpServer(
    {
      name: 'GymPi',
      version: '1.0.0',
      websiteUrl: baseUrl,
    },
    { instructions: GYMPI_MCP_INSTRUCTIONS },
  );

  server.registerResource(
    'gympi-agent-instructions',
    'gympi://instructions/agent',
    {
      title: 'GymPi agent instructions',
      description: 'Rules for safely analysing the trainee training data.',
      mimeType: 'text/plain',
    },
    async () => ({
      contents: [
        {
          uri: 'gympi://instructions/agent',
          mimeType: 'text/plain',
          text: GYMPI_MCP_INSTRUCTIONS,
        },
      ],
    }),
  );

  server.registerPrompt(
    'build-training-program',
    {
      title: 'Build a GymPi training program',
      description: 'Analyse the trainee context and prepare a structured program for GymPi.',
      argsSchema: { goal: z.string().trim().min(5).max(2000) },
    },
    async ({ goal }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text:
              'Goal: ' +
              goal +
              '\n\nFirst call get_training_context and list_exercises. Prepare a realistic draft that respects the saved gym and equipment. Explain the draft for review. This MCP server cannot save or activate it.',
          },
        },
      ],
    }),
  );

  server.registerTool(
    'get_training_context',
    {
      title: 'Get training context',
      description:
        'Returns the trainee profile, recent training, active program, records, goals, fatigue, readiness, conditioning and active gym equipment.',
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
        idempotentHint: true,
      },
    },
    async () => {
      const [coach, user] = await Promise.all([
        buildCoachPayload(principal.userId),
        db.user.findUnique({
          where: { id: principal.userId },
          select: {
            unit: true,
            activeGym: {
              include: {
                exerciseConfigs: {
                  orderBy: { exercise: { name: 'asc' } },
                  include: {
                    exercise: {
                      select: { id: true, name: true, equipmentType: true },
                    },
                  },
                },
              },
            },
          },
        }),
      ]);
      return result({
        instructionsVersion: 1,
        unit: user?.unit ?? 'KG',
        activeGym: user?.activeGym ?? null,
        coach,
      });
    },
  );

  server.registerTool(
    'list_exercises',
    {
      title: 'List exercise catalog',
      description: 'Lists the trainee exercise catalog with stable IDs and equipment categories.',
      inputSchema: {
        search: z.string().trim().max(120).optional(),
        limit: z.number().int().min(1).max(500).default(200),
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
        idempotentHint: true,
      },
    },
    async ({ search, limit }) => {
      const exercises = await db.exercise.findMany({
        where: {
          userId: principal.userId,
          ...(search ? { name: { contains: search, mode: 'insensitive' as const } } : {}),
        },
        orderBy: { name: 'asc' },
        take: limit,
        select: {
          id: true,
          name: true,
          muscleGroup: true,
          category: true,
          equipmentType: true,
          usesBodyweight: true,
          defaultRestSec: true,
          notes: true,
        },
      });
      return result({ exercises });
    },
  );

  server.registerTool(
    'list_programs',
    {
      title: 'List training programs',
      description: 'Lists saved programs and their workout counts.',
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
        idempotentHint: true,
      },
    },
    async () => {
      const programs = await db.program.findMany({
        where: { userId: principal.userId },
        orderBy: { updatedAt: 'desc' },
        select: {
          id: true,
          name: true,
          phase: true,
          description: true,
          isActive: true,
          updatedAt: true,
          _count: { select: { workouts: true, sessions: true } },
        },
      });
      return result({ programs });
    },
  );

  server.registerTool(
    'get_program',
    {
      title: 'Get a training program',
      description: 'Returns a complete program with workout, exercise and autoregulation IDs.',
      inputSchema: {
        programId: z.string().cuid().optional().describe('Omit to read the active program.'),
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
        idempotentHint: true,
      },
    },
    async ({ programId }) => {
      const id = await getOwnedProgram(principal.userId, programId);
      const program = await db.program.findUnique({
        where: { id },
        include: {
          workouts: {
            orderBy: { order: 'asc' },
            include: {
              exercises: {
                orderBy: { order: 'asc' },
                include: { exercise: true },
              },
            },
          },
        },
      });
      return result({ program });
    },
  );

  return server;
}
