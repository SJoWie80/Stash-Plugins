# Stash Funscript Generator

Small Docker web app for generating `.funscript` files from video files. It is meant to run beside Stash and write scripts with the same basename as the source video, for example:

```text
/videos/movie.mp4
/videos/movie.funscript
```

Stash can then scan the library and associate the generated script with the scene.

## What It Does

- Browse mounted media folders from a web interface.
- Select one or more video files.
- Generate `.funscript` files automatically.
- Skip existing scripts unless overwrite is enabled.
- Write scripts next to the video, or to `OUTPUT_DIR` when configured.

The first generator is a motion-based analyzer using OpenCV frame differences. It is useful as a starter pass, but it is not scene-aware AI yet. The code is structured so a stronger analyzer can be added later without changing the Docker or UI workflow.

## Docker Compose

Edit the volume path so the left side points to your Stash video folder.

```yaml
services:
  funscript-generator:
    build:
      context: https://github.com/SJoWie80/Stash-Plugins.git#main:bridges/funscript-generator
    container_name: funscript-generator
    restart: unless-stopped
    ports:
      - "8891:8891"
    environment:
      FUNSCRIPT_HOST: "0.0.0.0"
      FUNSCRIPT_PORT: "8891"
      MEDIA_ROOTS: "/videos"
      OUTPUT_DIR: ""
      ANALYSIS_WIDTH: "360"
    volumes:
      - "D:/Stash/Videos:/videos"
```

Open:

```text
http://YOUR_SERVER_IP:8891
```

## Local Build

From this folder:

```bash
docker compose -f docker-compose.example.yml up --build
```

Then open:

```text
http://127.0.0.1:8891
```

## TrueNAS Custom App YAML

Use this as a starting point and replace `/mnt/tank/media/stash` with your dataset path.

```yaml
services:
  funscript-generator:
    build:
      context: >-
        https://github.com/SJoWie80/Stash-Plugins.git#main:bridges/funscript-generator
    container_name: funscript-generator
    environment:
      FUNSCRIPT_HOST: 0.0.0.0
      FUNSCRIPT_PORT: '8891'
      MEDIA_ROOTS: /videos
      OUTPUT_DIR: ''
      ANALYSIS_WIDTH: '360'
    ports:
      - '8891:8891'
    restart: unless-stopped
    volumes:
      - /mnt/tank/media/stash:/videos
```

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `FUNSCRIPT_HOST` | `0.0.0.0` | Address the web app binds to inside the container. |
| `FUNSCRIPT_PORT` | `8891` | Web app port inside the container. |
| `MEDIA_ROOTS` | `/videos` | Mounted folders the UI may browse. Use `:` between multiple roots in Linux containers, for example `/videos:/downloads`. |
| `OUTPUT_DIR` | empty | Optional output folder. If empty, scripts are written next to each video. |
| `ANALYSIS_WIDTH` | `360` | Width used for internal frame analysis. Lower is faster; higher may keep more detail. Use `0` to disable resizing. |

## Generator Settings

| Setting | Default | Notes |
| --- | --- | --- |
| Sample rate | `3` | Frames per second to inspect. Higher is slower but can catch faster motion. |
| Sensitivity | `1.15` | Higher values ignore more low-level motion. Lower values create more actions. |
| Minimum action gap | `90 ms` | Prevents overly dense scripts. Lower values are more detailed. |
| Overwrite | off | Existing `.funscript` files are skipped by default. |

## Stash Workflow

1. Mount the same media folder in Stash and this generator.
2. Generate scripts next to the video files.
3. Run a Stash scan so the new `.funscript` files are detected.

If Stash runs in Docker too, make sure both containers see the same files, preferably with the same folder structure.

## Health Check

```text
http://YOUR_SERVER_IP:8891/api/health
```

This returns the mounted roots that are visible inside the container.
