import type { IncomingMessage } from "http";
import type { Duplex } from "stream";

import { WebSocket, WebSocketServer } from "ws";
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as awarenessProtocol from "y-protocols/awareness";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";

import { db } from "@/lib/db";
import { verifyCollabToken } from "@/lib/collab/token";
import {
  CLOSE_BOARD_NOT_FOUND,
  MESSAGE_AWARENESS,
  MESSAGE_SYNC,
} from "@/lib/collab/protocol";

/**
 * Self-hosted replacement for Liveblocks.
 *
 * One in-memory "room" (Y.Doc + Awareness) per open board. Document updates
 * are relayed to every socket in the room and persisted to Board.content in
 * Postgres (debounced). Awareness carries presence: cursors, selection,
 * pencil drafts and user info.
 */

const SAVE_DEBOUNCE_MS = 1_000;
const SAVE_MAX_WAIT_MS = 5_000;
const PING_INTERVAL_MS = 30_000;
const MAX_PAYLOAD_BYTES = 10 * 1024 * 1024;

type Room = {
  boardId: string;
  doc: Y.Doc;
  awareness: awarenessProtocol.Awareness;
  /** Socket -> awareness client ids that socket controls. */
  conns: Map<WebSocket, Set<number>>;
  saveTimer?: ReturnType<typeof setTimeout>;
  firstPendingChangeAt?: number;
  saving: Promise<void>;
  destroyed: boolean;
};

const rooms = new Map<string, Promise<Room>>();

const wss = new WebSocketServer({
  noServer: true,
  maxPayload: MAX_PAYLOAD_BYTES,
});

class BoardNotFoundError extends Error {}

/* -------------------------------------------------------------------------- */
/*                                 Persistence                                */
/* -------------------------------------------------------------------------- */

const persist = (room: Room) => {
  if (room.saveTimer) clearTimeout(room.saveTimer);
  room.saveTimer = undefined;
  room.firstPendingChangeAt = undefined;

  const content = Buffer.from(Y.encodeStateAsUpdate(room.doc));

  room.saving = room.saving
    .then(async () => {
      // updateMany: a no-op (not an error) if the board was deleted meanwhile.
      await db.board.updateMany({
        where: { id: room.boardId },
        data: { content },
      });
    })
    .catch((error) => {
      console.error(`[collab] failed to save board ${room.boardId}`, error);
    });

  return room.saving;
};

const scheduleSave = (room: Room) => {
  const now = Date.now();
  room.firstPendingChangeAt ??= now;

  if (room.saveTimer) clearTimeout(room.saveTimer);

  const waited = now - room.firstPendingChangeAt;
  const delay = Math.max(0, Math.min(SAVE_DEBOUNCE_MS, SAVE_MAX_WAIT_MS - waited));

  room.saveTimer = setTimeout(() => void persist(room), delay);
};

/* -------------------------------------------------------------------------- */
/*                                    Rooms                                   */
/* -------------------------------------------------------------------------- */

const send = (ws: WebSocket, message: Uint8Array) => {
  if (ws.readyState !== WebSocket.OPEN) return;

  ws.send(message, (error) => {
    if (error) ws.terminate();
  });
};

const broadcast = (room: Room, message: Uint8Array, except?: unknown) => {
  room.conns.forEach((_, ws) => {
    if (ws !== except) send(ws, message);
  });
};

