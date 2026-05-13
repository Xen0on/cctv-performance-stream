// ═══════════════════════════════════════════════════════════════
// DATA WORKER STREAM :: CONTROL MODULE
// ═══════════════════════════════════════════════════════════════

const socket = io();

// ─────────────────────────────────────────────────────────────────
// STATE
// ─────────────────────────────────────────────────────────────────

const peers = {};              // socketId → { peerId, socketId, video, stream }
const peerConnections = {};

// Slot system: fixed-size array, each entry is socketId or null
let slotCount = 6;
let slots = new Array(slotCount).fill(null);

// Layout: 'cctv' (default), 'grid', 'random'
let layoutMode = 'cctv';
const randomPositions = {};

// DOM
const peerCountEl = document.getElementById('peer-count');
const previewCanvas = document.getElementById('preview-canvas');
const previewCtx = previewCanvas ? previewCanvas.getContext('2d') : null;
const layoutToggle = document.getElementById('layout-toggle');
const slotSelect = document.getElementById('slot-count');
const fullscreenBtn = document.getElementById('fullscreen-btn');

// ─────────────────────────────────────────────────────────────────
// CANVAS RESIZE — match container, with reasonable max
// ─────────────────────────────────────────────────────────────────

function resizeCanvas() {
    if (!previewCanvas) return;
    const container = previewCanvas.parentElement;
    const rect = container.getBoundingClientRect();
    // Use device pixel ratio for crisp rendering, capped to keep perf sane
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    previewCanvas.width = Math.floor(rect.width * dpr);
    previewCanvas.height = Math.floor(rect.height * dpr);
}
window.addEventListener('resize', resizeCanvas);

// ─────────────────────────────────────────────────────────────────
// SLOT MANAGEMENT
// ─────────────────────────────────────────────────────────────────

function findFreeSlot() {
    for (let i = 0; i < slots.length; i++) {
        if (slots[i] === null) return i;
    }
    return -1;
}

function assignSlot(socketId) {
    // Already assigned?
    const existing = slots.indexOf(socketId);
    if (existing !== -1) return existing;
    const idx = findFreeSlot();
    if (idx !== -1) slots[idx] = socketId;
    return idx;
}

function releaseSlot(socketId) {
    const idx = slots.indexOf(socketId);
    if (idx !== -1) slots[idx] = null;
}

function setSlotCount(n) {
    slotCount = n;
    const newSlots = new Array(n).fill(null);
    // Preserve existing assignments where possible
    for (let i = 0; i < Math.min(slots.length, n); i++) {
        newSlots[i] = slots[i];
    }
    // Re-assign any peers that fell off (slots beyond new count)
    for (let i = n; i < slots.length; i++) {
        const sid = slots[i];
        if (sid !== null && peers[sid]) {
            const free = newSlots.indexOf(null);
            if (free !== -1) newSlots[free] = sid;
        }
    }
    slots = newSlots;
    sendStateUpdate();
}

// Build slot data for renderer
function buildSlotData() {
    return slots.map(sid => {
        if (!sid) return null;
        const p = peers[sid];
        if (!p) return null;
        return { peerId: p.peerId, video: p.video };
    });
}

// ─────────────────────────────────────────────────────────────────
// SOCKET
// ─────────────────────────────────────────────────────────────────

socket.on('connect', () => {
    console.log('[CTRL] Connected');
    socket.emit('join-as-control');
});

socket.on('peer-joined', (data) => {
    if (peers[data.socketId]) return;

    peers[data.socketId] = {
        peerId: data.peerId,
        socketId: data.socketId,
        video: null,
        stream: null
    };

    randomPositions[data.socketId] = {
        x: Math.random() * 0.7,
        y: Math.random() * 0.6,
        scale: 0.25 + Math.random() * 0.35
    };

    assignSlot(data.socketId);
    createPeerConnection(data.socketId, data.peerId);
    updatePeerCount();
    sendStateUpdate();
});

socket.on('peer-left', (data) => {
    removePeer(data.socketId);
    updatePeerCount();
    sendStateUpdate();
});

// ─────────────────────────────────────────────────────────────────
// WEBRTC (video only — audio ignored on control side)
// ─────────────────────────────────────────────────────────────────

function createPeerConnection(socketId, peerId) {
    const pc = new RTCPeerConnection(window.ICE_CONFIG);

    peerConnections[socketId] = pc;

    pc.addTransceiver('video', { direction: 'recvonly' });
    pc.addTransceiver('audio', { direction: 'recvonly' });

    pc.ontrack = (event) => {
        const peer = peers[socketId];
        if (!peer) return;

        if (event.streams?.[0]) {
            peer.stream = event.streams[0];
        } else {
            if (!peer.stream) peer.stream = new MediaStream();
            peer.stream.addTrack(event.track);
        }

        if (event.track.kind === 'video') {
            const video = document.createElement('video');
            video.autoplay = true;
            video.playsInline = true;
            video.muted = true;
            video.srcObject = peer.stream;
            peer.video = video;
            video.play().catch(() => { });
        }
        // Audio is ignored — operator runs silent
    };

    pc.onicecandidate = (e) => {
        if (e.candidate) {
            socket.emit('webrtc-ice-candidate', { target: socketId, candidate: e.candidate });
        }
    };

    pc.createOffer()
        .then(offer => pc.setLocalDescription(offer))
        .then(() => {
            socket.emit('webrtc-offer', { target: socketId, offer: pc.localDescription });
        });
}

