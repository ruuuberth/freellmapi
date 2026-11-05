# freellmapi

Monorepo para la puerta de enlace FreeLLMAPI: router de LLMs con varios proveedores gratuitos, dashboard web, cliente de línea de comandos y app de escritorio. Espacios de trabajo: `shared`, `server`, `client`, `cli`. Puerto del servidor: `3001`.

## Dev environment

- Node.js `>=20.18.0 <25.0.0`, npm `>=10.0.0` (CI corre en 20, 22 y 24).
- `scripts/dev-bootstrap.sh` (o `.ps1` en Windows): instala dependencias si el `package-lock.json` cambió y crea `.env` con `ENCRYPTION_KEY` (64 hex) + `PORT=3001` solo si `.env` no existe. No lo edites a mano.
- `npm install` (o `npm ci`) desde la raíz.

## Build & test

- `npm run dev` — server + client en paralelo (`npm run dev -w server` y `npm run dev -w client`).
- `npm test` — `test:bootstrap` + `test:hooks` + server + cli + client (`--if-present`). Lento: no corras el suite entero por cada cambio.
- `npm run test:migrations` — round trip de migraciones de DB (`server/src/db/migrations/`).
- `npm run lint` — eslint sobre `server` y `cli` (client se queda fuera por su propio backlog de violaciones).
- `npm run build` — build de server, cli y client (tsc; client usa `tsc -b && vite build`).
- `npm run db:migration:up/down/fresh/status/create` — migraciones via `tsx src/db/migrate/cli.ts` (workspace server).

## Conventions

- `server` y `client` son ESM (`"type": "module"`); `cli` también ESM.
- Migraciones: un archivo por migración bajo `server/src/db/migrations/` (formato `YYYYMMDD_<nombre>.ts`).
- `.env` no se versiona ni se sobrescribe: `dev-bootstrap` lo crea una sola vez.
- Commits: formato convencional (`feat:`, `fix:`, `chore:`), sin scope obligatorio; ejemplo: `feat: add free NovAI image generation`.

## Pitfalls

- Puerto 3001 ocupado → el servidor falla al arrancar (`PORT` en `.env`).
- `better-sqlite3` es nativo: en imágenes slim sin prebuilt compila con `node-gyp` (necesita `python3 make g++`).
- No declares `VOLUME` para `/app/server/data` en el Dockerfile: crea volúmenes anónimos que rompen la persistencia en PaaS (Railway, Render, etc.).
- El healthcheck es `GET /api/ping`.
