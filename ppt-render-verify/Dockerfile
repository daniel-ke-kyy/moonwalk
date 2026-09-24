FROM golang:1.25-bookworm AS sandbox
WORKDIR /src
COPY sandbox/ .
RUN CGO_ENABLED=0 go build -mod=readonly -trimpath -o /ppt-sandbox .

FROM python:3.12-slim-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends bubblewrap util-linux && rm -rf /var/lib/apt/lists/*
COPY --from=sandbox /ppt-sandbox /usr/local/bin/ppt-sandbox
WORKDIR /probe
COPY probe.py .
CMD ["python", "probe.py"]
