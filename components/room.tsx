"use client";

import Link from "next/link";
import { ReactNode } from "react";

import { RoomProvider } from "@/lib/collab/react";

interface RoomProps { 
  children: ReactNode
  roomId: string;
  fallback: NonNullable<ReactNode> | null;
};

export const Room = ({ 
  children,
  roomId,
  fallback,
}: RoomProps) => {
  return (
    <RoomProvider
      id={roomId}
      fallback={fallback}
      denied={
        <div className="h-full w-full flex flex-col items-center justify-center gap-y-4">
          <p className="text-lg font-semibold">
            This board doesn&apos;t exist or you don&apos;t have access to it.
          </p>
          <Link href="/" className="text-blue-600 underline">
            Back to boards
          </Link>
        </div>
      }
    >
      {children}
    </RoomProvider>
  );
};
