import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { db } from '@/lib/db';

const migrationPath = path.join(
  process.cwd(),
  'prisma',
  'migrations',
  '20260914010000_add_fitness_planning_foundation',
  'migration.sql',
);

describe('fitness planning persistence schema', () => {
  it('creates the versioned fitness planning tables', async () => {
    const tables = await db.$queryRaw<Array<{ name: string; relation: string | null }>>`
      SELECT name, to_regclass(format('%I', name))::text AS relation
      FROM (
        VALUES
          ('FitnessProfile'),
          ('HealthScreening'),
          ('FitnessGoal'),
          ('FitnessPlanVersion'),
          ('FitnessPlanActivation')
      ) AS expected(name)
      ORDER BY name
    `;

    expect(tables.filter(({ relation }) => relation === null).map(({ name }) => name)).toEqual([]);
  });

  it('enforces the fitness profile, plan version, and activation identities', async () => {
    const constraints = await db.$queryRaw<
      Array<{ tableName: string; constraintType: string; columns: string[] }>
    >`
      SELECT
        table_info.relname AS "tableName",
        constraint_info.contype::text AS "constraintType",
        array_agg(attribute_info.attname ORDER BY constraint_column.ordinality)::text[] AS columns
      FROM pg_constraint AS constraint_info
      JOIN pg_class AS table_info
        ON table_info.oid = constraint_info.conrelid
      JOIN pg_namespace AS schema_info
        ON schema_info.oid = table_info.relnamespace
      JOIN LATERAL unnest(constraint_info.conkey) WITH ORDINALITY
        AS constraint_column(attnum, ordinality) ON true
      JOIN pg_attribute AS attribute_info
        ON attribute_info.attrelid = constraint_info.conrelid
        AND attribute_info.attnum = constraint_column.attnum
      WHERE schema_info.nspname = 'public'
        AND table_info.relname IN (
          'FitnessProfile',
          'FitnessPlanVersion',
          'FitnessPlanActivation'
        )
        AND constraint_info.contype IN ('p', 'u')
      GROUP BY table_info.relname, constraint_info.contype, constraint_info.conname
    `;
    const signatures = constraints.map(
      ({ tableName, constraintType, columns }) =>
        `${tableName}:${constraintType}:${columns.join(',')}`,
    );

    expect(signatures).toEqual(
      expect.arrayContaining([
        'FitnessProfile:u:userId',
        'FitnessPlanVersion:u:userId,version',
        'FitnessPlanVersion:u:programId',
        'FitnessPlanActivation:p:userId',
        'FitnessPlanActivation:u:planVersionId',
      ]),
    );
  });

  it('adds the onboarding and program exercise planning columns', async () => {
    const columns = await db.$queryRaw<Array<{ tableName: string; columnName: string }>>`
      SELECT table_name AS "tableName", column_name AS "columnName"
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND (
          (table_name = 'User' AND column_name = 'fitnessOnboardingRequired')
          OR
          (table_name = 'ProgramExercise' AND column_name IN (
            'initialLoadKg',
            'initialLoadSource',
            'progressionRuleVersion',
            'introTargetRIR',
            'introEndsAt'
          ))
        )
    `;
    const signatures = columns.map(({ tableName, columnName }) => `${tableName}.${columnName}`);

    expect(signatures).toEqual(
      expect.arrayContaining([
        'User.fitnessOnboardingRequired',
        'ProgramExercise.initialLoadKg',
        'ProgramExercise.initialLoadSource',
        'ProgramExercise.progressionRuleVersion',
        'ProgramExercise.introTargetRIR',
        'ProgramExercise.introEndsAt',
      ]),
    );
    expect(signatures).toHaveLength(6);
  });

  it('requires fitness onboarding for users created after the migration', async () => {
    const user = await db.user.create({
      data: {
        email: 'fitness-schema@example.com',
        passwordHash: 'test-password-hash',
      },
    });
    const [storedUser] = await db.$queryRaw<Array<{ fitnessOnboardingRequired: boolean }>>`
      SELECT "fitnessOnboardingRequired"
      FROM "User"
      WHERE id = ${user.id}
    `;

    expect(storedUser?.fitnessOnboardingRequired).toBe(true);
  });

  it('backfills existing users only after adding the onboarding column', async () => {
    const migration = await readFile(migrationPath, 'utf8');
    const addColumnStatement =
      'ALTER TABLE "User" ADD COLUMN "fitnessOnboardingRequired" BOOLEAN NOT NULL DEFAULT true;';
    const backfillStatement = 'UPDATE "User" SET "fitnessOnboardingRequired" = false;';

    expect(migration.indexOf(addColumnStatement)).toBeGreaterThanOrEqual(0);
    expect(migration.indexOf(backfillStatement)).toBeGreaterThan(
      migration.indexOf(addColumnStatement),
    );
  });
});
