# Stash Plugins

This repository contains Stash plugin packages maintained by SJoWie80.

## Related Apps

- [Stash](https://docs.stashapp.cc/) ([GitHub](https://github.com/stashapp/stash)) - self-hosted media organizer and server.
- [PLAY'A VR](https://playavr.com/) ([Downloads](https://playavr.com/download-app)) - VR video player used by the PLAY'A bridge.

## Stash Plugin Source

Add this plugin source URL in Stash:

```text
https://raw.githubusercontent.com/SJoWie80/Stash-Plugins/main/stable/index.yml
```

Then open `Settings > Plugins`, reload plugin sources, and install the plugins you want.

## Included Plugins

- `Chaturbate` - browse and watch Chaturbate cams inside Stash.
- `Stash Cleanup` - clean up duplicate scenes, unused tags, and messy metadata.
- `Folder View` - browse scenes and galleries grouped by filesystem folder.
- `Now Playing` - show active Stash web playback sessions reported by connected browsers.
- `Tag Icon Studio` - generate or import consistent icon artwork and assign it to Stash tags.

## Included Bridges

- `PLAY'A VR Bridge` - a companion Docker service that exposes a PLAY'A API v2 compatible website backed by Stash.

The PLAY'A bridge is not installed through the Stash plugin source. It runs as a separate container because PLAY'A connects to its own website/API endpoint. See [bridges/playa-vr-stash](bridges/playa-vr-stash/README.md).

## Files

- `plugins/` contains the plugin source files.
- `bridges/` contains companion services that integrate Stash with external apps.
- `stable/index.yml` is the Stash plugin source index.
- `stable/packages/` contains the installable plugin zip packages referenced by the index.
