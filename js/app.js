import { FilesetResolver, HandLandmarker }
    from "../vendor/mediapipe/vision_bundle.mjs";

// Served from this same origin (see vendor/ and models/), resolved relative
// to this module so the app works from any subpath.
const VISION_WASM = new URL("../vendor/mediapipe/wasm", import.meta.url).href;
const MODEL_URL   = new URL("../models/hand_landmarker.task", import.meta.url).href;

/* ══════════════════════ Configuración ══════════════════════ */

const PALETTES = {
    neon:    ['#ff2d95', '#00ffcc', '#ffe600', '#b366ff', '#00ff66'],
    fire:    ['#fff3b0', '#ffd166', '#ff8c42', '#ff4d29', '#ff0033'],
    ice:     ['#ffffff', '#d6f5ff', '#7ad7f0', '#3aa8e0', '#2f5fd0'],
    rainbow: ['#ff0055', '#ff9500', '#ffee00', '#00e676', '#2979ff'],
};

const DEFAULTS = {
    fadeMs: 5000,
    freeze: false,
    brush: 8,
    glow: 1,
    smooth: 55,
    videoOpacity: 0.4,
    blurBg: false,
    mirror: true,
    sparkles: true,
    taper: true,
    mode: 'all',
    quality: 'high',
    palette: 'neon',
    colors: PALETTES.neon.slice(),
    deviceId: '',
};

const CFG = load();

function load() {
    try {
        const saved = JSON.parse(localStorage.getItem('magicdraw') || '{}');
        return { ...DEFAULTS, ...saved, colors: (saved.colors || DEFAULTS.colors).slice() };
    } catch { return { ...DEFAULTS }; }
}
let saveTimer = 0;
function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
        try { localStorage.setItem('magicdraw', JSON.stringify(CFG)); } catch {}
    }, 300);
}

const QUALITY = {
    high:   { dpr: 2,   passes: [ {w:3.4,a:.13}, {w:2.0,a:.19}, {w:1.0,a:.85}, {w:.35,a:.5,white:true} ], bands: 18, sparks: 4 },
    medium: { dpr: 1.5, passes: [ {w:2.6,a:.17}, {w:1.0,a:.9} ],                                          bands: 14, sparks: 3 },
    low:    { dpr: 1,   passes: [ {w:1.0,a:.95} ],                                                        bands: 10, sparks: 0 },
};

// Puntas de dedo en el modelo de MediaPipe.
const TIPS = [4, 8, 12, 16, 20];
const FINGER_NAMES = ['Thumb', 'Index', 'Middle', 'Ring', 'Pinky'];

const MIN_STEP = 0.0035;   // distancia mínima (normalizada) entre puntos
const MAX_POINTS = 3000;   // tope por trazo en modo congelado
const TRAIL_TTL = 2000;    // ms que sobrevive un trazo sin verse la mano

/* ══════════════════════ Elementos ══════════════════════ */

const $ = id => document.getElementById(id);
const stage = $('stage');
const ctx = stage.getContext('2d', { alpha: false, desynchronized: true });
const video = $('video');
const ui = $('ui');
const loading = $('loading');

let W = 0, H = 0, DPR = 1;

function resize() {
    W = window.innerWidth;
    H = window.innerHeight;
    DPR = Math.min(window.devicePixelRatio || 1, QUALITY[CFG.quality].dpr);
    stage.width = Math.round(W * DPR);
    stage.height = Math.round(H * DPR);
    stage.style.width = W + 'px';
    stage.style.height = H + 'px';
}
window.addEventListener('resize', resize);
window.addEventListener('orientationchange', resize);
resize();

/* ══════════════════════ Mapeo cámara → pantalla ══════════════════════

   El vídeo se dibuja con recorte tipo `cover`. Estos parámetros se
   recalculan una vez por frame y los comparten el dibujo del vídeo y la
   conversión de coordenadas de los dedos, así que nunca se desalinean.  */

const fit = { ox: 0, oy: 0, rw: 0, rh: 0 };

