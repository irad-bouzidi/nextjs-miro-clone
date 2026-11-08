import { auth, currentUser } from "@clerk/nextjs";

import { db } from "@/lib/db";
import { createCollabToken } from "@/lib/collab/token";

/**
 * Issues a short-lived ticket for the collaboration WebSocket
 * (replaces the old /api/liveblocks-auth route).
 */
export async function POST(request: Request) {
  const { userId, orgId } = auth();
  const user = await currentUser();

  if (!userId || !orgId || !user) {
    return new Response("Unauthorized", { status: 403 });
  }

  const { room } = (await request.json().catch(() => ({}))) as { room?: string };

  if (!room) {
    return new Response("Missing room", { status: 400 });
  }

  const board = await db.board.findUnique({
    where: { id: room },
    select: { orgId: true },
  });

  if (!board) {
    return new Response("Board not found", { status: 404 });
  }

  if (board.orgId !== orgId) {
    return new Response("Unauthorized", { status: 403 });
  }

  return Response.json({
    token: createCollabToken({ boardId: room, userId, orgId }),
    info: {
      name: user.firstName || "Teammate",
      picture: user.imageUrl,
    },
  });
}
