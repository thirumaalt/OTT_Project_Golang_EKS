FROM golang:1.25 AS builder
WORKDIR /app
COPY . .
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
    GOFLAGS=-mod=mod go build -ldflags="-s -w" -o user-service .

FROM scratch
COPY --from=builder /app/user-service /user-service
EXPOSE 8085
ENTRYPOINT ["/user-service"]
