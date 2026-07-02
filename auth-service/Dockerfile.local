FROM golang:1.25 AS builder
WORKDIR /app
COPY . .
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
    GOFLAGS=-mod=mod go build -ldflags="-s -w" -o auth-service .

FROM scratch
COPY --from=builder /app/auth-service /auth-service
EXPOSE 8083
ENTRYPOINT ["/auth-service"]
