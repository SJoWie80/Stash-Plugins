FROM python:3.12-slim

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg libglib2.0-0 libgomp1 \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt

COPY app /app/app

ENV FUNSCRIPT_HOST=0.0.0.0
ENV FUNSCRIPT_PORT=8891
ENV MEDIA_ROOTS=/videos
ENV OUTPUT_DIR=

EXPOSE 8891
CMD ["python", "-m", "app.main"]
