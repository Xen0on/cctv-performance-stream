// ═══════════════════════════════════════════════════════════════
// DATA WORKER STREAM :: CONNECT MODULE
// ═══════════════════════════════════════════════════════════════

// Socket with automatic reconnection (defaults: forever, exponential backoff)
const socket = io({
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
    reconnectionAttempts: Infinity
});

// ─────────────────────────────────────────────────────────────────
// STATE
// ─────────────────────────────────────────────────────────────────

let localStream = null;          // Raw camera (full quality)
let canvasStream = null;         // Canvas-processed stream (for effects)
let currentFacingMode = 'user';
let isConnected = false;
let hasJoinedBefore = false;     // Has this client ever successfully joined?
let myPeerId = null;
const peerConnections = {};
let wakeLock = null;

// Effect mode: 'normal' | 'thermal' | 'surveillance'
let mode = 'normal';
let effectLoopRunning = false;

// Quality preset: 'low' | 'med' | 'high'
// MED (720p@20fps@1.5Mbps) is default — friendly to hotspot, authentic CCTV look
let qualityPreset = 'med';

const QUALITY_PRESETS = {
    low:  { width: 640,  height: 480,  frameRate: 15, bitrate:  800_000 },
    med:  { width: 1280, height: 720,  frameRate: 20, bitrate: 1_500_000 },
    high: { width: 1920, height: 1080, frameRate: 30, bitrate: 3_500_000 }
};

// Canvas processing
let sourceVideo = null;
let processCanvas = null;        // Hidden canvas where effect is rendered
let processCtx = null;

// ─────────────────────────────────────────────────────────────────
// DOM
// ─────────────────────────────────────────────────────────────────

const previewVideo = document.getElementById('preview-video');
const previewCanvas = document.getElementById('preview-canvas');
const previewCtx = previewCanvas ? previewCanvas.getContext('2d', { willReadFrequently: true }) : null;
const connectBtn = document.getElementById('connect-btn');
const statusText = document.getElementById('status-text');
const statusDot = document.getElementById('status-dot');
const peerIdDisplay = document.getElementById('peer-id');
const modeBar = document.getElementById('mode-bar');
const qualityBar = document.getElementById('quality-bar');

// ─────────────────────────────────────────────────────────────────
// WAKE LOCK — keep screen on during streaming (critical for performance)
// ─────────────────────────────────────────────────────────────────

async function acquireWakeLock() {
    if (!('wakeLock' in navigator)) {
        console.warn('[JOIN] Wake Lock API not supported on this browser');
        return;
    }
    try {
        if (wakeLock && !wakeLock.released) return; // already held
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => {
            console.log('[JOIN] Wake lock released');
        });
        console.log('[JOIN] Wake lock acquired — screen will stay on');
    } catch (e) {
        console.warn('[JOIN] Wake lock failed:', e.name, e.message);
    }
}

// Re-acquire wake lock when page becomes visible again (iOS releases on background)
document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'visible' && isConnected) {
        await acquireWakeLock();
    }
});

// ─────────────────────────────────────────────────────────────────
// THERMAL COLOR PALETTE (Orange/Amber)
// ─────────────────────────────────────────────────────────────────

const thermalLUT = new Uint8Array(256 * 3);

function buildThermalLUT() {
    const palette = [
        { pos: 0.0, r: 0,   g: 0,   b: 0 },
        { pos: 0.2, r: 40,  g: 10,  b: 0 },
        { pos: 0.4, r: 120, g: 40,  b: 0 },
        { pos: 0.6, r: 200, g: 80,  b: 0 },
        { pos: 0.8, r: 255, g: 150, b: 20 },
        { pos: 1.0, r: 255, g: 255, b: 200 }
    ];

    for (let i = 0; i < 256; i++) {
        const t = i / 255;
        let r = 0, g = 0, b = 0;
        for (let j = 0; j < palette.length - 1; j++) {
            if (t >= palette[j].pos && t <= palette[j + 1].pos) {
                const range = palette[j + 1].pos - palette[j].pos;
                const local = (t - palette[j].pos) / range;
                r = palette[j].r + (palette[j + 1].r - palette[j].r) * local;
                g = palette[j].g + (palette[j + 1].g - palette[j].g) * local;
                b = palette[j].b + (palette[j + 1].b - palette[j].b) * local;
                break;
            }
        }
        thermalLUT[i * 3]     = Math.round(r);
        thermalLUT[i * 3 + 1] = Math.round(g);
        thermalLUT[i * 3 + 2] = Math.round(b);
    }
}

