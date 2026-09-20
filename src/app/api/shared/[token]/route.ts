import { accountErrorResponse, accountResponse } from "@/lib/account-http";
import { accountStore } from "@/lib/account-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ token: string }> }) {
  try {
    return accountResponse({ folder: accountStore().sharedFolder((await context.params).token) });
  } catch (error) {
    return accountErrorResponse(error);
  }
}
