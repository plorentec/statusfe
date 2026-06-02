FROM node:20-slim

WORKDIR /app

COPY package.json package-lock.json* ./
COPY node_modules ./node_modules
COPY . .

RUN mkdir -p /app/data

EXPOSE 3000

ENV PORT=3000

CMD ["node", "src/app.js"]
