FROM python:3.12-slim

WORKDIR /app
COPY playa_vr_stash.py /app/playa_vr_stash.py

ENV PLAYA_BRIDGE_HOST=0.0.0.0
ENV PLAYA_BRIDGE_PORT=8890

EXPOSE 8890
CMD ["python", "/app/playa_vr_stash.py"]
