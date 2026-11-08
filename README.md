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
