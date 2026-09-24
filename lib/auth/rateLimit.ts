const MAX_ATTEMPTS = 5;
/** Cap on failures across all clients combined, for callers that rotate
 *  their claimed address to dodge the per-client limit. */
export const GLOBAL_MAX_ATTEMPTS = 20;
const LOCKOUT_MS = 15 * 60 * 1000; // 15 minutes
const WINDOW_MS = 10 * 60 * 1000; // failures older than this don't count toward the limit

interface Entry {
  count: number;
  firstAttemptAt: number;
  lockedUntil: number;
}

const attempts = new Map<string, Entry>();

function sweep() {
  const now = Date.now();
  for (const [key, entry] of attempts) {
    if (entry.lockedUntil < now && now - entry.firstAttemptAt > WINDOW_MS) attempts.delete(key);
  }
}

export function isLockedOut(key: string): { locked: boolean; retryAfterMs: number } {
  const entry = attempts.get(key);
  if (!entry || entry.lockedUntil <= Date.now()) return { locked: false, retryAfterMs: 0 };
  return { locked: true, retryAfterMs: entry.lockedUntil - Date.now() };
}

export function recordLoginFailure(key: string, maxAttempts = MAX_ATTEMPTS): void {
  sweep();
  const now = Date.now();
  const entry = attempts.get(key);
  if (!entry || now - entry.firstAttemptAt > WINDOW_MS) {
    attempts.set(key, { count: 1, firstAttemptAt: now, lockedUntil: 0 });
    return;
  }
  entry.count += 1;
  if (entry.count >= maxAttempts) {
    entry.lockedUntil = now + LOCKOUT_MS;
  }
}

export function recordLoginSuccess(key: string): void {
  attempts.delete(key);
}
