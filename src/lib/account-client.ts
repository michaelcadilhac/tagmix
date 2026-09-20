export async function accountRequest<T>(path: string, options: {
  userId?: string; method?: string; body?: unknown; signal?: AbortSignal;
} = {}): Promise<T> {
  const response = await fetch(`/api/account/${path}`, {
    method: options.method ?? "GET", cache: "no-store", signal: options.signal,
    headers: {
      ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(options.userId ? { "X-Tagmix-Account": options.userId } : {}),
    },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "Could not complete that request.");
  return payload as T;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong. Please try again.";
}
