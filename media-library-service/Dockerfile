FROM golang:1.25 AS builder
WORKDIR /app
COPY . .
#RUN GOFLAGS=-mod=mod go build -ldflags="-s -w" -o media-library-service .
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
    GOFLAGS=-mod=mod go build -ldflags="-s -w" -o media-library-service .

FROM alpine:latest
RUN apk --no-cache add ca-certificates
COPY --from=builder /app/media-library-service /media-library-service
EXPOSE 8001
CMD ["/media-library-service"]
