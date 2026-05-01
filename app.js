/* ══════════════════════════════════════════
   EmoSense — Detector de Expresiones
   app.js
══════════════════════════════════════════ */

/* ─────────────────────────────────────────
   CONFIG — ajusta estos valores a tu modelo
───────────────────────────────────────── */
const INPUT_SIZE  = 48;   // tamaño de entrada: 48 para FER-2013, 64 para otros
const INTERVAL_MS = 200;  // milisegundos entre predicciones (~5 fps de inferencia)

const EMOTIONS = [
  { key: 'Feliz',   icon: '😄', color: 'var(--happy)'   },
  { key: 'Triste',  icon: '😢', color: 'var(--sad)'     },
  { key: 'Neutral', icon: '😐', color: 'var(--neutral)' },
  { key: 'Enojado', icon: '😠', color: 'var(--angry)'   },
  { key: 'Miedo',   icon: '😱', color: 'var(--fear)'    },
];

/* ─────────────────────────────────────────
   STATE
───────────────────────────────────────── */
let stream      = null;
let model       = null;
let detecting   = false;
let loopHandle  = null;
let source      = 'tfjs';   // 'tfjs' | 'api' | 'demo'
let frameCount  = 0;
let lastFpsTime = performance.now();

/* ─────────────────────────────────────────
   DOM REFS
───────────────────────────────────────── */
const video   = document.getElementById('video');
const overlay = document.getElementById('overlay');
const ctx     = overlay.getContext('2d');

/* ─────────────────────────────────────────
   INIT — build emotion bars dynamically
───────────────────────────────────────── */
(function buildBars() {
  const container = document.getElementById('barsContainer');
  EMOTIONS.forEach(e => {
    container.innerHTML += `
      <div class="bar-row">
        <span class="bar-key">${e.icon} ${e.key}</span>
        <div class="bar-track">
          <div class="bar-fill" id="bar-${e.key}" style="background:${e.color}"></div>
        </div>
        <span class="bar-pct" id="pct-${e.key}">0%</span>
      </div>`;
  });
})();

/* ═══════════════════════════════════════════
   LOGGING
═══════════════════════════════════════════ */
function log(msg, type = 'info') {
  const logEl = document.getElementById('statusLog');
  const t     = new Date().toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const cls   = type === 'ok' ? 'log-ok' : type === 'err' ? 'log-err' : 'log-info';
  logEl.innerHTML += `<div class="log-line"><span class="log-time">[${t}]</span><span class="${cls}">${msg}</span></div>`;
  logEl.scrollTop = logEl.scrollHeight;
}

/* ═══════════════════════════════════════════
   SOURCE SELECTOR
═══════════════════════════════════════════ */
function setSource(s) {
  source = s;

  // Toggle buttons
  ['tfjs', 'api', 'demo'].forEach(x => {
    const btnId = 'btn' + (x === 'tfjs' ? 'TFJS' : x === 'api' ? 'API' : 'Demo');
    const cfgId = 'config' + (x === 'tfjs' ? 'TFJS' : x === 'api' ? 'API' : 'Demo');
    document.getElementById(btnId).classList.toggle('active', x === s);
    document.getElementById(cfgId).classList.toggle('visible', x === s);
  });

  // Reset model state
  model = null;
  document.getElementById('btnDetect').disabled = true;

  if (s === 'demo') {
    document.getElementById('btnLoad').disabled = true;
    if (stream) document.getElementById('btnDetect').disabled = false;
    log('Modo Demo activado — sin modelo real.', 'info');
  } else {
    document.getElementById('btnLoad').disabled = !stream;
    log(`Fuente cambiada a ${s.toUpperCase()}.`, 'info');
  }
}

/* ═══════════════════════════════════════════
   CAMERA
═══════════════════════════════════════════ */
async function startCamera() {
  try {
    log('Solicitando acceso a cámara…');

    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: 640, height: 480 },
      audio: false
    });

    video.srcObject = stream;
    await new Promise(resolve => { video.onloadedmetadata = resolve; });

    // Sync canvas size with video
    overlay.width  = video.videoWidth;
    overlay.height = video.videoHeight;

    // Activate UI elements
    document.getElementById('placeholder').classList.add('hidden');
    document.getElementById('scanLine').classList.add('active');
    ['c1', 'c2', 'c3', 'c4'].forEach(id => document.getElementById(id).classList.add('active'));
    document.getElementById('videoLabel').textContent = '● LIVE';
    document.getElementById('videoLabel').classList.add('active');
    document.getElementById('fpsBadge').classList.add('visible');
    document.getElementById('btnStart').disabled = true;
    document.getElementById('btnLoad').disabled  = (source === 'demo');

    if (source === 'demo') document.getElementById('btnDetect').disabled = false;

    log('Cámara iniciada correctamente.', 'ok');
  } catch (err) {
    log(`Error cámara: ${err.message}`, 'err');
  }
}

