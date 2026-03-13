/* ===========================
   CAMERA + UI SETUP
=========================== */

const video = document.getElementById("video");
const captureCanvas = document.getElementById("captureCanvas");
const captureBtn = document.getElementById("captureBtn");
const fieldsDiv = document.getElementById("fields");
const confirmBtn = document.getElementById("confirmBtn");
const logDiv = document.getElementById("log");

let lastExtractedData = null;
let stream = null;

const APPS_SCRIPT_URL =
  "https://script.google.com/macros/s/AKfycbwq66OWAFID_aBqvMZpPp_vB1yuzOg3Fkz6ERpbhA3K-xj6JYKRPWJzstXkgxKFMo2o/exec";

function log(msg) {
  logDiv.textContent += msg + "\n";
}

/* Start camera with autofocus */
navigator.mediaDevices
  .getUserMedia({
    video: {
      facingMode: { ideal: "environment" },
      width: { ideal: 1920 },
      height: { ideal: 1080 },
      focusMode: "continuous",
      advanced: [{ focusMode: "continuous" }]
    }
  })
  .then((s) => {
    stream = s;
    video.srcObject = stream;
    video.addEventListener("loadedmetadata", () => {
      captureCanvas.width = video.videoWidth;
      captureCanvas.height = video.videoHeight;
    });
    log("Back camera started.");
  })
  .catch((err) => log("Camera error: " + err));

/* Tap-to-focus */
document.getElementById("cameraContainer").addEventListener("click", async () => {
  if (!stream) return;
  const track = stream.getVideoTracks()[0];
  try {
    await track.applyConstraints({ advanced: [{ focusMode: "single-shot" }] });
    setTimeout(() => {
      track.applyConstraints({ advanced: [{ focusMode: "continuous" }] });
    }, 800);
  } catch (e) {}
});

/* ===========================
   LEVENSHTEIN + SIMILARITY
=========================== */

function levenshtein(a, b) {
  a = a.toUpperCase();
  b = b.toUpperCase();
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      );
    }
  }
  return dp[m][n];
}

function similarity(a, b) {
  if (!a || !b) return 0;
  const dist = levenshtein(a, b);
  const maxLen = Math.max(a.length, b.length);
  return maxLen === 0 ? 1 : 1 - dist / maxLen;
}

/* ===========================
   CAPTURE BUTTON
=========================== */

captureBtn.addEventListener("click", async () => {
  const canvas = captureCanvas;
  const ctx = canvas.getContext("2d");

  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

  video.style.display = "none";
  canvas.style.display = "block";

  if (stream) {
    stream.getTracks().forEach((t) => t.stop());
    stream = null;
  }

  await runSmartOCR();
});

/* ===========================
   GROUP WORDS INTO LINES
=========================== */

function groupByLines(words, tolerance = 20) {
  const sorted = [...words].sort((a, b) => a.bbox.y0 - b.bbox.y0);
  const lines = [];
  let current = [];
  for (const w of sorted) {
    if (!current.length) {
      current.push(w);
      continue;
    }
    const last = current[current.length - 1];
    if (Math.abs(w.bbox.y0 - last.bbox.y0) < tolerance) {
      current.push(w);
    } else {
      lines.push(current);
      current = [w];
    }
  }
  if (current.length) lines.push(current);
  return lines;
}

/* ===========================
   MAIN OCR ENGINE
=========================== */

