/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType } from "@utils/types";
import { FluxDispatcher } from "@webpack/common";

// Discord's voice gateway (op 1 SELECT_PROTOCOL) carries the client's video codec
// list with priorities (lower = preferred); the server picks the codec from it.
// Chromium's VA-API encoder handles VP9/AV1 but not H264, so preferring them moves
// screen share/camera encoding onto the GPU.
//
// The web client only extracts H264/VP8/VP9 from Chromium's SDP, so AV1 is never
// offered; the patch below adds it to that list (Chromium already negotiates AV1).
//
// Vesktop also assumes 16:9 when turning the picked stream height into capture
// constraints and encoder limits, which caps ultrawide sources (5120x2160 -> 3840x1620),
// and never tells Discord which quality was picked, so Discord's stream quality
// indicator keeps showing its persisted setting. Both are corrected here.

const logger = new Logger("ForceVideoCodec");

const settings = definePluginSettings({
    preferredCodec: {
        type: OptionType.SELECT,
        description: "Video codec to rank first when joining voice / starting a stream",
        options: [
            { label: "AV1 (VA-API hardware encode)", value: "AV1", default: true },
            { label: "VP9 (VA-API hardware encode)", value: "VP9" },
            { label: "H264", value: "H264" },
            { label: "VP8", value: "VP8" }
        ]
    },
    nativeAspectRatio: {
        type: OptionType.BOOLEAN,
        description: "Size screen share to the source's aspect ratio instead of 16:9 (full width on ultrawide monitors)",
        default: true
    },
    syncQualityIndicator: {
        type: OptionType.BOOLEAN,
        description: "Report the resolution/fps picked in Vesktop's screen share picker to Discord's stream quality indicator",
        default: true
    }
});

const FALLBACK_ORDER = ["AV1", "VP9", "H264", "VP8"];
const SIXTEEN_NINE = 16 / 9;
// Discord's stream resolution enum has no 2160 entry; anything above 1440 is "Source"
const DISCORD_RESOLUTIONS = [480, 720, 1080, 1440];
const PRESET_CUSTOM = 3;

let originalSend: typeof WebSocket.prototype.send | null = null;
let originalApplyConstraints: typeof MediaStreamTrack.prototype.applyConstraints | null = null;
let originalPatchStreamQuality: ((opts: any) => any) | null = null;
let globalsTimer: ReturnType<typeof setInterval> | null = null;
let lastSourceAspect: number | null = null;

function rewriteCodecs(data: string) {
    const msg = JSON.parse(data);
    if (msg.op !== 1 || !Array.isArray(msg.d?.codecs)) return data;

    const preferred = settings.store.preferredCodec;
    const order = [preferred, ...FALLBACK_ORDER.filter(c => c !== preferred)];
    for (const codec of msg.d.codecs) {
        if (codec.type === "video" && order.includes(codec.name))
            codec.priority = 1000 * (order.indexOf(codec.name) + 1);
    }

    logger.info("Codec priorities:", msg.d.codecs.filter((c: any) => c.type === "video").map((c: any) => `${c.name}=${c.priority}`).join(" "));
    return JSON.stringify(msg);
}

function streamAspect() {
    return Math.max(SIXTEEN_NINE, lastSourceAspect ?? screen.width / screen.height);
}

// Vesktop calls this once right after getDisplayMedia, with width = height * 16/9.
// The track's current settings already reflect Discord's 16:9 getDisplayMedia request,
// so the native source size has to come from its capabilities.
function fixCaptureConstraints(track: MediaStreamTrack, constraints: MediaTrackConstraints & { resizeMode?: string; }) {
    if (!track.getSettings().displaySurface || constraints.resizeMode !== "none") return;

    const caps = track.getCapabilities();
    const sourceWidth = caps.width?.max;
    const sourceHeight = caps.height?.max;
    const height = (constraints.height as ConstrainULongRange | undefined)?.max;
    if (!sourceWidth || !sourceHeight || !height) return;

    const aspect = sourceWidth / sourceHeight;
    lastSourceAspect = aspect;
    if (aspect <= SIXTEEN_NINE + 0.01) return;

    const width = Math.round(height * aspect);
    constraints.width = { min: 640, ideal: width, max: width };
    constraints.advanced = [{ width, height }];
    logger.info(`Capture constraints widened to ${width}x${height} (source ${sourceWidth}x${sourceHeight})`);
}

