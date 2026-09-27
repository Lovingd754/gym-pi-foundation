/**
 * Agent evaluation harness (a resume/QA artifact, not part of the test suite).
 *
 * Four measurements, all reproducible:
 *
 *   1. Tool-output contract: every tool answers with bounded prose, never a
 *      serialized record - the rule that keeps one call from eating the window.
 *   2. Tool selection: a labeled set of trainee utterances is run through the
 *      real agent runtime and the first tool it calls is compared with the
 *      expected one. Needs a live model.
 *   3. Movement resolution: every movement in a real library is spoken back in
 *      its Chinese name, its English name and a shortened form, and the
 *      resolver's answer is checked. Pure functions.
 *   4. Long-thread compaction: a synthetic 60-message thread is compacted with
 *      the real model, and the before/after model input is measured.
 *
 * Usage: npx tsx scripts/agent-eval.ts [--no-model]
 */
import { randomUUID } from 'node:crypto';
import { describe, it } from 'vitest';
import { db } from '@/lib/db';
import { getExerciseDisplayName } from '@/i18n/exercise-names';
import { createPiFitnessAgentRuntime } from '@/lib/agent/pi-runtime';
import { resolveAgentConversation } from '@/lib/agent/conversations';
import { compactConversation, shouldCompact, COMPACTION_KEEP_RECENT } from '@/lib/agent/compaction';
import { createFitnessAgentTools } from '@/lib/agent/tools';
import { resolveExercise } from '@/lib/agent/tools/log-workout';

// DATABASE_URL and the provider keys are loaded by the runner config, which
// exists because lib/db.ts connects the moment it is imported.

// The flag is an environment variable rather than a CLI argument because the
// runner owns the command line (AGENT_EVAL_NO_MODEL=1 skips every model call).
const WITH_MODEL = process.env.AGENT_EVAL_NO_MODEL !== '1';
const LOCALE = 'zh-CN';