function updateFit() {
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh) { fit.ox = 0; fit.oy = 0; fit.rw = W; fit.rh = H; return; }
    const vr = vw / vh, sr = W / H;
    if (sr > vr) {
        fit.rw = W; fit.rh = W / vr; fit.ox = 0; fit.oy = (H - fit.rh) / 2;
    } else {
        fit.rh = H; fit.rw = H * vr; fit.oy = 0; fit.ox = (W - fit.rw) / 2;
    }
}

// Coordenada normalizada de la cámara → píxel CSS en pantalla.
const mapX = nx => fit.ox + (CFG.mirror ? 1 - nx : nx) * fit.rw;
const mapY = ny => fit.oy + ny * fit.rh;

/* ══════════════════════ Filtro One Euro ══════════════════════

   Los landmarks de MediaPipe tiemblan unos píxeles por frame. Sin filtrar,
   el trazo sale con "pelusa". One Euro suaviza cuando la mano está quieta y
   deja pasar el movimiento rápido sin retardo perceptible.                */

class OneEuro {
    constructor() { this.reset(); }
    reset() { this.xp = null; this.dxp = 0; this.tp = 0; }
    static alpha(cutoff, dt) {
        const tau = 1 / (2 * Math.PI * cutoff);
        return 1 / (1 + tau / dt);
    }
    filter(x, t, minCutoff, beta) {
        if (this.xp === null) { this.xp = x; this.tp = t; return x; }
        const dt = Math.max(1e-3, (t - this.tp) / 1000);
        this.tp = t;
        const dx = (x - this.xp) / dt;
        const ad = OneEuro.alpha(1, dt);
        this.dxp = ad * dx + (1 - ad) * this.dxp;
        const cutoff = minCutoff + beta * Math.abs(this.dxp);
        const a = OneEuro.alpha(cutoff, dt);
        this.xp = a * x + (1 - a) * this.xp;
        return this.xp;
    }
}

function smoothParams() {
    // 0 → crudo y reactivo · 100 → muy suave
    const s = CFG.smooth / 100;
    return { minCutoff: 6.0 - 5.6 * s, beta: 0.02 + 0.12 * (1 - s) };
}

/* ══════════════════════ Trazos ══════════════════════ */

/** key `${mano}:${índiceDedo}` → { pts, fx, fy, active, lastSeen, finger } */
const trails = new Map();
let particles = [];

function getTrail(key, finger) {
    let t = trails.get(key);
    if (!t) {
        t = { pts: [], fx: new OneEuro(), fy: new OneEuro(), active: false, lastSeen: 0, finger };
        trails.set(key, t);
    }
    return t;
}

function addPoint(trail, nx, ny, now) {
    const { minCutoff, beta } = smoothParams();
    const x = trail.fx.filter(nx, now, minCutoff, beta);
    const y = trail.fy.filter(ny, now, minCutoff, beta);

    const last = trail.pts[trail.pts.length - 1];
    if (last && !last.brk) {
        const dx = x - last.x, dy = y - last.y;
        if (dx * dx + dy * dy < MIN_STEP * MIN_STEP) {
            last.t = now;           // mano quieta: refresca en lugar de acumular
            return;
        }
    }
    trail.pts.push({ x, y, t: now, brk: false });
    if (trail.pts.length > MAX_POINTS) trail.pts.shift();

    if (CFG.sparkles) spawnSparks(mapX(x), mapY(y), CFG.colors[trail.finger], now);
}

function breakTrail(trail, now) {
    const last = trail.pts[trail.pts.length - 1];
    if (last && !last.brk) trail.pts.push({ brk: true, t: now });
    trail.fx.reset();
    trail.fy.reset();
}

function clearAll() {
    for (const t of trails.values()) { t.pts.length = 0; t.fx.reset(); t.fy.reset(); }
    particles.length = 0;
}

/* ══════════════════════ Chispas ══════════════════════ */

function spawnSparks(px, py, color, now) {
    const n = QUALITY[CFG.quality].sparks;
    for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2;
        const sp = 0.2 + Math.random() * 0.9;
        particles.push({
            x: px, y: py,
            vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 0.15,
            born: now, life: 500 + Math.random() * 600,
            size: 1 + Math.random() * 2.2,
            color,
        });
    }
    if (particles.length > 1200) particles.splice(0, particles.length - 1200);
}

