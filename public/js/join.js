// ═══════════════════════════════════════════════════════════════
// DATA WORKER STREAM :: CONNECT MODULE
// ═══════════════════════════════════════════════════════════════

const socket = io();

// ─────────────────────────────────────────────────────────────────
// STATE
// ─────────────────────────────────────────────────────────────────

let localStream = null;          // Raw camera (full quality)
let canvasStream = null;         // Canvas-processed stream (for effects)
let currentFacingMode = 'user';
let isConnected = false;
let myPeerId = null;
const peerConnections = {};

// Effect mode: 'normal' | 'thermal' | 'surveillance'
let mode = 'normal';
let effectLoopRunning = false;

// Canvas processing
let sourceVideo = null;
let processCanvas = null;        // Hidden canvas where effect is rendered
let processCtx = null;

// Target bitrate for WebRTC video (4 Mbps — solid HD)
const TARGET_BITRATE = 4_000_000;

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

// Tried in order — stop at the first one that works
const VIDEO_TIERS = [
    { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } },
    { width: { ideal: 1280 }, height: { ideal: 720 },  frameRate: { ideal: 30 } },
    { width: { ideal: 854 },  height: { ideal: 480 },  frameRate: { ideal: 30 } },
    { } // last resort: whatever the device gives
];

async function getCameraStreamWithFallback(facingMode) {
    let lastError = null;
    for (const tier of VIDEO_TIERS) {
        // Try with facingMode first
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
    // Absolute last resort: video:true, audio:true
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

        localStream = await getCameraStreamWithFallback(currentFacingMode);

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
    console.log('[JOIN] Socket connected');
});

socket.on('peer-id-assigned', (data) => {
    myPeerId = data.peerId;
    isConnected = true;

    setStatus('CONNECTED :: ' + myPeerId, 'online');

    if (peerIdDisplay) peerIdDisplay.textContent = myPeerId;
    if (connectBtn) {
        connectBtn.textContent = '[ CONNECTED ]';
        connectBtn.classList.add('connected');
    }

    const peerLine = document.querySelector('.peer-line');
    if (peerLine) peerLine.style.display = 'block';
});

// ─────────────────────────────────────────────────────────────────
// WEBRTC SIGNALING
// ─────────────────────────────────────────────────────────────────

async function boostBitrate(pc) {
    const sender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
    if (!sender) return;
    try {
        const params = sender.getParameters();
        if (!params.encodings || params.encodings.length === 0) {
            params.encodings = [{}];
        }
        params.encodings[0].maxBitrate = TARGET_BITRATE;
        params.encodings[0].maxFramerate = 30;
        await sender.setParameters(params);
        console.log('[JOIN] Bitrate boosted to', TARGET_BITRATE);
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

socket.on('disconnect', () => {
    isConnected = false;
    setStatus('DISCONNECTED', 'error');
    if (connectBtn) {
        connectBtn.disabled = false;
        connectBtn.textContent = '[ CONNECT ]';
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
});
