import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import catalog from '@/data/exercise-media.json';
import { exerciseMediaCoverage, getExerciseMedia } from './exercise-media';
import { EXERCISE_CATALOG } from './exercise-catalog';
import { STRENGTH_EXERCISE_CATALOG } from '@/lib/fitness/exercise-catalog';

function normalize(name: string): string {
  return name.trim().toLocaleLowerCase('en-US');
}

describe('exercise media catalog', () => {
  // The library is deliberately wider than the demo-frame dataset: 132
  // movements against 82 pairs of frames. So the invariant is not "every
  // catalog entry has frames" (the dialog falls back to a Commons search for
  // the ones that do not) but "every frame is attached to a movement that
  // exists" - a mapping for a name nothing resolves to is dead weight that
  // silently never shows.
  it('maps every pair of frames to a movement the library actually has', () => {
    const mapped = catalog.groups.flatMap((group) => group.names);
    expect(mapped.length).toBeGreaterThanOrEqual(80);
    const library = new Set(
      [
        ...EXERCISE_CATALOG.map((exercise) => exercise.name),
        // The plan generator prescribes from its own catalog and names some
        // movements differently ("Standing cable curl (straight bar)").
        ...STRENGTH_EXERCISE_CATALOG.flatMap((entry) => [entry.name, ...entry.aliases]),
      ].map(normalize),
    );
    // The "A · B" wording is what imported workouts call a movement (Alpha
    // Progression, Hevy, Strong); those names are translated in
    // i18n/exercise-names.ts rather than seeded, so they are exempt.
    const orphans = mapped.filter((name) => !library.has(normalize(name)) && !name.includes('·'));
    expect(orphans).toEqual([]);
  });

  it('keeps demo frames for most of the default library', () => {
    const { covered } = exerciseMediaCoverage(EXERCISE_CATALOG.map((exercise) => exercise.name));
    expect(covered.length).toBeGreaterThanOrEqual(100);
  });

  // Two groups claiming one name is not an error the lookup reports: the first
  // one wins and the second silently never shows.
  it('claims each movement name once', () => {
    const owner = new Map<string, string>();
    const duplicates: string[] = [];
    for (const group of catalog.groups) {
      for (const name of group.names) {
        const key = normalize(name);
        const previous = owner.get(key);
        if (previous) duplicates.push(`${name}: ${previous} and ${group.datasetId}`);
        else owner.set(key, group.datasetId);
      }
    }
    expect(duplicates).toEqual([]);
  });

  // A name listed as a variant that the group does not otherwise list is a typo
  // that would quietly do nothing.
  it('only flags variants the group lists', () => {
    const stray: string[] = [];
    for (const group of catalog.groups) {
      const own = new Set(group.names.map(normalize));
      const flagged = 'approximateNames' in group ? (group.approximateNames ?? []) : [];
      for (const name of flagged) {
        if (!own.has(normalize(name))) stray.push(`${name} (${group.datasetId})`);
      }
    }
    expect(stray).toEqual([]);
  });

  // A group's frames show one movement. A close variant listed in the group is
  // flagged on its own, so the movement the frames really show is not labelled
  // "similar variant" alongside it.
  it('flags a variant without flagging the movement the frames show', () => {
    expect(getExerciseMedia('EZ-bar curl')?.approximate).toBe(false);
    expect(getExerciseMedia('Barbell curl')?.approximate).toBe(true);
    expect(getExerciseMedia('Squats · Barbell')?.approximate).toBe(false);
    expect(getExerciseMedia('Front squat')?.approximate).toBe(true);
  });

  it('keeps both local frames for every mapped dataset exercise', () => {
    for (const group of catalog.groups) {
      for (const frame of ['0.jpg', '1.jpg']) {
        expect(
          fs.existsSync(
            path.join(
              process.cwd(),
              'public',
              'exercise-media',
              'free-exercise-db',
              group.datasetId,
              frame,
            ),
          ),
        ).toBe(true);
      }
    }
  });

  it('returns null for an unknown custom exercise', () => {
    expect(getExerciseMedia('A future custom movement')).toBeNull();
  });
});
