import { after } from 'next/server';

/**
 * Runs `task` once the response has been sent (Next's after(), which keeps a serverless function alive for it), so
 * work like filling the shared cache never delays the user. Outside a request (scripts, in-process tests) there is no
 * such scope: the task just runs. It must never throw into the caller.
 */
export function afterResponse(task: () => Promise<unknown>): void {
  const safe = () => task().catch((err) => console.error('[after-response]', (err as Error).message));
  try {
    after(safe);
  } catch {
    void safe();
  }
}
