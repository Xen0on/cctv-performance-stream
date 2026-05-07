const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const os = require('os');

const app = express();

// ========================================
// CONFIG
// ========================================

// In cloud (Render/Railway/Fly): PORT is provided as env var, HTTPS handled by platform.
// Locally: defaults to 3000 — but for direct phone access on local network you need HTTPS.
//          Set USE_LOCAL_SSL=1 to enable self-signed HTTPS server on LOCAL_HTTPS_PORT.
const PORT = parseInt(process.env.PORT, 10) || 3000;
const USE_LOCAL_SSL = process.env.USE_LOCAL_SSL === '1';
const LOCAL_HTTPS_PORT = parseInt(process.env.LOCAL_HTTPS_PORT, 10) || 3443;

// ========================================
// CREATE SERVER
// ========================================

const httpServer = http.createServer(app);

const io = new Server(httpServer, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// Optional local HTTPS for direct phone access on local network (without cloud)
let httpsServer = null;
if (USE_LOCAL_SSL) {
    try {
        const fs = require('fs');
        const https = require('https');
        const sslDir = path.join(__dirname, 'ssl');
        let sslOptions;

        if (fs.existsSync(path.join(sslDir, 'key.pem')) && fs.existsSync(path.join(sslDir, 'cert.pem'))) {
            sslOptions = {
                key: fs.readFileSync(path.join(sslDir, 'key.pem')),
                cert: fs.readFileSync(path.join(sslDir, 'cert.pem'))
            };
        } else {
            const selfsigned = require('selfsigned');
            const pems = selfsigned.generate(
                [{ name: 'commonName', value: 'localhost' }],
                { days: 365, keySize: 2048, algorithm: 'sha256' }
            );
            if (!fs.existsSync(sslDir)) fs.mkdirSync(sslDir);
            fs.writeFileSync(path.join(sslDir, 'key.pem'), pems.private);
            fs.writeFileSync(path.join(sslDir, 'cert.pem'), pems.cert);
            sslOptions = { key: pems.private, cert: pems.cert };
        }
        httpsServer = https.createServer(sslOptions, app);
        io.attach(httpsServer);
        console.log('[SSL] Local HTTPS enabled');
    } catch (e) {
        console.warn('[SSL] Failed to enable local HTTPS:', e.message);
    }
}

// ========================================
// STATIC FILES & ROUTES
// ========================================

app.use(express.static(path.join(__dirname, 'public')));

app.get('/',        (req, res) => res.type('html').sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/join',    (req, res) => res.type('html').sendFile(path.join(__dirname, 'public', 'join.html')));
app.get('/control', (req, res) => res.type('html').sendFile(path.join(__dirname, 'public', 'control.html')));
app.get('/output',  (req, res) => res.type('html').sendFile(path.join(__dirname, 'public', 'output.html')));

// ========================================
// API
// ========================================

function getLocalIP() {
    const interfaces = os.networkInterfaces();
    for (let iface in interfaces) {
        for (let alias of interfaces[iface]) {
            if (alias.family === 'IPv4' && !alias.internal) return alias.address;
        }
    }
    return 'localhost';
}

const localIP = getLocalIP();

app.get('/api/server-info', (req, res) => {
    // Detect public-facing host from request (works in cloud)
    const host = req.get('host');
    const proto = req.get('x-forwarded-proto') || req.protocol;
    res.json({
        ip: localIP,
        port: PORT,
        publicUrl: `${proto}://${host}`,
        joinUrl: `${proto}://${host}/join`
    });
});

// ========================================
// SOCKET.IO — SIGNALING & PEER MANAGEMENT
// ========================================

const peers = new Map();
let peerCounter = 0;
const controlSockets = new Set();
const outputSockets = new Set();
let lastControlState = null;

io.on('connection', (socket) => {
    console.log(`[CONNECT] ${socket.id}`);

    socket.on('join-as-peer', (data) => {
        peerCounter++;
        const peerId = `peer-${peerCounter}`;

        peers.set(socket.id, {
            peerId, socketId: socket.id,
            camera: data?.camera || 'user',
            joinedAt: Date.now()
        });

        console.log(`[PEER JOIN] ${peerId}`);
        socket.emit('peer-id-assigned', { peerId });

        const peerList = Array.from(peers.values());
        controlSockets.forEach(id => {
            io.to(id).emit('peer-joined', { peerId, socketId: socket.id });
            io.to(id).emit('peer-list', peerList);
        });
        outputSockets.forEach(id => {
            io.to(id).emit('peer-joined', { peerId, socketId: socket.id });
            io.to(id).emit('peer-list', peerList);
        });
    });

    socket.on('join-as-control', () => {
        controlSockets.add(socket.id);
        console.log(`[CONTROL] Connected: ${socket.id}`);
        socket.emit('peer-list', Array.from(peers.values()));
    });

    socket.on('join-as-output', () => {
        outputSockets.add(socket.id);
        console.log(`[OUTPUT] Connected: ${socket.id}`);
        socket.emit('peer-list', Array.from(peers.values()));
        if (lastControlState) socket.emit('control-command', lastControlState);
    });

    socket.on('webrtc-offer', (data) => {
        io.to(data.target).emit('webrtc-offer', { offer: data.offer, from: socket.id });
    });

    socket.on('webrtc-answer', (data) => {
        io.to(data.target).emit('webrtc-answer', { answer: data.answer, from: socket.id });
    });

    socket.on('webrtc-ice-candidate', (data) => {
        io.to(data.target).emit('webrtc-ice-candidate', { candidate: data.candidate, from: socket.id });
    });

    socket.on('control-command', (command) => {
        if (command && (command.type === 'state-update' || command.type === 'visibility-update')) {
            lastControlState = command;
        }
        outputSockets.forEach(id => io.to(id).emit('control-command', command));
    });

    socket.on('camera-changed', (data) => {
        const peer = peers.get(socket.id);
        if (peer) {
            peer.camera = data.camera;
            controlSockets.forEach(id => {
                io.to(id).emit('peer-camera-changed', { peerId: peer.peerId, camera: data.camera });
            });
        }
    });

    socket.on('disconnect', () => {
        console.log(`[DISCONNECT] ${socket.id}`);

        if (peers.has(socket.id)) {
            const peer = peers.get(socket.id);
            console.log(`[PEER LEAVE] ${peer.peerId}`);
            peers.delete(socket.id);

            const peerList = Array.from(peers.values());
            controlSockets.forEach(id => {
                io.to(id).emit('peer-left', { peerId: peer.peerId, socketId: socket.id });
                io.to(id).emit('peer-list', peerList);
            });
            outputSockets.forEach(id => {
                io.to(id).emit('peer-left', { peerId: peer.peerId, socketId: socket.id });
                io.to(id).emit('peer-list', peerList);
            });
        }

        controlSockets.delete(socket.id);
        outputSockets.delete(socket.id);
    });
});

// ========================================
// START
// ========================================

httpServer.listen(PORT, '0.0.0.0', () => {
    console.log('');
    console.log('═══════════════════════════════════════════════');
    console.log('   📡 DATA WORKER STREAM — Server Ready');
    console.log('═══════════════════════════════════════════════');
    console.log('');
    console.log(`HTTP:        http://localhost:${PORT}`);
    if (process.env.RENDER_EXTERNAL_URL) {
        console.log(`PUBLIC URL:  ${process.env.RENDER_EXTERNAL_URL}`);
    }
    console.log('');
    console.log('─── ENDPOINTS ───');
    console.log(`Landing:  /`);
    console.log(`Control:  /control`);
    console.log(`Output:   /output`);
    console.log(`Join:     /join   (phone)`);
    console.log('');
    if (!process.env.PORT) {
        console.log('─── LOCAL NETWORK (laptop + phones on same WiFi) ───');
        console.log(`Laptop:   http://localhost:${PORT}/control`);
        if (USE_LOCAL_SSL && httpsServer) {
            console.log(`Phones:   https://${localIP}:${LOCAL_HTTPS_PORT}/join  (HTTPS required for camera)`);
        } else {
            console.log(`Phones:   need HTTPS — restart with USE_LOCAL_SSL=1 npm start`);
            console.log(`          OR deploy to Render and open the public URL on phones.`);
        }
        console.log('');
    }
    console.log('═══════════════════════════════════════════════');
    console.log('');
});

if (httpsServer) {
    httpsServer.listen(LOCAL_HTTPS_PORT, '0.0.0.0', () => {
        console.log(`[HTTPS] Listening on ${LOCAL_HTTPS_PORT} (self-signed)`);
    });
}
