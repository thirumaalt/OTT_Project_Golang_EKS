FROM golang:1.25 AS builder
WORKDIR /app
COPY . .
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
    GOFLAGS=-mod=mod go build -ldflags="-s -w" -o payment-service .

FROM scratch
COPY --from=builder /app/payment-service /payment-service
EXPOSE 8091
ENTRYPOINT ["/payment-service"]
