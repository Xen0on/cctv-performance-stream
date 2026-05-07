# 🏰 IMMORTAL CASTLE

Live performance video/audio mixing system with WebRTC.

## 🚀 QUICK START

### 1. Install Dependencies
```bash
npm install
```

### 2. Start Server
```bash
npm start
```

Server auto-generates SSL certificates on first run.

### 3. Connect Devices

The server will display URLs:
```
📱 https://192.168.x.x:3443/join    ← For phones
🎛️  http://localhost:3000/control   ← Operator
🖥️  http://localhost:3000/output    ← Projector
```

---

## 📱 iPHONE FIRST TIME SETUP

**CRITICAL: iOS requires HTTPS for camera access!**

1. Open URL in **Safari** (not Chrome!)
2. Safari shows "This Connection Is Not Private"
3. Tap **"Show Details"**
4. Tap **"Visit this website"**
5. Tap **"Visit Website"** to confirm
6. Page loads → Tap **"CONNECT"**
7. Allow camera and microphone access

**You only need to do this ONCE per device.**

---

## 🎛️ HOW TO USE

### Participants (Phones)
1. Scan QR code on landing page OR type URL
2. Accept security certificate (first time only)
3. Allow camera/microphone
4. Tap CONNECT
5. You're streaming!

### Operator (Control Interface)
1. Open `http://localhost:3000/control` on laptop
2. See all connected participants
3. Control individual volumes (0-150%)
4. Mute/unmute participants
5. Show/hide video streams
6. Mix audio in real-time

### Output (Projector/Second Screen)
1. Open `http://localhost:3000/output`
2. Press F11 for fullscreen (or double-click)
3. Pure visual output - no UI elements
4. Connect to projector via HDMI

---

## 📁 FILE STRUCTURE

```
immortal-castle/
├── server.js              # HTTPS + HTTP server with Socket.io
├── generate-ssl.js        # SSL certificate generator
├── package.json
├── ssl/                   # SSL certificates (auto-generated)
│   ├── key.pem
│   └── cert.pem
└── public/
    ├── index.html         # Landing page with QR code
    ├── join.html          # Participant page
    ├── control.html       # Operator interface
    ├── output.html        # Clean projector output
    ├── css/               # Styling
    │   ├── index.css
    │   ├── join.css
    │   ├── control.css
    │   └── output.css
    └── js/
        ├── join.js        # Phone WebRTC client
        ├── control.js     # Mixing controls
        └── output.js      # Output display
```

---

## 🔧 TROUBLESHOOTING

### "Camera not working on iPhone"
- ✅ Make sure URL starts with `https://`
- ✅ Accept the security certificate warning
- ✅ Use Safari (not Chrome on iOS)
- ✅ Check Settings → Safari → Camera → Allow

### "ERR_SSL_PROTOCOL_ERROR"
- Run `npm start` - certificates are auto-generated

### "Cannot connect from phone"
- ✅ Phone and laptop on same WiFi network
- ✅ Windows Firewall allows ports 3000 and 3443
- ✅ Try disabling antivirus temporarily

### "No audio"
- ✅ Click anywhere on the page first (unlocks audio)
- ✅ Check master volume slider
- ✅ Check individual peer volume sliders

### "Video freezing"
- Reduce number of visible streams
- Check WiFi signal strength
- Close other bandwidth-heavy apps

---

## 🔒 SECURITY

Self-signed certificates are safe for local network use. Don't expose this server to the internet without proper security.

---

## ✅ TESTED ON

- ✅ iPhone (Safari)
- ✅ Android (Chrome)
- ✅ Desktop Chrome, Firefox, Edge
- ✅ Windows 10/11

---

## 📞 SUPPORT

Check browser DevTools (F12 → Console) for detailed logs.

All WebRTC events are logged with prefixes:
- `[JOIN]` - Phone events
- `[CONTROL]` - Operator events
- `[OUTPUT]` - Display events

---

**🏰 IMMORTAL CASTLE** - Performance Art System