async function main(): Promise<void> {
  const evaluationStartedAt = new Date();
  const user = await db.user.findFirstOrThrow({
    where: { fitnessPlanVersions: { some: { status: 'ACTIVE' } } },
    orderBy: { createdAt: 'desc' },
    select: { id: true, email: true },
  });
  console.log(`account: ${user.email}\n`);

  // ---------------------------------------------------------------- 1. tools
  const exercise = await db.exercise.findFirstOrThrow({
    where: { userId: user.id, category: { not: 'CARDIO' } },
  });
  const tools = createFitnessAgentTools({ userId: user.id, locale: LOCALE });
  const toolArguments: Record<string, unknown> = {
    get_current_plan: {},
    get_recent_training: { limit: 5 },
    get_memories: {},
    propose_memory: { content: '评估用：不喜欢跑步，优先骑车' },
    propose_plan_change: { changeType: 'set_cardio_minutes', cardioMinutes: 60 },
    log_workout: { exerciseName: exercise.name, weight: 40, reps: 8, sets: 3 },
  };

  console.log('== 1. tool output contract ==');
  console.log(`${'tool'.padEnd(22)}chars   json  truncated`);
  const conversationsToClean: string[] = [];
  for (const tool of tools) {
    const params = toolArguments[tool.name];
    if (!params) {
      console.log(`${tool.name.padEnd(22)}-       -     -`);
      continue;
    }
    const result = (await tool.execute('eval', params as never, undefined as never)) as {
      content: { type: string; text: string }[];
    };
    const text = result.content.map((block) => block.text).join('\n');
    const hasJson = /[{[][\s\S]*[:}]/.test(text);
    const truncated = text.includes('已截断');
    const flags =
      `${text.length}`.padEnd(8) + (hasJson ? 'yes' : 'no').padEnd(6) + (truncated ? 'yes' : 'no');
    console.log(`${tool.name.padEnd(22)}${flags}`);
  }

  // The swap path is the one tool that resolves a *name* the trainee said, so it
  // is probed in both wordings: the plan stores "Goblet squat", the interface
  // shows "高脚杯深蹲", and both have to reach the same movement.
  const activeVersion = await db.fitnessPlanVersion.findFirstOrThrow({
    where: { userId: user.id, status: 'ACTIVE' },
    select: { content: true },
  });
  const planContent = activeVersion.content as {
    strength?: { days?: { exercises?: { name?: string }[] }[] };
  };
  const storedMovement = planContent.strength?.days?.[0]?.exercises?.[0]?.name;
  if (storedMovement) {
    const swapTool = tools.find((tool) => tool.name === 'propose_plan_change')!;
    for (const spokenName of [getExerciseDisplayName(storedMovement, LOCALE), storedMovement]) {
      try {
        const result = (await swapTool.execute(
          'eval',
          { changeType: 'swap_exercise', exerciseName: spokenName } as never,
          undefined as never,
        )) as { content: { text: string }[] };
        console.log(`swap by name ${spokenName}: ${result.content[0]!.text.slice(0, 120)}`);
      } catch (error) {
        console.log(`swap by name ${spokenName}: ERROR ${String(error).slice(0, 160)}`);
      }
    }
  }

  // --------------------------------------------------------- 2. tool choice
  // Two of the cases name a movement the trainee's plan actually contains: a swap
  // request for a movement that is not in the plan is a different question
  // (explain, or offer to add one), so the label has to come from the plan.
  const activeContent = await db.fitnessPlanVersion.findFirstOrThrow({
    where: { userId: user.id, status: 'ACTIVE' },
    select: { content: true },
  });
  const plannedMovement = (() => {
    const content = activeContent.content as {
      strength?: { days?: { exercises?: { name?: string }[] }[] };
    };
    const name = content.strength?.days?.[0]?.exercises?.[0]?.name;
    return name ? getExerciseDisplayName(name, LOCALE) : '高脚杯深蹲';
  })();

  // `expectSkill` is the intent the router should land on: the labelled intent
  // half of the evaluation, next to the tool the model should then reach for.
  const CASES: { message: string; expect: string[]; expectSkill: string[] }[] = [
    { message: '我今天该练什么？', expect: ['get_current_plan'], expectSkill: ['review'] },
    {
      message: '看一下我这周是怎么安排的。',
      expect: ['get_current_plan'],
      expectSkill: ['review'],
    },
    { message: '这个计划里深蹲安排几组？', expect: ['get_current_plan'], expectSkill: ['review'] },
    { message: '我上次练了什么？', expect: ['get_recent_training'], expectSkill: ['review'] },
    {
      message: '把最近三次训练都给我看看。',
      expect: ['get_recent_training'],
      expectSkill: ['review'],
    },
    { message: '上周我一共练了几次？', expect: ['get_recent_training'], expectSkill: ['review'] },
    { message: '你还记得我什么？', expect: ['get_memories'], expectSkill: ['review'] },
    {
      message: '记住我不喜欢跑步，尽量别安排。',
      expect: ['propose_memory'],
      expectSkill: ['plan'],
    },
    {
      message: `我膝盖不太好，${plannedMovement}尽量换成别的。`,
      expect: ['propose_memory', 'propose_plan_change'],
      expectSkill: ['plan'],
    },
    { message: '把周三的训练挪到周四。', expect: ['propose_plan_change'], expectSkill: ['plan'] },
    {
      message: '有氧太多了，减到每周 60 分钟。',
      expect: ['propose_plan_change'],
      expectSkill: ['plan'],
    },
    {
      message: `把${plannedMovement}换个动作，做腻了。`,
      expect: ['propose_plan_change'],
      expectSkill: ['plan'],
    },
    { message: '卧推 60 公斤 8 次，做了 3 组。', expect: ['log_workout'], expectSkill: ['log'] },
    {
      message: '刚刚做了 5 组引体向上，每组 8 个，自重。',
      expect: ['log_workout'],
      expectSkill: ['log'],
    },
    {
      message: '今天只睡了 5 个小时，今天还练吗？',
      expect: ['get_current_plan', 'NONE'],
      expectSkill: ['review'],
    },
    {
      message: '我昨天没练成，今天要补上吗？',
      expect: ['get_current_plan', 'get_recent_training', 'NONE'],
      expectSkill: ['review'],
    },
    {
      message: '我明天要出差三天，训练怎么办？',
      expect: ['get_current_plan', 'propose_plan_change'],
      expectSkill: ['plan'],
    },
    {
      message: '我体重 71 公斤。',
      expect: ['propose_memory', 'NONE'],
      expectSkill: ['review'],
    },
    { message: '谢谢！', expect: ['NONE'], expectSkill: ['review'] },
    { message: '你好。', expect: ['NONE'], expectSkill: ['review'] },
  ];

  if (WITH_MODEL) {
    console.log('\n== 2. tool selection (live model) ==');
    const runtime = createPiFitnessAgentRuntime();
    let correct = 0;
    let contains = 0;
    const misses: string[] = [];
    const routingMisses: string[] = [];
    let routedRight = 0;
    const routedBy = new Map<string, number>();
    const latencies: number[] = [];
    const firstTokenLatencies: number[] = [];
    const tokensPerRun: number[] = [];
    const inputTokensPerRun: number[] = [];
    const outputTokensPerRun: number[] = [];
    let costMicroUsdTotal = 0;
    let modelName = '';
    for (const testCase of CASES) {
      const conversationId = await resolveAgentConversation(user.id, undefined, testCase.message);
      conversationsToClean.push(conversationId);
      const called: string[] = [];
      const started = Date.now();
      let firstToken: number | null = null;
      const result = await runtime.run(
        {
          runId: randomUUID(),
          kind: 'chat',
          userId: user.id,
          conversationId,
          locale: LOCALE,
          message: testCase.message,
        },
        (event) => {
          if (event.type === 'tool-start') called.push(event.toolName);
          if (event.type === 'text-delta' && firstToken === null) firstToken = Date.now() - started;
        },
      );
      latencies.push(Date.now() - started);
      if (firstToken !== null) firstTokenLatencies.push(firstToken);
      tokensPerRun.push(result.usage.totalTokens);
      inputTokensPerRun.push(result.usage.inputTokens);
      outputTokensPerRun.push(result.usage.outputTokens);
      costMicroUsdTotal += result.usage.costMicroUsd;
      modelName = `${result.provider}/${result.model}`;
      routedBy.set(result.routedBy, (routedBy.get(result.routedBy) ?? 0) + 1);
      if (testCase.expectSkill.includes(result.skill)) {
        routedRight += 1;
      } else {
        routingMisses.push(`"${testCase.message}" -> ${result.skill} (via ${result.routedBy})`);
      }
      const first = called[0] ?? 'NONE';
      if (testCase.expect.includes(first)) {
        correct += 1;
      } else if (
        called.some((name) => testCase.expect.includes(name)) ||
        testCase.expect.includes('NONE')
      ) {
        // The system prompt tells the agent to read the plan before proposing a
        // change, so "read, then propose" is the correct behaviour even when the
        // proposal is not the first call.
        contains += 1;
      } else {
        misses.push(
          `"${testCase.message}" -> ${called.join(' -> ') || 'NONE'} (expected ${testCase.expect.join(' | ')})`,
        );
      }
    }
    const pct = (value: number) => `${((value / CASES.length) * 100).toFixed(0)}%`;
    const bySource = [...routedBy].map(([source, count]) => `${source} ${count}`).join(', ');
    console.log(
      `intent routed right:  ${routedRight}/${CASES.length} (${pct(routedRight)}) [${bySource}]`,
    );
    for (const miss of routingMisses) console.log(`  route miss: ${miss}`);
    console.log(`first tool correct:   ${correct}/${CASES.length} (${pct(correct)})`);
    console.log(
      `expected tool used:   ${correct + contains}/${CASES.length} (${pct(correct + contains)})`,
    );
    for (const miss of misses) console.log(`  miss: ${miss}`);

    // Cost and latency are part of the report because an agent that answers well
    // and takes two minutes per reply is not shippable.
    const median = (values: number[]) =>
      values.length === 0
        ? 0
        : [...values].sort((left, right) => left - right)[Math.floor(values.length / 2)]!;
    const p95 = (values: number[]) =>
      values.length === 0
        ? 0
        : [...values].sort((left, right) => left - right)[Math.ceil(values.length * 0.95) - 1]!;
    const seconds = (value: number) => `${(value / 1000).toFixed(1)}s`;
    const average = (values: number[]) =>
      values.length === 0
        ? 0
        : Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
    console.log(
      `latency (${modelName}): median ${seconds(median(latencies))}, p95 ${seconds(p95(latencies))}, ` +
        `first token median ${seconds(median(firstTokenLatencies))}`,
    );
    console.log(
      `tokens per answer: median ${median(tokensPerRun)}, mean ${average(tokensPerRun)} | ` +
        `input median ${median(inputTokensPerRun)}, output median ${median(outputTokensPerRun)} | ` +
        `cost per answer $${(costMicroUsdTotal / CASES.length / 1_000_000).toFixed(5)}, ` +
        `whole eval $${(costMicroUsdTotal / 1_000_000).toFixed(4)}`,
    );
  }

  // ----------------------------------------------------- 3. movement names
  console.log('\n== 3. movement resolution ==');
  const library = await db.exercise.findMany({
    where: { userId: user.id, category: { not: 'CARDIO' } },
    select: { id: true, name: true },
  });
  const displayed = library.map((entry) => ({
    ...entry,
    display: getExerciseDisplayName(entry.name, LOCALE),
  }));

  // Two rows can carry the same displayed name: the plan generator materializes
  // the movements it prescribes under its own catalog's wording ("Barbell Curl"),
  // next to the library's ("Barbell curl"). For the resolver that is one name
  // with two answers, so those rows are reported and excluded from the score
  // rather than counted as wrong answers.
  const rowsByDisplay = new Map<string, number>();
  for (const entry of displayed) {
    rowsByDisplay.set(entry.display, (rowsByDisplay.get(entry.display) ?? 0) + 1);
  }
  const collisions = [...rowsByDisplay].filter(([, count]) => count > 1);
  const scored = displayed.filter((entry) => rowsByDisplay.get(entry.display) === 1);
  console.log(`library rows: ${library.length}, distinct names: ${rowsByDisplay.size}`);
  if (collisions.length > 0) {
    console.log(
      `duplicate display names: ${collisions.length} (${collisions
        .map(([name, count]) => `${name} x${count}`)
        .join(', ')})`,
    );
  }

  const qualifiers = [
    '杠铃',
    '哑铃',
    '器械',
    '绳索',
    '坐姿',
    '站姿',
    '上斜',
    '下斜',
    '反向',
    '单腿',
    '单臂',
    '俯身',
    '借力',
    '辅助',
    '史密斯',
    '潘德利',
  ];

  function score(utterances: { spoken: string; expectedId: string }[], label: string): void {
    let resolved = 0;
    let refused = 0;
    const wrong: string[] = [];
    for (const { spoken, expectedId } of utterances) {
      const match = resolveExercise(library, spoken, LOCALE);
      if (!match) refused += 1;
      else if (match.id === expectedId) resolved += 1;
      else {
        const wanted = displayed.find((entry) => entry.id === expectedId);
        wrong.push(`"${spoken}" -> ${match.name} (wanted ${wanted?.name ?? expectedId})`);
      }
    }
    const total = utterances.length;
    const pct = (value: number) => `${((value / total) * 100).toFixed(1)}%`.padEnd(8);
    console.log(
      `${label.padEnd(24)}n=${String(total).padEnd(6)}resolved=${pct(resolved)}refused=${pct(refused)}wrong=${wrong.length}`,
    );
    // A wrong top-1 is only a candidate: the flow shows the resolved movement
    // to the trainee and writes nothing until they confirm it, so these are
    // printed rather than hidden.
    for (const sample of wrong.slice(0, 6)) console.log(`  wrong sample: ${sample}`);
  }

  score(
    scored.map((entry) => ({ spoken: entry.display, expectedId: entry.id })),
    'Chinese name',
  );
  score(
    scored.map((entry) => ({ spoken: entry.name, expectedId: entry.id })),
    'English name',
  );
  score(
    scored.flatMap((entry) => {
      const qualifier = qualifiers.find(
        (prefix) => entry.display.startsWith(prefix) && entry.display.length - prefix.length >= 2,
      );
      return qualifier
        ? [{ spoken: entry.display.slice(qualifier.length), expectedId: entry.id }]
        : [];
    }),
    'shortened phrasing',
  );

  // -------------------------------------------------------- 4. compaction
  if (WITH_MODEL) {
    console.log('\n== 4. long-thread compaction (live model) ==');
    const conversation = await db.agentConversation.create({
      data: { userId: user.id, title: 'agent-eval 压缩测试' },
      select: { id: true },
    });
    conversationsToClean.push(conversation.id);
    const filler = [
      '我今天练了硬拉，感觉腰有点紧，是不是动作不对？另外我这周只练了两次，是不是有点少？',
      '硬拉的时候腰不要塌，先确认杠铃贴着小腿、背部保持平直；如果腰在起始位置就有牵拉感，把重量降 10% 到 15%，把动作放慢，感觉不对就停下来。这周两次不算少，但两次之间要留出至少一天的间隔，下一次把上次没做的那一天补上就好，不要连着两天练同一个部位。',
      '中午吃的是鸡胸肉和米饭，晚上打算补点豆腐和青菜，这样一天够吗？',
      '今天的目标是 1900 千卡、蛋白质 130 克、脂肪 50 克、碳水 225 克。你中午大概补了 40 克蛋白质，晚上再用 150 克北豆腐加 100 克鸡胸，蛋白质就基本到位；碳水不用刻意压，训练日的碳水吃足反而更容易坚持。',
      '昨天只睡了 5 个半小时，今天训练要不要减量？',
      '睡眠不足的时候把当天的组数减掉三分之一，重量不要加，热身多做一组。今天的目标是 7 到 7.5 小时，今晚把就寝时间提前 45 分钟，把手机放在房间外面。连着两天睡不够，就把有氧换成一次快走，强度降到能正常说话的程度。',
    ];
    const started = Date.now() - 60 * 60_000;
    for (let index = 0; index < 60; index += 1) {
      await db.agentMessage.create({
        data: {
          conversationId: conversation.id,
          role: index % 2 === 0 ? 'USER' : 'ASSISTANT',
          content: filler[index % filler.length]!,
          createdAt: new Date(started + index * 60_000),
        },
      });
    }
    const before = await db.agentMessage.findMany({
      where: { conversationId: conversation.id },
      select: { content: true },
    });
    const foldedCount = before.length - COMPACTION_KEEP_RECENT;
    const foldedChars = before
      .slice(0, foldedCount)
      .reduce((total, message) => total + message.content.length, 0);

    console.log(
      `shouldCompact(60) = ${shouldCompact(60)}   keepRecent = ${COMPACTION_KEEP_RECENT}`,
    );
    const result = await compactConversation(user.id, conversation.id);
    const after = await db.agentConversation.findUniqueOrThrow({
      where: { id: conversation.id },
      select: { contextSummary: true },
    });
    const digest = after.contextSummary ?? '';
    const reduction = ((1 - digest.length / foldedChars) * 100).toFixed(1);
    console.log(
      `compacted=${result.compacted} folded=${result.folded} digest=${digest.length} chars`,
    );
    console.log(
      `folded history: ${foldedChars} chars -> digest ${digest.length} chars (-${reduction}%)`,
    );
    console.log(`transcript rows kept: ${before.length} (nothing deleted)`);

    // The eval conversations are scaffolding, not the trainee's history.
    await db.agentConversation.deleteMany({ where: { id: { in: conversationsToClean } } });
  }

  // Part 1 calls every tool, including the three that propose something. Those
  // proposals belong to the evaluation, not to whoever owns the account, so the
  // harness takes them back out.
  await db.agentLogProposal.deleteMany({
    where: { userId: user.id, createdAt: { gte: evaluationStartedAt } },
  });
  await db.agentPlanProposal.deleteMany({
    where: { userId: user.id, createdAt: { gte: evaluationStartedAt } },
  });
  await db.agentMemory.deleteMany({
    where: { userId: user.id, status: 'PENDING', createdAt: { gte: evaluationStartedAt } },
  });

  await db.$disconnect();
}

// Vitest is the runner because the agent runtime's dependency (@earendil-works/
// pi-agent-core) ships as ESM only: a plain tsx script cannot load it, while
// vitest already resolves it for the agent unit tests.
describe('agent evaluation', () => {
  it('prints the report', async () => {
    await main();
  }, 1_800_000);
});