/* ═══════════════════════════════════════════
   MODEL LOADER — TensorFlow.js
═══════════════════════════════════════════ */
async function loadModel() {
  // API mode: no local model needed
  if (source === 'api') {
    log('Modo API: no se requiere modelo local.', 'ok');
    document.getElementById('btnDetect').disabled = false;
    model = 'api';
    return;
  }

  const path = document.getElementById('modelPath').value.trim();
  log(`Cargando modelo desde: ${path}`);
  document.getElementById('btnLoad').disabled = true;

  try {
    // tf.loadLayersModel acepta rutas relativas, absolutas o IndexedDB
    model = await tf.loadLayersModel(path);

    // Warm-up pass para evitar lag en la primera predicción real
    const dummy = tf.zeros([1, INPUT_SIZE, INPUT_SIZE, 1]);
    model.predict(dummy).dispose();
    dummy.dispose();

    log(`Modelo cargado ✓ — ${model.countParams().toLocaleString()} parámetros`, 'ok');
    document.getElementById('btnDetect').disabled = false;
  } catch (err) {
    log(`Error al cargar modelo: ${err.message}`, 'err');
    document.getElementById('btnLoad').disabled = false;
  }
}

/* ═══════════════════════════════════════════
   DETECTION LOOP
═══════════════════════════════════════════ */
function toggleDetection() {
  detecting = !detecting;
  const btn = document.getElementById('btnDetect');

  if (detecting) {
    btn.textContent       = '⏹ Detener Detección';
    btn.style.borderColor = 'var(--accent2)';
    btn.style.color       = 'var(--accent2)';
    log('Detección iniciada.', 'ok');
    loopHandle = setInterval(predict, INTERVAL_MS);
  } else {
    btn.textContent       = '● Iniciar Detección';
    btn.style.borderColor = '';
    btn.style.color       = '';
    clearInterval(loopHandle);
    ctx.clearRect(0, 0, overlay.width, overlay.height);
    log('Detección detenida.', 'info');
  }
}

/* ─── Main predict dispatcher ─── */
async function predict() {
  if (!stream || video.readyState < 2) return;

  let probs;

  if      (source === 'demo') probs = demoPredict();
  else if (source === 'api')  probs = await apiPredict();
  else {
    if (!model) return;
    probs = await tfjsPredict();
  }

  if (!probs) return;
  renderResult(probs);
  updateFPS();
}

/* ═══════════════════════════════════════════
   INFERENCE — TF.js local model
═══════════════════════════════════════════ */
async function tfjsPredict() {
  return tf.tidy(() => {
    const tensor = tf.browser.fromPixels(video, 1)      // → grayscale [H,W,1]
      .resizeBilinear([INPUT_SIZE, INPUT_SIZE])          // → [48,48,1]
      .toFloat()
      .div(255.0)                                        // normalizar [0,1]
      .expandDims(0);                                    // → [1,48,48,1]

    const output = model.predict(tensor);               // → [1,5] softmax
    return Array.from(output.dataSync());
  });
}

/* ═══════════════════════════════════════════
   INFERENCE — Flask REST API
   Endpoint esperado POST /predict
   Body:    { "image": "<base64 jpeg>" }
   Response:{ "probabilities": [f,f,f,f,f] }
═══════════════════════════════════════════ */
async function apiPredict() {
  try {
    // Capturar frame a INPUT_SIZE para reducir payload
    const tmpCanvas = document.createElement('canvas');
    tmpCanvas.width  = INPUT_SIZE;
    tmpCanvas.height = INPUT_SIZE;
    tmpCanvas.getContext('2d').drawImage(video, 0, 0, INPUT_SIZE, INPUT_SIZE);
    const base64 = tmpCanvas.toDataURL('image/jpeg', 0.8).split(',')[1];

    const resp = await fetch(document.getElementById('apiUrl').value.trim(), {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ image: base64 })
    });

    const data = await resp.json();

    // Acepta distintos nombres de campo según tu backend
    return data.probabilities ?? data.probs ?? data.predictions ?? null;
  } catch (err) {
    log(`Error API: ${err.message}`, 'err');
    return null;
  }
}

