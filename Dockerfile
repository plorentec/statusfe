FROM node:20-slim

RUN apt-get update && apt-get install -y dumb-init && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY . .

RUN mkdir -p /app/data

RUN addgroup --system appgroup && adduser --system --ingroup appgroup appuser
RUN chown -R appuser:appgroup /app /app/data
USER appuser

EXPOSE 3000

ENV PORT=3000

CMD ["dumb-init", "node", "src/app.js"]
