import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

/**
 * Wraps a server action, tracks its pending state and refreshes
 * board data afterwards (replaces Convex's reactive queries).
 */
export const useApiMutation = <TArgs, TResult>(
  mutationFunction: (args: TArgs) => Promise<TResult>,
) => {
  const [pending, setPending] = useState(false);
  const queryClient = useQueryClient();

  const mutate = async (payload: TArgs) => {
    setPending(true);
    try {
      const result = await mutationFunction(payload);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["boards"] }),
        queryClient.invalidateQueries({ queryKey: ["board"] }),
      ]);
      return result;
    } finally {
      setPending(false);
    }
  };

  return {
    mutate,
    pending,
  };
};
