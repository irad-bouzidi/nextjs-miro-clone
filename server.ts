/**
 * Single-process entry point: serves the Next.js app AND the Yjs
 * collaboration WebSocket on the same port.
 *
 *   npm run dev    -> tsx server.ts
 *   npm run start  -> NODE_ENV=production tsx server.ts   (after `next build`)
 */
import { createServer } from "http";

import { loadEnvConfig } from "@next/env";
import next from "next";

const dev = process.env.NODE_ENV !== "production";
loadEnvConfig(process.cwd(), dev);

const hostname = process.env.HOSTNAME || "0.0.0.0";
const port = Number(process.env.PORT) || 3000;

type UpgradeHandler = (
  req: import("http").IncomingMessage,
  socket: import("stream").Duplex,
  head: Buffer,
) => unknown;

async function main() {
  // Imported after env is loaded so DATABASE_URL etc. are available.
  const { COLLAB_PATH } = await import("./lib/collab/protocol");
  const { handleCollabUpgrade, flushAllRooms } = await import("./lib/collab/server");

  const server = createServer();
  const app = next({ dev, hostname, port, httpServer: server });
  const handle = app.getRequestHandler();

  await app.prepare();

  // Next would otherwise attach its own "upgrade" listener on the first
  // request and also see /collab upgrades (running middleware on them).
  // We route upgrades ourselves: /collab -> Yjs, everything else (e.g. the
  // dev HMR socket) -> Next.
  const internals = app as unknown as {
    didWebSocketSetup?: boolean;
    upgradeHandler?: UpgradeHandler;
  };
  internals.didWebSocketSetup = true;
  const nextUpgrade: UpgradeHandler =
    internals.upgradeHandler ?? app.getUpgradeHandler();

  server.on("request", (req, res) => {
    void handle(req, res);
  });

  server.on("upgrade", (req, socket, head) => {
    const { pathname } = new URL(req.url ?? "/", "http://localhost");

    if (pathname === COLLAB_PATH) {
      void handleCollabUpgrade(req, socket, head);
    } else if (dev) {
      // Hot reload (/_next/webpack-hmr) and anything else Next handles.
      void nextUpgrade(req, socket, head);
    } else {
      // Nothing else in production upgrades; don't leave sockets hanging.
      socket.destroy();
    }
  });

  server.listen(port, hostname, () => {
    console.log(`> Ready on http://${hostname === "0.0.0.0" ? "localhost" : hostname}:${port} (${dev ? "dev" : "prod"})`);
  });

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`> ${signal} received, saving open boards...`);

    server.close();
    await flushAllRooms().catch((error) => console.error(error));
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
