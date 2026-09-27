import { db } from '@/lib/db';
import { EXERCISE_CATALOG_VERSION, syncExerciseCatalog } from '@/lib/exercise-catalog';

// ============================================================
// Keeping an existing account's library up to date
// ============================================================
// The default catalog is seeded once, at registration. Without this, every
// account created before a catalog addition would keep the library it was
// born with, and "the library is missing movements" would be permanent for
// exactly the accounts that have been around longest.
//
// So: the version of the catalog an account was last synced from is stored on
// the user row. These helpers compare it with the shipped version and, when it
// is behind, add the missing movements once. It is called from every screen
// that displays the trainee's exercises and from the chat's logging path, so
// asking for a movement in the conversation works for a freshly added entry
// too.
//
// A process-level memo keeps the check to a single query per user per server
// process rather than one per page view; a restart simply re-checks.

const synced = new Set<string>();

export async function ensureExerciseCatalog(userId: string): Promise<void> {
  if (synced.has(userId)) return;

  try {
    const user = await db.user.findUnique({
      where: { id: userId },
      select: { exerciseCatalogVersion: true },
    });
    if (user && user.exerciseCatalogVersion < EXERCISE_CATALOG_VERSION) {
      const added = await syncExerciseCatalog(db, userId);
      if (added > 0) {
        console.info(`[exercise-catalog] added ${added} movements to user ${userId}`);
      }
    }
  } catch (error) {
    // A stale library is a much smaller problem than a page that will not
    // load. Left un-memoized on purpose, so the next request tries again.
    console.error('[exercise-catalog] sync failed:', error);
    return;
  }
  synced.add(userId);
}

// Test seam: the memo is per process, and a test that flips the stored version
// between cases needs the check to run again.
export function resetExerciseCatalogSyncMemo(): void {
  synced.clear();
}
