"use client";

/**
 * Self-hosted, Yjs-based replacement for the Liveblocks React hooks.
 *
 * The hook names and shapes intentionally mirror the subset of the
 * Liveblocks API this app used (useStorage, useMutation, useSelf,
 * useOthersMapped, useHistory, ...), so the canvas components barely changed.
 *
 * Document shape (inside each board's Y.Doc):
 *   layers:   Y.Map<Y.Map<unknown>>   one nested map per layer (field-level merging)
 *   layerIds: Y.Array<string>         z-order
 *
 * Presence (cursor, selection, pencil draft, ...) lives in Yjs awareness.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
} from "react";
import { useSyncExternalStoreWithSelector } from "use-sync-external-store/shim/with-selector";
import * as Y from "yjs";

import type { Color, Layer, LayerType } from "@/types/canvas";
import { LAYERS_KEY, LAYER_IDS_KEY } from "@/lib/collab/protocol";
import {
  CollabProvider,
  type ConnectionStatus,
  type UserInfo,
} from "@/lib/collab/provider";

/* -------------------------------------------------------------------------- */
/*                                    Types                                   */
/* -------------------------------------------------------------------------- */

export type Presence = {
  cursor: { x: number; y: number } | null;
  selection: string[];
  pencilDraft: [x: number, y: number, pressure: number][] | null;
  penColor: Color | null;
};

export type User = {
  connectionId: number;
  presence: Presence;
  info?: UserInfo;
};

export type StorageSnapshot = {
  layers: ReadonlyMap<string, Layer>;
  layerIds: readonly string[];
};

/** Every field any layer type can have (for typed get/set on a layer). */
export type LayerFields = {
  type: LayerType;
  x: number;
  y: number;
  width: number;
  height: number;
  fill: Color;
  value?: string;
  points?: number[][];
};

type AwarenessState = { presence?: Presence; info?: UserInfo };

const LOCAL_ORIGIN = Symbol("local-mutation");

export const INITIAL_PRESENCE: Presence = {
  cursor: null,
  selection: [],
  pencilDraft: null,
  penColor: null,
};

/* -------------------------------------------------------------------------- */
/*                                  Equality                                  */
/* -------------------------------------------------------------------------- */

/** One-level structural equality for arrays and plain objects. */
export function shallow(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;

  if (
    typeof a !== "object" ||
    typeof b !== "object" ||
    a === null ||
    b === null
  ) {
    return false;
  }

  if (Array.isArray(a) !== Array.isArray(b)) return false;

  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;

  return keysA.every(
    (key) =>
      Object.prototype.hasOwnProperty.call(b, key) &&
      Object.is(
        (a as Record<string, unknown>)[key],
        (b as Record<string, unknown>)[key],
      ),
  );
}

/* -------------------------------------------------------------------------- */
/*                           Mutable storage handles                          */
/* -------------------------------------------------------------------------- */

class LayerHandle {
  constructor(private readonly map: Y.Map<unknown>) {}

  get<K extends keyof LayerFields>(key: K): LayerFields[K] {
    return this.map.get(key) as LayerFields[K];
  }

  set<K extends keyof LayerFields>(key: K, value: LayerFields[K]) {
    this.map.set(key, value);
  }

  update(patch: Partial<LayerFields>) {
    for (const [key, value] of Object.entries(patch)) {
      if (value !== undefined) this.map.set(key, value);
    }
  }
}

class LayersHandle {
  constructor(
    private readonly map: Y.Map<Y.Map<unknown>>,
    private readonly snapshot: () => StorageSnapshot,
  ) {}

  get size() {
    return this.map.size;
  }

  get(id: string) {
    const layer = this.map.get(id);
    return layer ? new LayerHandle(layer) : undefined;
  }

  set(id: string, layer: Layer) {
    const yLayer = new Y.Map<unknown>();
    for (const [key, value] of Object.entries(layer)) {
      if (value !== undefined) yLayer.set(key, value);
    }
    this.map.set(id, yLayer);
  }

  delete(id: string) {
    this.map.delete(id);
  }

  toImmutable() {
    return this.snapshot().layers;
  }
}

class LayerIdsHandle {
  constructor(private readonly array: Y.Array<string>) {}

  get length() {
    return this.array.length;
  }

  push(id: string) {
    this.array.push([id]);
  }

  indexOf(id: string) {
    return this.array.toArray().indexOf(id);
  }

  delete(index: number) {
    this.array.delete(index, 1);
  }

