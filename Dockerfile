FROM node:20-slim

RUN mkdir -p /app
WORKDIR /app

COPY package.json ./
RUN npm install

COPY src/ ./src/
COPY public/ ./public/
COPY views/ ./views/

RUN mkdir -p /app/data

EXPOSE 3000

ENV PORT=3000

CMD ["node", "src/app.js"]
