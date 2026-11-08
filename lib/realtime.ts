import "server-only";

import { Client } from "pg";

import { db } from "@/lib/db";

/**
 * Realtime fan-out built on Postgres LISTEN/NOTIFY.
 *
 * - `publishBoardEvent` runs `pg_notify` through Prisma after a mutation.
 * - Each server process keeps ONE dedicated `pg` connection that LISTENs on
 *   the channel and forwards notifications to in-memory subscribers
 *   (the open SSE streams in app/api/events/route.ts).
 *
 * Because the notification goes through Postgres, every app instance
 * receives it, so this works with multiple servers too.
 */

const CHANNEL = "board_events";

export type BoardEventType =
  | "board.created"
  | "board.updated"
  | "board.deleted"
  | "board.favorited"
  | "board.unfavorited";

export type BoardEvent = {
  type: BoardEventType;
  orgId: string;
  boardId: string;
};

type Listener = (event: BoardEvent) => void;

type RealtimeState = {
  client?: Client;
  connecting?: Promise<void>;
  reconnectTimer?: ReturnType<typeof setTimeout>;
  listeners: Set<Listener>;
};

// Survive hot reloads in development.
const globalForRealtime = globalThis as unknown as {
  boardRealtime?: RealtimeState;
};

const state: RealtimeState =
  globalForRealtime.boardRealtime ??
  (globalForRealtime.boardRealtime = { listeners: new Set() });

const scheduleReconnect = () => {
  state.client = undefined;
  state.connecting = undefined;

  if (state.reconnectTimer || state.listeners.size === 0) return;

  state.reconnectTimer = setTimeout(() => {
    state.reconnectTimer = undefined;
    ensureListening().catch((error) => {
      console.error("[realtime] reconnect failed", error);
      scheduleReconnect();
    });
  }, 1000);
};

const ensureListening = async () => {
  if (state.client) return;
  if (state.connecting) return state.connecting;

  state.connecting = (async () => {
    const client = new Client({ connectionString: process.env.DATABASE_URL });

    client.on("notification", (msg) => {
      if (msg.channel !== CHANNEL || !msg.payload) return;

      let event: BoardEvent;
      try {
        event = JSON.parse(msg.payload);
      } catch {
        return;
      }

      state.listeners.forEach((listener) => {
        try {
          listener(event);
        } catch (error) {
          console.error("[realtime] listener failed", error);
        }
      });
    });

    client.on("error", (error) => {
      console.error("[realtime] connection error", error);
      client.end().catch(() => {});
      scheduleReconnect();
    });

    client.on("end", () => {
      if (state.client === client) scheduleReconnect();
    });

    await client.connect();
    await client.query(`LISTEN ${CHANNEL}`);
    state.client = client;
  })();

  try {
    await state.connecting;
  } finally {
    state.connecting = undefined;
  }
};

export const subscribeToBoardEvents = async (listener: Listener) => {
  state.listeners.add(listener);

  try {
    await ensureListening();
  } catch (error) {
    state.listeners.delete(listener);
    throw error;
  }

  return () => {
    state.listeners.delete(listener);
  };
};

export const publishBoardEvent = async (event: BoardEvent) => {
  try {
    await db.$executeRaw`SELECT pg_notify(${CHANNEL}, ${JSON.stringify(event)})`;
  } catch (error) {
    // The mutation itself succeeded; a missed notification must not fail it.
    console.error("[realtime] publish failed", error);
  }
};
