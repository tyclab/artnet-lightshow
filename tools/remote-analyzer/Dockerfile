# The server image's Debian and uv without Node; code, environment and models are mounted (runtime.js).
# uid 1000 needs a passwd entry, as "node" has in the server image: libraries look the user up by uid.
FROM debian:bookworm-slim@sha256:7c7b2c966bc9ee8cedfeef67e0e279108992c77681fa595db4a9d65c06ccc587
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates python3 python3-venv git gcc g++ libc6-dev \
  && rm -rf /var/lib/apt/lists/* \
  && python3 -m venv /opt/venv \
  && /opt/venv/bin/pip install --no-cache-dir uv==0.13.1 \
  && useradd --uid 1000 --no-create-home --home-dir /home/analyzer analyzer
ENV PATH=/opt/venv/bin:$PATH
