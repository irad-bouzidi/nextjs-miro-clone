import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as awarenessProtocol from "y-protocols/awareness";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";

import {
  CLOSE_BOARD_NOT_FOUND,
  COLLAB_PATH,
  MESSAGE_AWARENESS,
  MESSAGE_SYNC,
} from "@/lib/collab/protocol";

export type UserInfo = {
  name?: string;
  picture?: string;
};

export type ConnectionStatus =
  | "connecting"
  | "connected"
  | "disconnected"
  /** No access, or the board does not exist. Will not retry. */
  | "denied";

type TokenResponse = { token: string; info: UserInfo };

const MAX_BACKOFF_MS = 10_000;

/**
 * Minimal browser WebSocket provider for the self-hosted Yjs server.
 * Fetches a fresh signed token on every (re)connect, so tokens can stay
 * short-lived.
 */
export class CollabProvider {
  readonly doc: Y.Doc;
  readonly awareness: awarenessProtocol.Awareness;

  status: ConnectionStatus = "connecting";
  /** True once the initial document state has been received. */
  synced = false;
  info: UserInfo | null = null;

  private ws: WebSocket | null = null;
  private attempts = 0;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private destroyed = false;
  private listeners = new Set<() => void>();

  constructor(private readonly roomId: string, doc: Y.Doc) {
    this.doc = doc;
    this.awareness = new awarenessProtocol.Awareness(doc);

    doc.on("update", this.onDocUpdate);
    this.awareness.on("update", this.onAwarenessUpdate);
    window.addEventListener("pagehide", this.onPageHide);

    void this.connect();
  }

  /** Subscribe to status / synced changes. */
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private emit() {
    this.listeners.forEach((listener) => listener());
  }

  private setStatus(status: ConnectionStatus) {
    if (this.status === status) return;
    this.status = status;
    this.emit();
  }

  private async fetchToken(): Promise<TokenResponse | "denied" | null> {
    try {
      const res = await fetch("/api/collab-auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ room: this.roomId }),
      });

      if (res.status === 403 || res.status === 404) return "denied";
      if (!res.ok) return null;

      return (await res.json()) as TokenResponse;
    } catch {
      return null;
    }
  }

  private async connect() {
    if (this.destroyed) return;
    this.setStatus("connecting");

    const result = await this.fetchToken();
    if (this.destroyed) return;

    if (result === "denied") {
      this.setStatus("denied");
      return;
    }

    if (!result) {
      this.scheduleReconnect();
      return;
    }

    if (!this.info) {
      this.info = result.info;
      this.awareness.setLocalStateField("info", result.info);
    }

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${protocol}//${window.location.host}${COLLAB_PATH}?token=${encodeURIComponent(result.token)}`;

    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    this.ws = ws;

    ws.onopen = () => {
      this.attempts = 0;
      this.setStatus("connected");

      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      syncProtocol.writeSyncStep1(encoder, this.doc);
      this.send(encoding.toUint8Array(encoder));

      if (this.awareness.getLocalState() !== null) {
        this.sendAwareness([this.doc.clientID]);
      }
    };

    ws.onmessage = (event) => {
      this.handleMessage(new Uint8Array(event.data as ArrayBuffer));
    };

    ws.onclose = (event) => {
      if (this.ws !== ws) return;
      this.ws = null;

      // Everyone else's presence is unknown until we reconnect.
      const others = Array.from(this.awareness.getStates().keys()).filter(
        (id) => id !== this.doc.clientID,
      );
      awarenessProtocol.removeAwarenessStates(this.awareness, others, this);

      if (this.destroyed) return;

      if (event.code === CLOSE_BOARD_NOT_FOUND) {
        this.setStatus("denied");
        return;
      }

      this.setStatus("disconnected");
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect() {
    if (this.destroyed) return;

    const delay = Math.min(MAX_BACKOFF_MS, 250 * 2 ** this.attempts);
    this.attempts++;

    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => void this.connect(), delay);
  }

  private send(message: Uint8Array) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(message);
    }
  }

  private sendAwareness(clients: number[]) {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
    encoding.writeVarUint8Array(
      encoder,
      awarenessProtocol.encodeAwarenessUpdate(this.awareness, clients),
    );
    this.send(encoding.toUint8Array(encoder));
  }

  private handleMessage(message: Uint8Array) {
    const decoder = decoding.createDecoder(message);
    const type = decoding.readVarUint(decoder);

    switch (type) {
      case MESSAGE_SYNC: {
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, MESSAGE_SYNC);

        const syncType = syncProtocol.readSyncMessage(
          decoder,
          encoder,
          this.doc,
          this,
        );

        if (encoding.length(encoder) > 1) {
          this.send(encoding.toUint8Array(encoder));
        }

        if (syncType === syncProtocol.messageYjsSyncStep2 && !this.synced) {
          this.synced = true;
          this.emit();
        }
        break;
      }
      case MESSAGE_AWARENESS: {
        awarenessProtocol.applyAwarenessUpdate(
          this.awareness,
          decoding.readVarUint8Array(decoder),
          this,
        );
        break;
      }
    }
  }

  private onDocUpdate = (update: Uint8Array, origin: unknown) => {
    // Don't echo updates that came from the server.
    if (origin === this) return;

    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.writeUpdate(encoder, update);
    this.send(encoding.toUint8Array(encoder));
  };

  private onAwarenessUpdate = (
    { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ) => {
    if (origin === this) return;
    this.sendAwareness([...added, ...updated, ...removed]);
  };

  private onPageHide = () => {
    awarenessProtocol.removeAwarenessStates(
      this.awareness,
      [this.doc.clientID],
      "page hide",
    );
  };

  destroy() {
    if (this.destroyed) return;

    // Announce that we left before closing the socket.
    awarenessProtocol.removeAwarenessStates(
      this.awareness,
      [this.doc.clientID],
      "destroy",
    );

    this.destroyed = true;
    clearTimeout(this.reconnectTimer);
    window.removeEventListener("pagehide", this.onPageHide);
    this.doc.off("update", this.onDocUpdate);
    this.awareness.off("update", this.onAwarenessUpdate);
    this.ws?.close();
    this.ws = null;
    this.awareness.destroy();
    this.listeners.clear();
  }
}