/* ══════════════════════ Gestos ══════════════════════ */

const dist2 = (a, b) => { const dx = a.x - b.x, dy = a.y - b.y; return dx * dx + dy * dy; };

/** Un dedo cuenta como estirado si la punta está más lejos de la muñeca que
 *  su nudillo medio. Funciona con la mano girada, a diferencia de comparar y. */
function isExtended(lm, tip) {
    if (tip === 4) {
        const ref = lm[17];                       // nudillo del meñique
        return dist2(lm[4], ref) > dist2(lm[3], ref) * 1.15;
    }
    const wrist = lm[0];
    return dist2(lm[tip], wrist) > dist2(lm[tip - 2], wrist) * 1.25;
}

const isFist = lm => ![8, 12, 16, 20].some(t => isExtended(lm, t));

function isPinching(lm) {
    const span = Math.sqrt(dist2(lm[0], lm[9])) || 1;   // tamaño de la mano
    return Math.sqrt(dist2(lm[4], lm[8])) < span * 0.42;
}

let fistSince = 0, fistFired = false;

/* ══════════════════════ Detección ══════════════════════ */

let landmarker = null;
let lastVideoTime = -1;
let lastTs = 0;
let latest = { hands: [] };

function detect(now) {
    if (!landmarker || video.readyState < 2) return;
    if (video.currentTime === lastVideoTime) return;
    lastVideoTime = video.currentTime;

    lastTs = Math.max(now, lastTs + 1);
    let res;
    try { res = landmarker.detectForVideo(video, lastTs); }
    catch { return; }

    const marks = res.landmarks || [];
    const handed = res.handedness || res.handednesses || [];
    latest.hands = marks.map((lm, i) => ({
        lm,
        label: handed[i]?.[0]?.categoryName || `H${i}`,
    }));

    consume(now);
}

function consume(now) {
    const seen = new Set();

    for (const hand of latest.hands) {
        const lm = hand.lm;

        // Puño cerrado y sostenido = borrar todo.
        if (isFist(lm)) {
            if (!fistSince) fistSince = now;
            else if (!fistFired && now - fistSince > 350) {
                clearAll();
                fistFired = true;
                toast('✊ Canvas cleared');
            }
            continue;
        }

        let drawing;   // índices (0-4) que pintan este frame
        if (CFG.mode === 'index') {
            drawing = isExtended(lm, 8) ? [1] : [];
        } else if (CFG.mode === 'pinch') {
            drawing = isPinching(lm) ? [1] : [];
        } else {
            drawing = TIPS.map((t, i) => isExtended(lm, t) ? i : -1).filter(i => i >= 0);
        }

        for (let i = 0; i < 5; i++) {
            const key = `${hand.label}:${i}`;
            const trail = getTrail(key, i);
            seen.add(key);
            trail.lastSeen = now;

            if (drawing.includes(i)) {
                let p = lm[TIPS[i]];
                if (CFG.mode === 'pinch') {
                    // Punto medio entre pulgar e índice: un solo trazo limpio.
                    p = { x: (lm[4].x + lm[8].x) / 2, y: (lm[4].y + lm[8].y) / 2 };
                }
                addPoint(trail, p.x, p.y, now);
                trail.active = true;
            } else if (trail.active) {
                breakTrail(trail, now);
                trail.active = false;
            }
        }
    }

    if (!latest.hands.some(h => isFist(h.lm))) { fistSince = 0; fistFired = false; }

    // La mano salió de cuadro: corta el trazo para que no cruce la pantalla.
    for (const [key, trail] of trails) {
        if (seen.has(key)) continue;
        if (trail.active) { breakTrail(trail, now); trail.active = false; }
        if (now - trail.lastSeen > TRAIL_TTL && trail.pts.length === 0) trails.delete(key);
    }
}

/* ══════════════════════ Render ══════════════════════ */

let frames = 0, fpsTime = 0, fps = 0;