async function runSmartOCR() {
  log("Running OCR...");

  const imgW = captureCanvas.width;
  const imgH = captureCanvas.height;

  const scale = 2;
  const upCanvas = document.createElement("canvas");
  upCanvas.width = imgW * scale;
  upCanvas.height = imgH * scale;
  const upCtx = upCanvas.getContext("2d");
  upCtx.drawImage(captureCanvas, 0, 0, upCanvas.width, upCanvas.height);

  const dataURL = upCanvas.toDataURL("image/png");

  const result = await Tesseract.recognize(dataURL, "eng", {
    tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789/.-,' ",
    logger: (m) =>
      log(
        m.status +
          " " +
          (m.progress ? (m.progress * 100).toFixed(0) + "%" : "")
      ),
  });

  const words = (result.data.words || []).filter(
    (w) => (w.text || "").trim().length > 0 && w.confidence > 40
  );

  const labels = [
    "NAME",
    "PASSPORT",
    "NATIONALITY",
    "EMPLOYER",
    "ADDRESS",      // used only for positioning
    "EXPIRY DATE"
  ];

  const labelBoxes = {};

  /* Detect labels */
  for (const w of words) {
    const text = (w.text || "").trim().toUpperCase();
    for (const label of labels) {
      const tokens = label.split(" ");
      let bestSim = similarity(text, label);
      for (const t of tokens) bestSim = Math.max(bestSim, similarity(text, t));
      if (bestSim >= 0.6) {
        if (!labelBoxes[label] || w.bbox.y0 < labelBoxes[label].y0) {
          labelBoxes[label] = w.bbox;
        }
      }
    }
  }

  const ctx = captureCanvas.getContext("2d");
  ctx.lineWidth = 3;
  ctx.font = "16px Arial";
  ctx.textBaseline = "top";

  function drawBox(b, color, label) {
    const x0 = b.x0 / scale;
    const y0 = b.y0 / scale;
    const x1 = b.x1 / scale;
    const y1 = b.y1 / scale;
    ctx.strokeStyle = color;
    ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
    if (label) {
      ctx.fillStyle = color;
      ctx.fillText(label, x0 + 2, y0 - 18);
    }
  }

  for (const label of labels) {
    if (labelBoxes[label]) drawBox(labelBoxes[label], "#00bcd4", label);
  }

  const values = {
    NAME: "",
    PASSPORT: "",
    NATIONALITY: "",
    EMPLOYER: "",
    "EXPIRY DATE": ""
  };

  /* Extract value using font-size detection */
  function extractValue(label) {
    const box = labelBoxes[label];
    if (!box) return "";

    const labelHeight = box.y1 - box.y0;

    const below = words.filter(
      (w) =>
        w.bbox.y0 > box.y1 &&
        w.bbox.y0 < box.y1 + 400
    );

    const bigger = below.filter((w) => {
      const h = w.bbox.y1 - w.bbox.y0;
      return h > labelHeight * 1.2;
    });

    if (!bigger.length) return "";

    const lines = groupByLines(bigger, 18);
    const selected = lines.slice(0, label === "EMPLOYER" || label === "NAME" ? 2 : 1);

    const textLines = selected.map((line) =>
      line
        .sort((a, b) => a.bbox.x0 - b.bbox.x0)
        .map((w) => w.text)
        .join(" ")
    );

    const all = selected.flat();
    const minX = Math.min(...all.map((w) => w.bbox.x0));
    const maxX = Math.max(...all.map((w) => w.bbox.x1));
    const minY = Math.min(...all.map((w) => w.bbox.y0));
    const maxY = Math.max(...all.map((w) => w.bbox.y1));

    const pad = 8 * scale;
    const x0 = Math.max(0, minX - pad);
    const y0 = Math.max(0, minY - pad);
    const x1 = Math.min(upCanvas.width, maxX + pad);
    const y1 = Math.min(upCanvas.height, maxY + pad);

    drawBox({ x0, y0, x1, y1 }, "#8bc34a", "VALUE");

    const combined = textLines.join(" ").trim();

    if (label === "EXPIRY DATE") {
      const m = combined.match(/(\d{2}\/\d{2}\/\d{4})/);
      return m ? m[1] : combined;
    }

    return combined;
  }

  for (const label of labels) {
    if (label === "ADDRESS") continue;
    values[label] = extractValue(label);
  }

  const extracted = {
    name: values["NAME"],
    passport: values["PASSPORT"],
    nationality: values["NATIONALITY"],
    employer: values["EMPLOYER"],
    expiry: values["EXPIRY DATE"]
  };

  lastExtractedData = extracted;
  showFields(extracted);
}

/* ===========================
   SHOW FIELDS
=========================== */

function showFields(data) {
  fieldsDiv.innerHTML = `
    <div><strong>Name:</strong> ${data.name}</div>
    <div><strong>Passport:</strong> ${data.passport}</div>
    <div><strong>Nationality:</strong> ${data.nationality}</div>
    <div><strong>Employer:</strong> ${data.employer}</div>
    <div><strong>Expiry Date:</strong> ${data.expiry}</div>
  `;
  confirmBtn.style.display = "block";
}

/* ===========================
   SAVE TO GOOGLE SHEET
=========================== */

confirmBtn.addEventListener("click", async () => {
  if (!lastExtractedData) return;

  await fetch(APPS_SCRIPT_URL, {
    method: "POST",
    mode: "no-cors",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(lastExtractedData),
  });

  log("Saved successfully.");
});
