/**
 * Shared constants for the self-hosted Yjs collaboration server.
 * Message framing follows the standard y-websocket protocol.
 */

/** WebSocket endpoint served by server.ts (outside of Next's router). */
export const COLLAB_PATH = "/collab";

export const MESSAGE_SYNC = 0;
export const MESSAGE_AWARENESS = 1;

/** Names of the shared types inside each board's Y.Doc. */
export const LAYERS_KEY = "layers";
export const LAYER_IDS_KEY = "layerIds";

/** Close codes sent by the server. */
export const CLOSE_BOARD_NOT_FOUND = 4404;