function frame(now) {
    requestAnimationFrame(frame);

    detect(now);

    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);

    updateFit();

    // --- Fondo de vídeo ---
    if (CFG.videoOpacity > 0 && video.readyState >= 2) {
        ctx.globalAlpha = CFG.videoOpacity;
        ctx.save();
        if (CFG.mirror) {
            ctx.translate(W, 0);
            ctx.scale(-1, 1);
        }
        drawVideo();
        ctx.restore();
        ctx.globalAlpha = 1;
    }

    // --- Trazos (aditivo: los cruces brillan en vez de ensuciarse) ---
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    const fade = CFG.freeze ? Infinity : CFG.fadeMs;
    for (const trail of trails.values()) {
        prune(trail, now, fade);
        drawTrail(trail, now, fade);
    }

    drawParticles(now);

    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;

    // --- FPS ---
    frames++;
    if (now - fpsTime > 500) {
        fps = Math.round(frames * 1000 / (now - fpsTime));
        frames = 0; fpsTime = now;
        updateHud();
    }
}

/* Blurred background: the frame is shrunk onto a small canvas, blurred
   there (cheap at that size) and stretched back up. Without `ctx.filter`
   (older Safari) the shrink is stronger and bilinear upscaling alone gives
   the soft look. */
const BLUR_PX = 14;
const BLUR_SCALE = 4;
const blurCanvas = document.createElement('canvas');
const blurCtx = blurCanvas.getContext('2d');
const hasFilter = 'filter' in blurCtx;

function drawVideo() {
    if (!CFG.blurBg) {
        ctx.drawImage(video, fit.ox, fit.oy, fit.rw, fit.rh);
        return;
    }
    const k = hasFilter ? BLUR_SCALE : BLUR_PX;
    const bw = Math.max(1, Math.round(fit.rw / k));
    const bh = Math.max(1, Math.round(fit.rh / k));
    if (blurCanvas.width !== bw || blurCanvas.height !== bh) {
        blurCanvas.width = bw;
        blurCanvas.height = bh;
    }
    if (hasFilter) blurCtx.filter = `blur(${BLUR_PX / BLUR_SCALE}px)`;
    // Bleed past the edges so the blur doesn't pull in a dark border.
    const m = hasFilter ? Math.ceil(BLUR_PX / BLUR_SCALE) * 2 : 0;
    blurCtx.drawImage(video, -m, -m, bw + 2 * m, bh + 2 * m);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(blurCanvas, fit.ox, fit.oy, fit.rw, fit.rh);
}

function prune(trail, now, fade) {
    if (fade === Infinity) return;
    const pts = trail.pts;
    let i = 0;
    while (i < pts.length && now - pts[i].t > fade) i++;
    if (i) pts.splice(0, i);
}

function drawTrail(trail, now, fade) {
    const pts = trail.pts;
    if (pts.length < 2) return;

    const Q = QUALITY[CFG.quality];
    const BANDS = Q.bands;
    const color = CFG.colors[trail.finger];

    // Proyectar una sola vez por frame y clasificar por antigüedad.
    // Como los puntos van de viejo a nuevo, cada banda es un tramo contiguo.
    for (const p of pts) {
        if (p.brk) continue;
        p.sx = mapX(p.x);
        p.sy = mapY(p.y);
        const u = fade === Infinity ? 1 : Math.max(0, 1 - (now - p.t) / fade);
        p.band = Math.min(BANDS - 1, Math.floor(u * BANDS));
    }

    for (const pass of Q.passes) {
        ctx.strokeStyle = pass.white ? '#ffffff' : color;
        for (let b = 0; b < BANDS; b++) {
            const u = (b + 0.5) / BANDS;
            const alpha = Math.pow(u, 1.25) * pass.a * (pass.white ? CFG.glow : Math.min(1, 0.35 + CFG.glow * 0.65));
            if (alpha < 0.004) continue;

            const width = CFG.brush * pass.w * (CFG.taper ? 0.3 + 0.7 * u : 1);
            ctx.globalAlpha = alpha;
            ctx.lineWidth = Math.max(0.4, width);

            ctx.beginPath();
            let open = false;
            for (let j = 0; j < pts.length - 1; j++) {
                const p = pts[j], q = pts[j + 1];
                if (p.brk || q.brk || p.band !== b) { open = false; continue; }
                if (!open) { ctx.moveTo(p.sx, p.sy); open = true; }
                // Curva por punto medio: trazo orgánico sin sobrecoste real.
                ctx.quadraticCurveTo(p.sx, p.sy, (p.sx + q.sx) / 2, (p.sy + q.sy) / 2);
            }
            ctx.stroke();
        }
    }

    // Punta brillante del trazo vivo.
    const head = pts[pts.length - 1];
    if (trail.active && !head.brk) {
        ctx.globalAlpha = Math.min(1, 0.5 * CFG.glow);
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(head.sx, head.sy, CFG.brush * 0.9, 0, Math.PI * 2);
        ctx.fill();
    }
}

