/** Resolves after `ms` milliseconds. */
export const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Serialises callers so successive awaits resolve at least `intervalMs` apart,
 * keeping a whole process under a provider's rate limit.
 */
export function createThrottle(intervalMs: number): () => Promise<void> {
  let nextAt = 0;
  return async () => {
    const now = Date.now();
    const wait = Math.max(0, nextAt - now);
    nextAt = Math.max(now, nextAt) + intervalMs;
    if (wait > 0) await sleep(wait);
  };
}