socket.on('webrtc-answer', async (data) => {
    const pc = peerConnections[data.from];
    if (pc) await pc.setRemoteDescription(new RTCSessionDescription(data.answer));
});

socket.on('webrtc-ice-candidate', async (data) => {
    const pc = peerConnections[data.from];
    if (pc) try { await pc.addIceCandidate(new RTCIceCandidate(data.candidate)); } catch (e) { }
});

// ─────────────────────────────────────────────────────────────────
// CLEANUP
// ─────────────────────────────────────────────────────────────────

function removePeer(socketId) {
    if (peerConnections[socketId]) {
        peerConnections[socketId].close();
        delete peerConnections[socketId];
    }
    releaseSlot(socketId);
    delete peers[socketId];
    delete randomPositions[socketId];
}

function updatePeerCount() {
    if (peerCountEl) peerCountEl.textContent = Object.keys(peers).length;
}

// ─────────────────────────────────────────────────────────────────
// SEND STATE TO OUTPUT
// ─────────────────────────────────────────────────────────────────

function sendStateUpdate() {
    socket.emit('control-command', {
        type: 'state-update',
        data: {
            layout: layoutMode,
            slots: slots,            // array of socketId|null
            slotCount: slotCount,
            positions: randomPositions
        }
    });
}

// ─────────────────────────────────────────────────────────────────
// LAYOUT TOGGLE
// ─────────────────────────────────────────────────────────────────

const LAYOUT_CYCLE = ['cctv', 'grid', 'random'];

function toggleLayout() {
    const idx = LAYOUT_CYCLE.indexOf(layoutMode);
    layoutMode = LAYOUT_CYCLE[(idx + 1) % LAYOUT_CYCLE.length];

    if (layoutToggle) {
        layoutToggle.textContent = '[ ' + layoutMode.toUpperCase() + ' ]';
    }

    if (layoutMode === 'random') {
        for (const socketId in peers) {
            randomPositions[socketId] = {
                x: Math.random() * 0.7,
                y: Math.random() * 0.6,
                scale: 0.25 + Math.random() * 0.35
            };
        }
    }

    sendStateUpdate();
}

// ─────────────────────────────────────────────────────────────────
// PREVIEW RENDER
// ─────────────────────────────────────────────────────────────────

function renderPreview() {
    if (!previewCanvas || !previewCtx) {
        requestAnimationFrame(renderPreview);
        return;
    }

    previewCtx.fillStyle = '#000';
    previewCtx.fillRect(0, 0, previewCanvas.width, previewCanvas.height);

    if (layoutMode === 'cctv') {
        const slotData = buildSlotData();
        window.CCTV.renderSlots(previewCtx, previewCanvas, slotData);
    } else {
        // Legacy modes use only filled slots / connected peers
        const visible = slots.filter(s => s && peers[s]?.video);

        if (layoutMode === 'grid') {
            const cols = visible.length;
            if (cols === 0) {
                requestAnimationFrame(renderPreview);
                return;
            }
            const cellWidth = previewCanvas.width / cols;
            const cellHeight = previewCanvas.height;

            visible.forEach((id, i) => {
                const video = peers[id].video;
                if (!video || video.readyState < 2) return;

                const x = i * cellWidth;
                const vAspect = video.videoWidth / video.videoHeight;
                const cAspect = cellWidth / cellHeight;

                let dw, dh, dx, dy;
                if (vAspect > cAspect) {
                    dw = cellWidth; dh = cellWidth / vAspect; dx = x; dy = (cellHeight - dh) / 2;
                } else {
                    dh = cellHeight; dw = cellHeight * vAspect; dx = x + (cellWidth - dw) / 2; dy = 0;
                }
                previewCtx.drawImage(video, dx, dy, dw, dh);
            });
        } else {
            visible.forEach(id => {
                const video = peers[id].video;
                if (!video || video.readyState < 2) return;
                const pos = randomPositions[id] || { x: 0.5, y: 0.5, scale: 0.3 };
                const w = previewCanvas.width * pos.scale;
                const h = w * (video.videoHeight / video.videoWidth);
                const x = pos.x * previewCanvas.width;
                const y = pos.y * previewCanvas.height;
                previewCtx.drawImage(video, x, y, w, h);
            });
        }
    }

    requestAnimationFrame(renderPreview);
}

// ─────────────────────────────────────────────────────────────────
// INIT
// ─────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
    console.log('[CTRL] Ready');

    resizeCanvas();

    if (layoutToggle) {
        layoutToggle.addEventListener('click', toggleLayout);
        layoutToggle.textContent = '[ ' + layoutMode.toUpperCase() + ' ]';
    }

    if (slotSelect) {
        slotSelect.addEventListener('change', (e) => {
            setSlotCount(parseInt(e.target.value, 10));
        });
    }

    if (fullscreenBtn) {
        fullscreenBtn.addEventListener('click', () => {
            if (document.fullscreenElement) document.exitFullscreen();
            else document.documentElement.requestFullscreen();
        });
    }

    // Push initial state so output knows slot config even before peers join
    sendStateUpdate();

    renderPreview();
});
