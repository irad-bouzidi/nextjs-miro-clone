# Build a Real-Time Miro Clone With Nextjs, React, Tailwind (2024)

![Copy of Copy of Copy of Copy of Fullstack Twitter Clone (11)](https://github.com/AntonioErdeljac/next14-miro-clone/assets/23248726/1f973316-0bf4-4fa0-b014-40bb9edc1942)


This is a repository for a Build a Real-Time Miro Clone With Nextjs, React, Tailwind (2024) youtube video.

[VIDEO TUTORIAL](https://youtu.be/ADJKbuayubE)

Features:

- 🛠️ Whiteboard from scratch
- 🧰 Toolbar with Text, Shapes, Sticky Notes & Pencil
- 🪄 Layering functionality
- 🎨 Coloring system
- ↩️ Undo & Redo functionality
- ⌨️ Keyboard shortcuts
- 🤝 Real-time collaboration 
- 💾 Real-time database 
- 🔐 Auth, organisations and invites 
- ⭐️ Favoriting functionality
- 🌐 Next.js 14 framework
- 💅 TailwindCSS & ShadcnUI styling

### Prerequisites

**Node version 14.x**

### Cloning the repository

```shell
git clone https://github.com/AntonioErdeljac/next14-miro-clone.git
```

### Install packages

```shell
npm i
```

### Setup .env file

Copy `.env.example` to `.env` and fill in the keys:

```js
DATABASE_URL="postgresql://postgres:postgres@localhost:5433/miro_clone?schema=public"
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=
CLERK_SECRET_KEY=
LIVEBLOCKS_SECRET_KEY=
```

### Setup the database (Postgres + Prisma)

```shell
npm run db:up       # starts Postgres via docker compose (host port 5433)
npm run db:migrate  # applies prisma/migrations
```

### Start the app

```shell
npm run dev
```

### Realtime updates

Board changes (create, rename, delete, favorite) are pushed to every open tab in the
same organization instantly:

1. Server actions call `pg_notify('board_events', …)` after each change (`lib/realtime.ts`).
2. Each Next.js server keeps one Postgres connection that `LISTEN`s on that channel.
3. `/api/events` streams matching events to the browser as Server-Sent Events.
4. `providers/realtime-provider.tsx` refetches the affected TanStack Query data.

Because events go through Postgres, this works across multiple app instances.
Note: on serverless hosts with short function timeouts the SSE stream is cut
periodically; the browser reconnects automatically and refetches.
