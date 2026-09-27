import { describe, expect, it } from 'vitest';

import { fitnessDashboardEntryTarget, resolveFitnessDashboardEntry } from './dashboard-entry';

describe('resolveFitnessDashboardEntry', () => {
  it('redirects a new account that still requires onboarding', () => {
    expect(
      resolveFitnessDashboardEntry({
        onboardingRequired: true,
        hasProfile: false,
        hasActivePlan: false,
      }),
    ).toBe('REQUIRED_REDIRECT');
  });

  it('offers an optional call to action to a backfilled existing user', () => {
    expect(
      resolveFitnessDashboardEntry({
        onboardingRequired: false,
        hasProfile: false,
        hasActivePlan: false,
      }),
    ).toBe('CREATE');
  });

  it('offers to continue when a profile exists without an active plan', () => {
    expect(
      resolveFitnessDashboardEntry({
        onboardingRequired: false,
        hasProfile: true,
        hasActivePlan: false,
      }),
    ).toBe('CONTINUE');
    // A required-onboarding account that already saved an assessment still
    // continues the flow rather than being redirected again.
    expect(
      resolveFitnessDashboardEntry({
        onboardingRequired: true,
        hasProfile: true,
        hasActivePlan: false,
      }),
    ).toBe('CONTINUE');
  });

  it('offers to review when a personalized plan is active', () => {
    expect(
      resolveFitnessDashboardEntry({
        onboardingRequired: false,
        hasProfile: true,
        hasActivePlan: true,
      }),
    ).toBe('REVIEW');
  });

  it('still offers the optional action once onboarding is dismissed', () => {
    const state = resolveFitnessDashboardEntry({
      onboardingRequired: false,
      hasProfile: false,
      hasActivePlan: false,
    });
    // A backfilled account is never redirected, but the compact call to action
    // stays available.
    expect(state).toBe('CREATE');
    expect(fitnessDashboardEntryTarget(state)).toEqual({
      href: '/fitness/setup',
      labelKey: 'actions.ctaCreate',
    });
  });
});

describe('fitnessDashboardEntryTarget', () => {
  it('points each call to action at the right destination', () => {
    expect(fitnessDashboardEntryTarget('REQUIRED_REDIRECT')).toBeNull();
    expect(fitnessDashboardEntryTarget('CREATE')).toEqual({
      href: '/fitness/setup',
      labelKey: 'actions.ctaCreate',
    });
    expect(fitnessDashboardEntryTarget('CONTINUE')).toEqual({
      href: '/fitness/setup',
      labelKey: 'actions.ctaContinue',
    });
    expect(fitnessDashboardEntryTarget('REVIEW')).toEqual({
      href: '/fitness/plans',
      labelKey: 'actions.ctaReview',
    });
  });
});
