import type { Prisma } from '@/prisma/generated/client';
export async function lockFitnessUser(tx: Prisma.TransactionClient, userId: string): Promise<void> {
  const key = `fitness-user:${userId}`;
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))::text`;
}
