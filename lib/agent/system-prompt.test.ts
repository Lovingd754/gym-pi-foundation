import { describe, expect, it } from 'vitest';
import { AGENT_SKILL_PROMPTS, FITNESS_AGENT_SYSTEM_PROMPT, skillPrompt } from './system-prompt';
import { buildSystemPrompt } from './system-prompt';

describe('FITNESS_AGENT_SYSTEM_PROMPT', () => {
  it('states the read-only and calculation boundaries', () => {
    expect(FITNESS_AGENT_SYSTEM_PROMPT).toContain('Never claim that a proposal is active');
    expect(FITNESS_AGENT_SYSTEM_PROMPT).toContain('Do not calculate prescriptions');
    expect(FITNESS_AGENT_SYSTEM_PROMPT).toContain('Reading tools are read-only');
  });

  it('separates proposing a memory from having one', () => {
    expect(FITNESS_AGENT_SYSTEM_PROMPT).toContain('A proposal is not a memory');
    expect(FITNESS_AGENT_SYSTEM_PROMPT).toContain('never that you have remembered it');
  });

  it('tells the model to answer in the trainee language and not to invent missing facts', () => {
    expect(FITNESS_AGENT_SYSTEM_PROMPT).toContain('answer in the language the trainee writes in');
    expect(FITNESS_AGENT_SYSTEM_PROMPT).toContain('say when something is missing');
  });
});

describe('skill prompts', () => {
  // The capability rules moved out of the base prompt so a turn only carries the
  // rules it is about. These are the promises that must survive the move.
  it('keeps the plan rules with the plan skill', () => {
    expect(AGENT_SKILL_PROMPTS.plan).toContain('Read the plan before proposing anything about it');
    expect(AGENT_SKILL_PROMPTS.plan).toContain(
      'that request ends with a proposal from propose_plan_change in the same answer',
    );
  });

  it('keeps the logging rules with the log skill', () => {
    expect(AGENT_SKILL_PROMPTS.log).toContain('prepare them with log_workout');
    expect(AGENT_SKILL_PROMPTS.log).toContain('ask instead of guessing');
  });

  it('says less for one skill than for the fallback', () => {
    const log = skillPrompt('log');
    const general = skillPrompt('general');

    expect(log.startsWith(FITNESS_AGENT_SYSTEM_PROMPT)).toBe(true);
    expect(log).toContain(AGENT_SKILL_PROMPTS.log);
    expect(log).not.toContain(AGENT_SKILL_PROMPTS.plan);
    // The fallback carries every rule: it must never be the thinner agent.
    for (const fragment of Object.values(AGENT_SKILL_PROMPTS)) {
      expect(general).toContain(fragment);
    }
    expect(general.length).toBeGreaterThan(log.length);
  });
});

describe('buildSystemPrompt', () => {
  it('is the fallback prompt when nothing else is known and nothing was routed', () => {
    expect(buildSystemPrompt(null, [])).toBe(skillPrompt('general'));
  });

  it('carries the routed skill rules', () => {
    expect(buildSystemPrompt(null, [], 'log')).toContain(AGENT_SKILL_PROMPTS.log);
    expect(buildSystemPrompt(null, [], 'plan')).toContain(AGENT_SKILL_PROMPTS.plan);
  });

  it('carries confirmed memories into every conversation', () => {
    const prompt = buildSystemPrompt(null, ['膝盖怕深蹲', '只在午休健身']);

    expect(prompt).toContain('膝盖怕深蹲');
    expect(prompt).toContain('只在午休健身');
    expect(prompt).toContain('Use them without being asked');
    expect(prompt).toContain('never claim to remember something that is not on this list');
  });

  it('keeps the memories and the compressed digest apart', () => {
    const prompt = buildSystemPrompt('The trainee is cutting.', ['不喜欢有氧']);

    expect(prompt).toContain('# What the trainee has asked you to remember');
    expect(prompt).toContain('# Earlier in this conversation (compressed)');
    expect(prompt.indexOf('不喜欢有氧')).toBeLessThan(prompt.indexOf('The trainee is cutting.'));
  });
});
