FROM python:3.12-slim

WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends libcairo2 libpango-1.0-0 libpangocairo-1.0-0 libgdk-pixbuf-2.0-0 shared-mime-info \
    && rm -rf /var/lib/apt/lists/* \
    && pip install --no-cache-dir pillow cairosvg
COPY playa_vr_stash.py /app/playa_vr_stash.py

ENV PLAYA_BRIDGE_HOST=0.0.0.0
ENV PLAYA_BRIDGE_PORT=8890

EXPOSE 8890
CMD ["python", "/app/playa_vr_stash.py"]
