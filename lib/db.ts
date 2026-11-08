import { PrismaClient } from "@prisma/client";

const createClient = () =>
  new PrismaClient({
    // The canvas document can be large; only load it when asked for explicitly.
    omit: { board: { content: true } },
  });

const globalForPrisma = globalThis as unknown as {
  prisma?: ReturnType<typeof createClient>;
};

// Reuse a single client across hot reloads in development.
export const db = globalForPrisma.prisma ?? createClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = db;
