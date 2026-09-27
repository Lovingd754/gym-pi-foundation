import { describe, it } from 'vitest';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import { resolveAgentModel } from '@/lib/agent/models';
import { createPiFitnessAgentRuntime } from '@/lib/agent/pi-runtime';
import { routeIntent } from '@/lib/agent/intent';
import { getLlmProviderFor } from '@/lib/llm/settings';
import { createCurrentPlanTool } from '@/lib/agent/tools/current-plan';
import { createRecentTrainingTool } from '@/lib/agent/tools/recent-training';
import { createLogWorkoutTool } from '@/lib/agent/tools/log-workout';
import { createMemoriesTool, createProposeMemoryTool } from '@/lib/agent/tools/memories';
import type { AgentMemoryStore } from '@/lib/agent/memory-store';
import { buildBaselinePlan } from '@/lib/fitness/baseline-plan';
import { evaluateEligibility } from '@/lib/fitness/eligibility';
import { createAssessmentInputSchema } from '@/lib/fitness/schemas';
import { STRENGTH_EXERCISE_CATALOG } from '@/lib/fitness/exercise-catalog';

// Real model and production tools; synthetic fixtures and in-memory proposals.
// No database writes, no full-suite run. Capture wire usage for classification too.
describe('bounded budget pilot', () => {
  it('reports routing and agent usage on fixed fixtures', async () => {
    const resolved = await resolveAgentModel();
    if (resolved.model.provider === 'demo-agent') throw new Error('A live model is required');
    const provider = await getLlmProviderFor();
    const nativeFetch = globalThis.fetch;
    const usage: Record<string, number>[] = [];
    globalThis.fetch = async (...args) => {
      const response = await nativeFetch(...args);
      if (response.headers.get('content-type')?.includes('application/json')) {
        const body = await response.clone().json().catch(() => null);
        if (body?.usage) usage.push(body.usage);
      }
      return response;
    };
    try {
      const routeCases: [string, string][] = [
        ['卧推60公斤8次3组', 'log'], ['上周我练了几次？', 'review'],
        ['把周三训练挪到周四', 'plan'], ['我体重71公斤', 'review'],
        ['有氧减到60分钟', 'plan'], ['谢谢', 'review'],
        ['那个动作我不想继续了，能安排别的吗', 'plan'],
        ['刚撸完铁，卧推六十公斤，八下，三轮', 'log'],
        ['帮我看看最近的表现', 'review'], ['下周会很忙，想重新安排训练', 'plan'],
        ['最近总觉得练完恢复不过来', 'review'], ['随便聊聊', 'general'],
      ];
      let routesCorrect = 0;
      const classify = async ({ message }: { message: string }) => {
        const result = await provider.complete({
          system: 'Classify a fitness message: log=completed sets, plan=request plan change, review=question about training or recovery, general=other. Return only JSON {"intent":"log|plan|review|general"}.',
          messages: [{ role: 'user', content: message }], temperature: 0, maxTokens: 1200,
        });
        return JSON.parse(/\{[\s\S]*\}/.exec(result.text)?.[0] ?? 'null');
      };
      for (const [message, expected] of routeCases) {
        const start = Date.now();
        const route = await routeIntent(message, { dependencies: { classify } });
        if (route.skill === expected) routesCorrect++;
        console.log(JSON.stringify({ stage: 'route', expected, actual: route.skill, source: route.source, ms: Date.now() - start }));
      }
      console.log(JSON.stringify({ stage: 'router-summary', correct: routesCorrect, total: routeCases.length, wireUsage: usage }));
      const now = new Date('2026-09-26T04:00:00Z');
      const assessment = createAssessmentInputSchema(now).parse({
        profile: { ageYears: 30, displaySex: 'PREFER_NOT_TO_SAY', energyEquationReference: 'UNSPECIFIED', heightCm: 170, weightKg: 82, trainingAgeMonths: 3 },
        goal: { type: 'FAT_LOSS', desiredWeeklyRatePct: -0.5, targetWeightKg: 74, targetDate: '2027-03-01' },
        schedule: { weeklyFrequency: 3, availableWeekdays: [1, 3, 5], sessionDurationMin: 60, equipmentTypes: ['DUMBBELL', 'BODYWEIGHT'], recentMainLifts: [{ catalogKey: 'goblet_squat', weightKg: 24, reps: 10, rir: 2 }] },
        lifestyle: { activityLevel: 'SEDENTARY', avgDailySteps: 5000, currentModerateActivityMin: 40, habitualSleepMin: 380, bedtimeMin: 1430, wakeTimeMin: 420, timeZone: 'Asia/Shanghai' },
        health: { urgentSignals: [], clearanceSignals: [], temporarySignals: [], scopeSignals: [], healthChangedSinceClearance: false, attested: true },
      });
      const content = buildBaselinePlan({ assessment, eligibility: evaluateEligibility(assessment, now), gymConstraints: { unavailableExerciseNames: [] }, now,
        loadGuidance: STRENGTH_EXERCISE_CATALOG.map((e) => ({ catalogKey: e.key, source: 'CALIBRATION', initialLoadKg: null })),
      });
      const memories: string[] = [];
      const memoryStore: AgentMemoryStore = {
        propose: async ({ content: note }) => { memories.push(note); return { id: 'pilot-memory', status: 'PENDING', created: true }; },
        list: async () => [], confirm: async () => false, dismiss: async () => false, remove: async () => false,
      };
      const scope = { userId: 'pilot', locale: 'zh-CN' };
      const logs: unknown[] = [];
      const tools = [
        createCurrentPlanTool(scope, { loadSnapshot: async () => ({ version: 1, status: 'ACTIVE', activatedAt: now, goalType: 'FAT_LOSS', desiredWeeklyRatePct: -0.5, timeZone: 'Asia/Shanghai', content }) }, () => now),
        createRecentTrainingTool(scope, { loadHistory: async () => ({ timeZone: 'Asia/Shanghai', sessions: [{ startedAt: now, finishedAt: new Date(now.getTime() + 3600000), workoutName: null, sets: [{ weight: 60, reps: 8, durationSec: null, distanceM: null, isWarmup: false, exercise: { name: 'Bench Press', category: 'STRENGTH' } }] }] }) }),
        createMemoriesTool(scope, memoryStore), createProposeMemoryTool(scope, memoryStore),
        createLogWorkoutTool(scope, { loadExercises: async () => [{ id: 'bench', name: 'Bench Press' }], loadUnit: async () => 'KG' }, {
          propose: async (input) => { logs.push(input.entry); return { id: 'pilot-log' }; }, list: async () => [], loadPending: async () => null, markApplied: async () => {}, dismiss: async () => false,
        }),
      ];
      const runtime = createPiFitnessAgentRuntime({
        getModelRequest: async () => ({ provider: resolved.model.provider, model: resolved.model.id }),
        resolveModel: async () => ({ model: resolved.model, streamFn: resolved.models.streamSimple.bind(resolved.models) as StreamFn }),
        loadTurns: async () => ({ summary: null, memories: [], turns: [] }), createTools: () => tools,
        routeIntent: (message) => routeIntent(message, { dependencies: { classify } }),
        audit: { startRun: async () => {}, configureRun: async () => {}, startTool: async () => {}, finishTool: async () => {}, finishRun: async () => {} },
      });
      const cases: [string, string[]][] = [
        ['我今天该练什么？', ['get_current_plan']], ['我每顿应该吃多少？', ['get_current_plan']],
        ['我最近一次训练练的什么？', ['get_recent_training']], ['卧推60公斤8次，做了3组', ['log_workout']],
        ['记住我不喜欢跑步', ['propose_memory']], ['你还记得我什么？', ['get_memories']],
        ['刚刚做了卧推，但是忘记具体重量了', []], ['谢谢', []],
      ];
      let correct = 0;
      for (const [message, expected] of cases) {
        const called: string[] = [];
        const start = Date.now();
        const result = await runtime.run({ runId: crypto.randomUUID(), kind: 'chat', userId: 'pilot', locale: 'zh-CN', message }, (event) => { if (event.type === 'tool-start') called.push(event.toolName); });
        const passed = result.stopReason === 'completed' && (expected.length ? expected.some((e) => called.includes(e)) : !called.includes('log_workout'));
        if (passed) correct++;
        console.log(JSON.stringify({ stage: 'agent', passed, tools: called, ms: Date.now() - start, model: result.model, turns: result.modelTurns, usage: result.usage }));
        if (result.stopReason !== 'completed') break;
      }
      console.log(JSON.stringify({ stage: 'pilot-summary', correct, planned: cases.length, logs, pendingMemories: memories.length, classifierUsage: usage, fixture: 'synthetic-no-db', fullEvaluation: false }));
    } finally { globalThis.fetch = nativeFetch; }
  }, 600000);
});