buildThermalLUT();

// ─────────────────────────────────────────────────────────────────
// EFFECTS
// ─────────────────────────────────────────────────────────────────

function applyThermal(data) {
    for (let i = 0; i < data.length; i += 4) {
        const gray = (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]) | 0;
        data[i]     = thermalLUT[gray * 3];
        data[i + 1] = thermalLUT[gray * 3 + 1];
        data[i + 2] = thermalLUT[gray * 3 + 2];
    }
}

function applySurveillance(data, w, h) {
    // Grayscale + boosted contrast + slight noise
    const contrast = 1.35;
    const intercept = 128 * (1 - contrast);
    for (let i = 0; i < data.length; i += 4) {
        let g = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
        g = g * contrast + intercept;
        // Subtle film noise
        g += (Math.random() - 0.5) * 14;
        if (g < 0) g = 0; else if (g > 255) g = 255;
        const v = g | 0;
        data[i] = v;
        data[i + 1] = v;
        data[i + 2] = v;
    }
}

function drawVignette(ctx, w, h) {
    const grad = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.3, w / 2, h / 2, Math.max(w, h) * 0.7);
    grad.addColorStop(0, 'rgba(0,0,0,0)');
    grad.addColorStop(1, 'rgba(0,0,0,0.65)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);
}

// ─────────────────────────────────────────────────────────────────
// PROCESSING LOOP (only runs when an effect is active)
// ─────────────────────────────────────────────────────────────────

function processFrame() {
    if (!effectLoopRunning) return;
    if (!sourceVideo || !processCtx || sourceVideo.readyState < 2) {
        requestAnimationFrame(processFrame);
        return;
    }

    const w = processCanvas.width;
    const h = processCanvas.height;

    processCtx.drawImage(sourceVideo, 0, 0, w, h);

    if (mode === 'thermal') {
        const imageData = processCtx.getImageData(0, 0, w, h);
        applyThermal(imageData.data);
        processCtx.putImageData(imageData, 0, 0);
    } else if (mode === 'surveillance') {
        const imageData = processCtx.getImageData(0, 0, w, h);
        applySurveillance(imageData.data, w, h);
        processCtx.putImageData(imageData, 0, 0);
        drawVignette(processCtx, w, h);
    }

    // Mirror to visible preview canvas
    if (previewCtx && previewCanvas.style.display !== 'none') {
        previewCtx.drawImage(processCanvas, 0, 0, previewCanvas.width, previewCanvas.height);
    }

    requestAnimationFrame(processFrame);
}

function startEffectLoop() {
    if (effectLoopRunning) return;
    effectLoopRunning = true;
    requestAnimationFrame(processFrame);
}

function stopEffectLoop() {
    effectLoopRunning = false;
}

// ─────────────────────────────────────────────────────────────────
// MODE SWITCHING
// ─────────────────────────────────────────────────────────────────

function getActiveVideoTrack() {
    if (mode === 'normal') {
        return localStream ? localStream.getVideoTracks()[0] : null;
    }
    return canvasStream ? canvasStream.getVideoTracks()[0] : null;
}

async function setMode(newMode) {
    if (newMode === mode) return;
    mode = newMode;
    console.log('[JOIN] Mode →', mode);

    // UI: update button states
    document.querySelectorAll('.mode-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.mode === mode);
    });

    // UI: toggle preview element
    if (mode === 'normal') {
        if (previewVideo) previewVideo.style.display = 'block';
        if (previewCanvas) previewCanvas.style.display = 'none';
        stopEffectLoop();
    } else {
        if (previewVideo) previewVideo.style.display = 'none';
        if (previewCanvas) previewCanvas.style.display = 'block';
        startEffectLoop();
    }

    // Swap track in all active peer connections
    const newTrack = getActiveVideoTrack();
    if (!newTrack) return;

    for (const id in peerConnections) {
        const pc = peerConnections[id];
        const sender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
        if (sender) {
            try {
                await sender.replaceTrack(newTrack);
            } catch (e) {
                console.warn('[JOIN] replaceTrack failed:', e);
            }
        }
    }
}

