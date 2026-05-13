// ═══════════════════════════════════════════════════════════════
// SHARED WEBRTC ICE CONFIG
// ═══════════════════════════════════════════════════════════════
// STUN: free Google servers (work for direct P2P discovery)
// TURN: Open Relay public free TURN (relay when P2P fails — needed for
//       isolated networks like museums, hotels, mobile data, corporate WiFi)
// ═══════════════════════════════════════════════════════════════

window.ICE_CONFIG = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        {
            urls: 'turn:openrelay.metered.ca:80',
            username: 'openrelayproject',
            credential: 'openrelayproject'
        },
        {
            urls: 'turn:openrelay.metered.ca:443',
            username: 'openrelayproject',
            credential: 'openrelayproject'
        },
        {
            urls: 'turn:openrelay.metered.ca:443?transport=tcp',
            username: 'openrelayproject',
            credential: 'openrelayproject'
        }
    ],
    iceCandidatePoolSize: 10
};
