// ============================================================
// Dashboard entry point for the personalized flow
// ============================================================
// Gradual rollout has four states, and they must be decided by pure data so the
// rule is testable without a database or a request:
//
// - REQUIRED_REDIRECT: a brand-new account that has never finished (or skipped)
//   the assessment is taken straight to setup on its first dashboard load.
// - CREATE: an existing account backfilled with optional onboarding, no profile
//   yet - show a compact call to action instead of forcing navigation.
// - CONTINUE: a profile exists but no plan is ACTIVE yet (including a blocked
//   safety outcome): offer to finish the flow.
// - REVIEW: an active personalized plan exists: offer to review it and its
//   retained history.
//
export type FitnessDashboardEntryState = 'REQUIRED_REDIRECT' | 'CREATE' | 'CONTINUE' | 'REVIEW';

export interface FitnessDashboardEntryInput {
  onboardingRequired: boolean;
  hasProfile: boolean;
  hasActivePlan: boolean;
}

export function resolveFitnessDashboardEntry(
  input: FitnessDashboardEntryInput,
): FitnessDashboardEntryState {
  if (!input.hasProfile) {
    if (input.onboardingRequired) return 'REQUIRED_REDIRECT';
    return 'CREATE';
  }
  return input.hasActivePlan ? 'REVIEW' : 'CONTINUE';
}

// Where the corresponding call to action points, and which copy it uses. Kept
// next to the decision so the page cannot drift from the resolver.
export type FitnessDashboardEntryTarget = {
  href: '/fitness/setup' | '/fitness/plans';
  labelKey: 'actions.ctaCreate' | 'actions.ctaContinue' | 'actions.ctaReview';
};

export function fitnessDashboardEntryTarget(
  state: FitnessDashboardEntryState,
): FitnessDashboardEntryTarget | null {
  switch (state) {
    case 'CREATE':
      return { href: '/fitness/setup', labelKey: 'actions.ctaCreate' };
    case 'CONTINUE':
      return { href: '/fitness/setup', labelKey: 'actions.ctaContinue' };
    case 'REVIEW':
      return { href: '/fitness/plans', labelKey: 'actions.ctaReview' };
    default:
      return null;
  }
}
