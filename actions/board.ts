"use server";

import { auth, currentUser } from "@clerk/nextjs";
import type { Board } from "@prisma/client";

import { db } from "@/lib/db";
import { publishBoardEvent } from "@/lib/realtime";

const images = [
  "/placeholders/1.svg",
  "/placeholders/2.svg",
  "/placeholders/3.svg",
  "/placeholders/4.svg",
  "/placeholders/5.svg",
  "/placeholders/6.svg",
  "/placeholders/7.svg",
  "/placeholders/8.svg",
  "/placeholders/9.svg",
  "/placeholders/10.svg",
];

export type BoardDTO = {
  id: string;
  title: string;
  orgId: string;
  authorId: string;
  authorName: string;
  imageUrl: string;
  createdAt: number;
};

export type BoardWithFavorite = BoardDTO & { isFavorite: boolean };

const toDTO = (board: Omit<Board, "content">): BoardDTO => ({
  id: board.id,
  title: board.title,
  orgId: board.orgId,
  authorId: board.authorId,
  authorName: board.authorName,
  imageUrl: board.imageUrl,
  createdAt: board.createdAt.getTime(),
});

const requireUserId = () => {
  const { userId } = auth();

  if (!userId) {
    throw new Error("Unauthorized");
  }

  return userId;
};

// Loads a board and makes sure it belongs to the caller's active organization.
const getAuthorizedBoard = async (id: string) => {
  const { orgId } = auth();
  const board = await db.board.findUnique({ where: { id } });

  if (!board) {
    throw new Error("Board not found");
  }

  if (board.orgId !== orgId) {
    throw new Error("Unauthorized");
  }

  return board;
};

export async function getBoards(args: {
  orgId: string;
  search?: string;
  favorites?: string;
}): Promise<BoardWithFavorite[]> {
  const userId = requireUserId();

  if (args.orgId !== auth().orgId) {
    throw new Error("Unauthorized");
  }

  if (args.favorites) {
    const favorites = await db.userFavorite.findMany({
      where: { userId, orgId: args.orgId },
      orderBy: { createdAt: "desc" },
      include: { board: true },
    });

    return favorites.map((f) => ({ ...toDTO(f.board), isFavorite: true }));
  }

  const search = args.search?.trim();

  const boards = await db.board.findMany({
    where: {
      orgId: args.orgId,
      ...(search && {
        title: { contains: search, mode: "insensitive" as const },
      }),
    },
    orderBy: { createdAt: "desc" },
    include: { favorites: { where: { userId }, select: { id: true } } },
  });

  return boards.map(({ favorites, ...board }) => ({
    ...toDTO(board),
    isFavorite: favorites.length > 0,
  }));
}

export async function getBoard(id: string): Promise<BoardDTO | null> {
  requireUserId();
  const { orgId } = auth();

  const board = await db.board.findUnique({ where: { id } });

  if (!board || board.orgId !== orgId) {
    return null;
  }

  return toDTO(board);
}

export async function createBoard(args: { orgId: string; title: string }) {
  const userId = requireUserId();

  if (args.orgId !== auth().orgId) {
    throw new Error("Unauthorized");
  }

  const user = await currentUser();
  const authorName =
    [user?.firstName, user?.lastName].filter(Boolean).join(" ") ||
    user?.username ||
    "Teammate";

  const randomImage = images[Math.floor(Math.random() * images.length)];

  const board = await db.board.create({
    data: {
      title: args.title,
      orgId: args.orgId,
      authorId: userId,
      authorName,
      imageUrl: randomImage,
    },
  });

  await publishBoardEvent({
    type: "board.created",
    orgId: board.orgId,
    boardId: board.id,
  });

  return board.id;
}

export async function removeBoard(args: { id: string }) {
  requireUserId();
  const board = await getAuthorizedBoard(args.id);

  // Favorites are removed by the onDelete: Cascade relation.
  await db.board.delete({ where: { id: args.id } });

  await publishBoardEvent({
    type: "board.deleted",
    orgId: board.orgId,
    boardId: board.id,
  });
}

export async function updateBoard(args: { id: string; title: string }) {
  requireUserId();

  const title = args.title.trim();

  if (!title) {
    throw new Error("Title is required");
  }

  if (title.length > 60) {
    throw new Error("Title cannot be longer than 60 characters");
  }

  await getAuthorizedBoard(args.id);

  const board = await db.board.update({
    where: { id: args.id },
    data: { title },
  });

  await publishBoardEvent({
    type: "board.updated",
    orgId: board.orgId,
    boardId: board.id,
  });

  return toDTO(board);
}

export async function favoriteBoard(args: { id: string; orgId: string }) {
  const userId = requireUserId();
  const board = await getAuthorizedBoard(args.id);

  const existing = await db.userFavorite.findUnique({
    where: { userId_boardId: { userId, boardId: board.id } },
  });

  if (existing) {
    throw new Error("Board already favorited");
  }

  await db.userFavorite.create({
    data: { userId, boardId: board.id, orgId: board.orgId },
  });

  await publishBoardEvent({
    type: "board.favorited",
    orgId: board.orgId,
    boardId: board.id,
  });

  return toDTO(board);
}

export async function unfavoriteBoard(args: { id: string }) {
  const userId = requireUserId();
  const board = await getAuthorizedBoard(args.id);

  const { count } = await db.userFavorite.deleteMany({
    where: { userId, boardId: board.id },
  });

  if (!count) {
    throw new Error("Favorited board not found");
  }

  await publishBoardEvent({
    type: "board.unfavorited",
    orgId: board.orgId,
    boardId: board.id,
  });

  return toDTO(board);
}
