import { createHmac, timingSafeEqual } from "crypto";

/**
 * Short-lived, HMAC-signed ticket that lets a browser open the collaboration
 * WebSocket for one board. Issued by /api/collab-auth after Clerk + org checks,
 * verified by the WebSocket server in server.ts.
 */

export type CollabTokenPayload = {
  boardId: string;
  userId: string;
  orgId: string;
  /** Expiry, unix ms. */
  exp: number;
};

const TOKEN_TTL_MS = 60_000;

const getSecret = () => {
  const secret = process.env.COLLAB_SECRET || process.env.CLERK_SECRET_KEY;

  if (!secret) {
    throw new Error("COLLAB_SECRET (or CLERK_SECRET_KEY) must be set");
  }

  return secret;
};

const sign = (data: string) =>
  createHmac("sha256", getSecret()).update(data).digest("base64url");

export const createCollabToken = (
  payload: Omit<CollabTokenPayload, "exp">,
) => {
  const body = Buffer.from(
    JSON.stringify({ ...payload, exp: Date.now() + TOKEN_TTL_MS }),
  ).toString("base64url");

  return `${body}.${sign(body)}`;
};

export const verifyCollabToken = (
  token: string | null | undefined,
): CollabTokenPayload | null => {
  if (!token) return null;

  const [body, signature] = token.split(".");
  if (!body || !signature) return null;

  const expected = Buffer.from(sign(body));
  const actual = Buffer.from(signature);

  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    return null;
  }

  try {
    const payload = JSON.parse(
      Buffer.from(body, "base64url").toString("utf8"),
    ) as CollabTokenPayload;

    if (typeof payload.exp !== "number" || payload.exp < Date.now()) {
      return null;
    }

    return payload;
  } catch {
    return null;
  }
};
