// ═══════════════════════════════════════════════════════════════
// DATA WORKER STREAM :: OUTPUT MODULE
// ═══════════════════════════════════════════════════════════════

const socket = io();

// ─────────────────────────────────────────────────────────────────
// STATE
// ─────────────────────────────────────────────────────────────────

const peers = {};
const peerConnections = {};

let layoutMode = 'cctv';
let slots = [null, null, null, null, null, null];   // default 6 slots
let randomPositions = {};

// Canvas
const canvas = document.getElementById('output-canvas');
const ctx = canvas.getContext('2d');

// ─────────────────────────────────────────────────────────────────
// CANVAS SIZE
// ─────────────────────────────────────────────────────────────────

function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.floor(window.innerWidth * dpr);
    canvas.height = Math.floor(window.innerHeight * dpr);
    canvas.style.width = window.innerWidth + 'px';
    canvas.style.height = window.innerHeight + 'px';
}
window.addEventListener('resize', resize);
resize();

// ─────────────────────────────────────────────────────────────────
// SOCKET
// ─────────────────────────────────────────────────────────────────

socket.on('connect', () => {
    console.log('[OUT] Connected');
    socket.emit('join-as-output');
});

socket.on('control-command', (cmd) => {
    if (cmd.type === 'state-update') {
        layoutMode = cmd.data.layout || 'cctv';
        slots = cmd.data.slots || [];
        randomPositions = cmd.data.positions || {};
        document.body.classList.toggle('cctv-mode', layoutMode === 'cctv');
    }
    // Backward-compat for old visibility-update
    if (cmd.type === 'visibility-update') {
        layoutMode = cmd.data.layout || 'cctv';
        slots = cmd.data.visible || [];
        randomPositions = cmd.data.positions || {};
        document.body.classList.toggle('cctv-mode', layoutMode === 'cctv');
    }
});

// ─────────────────────────────────────────────────────────────────
// PEER EVENTS
// ─────────────────────────────────────────────────────────────────

socket.on('peer-joined', (data) => {
    if (peers[data.socketId]) return;
    peers[data.socketId] = { peerId: data.peerId, video: null, stream: null };
    createPC(data.socketId);
});

socket.on('peer-left', (data) => {
    removePeer(data.socketId);
});

// ─────────────────────────────────────────────────────────────────
// WEBRTC
// ─────────────────────────────────────────────────────────────────

function createPC(socketId) {
    const pc = new RTCPeerConnection({
        iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
    });

    peerConnections[socketId] = pc;

    pc.addTransceiver('video', { direction: 'recvonly' });
    pc.addTransceiver('audio', { direction: 'recvonly' });

    pc.ontrack = (e) => {
        const peer = peers[socketId];
        if (!peer) return;

        if (e.streams?.[0]) {
            peer.stream = e.streams[0];
        } else {
            if (!peer.stream) peer.stream = new MediaStream();
            peer.stream.addTrack(e.track);
        }

        if (e.track.kind === 'video') {
            const video = document.createElement('video');
            video.autoplay = true;
            video.playsInline = true;
            video.muted = true;
            video.srcObject = peer.stream;
            peer.video = video;
            video.play().catch(() => { });
        }
        // Audio ignored — no audio output
    };

    pc.onicecandidate = (e) => {
        if (e.candidate) {
            socket.emit('webrtc-ice-candidate', { target: socketId, candidate: e.candidate });
        }
    };

    pc.createOffer()
        .then(o => pc.setLocalDescription(o))
        .then(() => socket.emit('webrtc-offer', { target: socketId, offer: pc.localDescription }));
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
    delete peers[socketId];
}

// ─────────────────────────────────────────────────────────────────
// RENDER
// ─────────────────────────────────────────────────────────────────

function buildSlotData() {
    return slots.map(sid => {
        if (!sid) return null;
        const p = peers[sid];
        if (!p) return null;
        return { peerId: p.peerId, video: p.video };
    });
}

function render() {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    if (layoutMode === 'cctv') {
        const slotData = buildSlotData();
        window.CCTV.renderSlots(ctx, canvas, slotData);
    } else {
        // Legacy modes: only show actually-connected peers
        const active = slots.filter(id => id && peers[id]?.video);

        if (layoutMode === 'grid') {
            if (active.length === 0) {
                requestAnimationFrame(render);
                return;
            }
            const cols = active.length;
            const cellW = canvas.width / cols;
            const cellH = canvas.height;
            active.forEach((id, i) => {
                const video = peers[id].video;
                if (!video || video.readyState < 2) return;
                const x = i * cellW;
                const va = video.videoWidth / video.videoHeight;
                const ca = cellW / cellH;
                let dw, dh, dx, dy;
                if (va > ca) {
                    dw = cellW; dh = cellW / va; dx = x; dy = (cellH - dh) / 2;
                } else {
                    dh = cellH; dw = cellH * va; dx = x + (cellW - dw) / 2; dy = 0;
                }
                ctx.drawImage(video, dx, dy, dw, dh);
            });
        } else {
            active.forEach(id => {
                const video = peers[id].video;
                if (!video || video.readyState < 2) return;
                const pos = randomPositions[id] || { x: 0.3, y: 0.3, scale: 0.4 };
                const w = canvas.width * pos.scale;
                const h = w * (video.videoHeight / video.videoWidth);
                const x = pos.x * canvas.width;
                const y = pos.y * canvas.height;
                ctx.drawImage(video, x, y, w, h);
            });
        }
    }

    requestAnimationFrame(render);
}

// ─────────────────────────────────────────────────────────────────
// INIT
// ─────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
    console.log('[OUT] Ready');
    document.body.classList.add('cctv-mode');
    render();
});

// Fullscreen
canvas.addEventListener('dblclick', () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else canvas.requestFullscreen();
});

document.addEventListener('keydown', (e) => {
    if (e.key === 'F11') {
        e.preventDefault();
        if (document.fullscreenElement) document.exitFullscreen();
        else canvas.requestFullscreen();
    }
});
