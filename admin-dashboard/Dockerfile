# Stage 1: Build
FROM node:20-alpine AS builder
WORKDIR /app

RUN apk add --no-cache python3 make g++

COPY package.json ./
RUN npm install

COPY . .
ENV NODE_ENV=production
RUN npm run build

# Stage 2: Production
FROM nginx:stable-alpine AS runner
COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 5174
CMD ["nginx", "-g", "daemon off;"]