// ─────────────────────────────────────────────────────────────────
// MEDIA CONSTRAINTS — progressive fallback for picky devices (iOS!)
// ─────────────────────────────────────────────────────────────────

const AUDIO_CONSTRAINTS = {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false
};

function buildVideoTiers(preset) {
    // Try the preset first, then fall back to lower tiers if camera rejects
    const p = QUALITY_PRESETS[preset] || QUALITY_PRESETS.med;
    const tiers = [
        { width: { ideal: p.width },  height: { ideal: p.height }, frameRate: { ideal: p.frameRate } }
    ];
    if (p.width > 1280) tiers.push({ width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 20 } });
    if (p.width > 640)  tiers.push({ width: { ideal: 640 },  height: { ideal: 480 }, frameRate: { ideal: 15 } });
    tiers.push({}); // last resort: anything
    return tiers;
}

async function getCameraStreamWithFallback(facingMode, preset) {
    const tiers = buildVideoTiers(preset);
    let lastError = null;
    for (const tier of tiers) {
        try {
            return await navigator.mediaDevices.getUserMedia({
                video: { ...tier, facingMode },
                audio: AUDIO_CONSTRAINTS
            });
        } catch (e) {
            lastError = e;
            console.warn('[JOIN] getUserMedia tier failed:', tier, e.name);
        }
        // Some iPhones reject facingMode constraint specifically — retry without it
        try {
            return await navigator.mediaDevices.getUserMedia({
                video: tier,
                audio: AUDIO_CONSTRAINTS
            });
        } catch (e) {
            lastError = e;
        }
    }
    try {
        return await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    } catch (e) {
        throw lastError || e;
    }
}

// ─────────────────────────────────────────────────────────────────
// STATUS UPDATE
// ─────────────────────────────────────────────────────────────────

function setStatus(text, state) {
    if (statusText) statusText.textContent = text;
    if (statusDot) {
        statusDot.className = 'dot';
        if (state === 'online') statusDot.classList.add('online');
        else if (state === 'connecting') statusDot.classList.add('connecting');
    }
    console.log('[JOIN]', text);
}

// ─────────────────────────────────────────────────────────────────
// GET CAMERA
// ─────────────────────────────────────────────────────────────────

async function getCamera() {
    try {
        setStatus('ACCESSING_CAMERA...', 'connecting');

        if (localStream) {
            localStream.getTracks().forEach(t => t.stop());
        }

        localStream = await getCameraStreamWithFallback(currentFacingMode, qualityPreset);

        const settings = localStream.getVideoTracks()[0].getSettings();
        console.log('[JOIN] Camera OK:', settings.width + 'x' + settings.height + '@' + settings.frameRate + 'fps');

        // Hidden source video element (used by canvas effects)
        if (sourceVideo) sourceVideo.remove();
        sourceVideo = document.createElement('video');
        sourceVideo.srcObject = localStream;
        sourceVideo.autoplay = true;
        sourceVideo.playsInline = true;
        sourceVideo.muted = true;
        sourceVideo.style.display = 'none';
        document.body.appendChild(sourceVideo);

        await new Promise(r => sourceVideo.onloadedmetadata = r);
        await sourceVideo.play();

        // Visible preview <video> (for normal mode)
        if (previewVideo) {
            previewVideo.srcObject = localStream;
            previewVideo.style.display = 'block';
        }

        // Hidden processing canvas — sized to camera resolution (capped at 1280x720 for perf)
        const srcW = settings.width || 1280;
        const srcH = settings.height || 720;
        const procW = Math.min(srcW, 1280);
        const procH = Math.round(procW * (srcH / srcW));

        if (!processCanvas) {
            processCanvas = document.createElement('canvas');
            processCtx = processCanvas.getContext('2d', { willReadFrequently: true });
        }
        processCanvas.width = procW;
        processCanvas.height = procH;

        // Visible preview canvas — match aspect, smaller resolution to keep DOM light
        if (previewCanvas) {
            previewCanvas.width = 480;
            previewCanvas.height = Math.round(480 * (srcH / srcW));
        }

        // Persistent canvas stream for effect modes (lazy: created once, reused)
        if (!canvasStream) {
            canvasStream = processCanvas.captureStream(30);
            const audioTrack = localStream.getAudioTracks()[0];
            if (audioTrack) canvasStream.addTrack(audioTrack);
        }

        // Show mode bar
        if (modeBar) modeBar.style.display = 'flex';

        setStatus('CAMERA_READY', 'online');
        return true;

    } catch (err) {
        console.error('[JOIN] Camera error:', err);
        const tip = err.name === 'NotAllowedError'
            ? 'Pozwól na dostęp do kamery w ustawieniach Safari.'
            : err.name === 'NotReadableError'
                ? 'Kamera jest używana przez inną aplikację. Zamknij ją i spróbuj ponownie.'
                : err.name === 'OverconstrainedError'
                    ? 'Kamera nie wspiera tej rozdzielczości.'
                    : err.message;
        setStatus('ERR: ' + err.name, 'error');
        alert('Camera error (' + err.name + '): ' + tip);
        return false;
    }
}

