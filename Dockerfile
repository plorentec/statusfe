FROM node:20-slim

# openssh-client: lets `cmd` sensors run `ssh user@host command` when the
# operator mounts keys (same trust model as PRTG local sensors).
RUN apt-get update && apt-get install -y --no-install-recommends openssh-client iputils-ping && rm -rf /var/lib/apt/lists/*

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