  /** Same semantics as Liveblocks' LiveList.move. */
  move(from: number, to: number) {
    if (from === to) return;
    const value = this.array.get(from);
    this.array.delete(from, 1);
    this.array.insert(to, [value]);
  }

  toImmutable(): readonly string[] {
    return this.array.toArray();
  }
}

/* -------------------------------------------------------------------------- */
/*                                 Room client                                */
/* -------------------------------------------------------------------------- */

type Listener = () => void;

class RoomClient {
  readonly doc = new Y.Doc();
  readonly provider: CollabProvider;
  readonly undoManager: Y.UndoManager;

  private readonly yLayers: Y.Map<Y.Map<unknown>>;
  private readonly yLayerIds: Y.Array<string>;

  // Storage snapshot with structural sharing: unchanged layers keep identity.
  private storage: StorageSnapshot = { layers: new Map(), layerIds: [] };
  private dirtyLayers = new Set<string>();
  private layerIdsDirty = false;
  private storageListeners = new Set<Listener>();

  // Presence snapshot.
  private self: User | null = null;
  private others: readonly User[] = [];
  private userCache = new Map<number, { state: AwarenessState; user: User }>();
  private presenceListeners = new Set<Listener>();

  private historyListeners = new Set<Listener>();
  private paused = false;

  constructor(roomId: string) {
    this.yLayers = this.doc.getMap<Y.Map<unknown>>(LAYERS_KEY);
    this.yLayerIds = this.doc.getArray<string>(LAYER_IDS_KEY);

    this.yLayers.observeDeep((events) => {
      for (const event of events) {
        if (event.target === this.yLayers) {
          (event as Y.YMapEvent<unknown>).keysChanged.forEach((id) =>
            this.dirtyLayers.add(id),
          );
        } else if (typeof event.path[0] === "string") {
          this.dirtyLayers.add(event.path[0]);
        }
      }
    });
    this.yLayerIds.observe(() => {
      this.layerIdsDirty = true;
    });
    this.doc.on("afterTransaction", this.flushStorage);

    this.undoManager = new Y.UndoManager([this.yLayers, this.yLayerIds], {
      trackedOrigins: new Set([LOCAL_ORIGIN]),
      captureTimeout: 0,
    });
    const notifyHistory = () => this.historyListeners.forEach((l) => l());
    this.undoManager.on("stack-item-added", notifyHistory);
    this.undoManager.on("stack-item-popped", notifyHistory);
    this.undoManager.on("stack-cleared", notifyHistory);
    // After undo/redo, drop selected layers that no longer exist.
    this.undoManager.on("stack-item-popped", () => {
      const selection = this.self?.presence.selection ?? [];
      const existing = selection.filter((id) => this.yLayers.has(id));
      if (existing.length !== selection.length) {
        this.setPresence({ selection: existing });
      }
    });

    this.provider = new CollabProvider(roomId, this.doc);
    this.provider.awareness.setLocalState({ presence: INITIAL_PRESENCE });
    this.provider.awareness.on("change", this.updatePresence);
    this.updatePresence();
  }

  /* ------------------------------- Storage ------------------------------- */

  private flushStorage = () => {
    if (this.dirtyLayers.size === 0 && !this.layerIdsDirty) return;

    let layers = this.storage.layers;

    if (this.dirtyLayers.size > 0) {
      const next = new Map(layers);
      this.dirtyLayers.forEach((id) => {
        const yLayer = this.yLayers.get(id);
        if (yLayer) {
          next.set(id, yLayer.toJSON() as Layer);
        } else {
          next.delete(id);
        }
      });
      this.dirtyLayers.clear();
      layers = next;
    }

    // Always rebuild ids when layers change, so they stay consistent.
    // Dedupe (concurrent moves can duplicate an id) and drop dangling ids.
    const seen = new Set<string>();
    const layerIds = this.yLayerIds
      .toArray()
      .filter((id) => layers.has(id) && !seen.has(id) && seen.add(id));
    this.layerIdsDirty = false;

    const prevIds = this.storage.layerIds;
    const idsUnchanged =
      prevIds.length === layerIds.length &&
      prevIds.every((id, i) => id === layerIds[i]);

    this.storage = {
      layers,
      layerIds: idsUnchanged ? prevIds : layerIds,
    };
    this.storageListeners.forEach((listener) => listener());
  };

  getStorage = () => this.storage;

  subscribeStorage = (listener: Listener) => {
    this.storageListeners.add(listener);
    return () => {
      this.storageListeners.delete(listener);
    };
  };

