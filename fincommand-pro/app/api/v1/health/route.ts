import { NextResponse } from 'next/server';

export const runtime = 'nodejs';

const START = Date.now();

export async function GET() {
  return NextResponse.json({
    status: 'ok',
    service: 'FinCommand Pro API',
    version: '1.0.0',
    uptime: Math.floor((Date.now() - START) / 1000),
    timestamp: new Date().toISOString(),
  });
}
