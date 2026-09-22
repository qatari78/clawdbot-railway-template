FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force
COPY restore-proof.mjs ./
CMD ["node", "restore-proof.mjs"]