function fixStreamQuality(opts: any) {
    if (settings.store.nativeAspectRatio) {
        const aspect = streamAspect();
        for (const target of [opts?.capture, opts?.encode]) {
            if (!target?.height) continue;
            target.width = Math.round(target.height * aspect);
            target.pixelCount = target.width * target.height;
        }
    }

    if (settings.store.syncQualityIndicator && opts?.capture?.height) {
        const { height, framerate } = opts.capture;
        const resolution = DISCORD_RESOLUTIONS.includes(height) ? height : 0;
        // getDefaultGoliveQuality runs inside a store update, so dispatch afterwards
        setTimeout(() => FluxDispatcher.dispatch({ type: "STREAM_UPDATE_SETTINGS", preset: PRESET_CUSTOM, resolution, frameRate: framerate }));
    }

    return opts;
}

function hookVesktopGlobals() {
    const globals = (window as any).VesktopPatchGlobals;
    if (typeof globals?.patchStreamQuality !== "function") return false;

    originalPatchStreamQuality = globals.patchStreamQuality;
    const original = originalPatchStreamQuality!;
    globals.patchStreamQuality = (opts: any) => fixStreamQuality(original(opts));
    return true;
}

export default definePlugin({
    name: "ForceVideoCodec",
    description: "Ranks a chosen video codec first in Discord's voice codec negotiation (AV1 by default), offers AV1 on the web client, and fixes Vesktop stream sizing on ultrawide screens",
    authors: [{ name: "faruk", id: 0n }],
    settings,

    patches: [
        {
            find: "Unable to find a unique rtx SSRC!",
            replacement: {
                match: /(\i\.\i\.H264,\i\.\i\.VP8,\i\.\i\.VP9)\]/g,
                replace: '$1,"AV1"]'
            }
        }
    ],

    start() {
        originalSend = WebSocket.prototype.send;
        const send = originalSend;
        WebSocket.prototype.send = function (this: WebSocket, data) {
            if (typeof data === "string" && this.url.includes("discord.media")) {
                try {
                    data = rewriteCodecs(data);
                } catch (e) {
                    logger.error("Failed to rewrite voice payload", e);
                }
            }
            return send.call(this, data);
        };

        originalApplyConstraints = MediaStreamTrack.prototype.applyConstraints;
        const applyConstraints = originalApplyConstraints;
        MediaStreamTrack.prototype.applyConstraints = function (this: MediaStreamTrack, constraints) {
            if (constraints && this.kind === "video" && settings.store.nativeAspectRatio) {
                try {
                    fixCaptureConstraints(this, constraints);
                } catch (e) {
                    logger.error("Failed to fix capture constraints", e);
                }
            }
            return applyConstraints.call(this, constraints);
        };

        // Vesktop's renderer may set up its patch globals after Vencord starts plugins
        if (!hookVesktopGlobals()) {
            let tries = 0;
            globalsTimer = setInterval(() => {
                if (hookVesktopGlobals() || ++tries > 60) {
                    clearInterval(globalsTimer!);
                    globalsTimer = null;
                }
            }, 500);
        }
    },

    stop() {
        if (originalSend) WebSocket.prototype.send = originalSend;
        if (originalApplyConstraints) MediaStreamTrack.prototype.applyConstraints = originalApplyConstraints;
        if (originalPatchStreamQuality) (window as any).VesktopPatchGlobals.patchStreamQuality = originalPatchStreamQuality;
        if (globalsTimer) clearInterval(globalsTimer);
        originalSend = null;
        originalApplyConstraints = null;
        originalPatchStreamQuality = null;
        globalsTimer = null;
    }
});
