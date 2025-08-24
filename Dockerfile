# Minimal Node runtime for CalcAI Server
FROM node:20-alpine

WORKDIR /app

# Install dependencies first (better layer caching)
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

# Copy source
COPY . .

# Runtime env
ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

# Start
CMD ["npm", "start"]

