FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
COPY yapper.js bot.js ./
COPY engine ./engine
COPY apps ./apps
CMD ["node", "bot.js"]
