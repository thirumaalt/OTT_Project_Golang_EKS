FROM golang:1.25 AS builder
WORKDIR /app
COPY . .
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
    GOFLAGS=-mod=mod go build -ldflags="-s -w" -o interaction-service .

FROM scratch
COPY --from=builder /app/interaction-service /interaction-service
EXPOSE 8089
ENTRYPOINT ["/interaction-service"]
