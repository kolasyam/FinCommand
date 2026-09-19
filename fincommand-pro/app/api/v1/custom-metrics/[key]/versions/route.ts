import type { NextRequest } from 'next/server';
import { authenticate } from '@/lib/auth/permissions';
import { withErrorHandling, json } from '@/lib/utils/api-handler';
import { listCustomMetricVersions } from '@/lib/db/queries/custom-metrics';

export const runtime = 'nodejs';

/** GET — a custom metric's full version history, newest first (who changed what, when, and why). Readable by any authenticated role, like the metric itself. */
export const GET = withErrorHandling(async (req: NextRequest, { params }: { params: Promise<{ key: string }> }) => {
  const user = await authenticate(req);
  const { key } = await params;
  const versions = await listCustomMetricVersions(user.company_id, key);
  if (!versions) return json({ error: 'Custom metric not found' }, { status: 404 });
  return json({ versions });
});