function drawParticles(now) {
    if (!particles.length) return;
    let n = 0;
    for (const p of particles) {
        const age = now - p.born;
        if (age >= p.life) continue;
        particles[n++] = p;
        p.x += p.vx;
        p.y += p.vy;
        p.vy += 0.012;                       // gravedad muy suave
        ctx.globalAlpha = (1 - age / p.life) * 0.85;
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fill();
    }
    particles.length = n;
}

/* ══════════════════════ Cámara ══════════════════════ */

let stream = null;

async function startCamera(deviceId) {
    if (stream) stream.getTracks().forEach(t => t.stop());
    const constraints = {
        audio: false,
        video: deviceId
            ? { deviceId: { exact: deviceId }, width: { ideal: 1280 }, height: { ideal: 720 } }
            : { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
    };
    stream = await navigator.mediaDevices.getUserMedia(constraints);
    video.srcObject = stream;
    await video.play();
    lastVideoTime = -1;
}

async function listCameras() {
    const sel = $('camSel');
    try {
        const devs = (await navigator.mediaDevices.enumerateDevices())
            .filter(d => d.kind === 'videoinput');
        if (!devs.length) return;
        sel.innerHTML = '';
        devs.forEach((d, i) => {
            const o = document.createElement('option');
            o.value = d.deviceId;
            o.textContent = d.label || `Camera ${i + 1}`;
            sel.appendChild(o);
        });
        if (CFG.deviceId && devs.some(d => d.deviceId === CFG.deviceId)) sel.value = CFG.deviceId;
        else CFG.deviceId = sel.value;
    } catch {}
}

/* ══════════════════════ Arranque ══════════════════════ */

function fail(msg, sub) {
    loading.classList.remove('gone');
    loading.querySelector('.spin').style.display = 'none';
    $('loadMsg').innerHTML = `<span class="err">${msg}</span>`;
    $('loadSub').textContent = sub || '';
}

async function boot() {
    if (!window.isSecureContext) {
        fail('A secure connection is required',
             'The camera only works on https:// or http://localhost. Serve the file with a local server.');
        return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
        fail('This browser does not support the camera', 'Try an up-to-date Chrome, Edge or Safari.');
        return;
    }

    try {
        $('loadSub').textContent = 'Requesting camera permission…';
        await startCamera(CFG.deviceId);
    } catch (e) {
        const map = {
            NotAllowedError: ['Camera permission denied', 'Allow access from the icon in the address bar and reload.'],
            NotFoundError:   ['No camera found', 'Connect a camera and reload the page.'],
            NotReadableError:['The camera is in use', 'Another application is using it. Close it and reload.'],
        };
        const [m, s] = map[e.name] || ['Could not open the camera', e.message];
        fail(m, s);
        return;
    }

    listCameras();

    try {
        $('loadSub').textContent = 'Loading the hand detection model…';
        const vision = await FilesetResolver.forVisionTasks(VISION_WASM);
        const opts = (delegate) => ({
            baseOptions: { modelAssetPath: MODEL_URL, delegate },
            runningMode: 'VIDEO',
            numHands: 2,
            minHandDetectionConfidence: 0.6,
            minHandPresenceConfidence: 0.6,
            minTrackingConfidence: 0.6,
        });
        try {
            landmarker = await HandLandmarker.createFromOptions(vision, opts('GPU'));
        } catch {
            landmarker = await HandLandmarker.createFromOptions(vision, opts('CPU'));
        }
    } catch (e) {
        fail('Could not load the model', 'Check your internet connection. ' + (e.message || ''));
        return;
    }

    loading.classList.add('gone');
    requestAnimationFrame(frame);
}

/* ══════════════════════ Interfaz ══════════════════════ */

function toast(msg) {
    const el = $('toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.remove('show'), 1100);
}

function updateHud() {
    const hands = latest.hands.length;
    $('hud').innerHTML =
        `${fps} fps · ${hands} hand${hands === 1 ? '' : 's'} · ` +
        `${[...trails.values()].reduce((n, t) => n + t.pts.length, 0)} points`;

    const hints = {
        all: 'Extend your fingers to draw · make a fist to clear',
        index: 'Draw with your index finger · make a fist to clear',
        pinch: 'Pinch thumb and index together to draw',
    };
    $('hint').textContent = hands ? hints[CFG.mode] : 'Show your hand to the camera';
}

function syncUI() {
    $('fade').value = CFG.fadeMs / 1000;
    $('vFade').textContent = (CFG.fadeMs / 1000).toFixed(1) + ' s';
    $('fade').disabled = CFG.freeze;

    $('brush').value = CFG.brush;
    $('vBrush').textContent = CFG.brush;

    $('glow').value = CFG.glow;
    $('vGlow').textContent = Math.round(CFG.glow * 100) + '%';

    $('smooth').value = CFG.smooth;
    $('vSmooth').textContent = CFG.smooth < 25 ? 'raw' : CFG.smooth < 60 ? 'medium' : 'high';

    $('vid').value = CFG.videoOpacity * 100;
    $('vVid').textContent = Math.round(CFG.videoOpacity * 100) + '%';

    $('quality').value = CFG.quality;
    $('palette').value = CFG.palette;

    $('btnMirror').classList.toggle('on', CFG.mirror);
    $('btnSparks').classList.toggle('on', CFG.sparkles);
    $('btnTaper').classList.toggle('on', CFG.taper);
    $('btnBlur').classList.toggle('on', CFG.blurBg);
    $('btnFreeze').classList.toggle('on', CFG.freeze);

    [...$('modeSeg').children].forEach(b =>
        b.classList.toggle('on', b.dataset.mode === CFG.mode));

    [...$('fingers').children].forEach((row, i) => {
        row.querySelector('input').value = CFG.colors[i];
    });

    save();
}

// Selectores de color por dedo
FINGER_NAMES.forEach((name, i) => {
    const row = document.createElement('label');
    row.className = 'finger';
    row.innerHTML = `<span class="name">${name}</span>`;
    const inp = document.createElement('input');
    inp.type = 'color';
    inp.value = CFG.colors[i];
    inp.oninput = () => {
        CFG.colors[i] = inp.value;
        CFG.palette = 'custom';
        $('palette').value = 'custom';
        save();
    };
    row.appendChild(inp);
    $('fingers').appendChild(row);
});

// Sliders
$('fade').oninput  = e => { CFG.fadeMs = parseFloat(e.target.value) * 1000; syncUI(); };
$('brush').oninput = e => { CFG.brush = parseInt(e.target.value); syncUI(); };
$('glow').oninput  = e => { CFG.glow = parseFloat(e.target.value); syncUI(); };
$('smooth').oninput= e => { CFG.smooth = parseInt(e.target.value); syncUI(); };
$('vid').oninput   = e => { CFG.videoOpacity = parseInt(e.target.value) / 100; syncUI(); };

$('quality').onchange = e => { CFG.quality = e.target.value; resize(); save(); };
$('palette').onchange = e => {
    CFG.palette = e.target.value;
    if (PALETTES[CFG.palette]) CFG.colors = PALETTES[CFG.palette].slice();
    syncUI();
};
$('camSel').onchange = async e => {
    CFG.deviceId = e.target.value;
    save();
    try { await startCamera(CFG.deviceId); } catch { toast('Could not switch camera'); }
};

// Botones
$('modeSeg').onclick = e => {
    const b = e.target.closest('button');
    if (b) { CFG.mode = b.dataset.mode; syncUI(); }
};
$('btnClear').onclick  = () => { clearAll(); toast('Canvas cleared'); };
$('btnMirror').onclick = () => { CFG.mirror = !CFG.mirror; syncUI(); };
$('btnSparks').onclick = () => { CFG.sparkles = !CFG.sparkles; syncUI(); };
$('btnTaper').onclick  = () => { CFG.taper = !CFG.taper; syncUI(); };
$('btnBlur').onclick   = () => { CFG.blurBg = !CFG.blurBg; syncUI(); };
$('btnFreeze').onclick = () => {
    CFG.freeze = !CFG.freeze;
    syncUI();
    toast(CFG.freeze ? '❄ Canvas frozen' : 'Fading on');
};
$('btnPanel').onclick = () => {
    const open = $('panel').classList.toggle('open');
    $('btnPanel').classList.toggle('on', open);
};
$('btnFull').onclick = () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen?.().catch(() => {});
};

/* --- Foto --- */
$('btnShot').onclick = () => {
    stage.toBlob(blob => {
        if (!blob) return toast('Could not save');
        download(blob, `magicdraw-${stamp()}.png`);
        toast('📷 Photo saved');
    }, 'image/png');
};

/* --- Grabación --- */
let recorder = null, chunks = [], recStart = 0, recTimer = 0;

$('btnRec').onclick = () => recorder ? stopRec() : startRec();

function startRec() {
    if (!window.MediaRecorder || !stage.captureStream) return toast('Recording not supported');
    const types = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
    const mime = types.find(t => MediaRecorder.isTypeSupported(t));
    if (!mime) return toast('Recording not supported');

    try {
        recorder = new MediaRecorder(stage.captureStream(30), { mimeType: mime, videoBitsPerSecond: 8e6 });
    } catch { return toast('Could not start recording'); }

    chunks = [];
    recorder.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
    recorder.onstop = () => {
        download(new Blob(chunks, { type: mime }), `magicdraw-${stamp()}.webm`);
        toast('Video saved');
    };
    recorder.start(1000);

    recStart = performance.now();
    $('recDot').classList.add('on');
    $('btnRec').classList.add('rec');
    recTimer = setInterval(() => {
        const s = Math.floor((performance.now() - recStart) / 1000);
        $('recTime').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    }, 500);
}

function stopRec() {
    recorder?.stop();
    recorder = null;
    clearInterval(recTimer);
    $('recDot').classList.remove('on');
    $('btnRec').classList.remove('rec');
}

function download(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
}

const stamp = () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');

/* --- Atajos de teclado --- */
addEventListener('keydown', e => {
    if (e.target.matches('input, select')) return;
    const k = e.key.toLowerCase();
    if (k === 'c') { clearAll(); toast('Canvas cleared'); }
    else if (k === 'm') $('btnMirror').click();
    else if (k === 'b') $('btnBlur').click();
    else if (k === 'f') $('btnFull').click();
    else if (k === 's') $('btnShot').click();
    else if (k === 'r') $('btnRec').click();
    else if (k === 'h') { ui.classList.toggle('hidden'); }
    else if (k === ' ') { e.preventDefault(); $('btnFreeze').click(); }
    else if (k === '1' || k === '2' || k === '3') {
        CFG.mode = ['all', 'index', 'pinch'][+k - 1];
        syncUI();
    }
});

/* --- Ocultar la interfaz al estar inactivo --- */
let idleTimer = 0;
function poke() {
    ui.classList.remove('hidden');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
        if (!$('panel').classList.contains('open')) ui.classList.add('hidden');
    }, 4000);
}
['mousemove', 'pointerdown', 'keydown'].forEach(ev => addEventListener(ev, poke));
poke();

// Pausa la cámara al esconder la pestaña: ahorra batería y evita saltos de tiempo.
document.addEventListener('visibilitychange', () => {
    stream?.getVideoTracks().forEach(t => t.enabled = !document.hidden);
    if (!document.hidden) lastVideoTime = -1;
});

syncUI();
boot();
