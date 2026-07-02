FROM node:20-alpine AS builder
WORKDIR /app

RUN apk add --no-cache python3 make g++ bash

# Build context is Project_1_Traditional/frontend-ui
COPY package.json ./
RUN npm install
COPY . .

# Empty VITE_API_BASE makes all /api calls relative — nginx proxies them to the gateway
ARG VITE_API_BASE=""
ENV VITE_API_BASE=${VITE_API_BASE}
ENV NODE_ENV=production
# Write .env so Vite picks it up regardless of ARG propagation
RUN echo "VITE_API_BASE=" > .env
RUN npm run build

FROM nginx:stable-alpine
COPY --from=builder /app/dist /usr/share/nginx/html
# nginx.conf is injected via volume mount in docker-compose — no COPY needed here
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
