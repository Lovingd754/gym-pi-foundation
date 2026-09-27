import { describe, expect, it } from 'vitest';
import { ALWAYS_AVAILABLE_TOOLS, SKILL_LABELS, toolsForSkill } from './skills';

describe('skills', () => {
  it('always offers the read tools and the note-to-self tool', () => {
    // A misroute has to cost context, not capability: every skill can still read
    // the plan, the history and the memories.
    for (const skill of ['log', 'plan', 'review', 'general'] as const) {
      for (const tool of ALWAYS_AVAILABLE_TOOLS) {
        expect(toolsForSkill(skill)).toContain(tool);
      }
    }
  });

  it('gates the two tools that touch real data', () => {
    // log_workout and propose_plan_change are the only tools that can end up
    // writing something the trainee cares about, so the skill decides.
    expect(toolsForSkill('log')).toContain('log_workout');
    expect(toolsForSkill('log')).not.toContain('propose_plan_change');

    expect(toolsForSkill('plan')).toContain('propose_plan_change');
    expect(toolsForSkill('plan')).not.toContain('log_workout');

    expect(toolsForSkill('review')).not.toContain('log_workout');
    expect(toolsForSkill('review')).not.toContain('propose_plan_change');

    // The fallback is the agent as it was before skills existed.
    expect(toolsForSkill('general')).toContain('log_workout');
    expect(toolsForSkill('general')).toContain('propose_plan_change');
    expect(toolsForSkill('general')).toHaveLength(6);
  });

  it('gives every skill a label the interface can show', () => {
    expect(SKILL_LABELS.log).toBeTruthy();
    expect(SKILL_LABELS.plan).toBeTruthy();
    expect(SKILL_LABELS.review).toBeTruthy();
    expect(SKILL_LABELS.general).toBeTruthy();
  });
});
