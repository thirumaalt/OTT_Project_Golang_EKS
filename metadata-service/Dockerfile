FROM golang:1.25 AS builder
WORKDIR /app
COPY . .
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
    GOFLAGS=-mod=mod go build -ldflags="-s -w" -o metadata-service .

FROM alpine:latest
RUN apk --no-cache add ca-certificates
COPY --from=builder /app/metadata-service /metadata-service
EXPOSE 8088
ENTRYPOINT ["/metadata-service"]