/* ═══════════════════════════════════════════
   INFERENCE — Demo (simulación aleatoria)
═══════════════════════════════════════════ */
function demoPredict() {
  if (!demoPredict._state) {
    demoPredict._state = EMOTIONS.map(() => Math.random());
  }
  // Transiciones suaves hacia valores aleatorios
  demoPredict._state = demoPredict._state.map(v =>
    Math.max(0, v + (Math.random() - 0.5) * 0.2)
  );
  const sum = demoPredict._state.reduce((a, b) => a + b, 0);
  return demoPredict._state.map(v => v / sum);
}

/* ═══════════════════════════════════════════
   RENDER RESULT
═══════════════════════════════════════════ */
function renderResult(probs) {
  // Encontrar emoción dominante
  let maxIdx = 0;
  probs.forEach((p, i) => { if (p > probs[maxIdx]) maxIdx = i; });
  const top  = EMOTIONS[maxIdx];
  const conf = (probs[maxIdx] * 100).toFixed(1);

  // Actualizar nombre e ícono con animación de salida/entrada
  const nameEl = document.getElementById('emotionName');
  const iconEl = document.getElementById('emotionIcon');
  const confEl = document.getElementById('confValue');

  if (nameEl.textContent !== top.key) {
    nameEl.style.transform = 'translateY(-4px)';
    nameEl.style.opacity   = '0';
    setTimeout(() => {
      nameEl.textContent     = top.key;
      nameEl.style.color     = top.color;
      nameEl.style.transform = '';
      nameEl.style.opacity   = '';
    }, 150);

    iconEl.style.transform = 'scale(1.3) rotate(10deg)';
    setTimeout(() => {
      iconEl.textContent     = top.icon;
      iconEl.style.transform = '';
    }, 150);
  }

  confEl.textContent = `${conf}%`;

  // Actualizar barras de probabilidad
  probs.forEach((p, i) => {
    const pct = (p * 100).toFixed(1);
    document.getElementById(`bar-${EMOTIONS[i].key}`).style.width = pct + '%';
    document.getElementById(`pct-${EMOTIONS[i].key}`).textContent = pct + '%';
  });

  // Dibujar recuadro facial en canvas overlay
  drawOverlay(top.color);
}

/* ═══════════════════════════════════════════
   OVERLAY CANVAS — recuadro facial coloreado
═══════════════════════════════════════════ */
function drawOverlay(color) {
  ctx.clearRect(0, 0, overlay.width, overlay.height);

  const w  = overlay.width;
  const h  = overlay.height;
  const fw = w * 0.40;
  const fh = h * 0.65;
  const fx = (w - fw) / 2;
  const fy = (h - fh) * 0.35;
  const r  = 12;

  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth   = 2;
  ctx.shadowColor = color;
  ctx.shadowBlur  = 12;
  ctx.globalAlpha = 0.85;

  // Rounded rectangle path
  ctx.beginPath();
  ctx.moveTo(fx + r, fy);
  ctx.lineTo(fx + fw - r, fy);
  ctx.arcTo(fx + fw, fy,       fx + fw, fy + r,       r);
  ctx.lineTo(fx + fw, fy + fh - r);
  ctx.arcTo(fx + fw, fy + fh,  fx + fw - r, fy + fh,  r);
  ctx.lineTo(fx + r,  fy + fh);
  ctx.arcTo(fx,       fy + fh, fx, fy + fh - r,        r);
  ctx.lineTo(fx,      fy + r);
  ctx.arcTo(fx,       fy,      fx + r, fy,              r);
  ctx.closePath();
  ctx.stroke();

  ctx.restore();
}

/* ═══════════════════════════════════════════
   FPS COUNTER
═══════════════════════════════════════════ */
function updateFPS() {
  frameCount++;
  const now = performance.now();
  if (now - lastFpsTime >= 1000) {
    const fps = (frameCount / ((now - lastFpsTime) / 1000)).toFixed(0);
    document.getElementById('fpsBadge').textContent = `${fps} fps`;
    frameCount  = 0;
    lastFpsTime = now;
  }
}
