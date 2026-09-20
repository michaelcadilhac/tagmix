"use client";

import { useEffect, useRef, useState } from "react";
import { accountRequest, errorMessage } from "@/lib/account-client";

export function useAccountResource<T>(path: string, userId: string | undefined, refreshOnFocus = false) {
  const generation = useRef(0);
  const [attempt, setAttempt] = useState(0);
  const key = `${userId}:${path}:${attempt}`;
  const [state, setState] = useState<{ key: string; data: T | null; error: string }>({ key: "", data: null, error: "" });
  useEffect(() => {
    if (!userId) return;
    const controller = new AbortController();
    function refresh() {
      const request = ++generation.current;
      accountRequest<T>(path, { userId, signal: controller.signal })
        .then((data) => { if (!controller.signal.aborted && request === generation.current) setState({ key, data, error: "" }); })
        .catch((error) => { if (!controller.signal.aborted && request === generation.current) setState({ key, data: null, error: errorMessage(error) }); });
    }
    refresh();
    if (refreshOnFocus) window.addEventListener("focus", refresh);
    return () => { controller.abort(); window.removeEventListener("focus", refresh); };
  }, [key, path, userId, refreshOnFocus]);
  return {
    data: state.key === key ? state.data : null,
    error: state.key === key ? state.error : "",
    loading: Boolean(userId) && state.key !== key,
    reload: () => setAttempt((value) => value + 1),
    update: (updateData: (data: T) => T) => {
      generation.current++;
      setState((current) => current.key === key && current.data !== null ? { ...current, data: updateData(current.data) } : current);
    },
    replace: (data: T) => { generation.current++; setState({ key, data, error: "" }); },
  };
}
