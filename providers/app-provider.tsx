"use client";

import { useState } from "react";
import { ClerkLoaded, ClerkLoading, ClerkProvider, SignedIn } from "@clerk/nextjs";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { Loading } from "@/components/auth/loading";

interface AppProviderProps {
  children: React.ReactNode;
};

export const AppProvider = ({
  children,
}: AppProviderProps) => {
  const [queryClient] = useState(() => new QueryClient({
    defaultOptions: {
      queries: { refetchOnWindowFocus: true, staleTime: 5_000 },
    },
  }));

  return (
    <ClerkProvider>
      <QueryClientProvider client={queryClient}>
        <ClerkLoading>
          <Loading />
        </ClerkLoading>
        <ClerkLoaded>
          <SignedIn>
            {children}
          </SignedIn>
        </ClerkLoaded>
      </QueryClientProvider>
    </ClerkProvider>
  );
};
