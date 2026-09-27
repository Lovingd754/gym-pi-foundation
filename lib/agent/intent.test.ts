import { describe, expect, it } from 'vitest';
import { routeByRules, routeIntent } from './intent';

describe('routeByRules', () => {
  it('reads a change request as a plan turn', () => {
    expect(routeByRules('把周三的训练挪到周四。')?.skill).toBe('plan');
    expect(routeByRules('有氧太多了，减到每周 60 分钟。')?.skill).toBe('plan');
    expect(routeByRules('把深蹲换成腿举吧。')?.skill).toBe('plan');
    expect(routeByRules('我膝盖不太好，深蹲尽量换成别的。')?.skill).toBe('plan');
    expect(routeByRules('明天要出差三天，训练怎么办？')?.skill).toBe('plan');
  });

  it('reads a described set as a logging turn', () => {
    expect(routeByRules('卧推 60 公斤 8 次，做了 3 组。')?.skill).toBe('log');
    expect(routeByRules('刚刚做了 5 组引体向上，每组 8 个，自重。')?.skill).toBe('log');
  });

  it('does not read a bodyweight report as a set', () => {
    // "我体重 71 公斤" carries a number and a unit, like a set does. It is not
    // one, and logging it as one would be a wrong write.
    expect(routeByRules('我体重 71 公斤。')?.skill).toBe('review');
    expect(routeByRules('腰围 82 厘米。')?.skill).toBe('review');
  });

  it('reads a question as a review turn', () => {
    expect(routeByRules('我今天该练什么？')?.skill).toBe('review');
    expect(routeByRules('我上次练了什么？')?.skill).toBe('review');
    expect(routeByRules('这个计划里深蹲安排几组？')?.skill).toBe('review');
    expect(routeByRules('你还记得我什么？')?.skill).toBe('review');
    // A question that contains a reported verb and a number is still a question.
    expect(routeByRules('上周我一共练了几次？')?.skill).toBe('review');
    expect(routeByRules('昨天练了多久？')?.skill).toBe('review');
  });

  it('treats pleasantries as review turns without asking a model', () => {
    // Small talk is the one case where the free path also saves a model call.
    expect(routeByRules('谢谢！')?.skill).toBe('review');
    expect(routeByRules('你好。')?.skill).toBe('review');
    expect(routeByRules('ok')?.skill).toBe('review');
  });

  it('says nothing when the message is not obviously one thing', () => {
    expect(routeByRules('我最近状态不太行')).toBeNull();
    expect(routeByRules('记住我不喜欢跑步。')).toBeNull();
    expect(routeByRules('')).toBeNull();
  });
});

describe('routeIntent', () => {
  it('does not call a model when a rule matched', async () => {
    let called = 0;
    const route = await routeIntent('把周三挪到周四。', {
      dependencies: {
        async classify() {
          called += 1;
          return { intent: 'log' };
        },
      },
    });

    expect(route).toMatchObject({ skill: 'plan', source: 'RULE' });
    expect(called).toBe(0);
  });

  it('asks a model only when no rule matched', async () => {
    const route = await routeIntent('我最近状态不太行', {
      dependencies: {
        async classify() {
          return { intent: 'review', reason: 'asking about self' };
        },
      },
    });

    expect(route).toMatchObject({ skill: 'review', source: 'MODEL' });
  });

  it('falls back to every tool and every rule when the classifier fails', async () => {
    const route = await routeIntent('我最近状态不太行', {
      dependencies: {
        async classify() {
          return null;
        },
      },
    });
    expect(route).toMatchObject({ skill: 'general', source: 'FALLBACK' });
  });

  it('ignores a classifier that answers something unusable', async () => {
    const route = await routeIntent('我最近状态不太行', {
      dependencies: {
        async classify() {
          return { intent: 'not-a-skill' };
        },
      },
    });
    expect(route).toMatchObject({ skill: 'general', source: 'FALLBACK' });
  });

  it('survives a provider that throws', async () => {
    const route = await routeIntent('我最近状态不太行', {
      dependencies: {
        async classify() {
          throw new Error('provider down');
        },
      },
    });
    expect(route).toMatchObject({ skill: 'general', source: 'FALLBACK' });
  });
});
