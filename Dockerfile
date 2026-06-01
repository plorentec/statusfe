FROM node:20-slim

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

RUN mkdir -p /app/data

COPY . .

EXPOSE 3000

ENV PORT=3000

CMD ["node", "src/app.js"]