// ─────────────────────────────────────────────────────────────────
// CONNECT
// ─────────────────────────────────────────────────────────────────

async function connect() {
    if (isConnected) return;
    if (connectBtn) connectBtn.disabled = true;

    const ok = await getCamera();
    if (!ok) {
        if (connectBtn) connectBtn.disabled = false;
        return;
    }

    setStatus('CONNECTING...', 'connecting');
    socket.emit('join-as-peer', { camera: currentFacingMode });
}

// ─────────────────────────────────────────────────────────────────
// SOCKET EVENTS
// ─────────────────────────────────────────────────────────────────

socket.on('connect', () => {
    console.log('[JOIN] Socket connected, id=', socket.id);
    // If we'd already joined before (socket reconnect), automatically re-join
    if (hasJoinedBefore && localStream) {
        console.log('[JOIN] Auto re-joining after reconnect');
        setStatus('RECONNECTING...', 'connecting');
        socket.emit('join-as-peer', { camera: currentFacingMode });
    }
});

socket.on('peer-id-assigned', async (data) => {
    myPeerId = data.peerId;
    isConnected = true;
    hasJoinedBefore = true;

    setStatus('CONNECTED :: ' + myPeerId, 'online');

    if (peerIdDisplay) peerIdDisplay.textContent = myPeerId;
    if (connectBtn) {
        connectBtn.textContent = '[ CONNECTED ]';
        connectBtn.classList.add('connected');
    }

    const peerLine = document.querySelector('.peer-line');
    if (peerLine) peerLine.style.display = 'block';

    // Lock screen on so phone doesn't sleep during streaming
    await acquireWakeLock();
});

// ─────────────────────────────────────────────────────────────────
// WEBRTC SIGNALING
// ─────────────────────────────────────────────────────────────────

async function boostBitrate(pc) {
    const sender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
    if (!sender) return;
    const preset = QUALITY_PRESETS[qualityPreset] || QUALITY_PRESETS.med;
    try {
        const params = sender.getParameters();
        if (!params.encodings || params.encodings.length === 0) {
            params.encodings = [{}];
        }
        params.encodings[0].maxBitrate = preset.bitrate;
        params.encodings[0].maxFramerate = preset.frameRate;
        await sender.setParameters(params);
        console.log('[JOIN] Bitrate set to', preset.bitrate, 'bps');
    } catch (e) {
        console.warn('[JOIN] setParameters failed:', e);
    }
}

socket.on('webrtc-offer', async (data) => {
    console.log('[JOIN] Offer from:', data.from);

    if (!localStream) {
        console.error('[JOIN] No camera stream!');
        return;
    }

    try {
        const pc = new RTCPeerConnection(window.ICE_CONFIG);

        peerConnections[data.from] = pc;

        // Send video track based on current mode
        const videoTrack = getActiveVideoTrack();
        if (videoTrack) {
            pc.addTrack(videoTrack, localStream);
        }
        // Always send raw audio from camera
        const audioTrack = localStream.getAudioTracks()[0];
        if (audioTrack) {
            pc.addTrack(audioTrack, localStream);
        }

        pc.onicecandidate = (e) => {
            if (e.candidate) {
                socket.emit('webrtc-ice-candidate', {
                    target: data.from,
                    candidate: e.candidate
                });
            }
        };

        pc.oniceconnectionstatechange = () => {
            console.log('[JOIN] ICE:', pc.iceConnectionState);
            if (pc.iceConnectionState === 'connected') {
                setStatus('STREAMING :: ' + myPeerId, 'online');
            } else if (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'disconnected') {
                setStatus('LINK_LOST', 'error');
            }
        };

        await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);

        socket.emit('webrtc-answer', {
            target: data.from,
            answer: answer
        });

        // Boost bitrate after negotiation
        await boostBitrate(pc);

        console.log('[JOIN] Answer sent');

    } catch (err) {
        console.error('[JOIN] WebRTC error:', err);
    }
});