  storageApi = {
    get: ((key: "layers" | "layerIds") =>
      key === "layers"
        ? new LayersHandle(this.yLayers, this.getStorage)
        : new LayerIdsHandle(this.yLayerIds)) as {
      (key: "layers"): LayersHandle;
      (key: "layerIds"): LayerIdsHandle;
    },
  };

  transact<T>(fn: () => T): T {
    let result!: T;
    this.doc.transact(() => {
      result = fn();
    }, LOCAL_ORIGIN);
    return result;
  }

  /* ------------------------------- Presence ------------------------------ */

  private toUser(clientId: number, state: AwarenessState): User | null {
    if (!state.presence) return null;

    const cached = this.userCache.get(clientId);
    if (cached && cached.state === state) return cached.user;

    const user: User = {
      connectionId: clientId,
      presence: state.presence,
      info: state.info,
    };
    this.userCache.set(clientId, { state, user });
    return user;
  }

  private updatePresence = () => {
    const states = this.provider.awareness.getStates() as Map<number, AwarenessState>;
    const selfId = this.doc.clientID;

    const selfState = states.get(selfId);
    const self = selfState ? this.toUser(selfId, selfState) : null;

    const others: User[] = [];
    states.forEach((state, clientId) => {
      if (clientId === selfId) return;
      const user = this.toUser(clientId, state);
      if (user) others.push(user);
    });

    // Forget users that left.
    this.userCache.forEach((_, clientId) => {
      if (!states.has(clientId)) this.userCache.delete(clientId);
    });

    const othersUnchanged =
      others.length === this.others.length &&
      others.every((user, i) => user === this.others[i]);

    if (self === this.self && othersUnchanged) return;

    this.self = self;
    if (!othersUnchanged) this.others = others;
    this.presenceListeners.forEach((listener) => listener());
  };

  getSelf = () => this.self;
  getOthers = () => this.others;

  subscribePresence = (listener: Listener) => {
    this.presenceListeners.add(listener);
    return () => {
      this.presenceListeners.delete(listener);
    };
  };

  setPresence = (patch: Partial<Presence>) => {
    const awareness = this.provider.awareness;
    const state = (awareness.getLocalState() ?? {}) as AwarenessState;

    awareness.setLocalState({
      ...state,
      presence: { ...(state.presence ?? INITIAL_PRESENCE), ...patch },
    });
  };

  /* -------------------------------- History ------------------------------ */

  history = {
    undo: () => {
      this.undoManager.undo();
    },
    redo: () => {
      this.undoManager.redo();
    },
    /** Group every change until resume() into a single undo step. */
    pause: () => {
      if (this.paused) return;
      this.paused = true;
      this.undoManager.stopCapturing();
      this.undoManager.captureTimeout = Number.MAX_SAFE_INTEGER;
    },
    resume: () => {
      if (!this.paused) return;
      this.paused = false;
      this.undoManager.captureTimeout = 0;
      this.undoManager.stopCapturing();
    },
  };

  subscribeHistory = (listener: Listener) => {
    this.historyListeners.add(listener);
    return () => {
      this.historyListeners.delete(listener);
    };
  };

  /* ------------------------------- Lifecycle ----------------------------- */

  destroy() {
    this.provider.awareness.off("change", this.updatePresence);
    this.doc.off("afterTransaction", this.flushStorage);
    this.undoManager.destroy();
    this.provider.destroy();
    this.doc.destroy();
  }
}

/* -------------------------------------------------------------------------- */
/*                                Room provider                               */
/* -------------------------------------------------------------------------- */

const RoomContext = createContext<RoomClient | null>(null);

const useRoomClient = () => {
  const room = useContext(RoomContext);
  if (!room) throw new Error("Collaboration hooks must be used inside <RoomProvider>");
  return room;
};

const noopSubscribe = () => () => {};

interface RoomProviderProps {
  id: string;
  children: React.ReactNode;
  /** Rendered until the board's content has been loaded. */
  fallback: React.ReactNode;
  /** Rendered when the user has no access or the board does not exist. */
  denied: React.ReactNode;
}

export const RoomProvider = ({
  id,
  children,
  fallback,
  denied,
}: RoomProviderProps) => {
  const [room, setRoom] = useState<RoomClient | null>(null);

  useEffect(() => {
    const client = new RoomClient(id);
    setRoom(client);

    return () => {
      client.destroy();
      setRoom(null);
    };
  }, [id]);

  const subscribe = room?.provider.subscribe ?? noopSubscribe;
  const synced = useSyncExternalStore(
    subscribe,
    () => room?.provider.synced ?? false,
    () => false,
  );
  const status = useSyncExternalStore<ConnectionStatus>(
    subscribe,
    () => room?.provider.status ?? "connecting",
    () => "connecting",
  );

  if (status === "denied") return <>{denied}</>;
  // Keep rendering the canvas during later reconnects (synced stays true).
  if (!room || !synced) return <>{fallback}</>;

  return <RoomContext.Provider value={room}>{children}</RoomContext.Provider>;
};

