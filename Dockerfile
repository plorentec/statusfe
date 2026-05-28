FROM node:20-alpine

RUN echo "nameserver 8.8.8.8" > /etc/resolv.conf && \
    echo "nameserver 8.8.4.4" >> /etc/resolv.conf && \
    apk add --no-cache dumb-init

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY . .

RUN mkdir -p /app/data

RUN addgroup -S appgroup && adduser -S appuser -G appgroup
RUN chown -R appuser:appgroup /app /app/data
USER appuser

EXPOSE 3000

ENV PORT=3000

CMD ["dumb-init", "node", "src/app.js"]
