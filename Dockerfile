FROM node:20-slim

# Build tools pour compiler better-sqlite3 si pas de binaire prébuilt + tzdata pour TZ=Europe/Paris
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ tzdata \
    && rm -rf /var/lib/apt/lists/*

# Le serveur vit à l'heure de l'utilisateur : rappels/pushs, minuit, heures des stats.
# (Les pointages manuels n'en dépendent plus : le navigateur envoie son tzOffset.)
ENV TZ=Europe/Paris

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY server.js ./
COPY public ./public

ENV PORT=3000
ENV DATA_DIR=/data
RUN mkdir -p /data

EXPOSE 3000
CMD ["node", "server.js"]