const createRoom = async (boardId: string): Promise<Room> => {
  const board = await db.board.findUnique({
    where: { id: boardId },
    select: { id: true, content: true },
  });

  if (!board) throw new BoardNotFoundError(boardId);

  const doc = new Y.Doc();

  if (board.content) {
    Y.applyUpdate(doc, new Uint8Array(board.content));
  }

  const awareness = new awarenessProtocol.Awareness(doc);
  // The server itself is not a participant.
  awareness.setLocalState(null);

  const room: Room = {
    boardId,
    doc,
    awareness,
    conns: new Map(),
    saving: Promise.resolve(),
    destroyed: false,
  };

  doc.on("update", (update: Uint8Array, origin: unknown) => {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.writeUpdate(encoder, update);
    broadcast(room, encoding.toUint8Array(encoder), origin);

    scheduleSave(room);
  });

  awareness.on(
    "update",
    (
      { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
      origin: unknown,
    ) => {
      const owned = room.conns.get(origin as WebSocket);

      if (owned) {
        added.forEach((id) => owned.add(id));
        removed.forEach((id) => owned.delete(id));
      }

      const changed = [...added, ...updated, ...removed];
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
      encoding.writeVarUint8Array(
        encoder,
        awarenessProtocol.encodeAwarenessUpdate(awareness, changed),
      );
      broadcast(room, encoding.toUint8Array(encoder), origin);
    },
  );

  return room;
};

const getRoom = (boardId: string) => {
  let room = rooms.get(boardId);

  if (!room) {
    room = createRoom(boardId);
    rooms.set(boardId, room);
    // Don't cache failures (e.g. board not found).
    room.catch(() => rooms.delete(boardId));
  }

  return room;
};

const teardownIfEmpty = async (room: Room) => {
  if (room.conns.size > 0) return;

  await persist(room);

  // Someone may have joined while we were saving.
  if (room.conns.size > 0) return;

  room.destroyed = true;
  rooms.delete(room.boardId);
  room.awareness.destroy();
  room.doc.destroy();
};

/* -------------------------------------------------------------------------- */
/*                                 Connections                                */
/* -------------------------------------------------------------------------- */

const handleMessage = (room: Room, ws: WebSocket, message: Uint8Array) => {
  const decoder = decoding.createDecoder(message);
  const encoder = encoding.createEncoder();
  const type = decoding.readVarUint(decoder);

  switch (type) {
    case MESSAGE_SYNC: {
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      syncProtocol.readSyncMessage(decoder, encoder, room.doc, ws);

      // Only reply when there is a payload (sync step 2).
      if (encoding.length(encoder) > 1) {
        send(ws, encoding.toUint8Array(encoder));
      }
      break;
    }
    case MESSAGE_AWARENESS: {
      awarenessProtocol.applyAwarenessUpdate(
        room.awareness,
        decoding.readVarUint8Array(decoder),
        ws,
      );
      break;
    }
    default:
      console.warn("[collab] unknown message type", type);
  }
};

const setupConnection = (room: Room, ws: WebSocket) => {
  ws.binaryType = "arraybuffer";
  room.conns.set(ws, new Set());

  let alive = true;
  ws.on("pong", () => {
    alive = true;
  });

  const pingInterval = setInterval(() => {
    if (!alive) {
      ws.terminate();
      return;
    }
    alive = false;
    ws.ping();
  }, PING_INTERVAL_MS);

  ws.on("message", (data: ArrayBuffer) => {
    try {
      handleMessage(room, ws, new Uint8Array(data));
    } catch (error) {
      console.error("[collab] failed to handle message", error);
      ws.close(1011, "Invalid message");
    }
  });

  ws.on("close", () => {
    clearInterval(pingInterval);

    const owned = room.conns.get(ws);
    room.conns.delete(ws);

    if (owned && owned.size > 0) {
      awarenessProtocol.removeAwarenessStates(
        room.awareness,
        Array.from(owned),
        null,
      );
    }

    void teardownIfEmpty(room);
  });

  // Start the sync handshake.
  const syncEncoder = encoding.createEncoder();
  encoding.writeVarUint(syncEncoder, MESSAGE_SYNC);
  syncProtocol.writeSyncStep1(syncEncoder, room.doc);
  send(ws, encoding.toUint8Array(syncEncoder));

  // Tell the newcomer who is already here.
  const states = room.awareness.getStates();
  if (states.size > 0) {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
    encoding.writeVarUint8Array(
      encoder,
      awarenessProtocol.encodeAwarenessUpdate(
        room.awareness,
        Array.from(states.keys()),
      ),
    );
    send(ws, encoding.toUint8Array(encoder));
  }
};

const rejectUpgrade = (socket: Duplex, status: number, text: string) => {
  socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
};

/** Handle an HTTP upgrade request for the collaboration endpoint. */
export const handleCollabUpgrade = async (
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const payload = verifyCollabToken(url.searchParams.get("token"));

  if (!payload) {
    rejectUpgrade(socket, 401, "Unauthorized");
    return;
  }

  let room: Room;
  try {
    room = await getRoom(payload.boardId);
  } catch (error) {
    if (error instanceof BoardNotFoundError) {
      // Complete the handshake so the browser gets a readable close code.
      wss.handleUpgrade(req, socket, head, (ws) => {
        ws.close(CLOSE_BOARD_NOT_FOUND, "Board not found");
      });
      return;
    }

    console.error("[collab] failed to load room", error);
    rejectUpgrade(socket, 500, "Internal Server Error");
    return;
  }

  wss.handleUpgrade(req, socket, head, async (ws) => {
    // The room may have been torn down while the handshake completed.
    if (room.destroyed) {
      try {
        room = await getRoom(payload.boardId);
      } catch {
        ws.close(CLOSE_BOARD_NOT_FOUND, "Board not found");
        return;
      }
    }

    setupConnection(room, ws);
  });
};

/** Flush every open room to the database (used on shutdown). */
export const flushAllRooms = async () => {
  const loaded = await Promise.allSettled(Array.from(rooms.values()));

  await Promise.all(
    loaded.map((result) =>
      result.status === "fulfilled" ? persist(result.value) : undefined,
    ),
  );
};
