# Stash PLAY'A VR Bridge

Companion Docker service that exposes a PLAY'A API v2 compatible website backed by a Stash library.

PLAY'A does not connect to a normal Stash UI plugin. In PLAY'A you add this bridge as a website. The bridge then queries Stash through GraphQL and returns PLAY'A-compatible videos, studios, actors, categories, thumbnails, and stream URLs.

## Related Apps

- [Stash](https://docs.stashapp.cc/) ([GitHub](https://github.com/stashapp/stash)) - source library and GraphQL server.
- [PLAY'A VR](https://playavr.com/) ([Downloads](https://playavr.com/download-app)) - VR video player that connects to this bridge as a website.

## Features

- Browse Stash scenes in PLAY'A as videos.
- Browse and filter by studios, performers, and tags.
- Sort studios by the number of linked scenes, highest first.
- Play Stash scenes in PLAY'A through a bridge stream proxy with HTTP range support.
- Supports SBS and over-under VR playback metadata.
- Defaults to `180` projection and `LR` side-by-side stereo when no filename/tag hint is found.
- Detects `sbs`, `hsbs`, `fsbs`, `side by side`, `ou`, `tb`, `top bottom`, `over under`, `180`, `360`, and `fisheye` hints.
- Normalizes studio, actor, and tag thumbnails for PLAY'A.
- Converts supported images, including SVG logos, to transparent PNG thumbnails.
- Hides PLAY'A `Published` badges by default.

## Add To PLAY'A

After the container is running:

1. Open PLAY'A VR.
2. Go to `Web`.
3. Choose `Add Website`.
4. Enter the bridge URL, for example:

```text
http://YOUR_SERVER_IP:8890
```

The PLAY'A API itself is served under `/api/playa/v2`, but PLAY'A only needs the base bridge URL.

## Docker Compose

Use this when running Docker or Docker Compose directly.

```yaml
services:
  playa-vr-stash:
    build:
      context: https://github.com/SJoWie80/Stash-Plugins.git#main:bridges/playa-vr-stash
    container_name: playa-vr-stash
    restart: unless-stopped
    ports:
      - "8890:8890"
    environment:
      PLAYA_BRIDGE_HOST: "0.0.0.0"
      PLAYA_BRIDGE_PORT: "8890"
      PUBLIC_BRIDGE_URL: "http://YOUR_SERVER_IP:8890"
      STASH_URL: "http://YOUR_STASH_HOST:STASH_PORT"
      PUBLIC_STASH_URL: "http://YOUR_STASH_HOST:STASH_PORT"
      STASH_API_KEY: "YOUR_STASH_API_KEY"
      PLAYA_DEFAULT_PROJECTION: "180"
      PLAYA_DEFAULT_STEREO: "LR"
      PLAYA_SHOW_VIDEO_STATUS: "false"
      PLAYA_IMAGE_TILE_SIZE: "512"
      PLAYA_SITE_LOGO: ""
```

## TrueNAS Custom App YAML

In TrueNAS SCALE:

1. Open `Apps`.
2. Choose `Custom App`.
3. Install using YAML.
4. Use this template and replace only the placeholder values.

```yaml
services:
  playa-vr-stash:
    build:
      context: >-
        https://github.com/SJoWie80/Stash-Plugins.git#main:bridges/playa-vr-stash
    container_name: playa-vr-stash
    environment:
      PLAYA_BRIDGE_HOST: 0.0.0.0
      PLAYA_BRIDGE_PORT: '8890'
      PUBLIC_BRIDGE_URL: http://YOUR_SERVER_IP:8890
      PUBLIC_STASH_URL: http://YOUR_STASH_HOST:STASH_PORT
      STASH_API_KEY: >-
        YOUR_STASH_API_KEY
      STASH_URL: http://YOUR_STASH_HOST:STASH_PORT
      PLAYA_DEFAULT_PROJECTION: '180'
      PLAYA_DEFAULT_STEREO: 'LR'
      PLAYA_SHOW_VIDEO_STATUS: 'false'
      PLAYA_IMAGE_TILE_SIZE: '512'
      PLAYA_SITE_LOGO: ''
    ports:
      - '8890:8890'
    restart: unless-stopped
```

For TrueNAS, use addresses that are reachable from inside the bridge container. If Stash and the bridge run on the same TrueNAS host, the LAN IP and the published Stash port usually work well.

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `STASH_URL` | `http://127.0.0.1:9999` | Stash base URL reachable by the bridge container. Must expose `/graphql`. |
| `PUBLIC_STASH_URL` | `STASH_URL` | Stash URL returned in media and image URLs when needed. Use the URL reachable by PLAY'A. |
| `STASH_API_KEY` | empty | Stash API key. Required when Stash authentication is enabled. |
| `PLAYA_BRIDGE_HOST` | `0.0.0.0` | Address the bridge binds to inside the container. |
| `PLAYA_BRIDGE_PORT` | `8890` | Bridge HTTP port inside the container. |
| `PUBLIC_BRIDGE_URL` | request host | Bridge URL returned to PLAY'A for proxied video streams and thumbnails. |
| `PLAYA_DEFAULT_PROJECTION` | `180` | Default projection. Use `180`, `360`, `FSH`, or `FLT`. |
| `PLAYA_DEFAULT_STEREO` | `LR` | Default stereo. Use `LR` for side-by-side, `TB` for over-under, or `MN` for mono. |
| `PLAYA_SCAN_PAGE_SIZE` | `250` | Internal page size used when scanning scenes for filtering and counts. |
| `PLAYA_SCAN_MAX_PAGES` | `200` | Maximum internal pages scanned. |
| `PLAYA_SHOW_VIDEO_STATUS` | `false` | Show PLAY'A video status badges such as `Published`. |
| `PLAYA_IMAGE_TILE_SIZE` | `512` | Base size for generated thumbnails. |
| `PLAYA_SITE_LOGO` | generated bridge logo | Optional absolute URL for a custom 256x256 transparent PNG logo shown on PLAY'A's website/home screen. |

## Health Check

Open this URL in a browser:

```text
http://YOUR_SERVER_IP:8890/api/playa/v2/health
```

It shows the bridge status, the configured Stash URL, and whether Stash GraphQL is reachable.

## Troubleshooting

If PLAY'A shows no videos, first check the health endpoint. The most common issue is:

```text
Connection refused
```

That means the bridge is running, but `STASH_URL` is not reachable from the bridge container. Check the Stash host, port, and whether Stash is running.

If PLAY'A connects but cannot play, open a video detail:

```text
http://YOUR_SERVER_IP:8890/api/playa/v2/video/SCENE_ID
```

The stream URL should point to:

```text
http://YOUR_SERVER_IP:8890/api/playa/v2/stream/SCENE_ID
```

If Stash authentication is enabled, generate a Stash API key and set `STASH_API_KEY`. Keep the bridge on a trusted LAN and do not expose it publicly.

## Notes

- The bridge is not listed in `stable/index.yml` because it is not a Stash plugin package.
- PLAY'A thumbnails are proxied through the bridge so unsupported or awkward images can be normalized before PLAY'A displays them.
- SVG logos are converted to transparent PNG thumbnails.
