FROM python:3.12-slim-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends bubblewrap util-linux && rm -rf /var/lib/apt/lists/*
WORKDIR /probe
COPY probe.py .
RUN useradd --uid 10001 --create-home worker
USER worker
CMD ["python", "probe.py"]