socket.on('webrtc-ice-candidate', async (data) => {
    const pc = peerConnections[data.from];
    if (pc) {
        try {
            await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
        } catch (e) { }
    }
});

socket.on('disconnect', (reason) => {
    isConnected = false;
    console.log('[JOIN] Socket disconnected:', reason);
    setStatus('RECONNECTING...', 'connecting');
    // Tear down stale peer connections — socket.io will reconnect and trigger fresh offers
    for (const id in peerConnections) {
        try { peerConnections[id].close(); } catch (e) { }
        delete peerConnections[id];
    }
    // Keep button label as "CONNECTED" since we're trying to recover automatically
});

socket.io.on('reconnect_attempt', (attempt) => {
    console.log('[JOIN] Reconnect attempt #' + attempt);
});

socket.io.on('reconnect_failed', () => {
    console.error('[JOIN] Reconnect failed completely');
    setStatus('LINK_LOST :: TAP CONNECT', 'error');
    if (connectBtn) {
        connectBtn.disabled = false;
        connectBtn.textContent = '[ RECONNECT ]';
        connectBtn.classList.remove('connected');
    }
});

// ─────────────────────────────────────────────────────────────────
// INIT
// ─────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
    console.log('[JOIN] Ready');

    if (location.protocol !== 'https:' && location.hostname !== 'localhost') {
        setStatus('ERR: HTTPS REQUIRED', 'error');
    }

    if (connectBtn) {
        connectBtn.addEventListener('click', connect);
    }

    document.querySelectorAll('.mode-btn').forEach(btn => {
        btn.addEventListener('click', () => setMode(btn.dataset.mode));
    });

    document.querySelectorAll('.qual-btn').forEach(btn => {
        btn.addEventListener('click', () => setQuality(btn.dataset.quality));
    });
});

// ─────────────────────────────────────────────────────────────────
// QUALITY PRESET — can be changed before OR after connect
// ─────────────────────────────────────────────────────────────────

async function setQuality(newPreset) {
    if (newPreset === qualityPreset) return;
    if (!QUALITY_PRESETS[newPreset]) return;
    qualityPreset = newPreset;
    console.log('[JOIN] Quality →', qualityPreset);

    document.querySelectorAll('.qual-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.quality === qualityPreset);
    });

    // If we're already streaming, re-acquire camera at new resolution
    if (localStream) {
        try {
            const newStream = await getCameraStreamWithFallback(currentFacingMode, qualityPreset);
            // Replace tracks on all peer connections without re-negotiation
            const newVideo = newStream.getVideoTracks()[0];
            const newAudio = newStream.getAudioTracks()[0];

            for (const id in peerConnections) {
                const pc = peerConnections[id];
                pc.getSenders().forEach(async (s) => {
                    if (!s.track) return;
                    if (s.track.kind === 'video' && newVideo && mode === 'normal') {
                        try { await s.replaceTrack(newVideo); } catch (e) { }
                    }
                    if (s.track.kind === 'audio' && newAudio) {
                        try { await s.replaceTrack(newAudio); } catch (e) { }
                    }
                });
                await boostBitrate(pc);
            }

            // Update source video for effects + preview
            if (sourceVideo) sourceVideo.srcObject = newStream;
            if (previewVideo) previewVideo.srcObject = newStream;

            // Stop old stream tracks
            localStream.getTracks().forEach(t => t.stop());
            localStream = newStream;
        } catch (e) {
            console.warn('[JOIN] Quality change failed:', e);
        }
    }
}
