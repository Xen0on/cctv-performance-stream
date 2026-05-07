# 📡 CCTV PERFORMANCE STREAM

A live multi-phone streaming system for **performance art**, styled like industrial surveillance.

Phones connect through WebRTC and appear in a CCTV-style grid (`CAM 01`, `CAM 02`...) with timestamps, REC indicators, and visual modes (HD / thermal / surveillance). Designed to run on a local WiFi — phones stream directly to the operator's laptop, then to a projector.

---

## 🚀 QUICK START

```bash
npm install
npm start
```

The server prints URLs on startup. Open them on the right devices:

- `/control` — operator panel (your laptop)
- `/output` — projector / fullscreen display
- `/join` — phone participants

For local-network HTTPS (required by iOS for camera access):
```bash
USE_LOCAL_SSL=1 npm start
```

---

## 📱 iPHONE FIRST-TIME SETUP

iOS requires HTTPS for camera access. With self-signed local SSL:

1. Open URL in **Safari**
2. Tap **"Show Details"** → **"Visit this website"**
3. Tap **"Visit Website"** to confirm
4. Allow camera & microphone
5. Tap **CONNECT**

(You only do this once per device.)

---

## 🎛️ HOW IT WORKS

- **Phones** scan the QR code, choose a visual mode (HD / thermal / surveillance), tap CONNECT
- **Operator** sees a fixed CCTV grid (4/6/9/12/16 slots) — phones auto-fill empty slots as they connect
- **Output** mirrors the operator's grid, fullscreen, ready for a projector

WebRTC media goes peer-to-peer over the local WiFi. The server is only used for signaling.

---

## 🔧 TROUBLESHOOTING

**iPhone camera not working** — Use Safari, accept the certificate warning, allow camera in Settings → Safari.

**Phone can't reach the laptop** — Same WiFi network, firewall allows ports 3000 / 3443.

**Video freezing** — Reduce visible streams, check WiFi signal.

---

## 🔒 SECURITY

Self-signed SSL is fine for local-network use. Don't expose this server publicly without proper hardening.
