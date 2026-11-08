"use client";

import { useEffect } from "react";
import { useOrganization } from "@clerk/nextjs";
import { useQueryClient } from "@tanstack/react-query";

import type { BoardEvent } from "@/lib/realtime";

/**
 * Subscribes to /api/events and refreshes cached board data whenever
 * anyone in the active organization changes a board.
 */
export const RealtimeProvider = () => {
  const { organization } = useOrganization();
  const queryClient = useQueryClient();
  const orgId = organization?.id;

  useEffect(() => {
    if (!orgId) return;

    const source = new EventSource("/api/events");
    let hasConnected = false;

    source.onopen = () => {
      // After a reconnect we may have missed events: refetch everything.
      if (hasConnected) {
        queryClient.invalidateQueries({ queryKey: ["boards"] });
        queryClient.invalidateQueries({ queryKey: ["board"] });
      }
      hasConnected = true;
    };

    source.addEventListener("board", (message) => {
      let event: BoardEvent;
      try {
        event = JSON.parse((message as MessageEvent<string>).data);
      } catch {
        return;
      }

      queryClient.invalidateQueries({ queryKey: ["boards", event.orgId] });
      queryClient.invalidateQueries({ queryKey: ["board", event.boardId] });
    });

    return () => source.close();
  }, [orgId, queryClient]);

  return null;
};
