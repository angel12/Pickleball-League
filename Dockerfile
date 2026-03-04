FROM node:22-alpine

WORKDIR /app

COPY package.json ./
COPY server.mjs ./
COPY public ./public
COPY data.json ./data.json

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000

EXPOSE 3000

CMD ["npm", "start"]
