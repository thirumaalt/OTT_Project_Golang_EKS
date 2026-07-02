FROM golang:1.25 AS builder
WORKDIR /app
COPY . .
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
    GOFLAGS=-mod=mod go build -ldflags="-s -w" -o subscription-service .

FROM scratch
COPY --from=builder /app/subscription-service /subscription-service
EXPOSE 8093
ENTRYPOINT ["/subscription-service"]
