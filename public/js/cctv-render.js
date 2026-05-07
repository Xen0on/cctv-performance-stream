// ═══════════════════════════════════════════════════════════════
// DATA WORKER STREAM :: CCTV RENDER (shared by output + control preview)
// ═══════════════════════════════════════════════════════════════

(function () {
    'use strict';

    // Compute optimal grid dimensions for slot count.
    // Prefers cell aspect ratio close to 16:9 to match canvas shape.
    function gridDims(n, canvasW, canvasH) {
        const targetCellAspect = 16 / 9;
        const canvasIsWide = canvasW >= canvasH;
        let best = { cols: 1, rows: n, score: Infinity };
        for (let cols = 1; cols <= n; cols++) {
            const rows = Math.ceil(n / cols);
            const cellAspect = (canvasW / cols) / (canvasH / rows);
            const aspectScore = Math.abs(Math.log(cellAspect / targetCellAspect));
            const emptyPenalty = (cols * rows - n) * 0.15;
            // Tiebreaker: prefer cols >= rows on wide canvases (more CCTV-style)
            const orientationBonus = canvasIsWide && cols >= rows ? -0.02 : 0;
            const score = aspectScore + emptyPenalty + orientationBonus;
            if (score < best.score) best = { cols, rows, score };
        }
        return best;
    }

    function drawVideoCover(ctx, video, x, y, w, h) {
        if (!video || video.readyState < 2) return;
        const va = video.videoWidth / video.videoHeight;
        const ca = w / h;
        let dw, dh, dx, dy;
        if (va > ca) {
            dh = h; dw = h * va; dx = x + (w - dw) / 2; dy = y;
        } else {
            dw = w; dh = w / va; dx = x; dy = y + (h - dh) / 2;
        }
        ctx.save();
        ctx.beginPath();
        ctx.rect(x, y, w, h);
        ctx.clip();
        ctx.drawImage(video, dx, dy, dw, dh);
        ctx.restore();
    }

    function drawNoSignalNoise(ctx, x, y, w, h) {
        // Subtle static texture for empty slots
        const blockSize = 4;
        const time = Math.floor(Date.now() / 100);
        for (let py = y; py < y + h; py += blockSize) {
            for (let px = x; px < x + w; px += blockSize) {
                // Pseudo-random per cell + time
                const v = ((px * 73 + py * 31 + time) % 50) + 8;
                ctx.fillStyle = 'rgb(' + v + ',' + v + ',' + v + ')';
                ctx.fillRect(px, py, blockSize, blockSize);
            }
        }
    }

    function drawCCTVOverlay(ctx, x, y, w, h, peerId, idx, hasVideo, scale) {
        scale = scale || 1;

        // Outer thin border
        ctx.strokeStyle = hasVideo ? '#444' : '#222';
        ctx.lineWidth = 1;
        ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);

        // Corner brackets
        const bl = Math.max(8, Math.min(28, w * 0.05));
        ctx.strokeStyle = hasVideo ? '#cccccc' : '#555555';
        ctx.lineWidth = Math.max(1, 2 * scale);
        const off = 5;
        ctx.beginPath();
        ctx.moveTo(x + off, y + off + bl); ctx.lineTo(x + off, y + off); ctx.lineTo(x + off + bl, y + off);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(x + w - off - bl, y + off); ctx.lineTo(x + w - off, y + off); ctx.lineTo(x + w - off, y + off + bl);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(x + off, y + h - off - bl); ctx.lineTo(x + off, y + h - off); ctx.lineTo(x + off + bl, y + h - off);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(x + w - off - bl, y + h - off); ctx.lineTo(x + w - off, y + h - off); ctx.lineTo(x + w - off, y + h - off - bl);
        ctx.stroke();

        const fs = Math.max(10, Math.min(22, Math.floor(h * 0.05)));
        const pad = Math.max(4, 8 * scale);

        // CAM label (top-left)
        const camLabel = 'CAM ' + String(idx + 1).padStart(2, '0');
        const camSub = peerId ? '// ' + peerId.toUpperCase() : '// --';
        ctx.font = 'bold ' + fs + 'px "Courier New", monospace';
        const labelW = ctx.measureText(camLabel).width;
        ctx.font = (fs - 2) + 'px "Courier New", monospace';
        const subW = ctx.measureText(camSub).width;
        ctx.fillStyle = 'rgba(0,0,0,0.7)';
        ctx.fillRect(x + pad, y + pad, labelW + subW + 22, fs + 8);
        ctx.font = 'bold ' + fs + 'px "Courier New", monospace';
        ctx.fillStyle = '#ffffff';
        ctx.fillText(camLabel, x + pad + 6, y + pad + fs);
        ctx.font = (fs - 2) + 'px "Courier New", monospace';
        ctx.fillStyle = hasVideo ? '#888' : '#555';
        ctx.fillText(camSub, x + pad + 6 + labelW + 8, y + pad + fs);

        // REC indicator (top-right)
        ctx.font = 'bold ' + fs + 'px "Courier New", monospace';
        const recText = hasVideo ? 'REC' : 'NO SIG';
        const recColor = hasVideo ? '#ff2828' : '#ffaa00';
        const recW = ctx.measureText(recText).width;
        ctx.fillStyle = 'rgba(0,0,0,0.7)';
        ctx.fillRect(x + w - pad - recW - 22, y + pad, recW + 22, fs + 8);
        if (Math.floor(Date.now() / 600) % 2 === 0 || !hasVideo) {
            ctx.fillStyle = recColor;
            ctx.beginPath();
            ctx.arc(x + w - pad - recW - 12, y + pad + (fs + 8) / 2, Math.max(2.5, 4 * scale), 0, Math.PI * 2);
            ctx.fill();
        }
        ctx.fillStyle = '#fff';
        ctx.fillText(recText, x + w - pad - recW - 4, y + pad + fs);

        // Bottom timestamp
        const now = new Date();
        const p = (n) => String(n).padStart(2, '0');
        const tsLine = now.getFullYear() + '-' + p(now.getMonth() + 1) + '-' + p(now.getDate())
            + ' ' + p(now.getHours()) + ':' + p(now.getMinutes()) + ':' + p(now.getSeconds());
        ctx.font = (fs - 1) + 'px "Courier New", monospace';
        const tsW = ctx.measureText(tsLine).width;
        ctx.fillStyle = 'rgba(0,0,0,0.7)';
        ctx.fillRect(x + w - pad - tsW - 12, y + h - pad - fs - 6, tsW + 12, fs + 6);
        ctx.fillStyle = hasVideo ? '#33ff66' : '#666';
        ctx.fillText(tsLine, x + w - pad - tsW - 6, y + h - pad - 4);

        // LIVE indicator (bottom-left)
        const liveText = hasVideo ? '● LIVE' : '○ OFFLINE';
        const liveW = ctx.measureText(liveText).width;
        ctx.fillStyle = 'rgba(0,0,0,0.7)';
        ctx.fillRect(x + pad, y + h - pad - fs - 6, liveW + 12, fs + 6);
        ctx.fillStyle = hasVideo ? '#33ff66' : '#666';
        ctx.fillText(liveText, x + pad + 6, y + h - pad - 4);

        // For empty slot — big "NO SIGNAL" centered
        if (!hasVideo) {
            const bigFs = Math.max(20, Math.min(64, Math.floor(h * 0.18)));
            ctx.font = 'bold ' + bigFs + 'px "Courier New", monospace';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillStyle = 'rgba(255, 170, 0, 0.85)';
            ctx.fillText('NO SIGNAL', x + w / 2, y + h / 2 - bigFs * 0.2);
            const subFs = Math.max(10, Math.min(20, Math.floor(h * 0.05)));
            ctx.font = subFs + 'px "Courier New", monospace';
            ctx.fillStyle = 'rgba(255, 170, 0, 0.55)';
            ctx.fillText('CHANNEL ' + String(idx + 1).padStart(2, '0'), x + w / 2, y + h / 2 + bigFs * 0.6);
            ctx.textAlign = 'left';
            ctx.textBaseline = 'alphabetic';
        }
    }

    /**
     * Render fixed-size CCTV grid.
     * @param {CanvasRenderingContext2D} ctx
     * @param {HTMLCanvasElement} canvas
     * @param {Array<{peerId:string, video:HTMLVideoElement}|null>} slots — fixed-length array; nulls = empty slots
     */
    function renderSlots(ctx, canvas, slots) {
        const n = slots.length;
        if (n === 0) return;
        const { cols, rows } = gridDims(n, canvas.width, canvas.height);
        const gap = 4;
        const cellW = (canvas.width - gap * (cols + 1)) / cols;
        const cellH = (canvas.height - gap * (rows + 1)) / rows;
        const scale = Math.min(canvas.width, canvas.height) / 800;

        for (let i = 0; i < n; i++) {
            const slot = slots[i];
            const col = i % cols;
            const row = Math.floor(i / cols);
            const x = gap + col * (cellW + gap);
            const y = gap + row * (cellH + gap);

            ctx.fillStyle = '#0a0a0a';
            ctx.fillRect(x, y, cellW, cellH);

            const hasVideo = slot && slot.video && slot.video.readyState >= 2;
            if (hasVideo) {
                drawVideoCover(ctx, slot.video, x, y, cellW, cellH);
            } else {
                drawNoSignalNoise(ctx, x, y, cellW, cellH);
            }

            drawCCTVOverlay(ctx, x, y, cellW, cellH, slot ? slot.peerId : null, i, hasVideo, scale);
        }
    }

    // Legacy API (used by non-cctv layouts) — wraps slots from active list
    function renderGrid(ctx, canvas, activeIds, peerLookup) {
        const slots = activeIds.map(id => {
            const p = peerLookup(id);
            return p ? { peerId: p.peerId, video: p.video } : null;
        });
        renderSlots(ctx, canvas, slots);
    }

    window.CCTV = { renderSlots, renderGrid };
})();
