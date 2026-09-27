'use client';

import { useLocale, useTranslations } from 'next-intl';
import type { FitnessPlanContent } from '@/lib/fitness/plan-schema';
import type { PlainLanguageEnergy } from '@/lib/fitness/pace';
import { foodEquivalent } from '@/lib/fitness/pace';
import { CONVENIENCE_OPTIONS } from '@/lib/fitness/meal-plan';
import { closestFood, formatPortion, type FoodPortion } from '@/lib/fitness/food-equivalents';
import { langFromLocale } from '@/lib/fitness/food-names';

// ============================================================
// The parts of a plan that are not the workout
// ============================================================
// What to eat, how much cardio and how much sleep are prescribed by the same
// stored plan as the training days, so both screens that show a plan - the
// preview before activation and the plan screen afterwards - render them from
// one place. Duplicating them is how the nutrition block went missing from the
// screen a trainee actually looks at every day.

export function PlanLifestyleSections({
  content,
  energy,
}: {
  content: FitnessPlanContent;
  // The same targets said in plain language (kilograms per month, and what the
  // daily difference is worth in food). Absent when the stored input cannot be
  // read; the numbers above still render.
  energy?: PlainLanguageEnergy | null;
}) {
  const t = useTranslations('fitness');
  const lang = langFromLocale(useLocale());
  const calories = content.nutrition.caloriesKcal;
  const equalCalories = calories.min === calories.max;

  return (
    <>
      <section className="flex flex-col gap-2 border-t border-border pt-4">
        <h2 className="text-sm font-medium">{t('plan.sections.nutrition')}</h2>
        <p className="text-sm">
          {equalCalories
            ? t('plan.nutrition.singleCalories', { value: calories.min })
            : t('plan.nutrition.calories', { min: calories.min, max: calories.max })}
        </p>
        {!equalCalories && (
          <p className="text-xs text-muted-foreground">{t('notes.energyReferenceRange')}</p>
        )}
        <p className="text-sm text-muted-foreground">
          {t('plan.nutrition.macros', {
            protein: formatRange(content.nutrition.proteinG, 'g'),
            fat: formatRange(content.nutrition.fatG, 'g'),
            carbs: formatRange(content.nutrition.carbsG, 'g'),
          })}
        </p>
        <p className="text-xs text-muted-foreground">{t('plan.nutrition.sameTargetEveryDay')}</p>
        {energy ? (
          <p className="text-sm">
            {energy.direction === 'MAINTAIN'
              ? t('plan.nutrition.plainMaintain')
              : t(
                  energy.direction === 'LOSE'
                    ? 'plan.nutrition.plainLose'
                    : 'plan.nutrition.plainGain',
                  {
                    kg: energy.monthlyChangeKg,
                    kcal: Math.abs(energy.deficitKcal),
                    rice: foodEquivalent(energy.deficitKcal).riceBowls,
                  },
                )}
          </p>
        ) : null}
        {content.nutrition.meals ? (
          <div className="mt-1 flex flex-col gap-3 border-t border-border pt-3">
            <div>
              <h3 className="text-xs font-medium">{t('plan.nutrition.mealsTitle')}</h3>
              <p className="text-xs text-muted-foreground">{t('plan.nutrition.mealsNote')}</p>
            </div>
            <ul className="flex flex-col gap-3">
              {content.nutrition.meals.map((meal) => {
                const plate = describePlate(lang, meal);
                const convenience = CONVENIENCE_OPTIONS[meal.key];
                return (
                  <li key={meal.key} className="flex flex-col gap-1">
                    <p className="text-sm font-medium">{t(`plan.nutrition.meals.${meal.key}`)}</p>
                    <p className="text-xs text-muted-foreground">
                      {t('plan.nutrition.mealLine', {
                        calories: formatRange(meal.caloriesKcal, ''),
                        protein: formatRange(meal.proteinG, ''),
                        carbs: formatRange(meal.carbsG, ''),
                        fat: formatRange(meal.fatG, ''),
                      })}
                    </p>
                    {plate ? (
                      <p className="text-sm">{t('plan.nutrition.mealExample', { plate })}</p>
                    ) : null}
                    <p className="text-xs text-muted-foreground">
                      {t('plan.nutrition.mealNoTime', { option: convenience[lang] })}
                    </p>
                  </li>
                );
              })}
            </ul>
            <p className="text-xs text-muted-foreground">{t('plan.nutrition.mealsFlexible')}</p>
          </div>
        ) : null}
      </section>

      <section className="flex flex-col gap-2 border-t border-border pt-4">
        <h2 className="text-sm font-medium">{t('plan.sections.cardio')}</h2>
        <p className="text-sm">
          {content.cardio.sessions.length === 0
            ? t('plan.cardio.maintain')
            : t('plan.cardio.summary', { minutes: content.cardio.additionalWeeklyMin })}
        </p>
        {content.cardio.sessions.length > 0 && (
          <>
            <p className="text-sm text-muted-foreground">{t('plan.cardio.intensity')}</p>
            <p className="text-sm text-muted-foreground">{t('plan.cardio.talkTest')}</p>
            <p className="text-sm text-muted-foreground">{t('plan.cardio.lowImpact')}</p>
            <p className="text-sm text-muted-foreground">{t('plan.cardio.strengthFirst')}</p>
          </>
        )}
      </section>

      <section className="flex flex-col gap-2 border-t border-border pt-4">
        <h2 className="text-sm font-medium">{t('plan.sections.sleep')}</h2>
        <p className="text-sm">
          {t('plan.sleep.target', { hours: formatHours(content.sleep.initialTargetMin) })}
        </p>
        <p className="text-sm text-muted-foreground">
          {t('plan.sleep.bedtime', { time: formatClock(content.sleep.suggestedBedtimeMin) })}
        </p>
        <p className="text-xs text-muted-foreground">{t('plan.sleep.onsetBuffer')}</p>
        <p className="text-xs text-muted-foreground">{t('plan.sleep.longTerm')}</p>
      </section>
    </>
  );
}

export function formatRange(range: { min: number; max: number }, suffix: string): string {
  return range.min === range.max ? `${range.min}${suffix}` : `${range.min}-${range.max}${suffix}`;
}

// One concrete plate for a meal, built from the midpoint of each macro range.
// Seeing "about 3 eggs + 1 bowl of rice + 1.5 handfuls of nuts" is the point of
// the whole section: the grams above it are the target, this is what it looks
// like on a table.
function describePlate(
  lang: ReturnType<typeof langFromLocale>,
  meal: {
    key: 'BREAKFAST' | 'LUNCH' | 'TRAINING' | 'DINNER';
    proteinG: { min: number; max: number };
    carbsG: { min: number; max: number };
    fatG: { min: number; max: number };
  },
): string | null {
  const midpoint = (range: { min: number; max: number }) => (range.min + range.max) / 2;
  const parts = [
    closestFood('protein', midpoint(meal.proteinG), lang, meal.key),
    closestFood('carbs', midpoint(meal.carbsG), lang, meal.key),
    closestFood('fat', midpoint(meal.fatG), lang, meal.key),
  ].flatMap((portion: FoodPortion | null) => (portion ? [formatPortion(portion, lang)] : []));
  return parts.length > 0 ? parts.join(lang === 'zh' ? ' ＋ ' : ' + ') : null;
}

function formatHours(minutes: number): string {
  return (minutes / 60).toFixed(minutes % 60 === 0 ? 0 : 1);
}

function formatClock(minutes: number): string {
  const hours = Math.floor(minutes / 60) % 24;
  return `${String(hours).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}
