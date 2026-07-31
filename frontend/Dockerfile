FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json ./
COPY scripts ./scripts
# Stamp the lockfile hash so the container's dependency check (see
# scripts/ensure-deps.mjs) knows this node_modules is already current.
RUN npm ci && node scripts/ensure-deps.mjs --stamp

COPY . .

EXPOSE 3000

CMD ["npm", "run", "dev"]
