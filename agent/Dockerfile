FROM golang:1.23-alpine AS build
ARG VERSION=dev
WORKDIR /src
COPY agent/go.mod agent/go.sum* ./
RUN go mod download
COPY agent/main.go ./
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags="-s -w -X main.version=${VERSION}" -o /out/netpilot-agent .

FROM alpine:3.21
RUN apk add --no-cache ca-certificates iperf3 && adduser -D -H -u 10001 netpilot
COPY --from=build /out/netpilot-agent /usr/local/bin/netpilot-agent
USER netpilot
ENTRYPOINT ["/usr/local/bin/netpilot-agent"]
