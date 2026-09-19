import { NextResponse } from "next/server";
import { catalogCacheInfo } from "@/lib/catalog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  const catalogCache = await catalogCacheInfo();
  return NextResponse.json({
    status: "ok",
    service: "tagmix",
    uptimeSeconds: Math.round(process.uptime()),
    catalogCache,
  });
}
