import { NextResponse } from "next/server";

export function errorResponse(error: unknown, fallback: string, status = 500): NextResponse {
  const message = error instanceof Error ? error.message : fallback;
  console.error(fallback, error);
  return NextResponse.json({ error: message || fallback }, { status });
}

export function parsePositiveInteger(value: string | null, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
