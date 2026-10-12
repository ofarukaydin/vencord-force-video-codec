# ForceVideoCodec

A [Vencord](https://github.com/Vendicated/Vencord) user plugin, mainly for [Vesktop](https://github.com/Vencord/Vesktop) on Linux.

Discord's web client prefers H264 for screen share and camera, which Chromium encodes in software on Linux. Chromium's VA-API encoder handles VP9 and AV1, so making Discord pick one of those moves encoding onto the GPU.

- **Codec preference**: ranks the chosen codec (AV1 by default, or VP9/H264/VP8) first in the voice gateway's codec negotiation, so the server selects it.
- **AV1 offer**: the web client only extracts H264/VP8/VP9 from Chromium's SDP; the plugin adds AV1 to that list.
- **Native aspect ratio**: Vesktop assumes 16:9 when sizing the capture, which caps ultrawide sources (5120x2160 becomes 3840x1620). The plugin sizes it to the source's aspect ratio instead.
- **Quality indicator**: reports the resolution/fps picked in Vesktop's screen share picker to Discord's stream quality indicator.

Each part can be toggled in the plugin settings.

## Install

Vencord user plugins require [building Vencord from source](https://docs.vencord.dev/installing/custom-plugins/).

```sh
git clone https://github.com/ofarukaydin/vencord-force-video-codec src/userplugins/forceVideoCodec
pnpm build
```

For Vesktop, point its Vencord location (`vencordDir`) at the build's `dist` folder, then enable **ForceVideoCodec** in the plugin list.

For hardware encoding, Vesktop also needs VA-API enabled, for example in `~/.config/vesktop-flags.conf`:

```
--enable-features=AcceleratedVideoEncoder,VaapiVideoEncoder,VaapiIgnoreDriverChecks
--ignore-gpu-blocklist
```

To confirm it works while streaming, call `getStats()` on the active `RTCPeerConnection` from DevTools: the outbound video `encoderImplementation` should read `VaapiVideoEncodeAccelerator`.

## License

GPL-3.0-or-later
