FROM golang:1.23-alpine AS build
ARG VERSION=dev
WORKDIR /src
COPY agent/go.mod agent/go.sum* ./
RUN go mod download
COPY agent/main.go ./
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags="-s -w -X main.version=${VERSION}" -o /out/netpilot-agent .

FROM alpine:3.21
ARG NEXTTRACE_VERSION=v1.7.1
ARG NEXTTRACE_AMD64_SHA256=1f4c559cbdf6f667a1a9e050567c9cf1fc11741e8cc1e50f5fdcaf2dbb247232
ARG NEXTTRACE_LICENSE_SHA256=3972dc9744f6499f0f9b2dbf76696f2ae7ad8af9b23dde66d6af86c9dfb36986
RUN apk add --no-cache ca-certificates iperf3 libcap \
    && mkdir -p /usr/share/licenses/nexttrace \
    && wget -O /usr/local/bin/nexttrace "https://github.com/nxtrace/NTrace-core/releases/download/${NEXTTRACE_VERSION}/nexttrace_linux_amd64" \
    && wget -O /usr/share/licenses/nexttrace/LICENSE "https://raw.githubusercontent.com/nxtrace/NTrace-core/${NEXTTRACE_VERSION}/LICENSE" \
    && echo "${NEXTTRACE_AMD64_SHA256}  /usr/local/bin/nexttrace" | sha256sum -c - \
    && echo "${NEXTTRACE_LICENSE_SHA256}  /usr/share/licenses/nexttrace/LICENSE" | sha256sum -c - \
    && chmod 0755 /usr/local/bin/nexttrace \
    && setcap cap_net_raw+ep /usr/local/bin/nexttrace \
    && adduser -D -H -u 10001 netpilot
COPY --from=build /out/netpilot-agent /usr/local/bin/netpilot-agent
LABEL org.opencontainers.image.licenses="AGPL-3.0-only AND GPL-3.0-only" \
      org.opencontainers.image.vendor="NetPilot" \
      org.opencontainers.image.description="NetPilot Agent with iperf3 and NextTrace v1.7.1"
USER netpilot
ENTRYPOINT ["/usr/local/bin/netpilot-agent"]
