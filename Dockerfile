FROM node:20-alpine

RUN apk add --no-cache dumb-init

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --only=production

COPY . .

RUN mkdir -p /app/data

RUN addgroup -S appgroup && adduser -S appuser -G appgroup
RUN chown -R appuser:appgroup /app /app/data
USER appuser

EXPOSE 3000

ENV PORT=3000

CMD ["dumb-init", "node", "src/app.js"]
