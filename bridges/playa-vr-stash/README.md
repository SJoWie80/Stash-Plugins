# Stash PLAY'A VR Bridge

Small companion server that exposes a PLAY'A API v2 compatible endpoint backed by a Stash library.

PLAY'A does not talk to a Stash UI plugin directly. In PLAY'A you add this bridge as a website, then the bridge queries Stash through GraphQL and returns PLAY'A compatible videos, studios, actors, and categories.

## Quick Start

```powershell
$env:STASH_URL = "http://192.168.101.4:30198"
$env:STASH_API_KEY = ""
$env:PUBLIC_BRIDGE_URL = "http://192.168.101.4:8890"
$env:PLAYA_BRIDGE_HOST = "0.0.0.0"
$env:PLAYA_BRIDGE_PORT = "8890"
python .\playa_vr_stash.py
```

In PLAY'A VR:

1. Open `Web`.
2. Choose `Add Website`.
3. Enter `http://192.168.101.4:8890`.

The bridge serves PLAY'A under `/api/playa/v2`, but PLAY'A only needs the host URL.

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `STASH_URL` | `http://127.0.0.1:9999` | Stash base URL reachable by the bridge. Use your LAN URL if PLAY'A needs direct streams. |
| `STASH_API_KEY` | empty | Optional Stash API key. |
| `PLAYA_BRIDGE_HOST` | `0.0.0.0` | Bind address. |
| `PLAYA_BRIDGE_PORT` | `8890` | Bridge HTTP port. |
| `PUBLIC_STASH_URL` | `STASH_URL` | Optional Stash URL returned to PLAY'A for images and streams. |
| `PUBLIC_BRIDGE_URL` | request host | Optional bridge URL returned to PLAY'A for proxied video streams. |
| `PLAYA_SCAN_PAGE_SIZE` | `250` | Internal page size used when filtering videos by studio, actor, or tag. |
| `PLAYA_SCAN_MAX_PAGES` | `200` | Maximum internal pages scanned for filtered PLAY'A views. |
| `PLAYA_DEFAULT_PROJECTION` | `180` | Default projection when no filename/tag hint is found. Use `180`, `360`, `FSH`, or `FLT`. |
| `PLAYA_DEFAULT_STEREO` | `LR` | Default stereo mode when no filename/tag hint is found. Use `LR` for side-by-side, `TB` for over-under, or `MN` for mono. |
| `PLAYA_SHOW_VIDEO_STATUS` | `false` | Show PLAY'A status badges such as `Published` on videos. |
| `PLAYA_IMAGE_TILE_SIZE` | `512` | Size of normalized square JPEG thumbnails served to PLAY'A for studios, actors, and tags. |

If `STASH_API_KEY` is set, the bridge adds `apikey` to Stash media URLs so PLAY'A can load screenshots and streams without custom headers. Keep this bridge on your trusted LAN and do not expose it publicly.

## Features

- Browse Stash scenes in PLAY'A as videos.
- Filter by studios, performers, and tags when PLAY'A sends those filters.
- Browse Stash studios as PLAY'A studios.
- Browse Stash performers as PLAY'A actors.
- Browse Stash tags as PLAY'A categories.
- Stream scenes through the bridge with HTTP range requests proxied to Stash.
- Basic VR format inference from scene title, path, and tags.

This is an initial bridge. Metadata write-back from PLAY'A events can be added later.