/* -------------------------------------------------------------------------- */
/*                                    Hooks                                   */
/* -------------------------------------------------------------------------- */

export function useStorage<T>(
  selector: (root: StorageSnapshot) => T,
  isEqual?: (a: T, b: T) => boolean,
): T {
  const room = useRoomClient();
  return useSyncExternalStoreWithSelector(
    room.subscribeStorage,
    room.getStorage,
    room.getStorage,
    selector,
    isEqual,
  );
}

export function useSelf(): User;
export function useSelf<T>(selector: (me: User) => T, isEqual?: (a: T, b: T) => boolean): T;
export function useSelf<T>(
  selector?: (me: User) => T,
  isEqual?: (a: T, b: T) => boolean,
) {
  const room = useRoomClient();
  return useSyncExternalStoreWithSelector<User | null, T | User>(
    room.subscribePresence,
    room.getSelf,
    room.getSelf,
    // The local state is set before the room renders, so self always exists.
    (me) => (selector ? selector(me as User) : (me as User)),
    isEqual as ((a: T | User, b: T | User) => boolean) | undefined,
  );
}

export function useOthers(): readonly User[] {
  const room = useRoomClient();
  return useSyncExternalStore(room.subscribePresence, room.getOthers, room.getOthers);
}

export function useOthersMapped<T>(
  selector: (other: User) => T,
  itemIsEqual: (a: T, b: T) => boolean = shallow,
): ReadonlyArray<readonly [connectionId: number, data: T]> {
  const room = useRoomClient();
  return useSyncExternalStoreWithSelector(
    room.subscribePresence,
    room.getOthers,
    room.getOthers,
    (others) => others.map((user) => [user.connectionId, selector(user)] as const),
    (a, b) =>
      a.length === b.length &&
      a.every(([id, value], i) => id === b[i][0] && itemIsEqual(value, b[i][1])),
  );
}

export function useOthersConnectionIds(): readonly number[] {
  const room = useRoomClient();
  return useSyncExternalStoreWithSelector(
    room.subscribePresence,
    room.getOthers,
    room.getOthers,
    (others) => others.map((user) => user.connectionId),
    (a, b) => a.length === b.length && a.every((id, i) => id === b[i]),
  );
}

export function useOther<T>(
  connectionId: number,
  selector: (other: User) => T,
  isEqual?: (a: T | undefined, b: T | undefined) => boolean,
): T | undefined {
  const room = useRoomClient();
  return useSyncExternalStoreWithSelector(
    room.subscribePresence,
    room.getOthers,
    room.getOthers,
    (others) => {
      const user = others.find((other) => other.connectionId === connectionId);
      return user ? selector(user) : undefined;
    },
    isEqual,
  );
}

export type MutationContext = {
  storage: RoomClient["storageApi"];
  self: User;
  setMyPresence: (
    patch: Partial<Presence>,
    options?: { addToHistory?: boolean },
  ) => void;
};

type OmitFirstArg<F> = F extends (first: any, ...args: infer A) => infer R
  ? (...args: A) => R
  : never;

/**
 * Run `fn` as one Yjs transaction (one network update, one undo step).
 * Mirrors Liveblocks' useMutation: the context is read at call time.
 */
export function useMutation<F extends (context: MutationContext, ...args: any[]) => any>(
  fn: F,
  deps: readonly unknown[],
): OmitFirstArg<F> {
  const room = useRoomClient();

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const callback = useCallback(fn, deps);

  return useCallback(
    (...args: unknown[]) =>
      room.transact(() =>
        callback(
          {
            storage: room.storageApi,
            get self() {
              return room.getSelf() as User;
            },
            setMyPresence: (patch) => room.setPresence(patch),
          },
          ...args,
        ),
      ),
    [room, callback],
  ) as OmitFirstArg<F>;
}

export function useHistory() {
  return useRoomClient().history;
}

export function useCanUndo() {
  const room = useRoomClient();
  return useSyncExternalStore(
    room.subscribeHistory,
    () => room.undoManager.canUndo(),
    () => false,
  );
}

export function useCanRedo() {
  const room = useRoomClient();
  return useSyncExternalStore(
    room.subscribeHistory,
    () => room.undoManager.canRedo(),
    () => false,
  );
}

export type { UserInfo };
