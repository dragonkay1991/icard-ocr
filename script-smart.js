const video = document.getElementById("video");
const captureCanvas = document.getElementById("captureCanvas");
const captureBtn = document.getElementById("captureBtn");
const fieldsDiv = document.getElementById("fields");
const confirmBtn = document.getElementById("confirmBtn");
const logDiv = document.getElementById("log");

let lastExtractedData = null;
let stream = null;

// Your Apps Script URL
const APPS_SCRIPT_URL =
  "https://script.google.com/macros/s/AKfycbwq66OWAFID_aBqvMZpPp_vB1yuzOg3Fkz6ERpbhA3K-xj6JYKRPWJzstXkgxKFMo2o/exec";

function log(msg) {
  logDiv.textContent += msg + "\n";
}

/* Start back camera with autofocus */
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
async function tapToFocus() {
  if (!stream) return;

  const track = stream.getVideoTracks()[0];
  const capabilities = track.getCapabilities();

  if (capabilities.focusMode) {
    try {
      await track.applyConstraints({
        advanced: [{ focusMode: "single-shot" }]
      });
      log("Tap-to-focus triggered.");

      setTimeout(async () => {
        await track.applyConstraints({
          advanced: [{ focusMode: "continuous" }]
        });
        log("Continuous focus restored.");
      }, 800);

    } catch (err) {
      log("Tap-to-focus not supported.");
    }
  }
}

document.getElementById("cameraContainer").addEventListener("click", tapToFocus);

/* Levenshtein for fuzzy matching */
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

/* Capture & Scan */
captureBtn.addEventListener("click", async () => {
  try {
    const canvas = captureCanvas;
    const ctx = canvas.getContext("2d");

    if (!video.videoWidth || !video.videoHeight) {
      log("Video not ready.");
      return;
    }

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

  } catch (e) {
    log("Capture error: " + e);
  }
});

/* Run OCR with fuzzy label detection + C3 cropping */
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
    tessedit_char_whitelist:
      "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789/.-,' ",
    logger: (m) =>
      log(
        m.status +
          " " +
          (m.progress ? (m.progress * 100).toFixed(0) + "%" : "")
      ),
  });

  log("OCR done.");

  const words = result.data.words || [];
  if (!words.length) {
    log("No words detected.");
    return;
  }

  const labels = [
    "NAME",
    "PASSPORT",
    "NATIONALITY",
    "EMPLOYER",
    "EXPIRY DATE"
  ];

  const labelBoxes = {};

  for (const w of words) {
    const text = (w.text || "").trim().toUpperCase();
    if (!text) continue;

    for (const label of labels) {
      const tokens = label.split(" ");
      let bestSim = similarity(text, label);
      for (const t of tokens) {
        bestSim = Math.max(bestSim, similarity(text, t));
      }
      if (bestSim >= 0.6) {
        if (!labelBoxes[label] || w.bbox.y0 < labelBoxes[label].y0) {
          labelBoxes[label] = w.bbox;
        }
      }
    }
  }

  log("Detected labels: " + Object.keys(labelBoxes).join(", "));

  const ctx = captureCanvas.getContext("2d");
  ctx.lineWidth = 3;
  ctx.font = "16px Arial";
  ctx.textBaseline = "top";

  function drawBox(bboxUp, color, textLabel) {
    const x0 = bboxUp.x0 / scale;
    const y0 = bboxUp.y0 / scale;
    const x1 = bboxUp.x1 / scale;
    const y1 = bboxUp.y1 / scale;
    ctx.strokeStyle = color;
    ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
    if (textLabel) {
      ctx.fillStyle = color;
      ctx.fillText(textLabel, x0 + 2, y0 - 18);
    }
  }

  for (const label of labels) {
    if (labelBoxes[label]) {
      drawBox(labelBoxes[label], "#00bcd4", label);
    }
  }

  const values = {
    NAME: "",
    PASSPORT: "",
    NATIONALITY: "",
    EMPLOYER: "",
    "EXPIRY DATE": ""
  };

  function getNextLabelBelow(currentLabel) {
    const curBox = labelBoxes[currentLabel];
    if (!curBox) return null;
    let bestLabel = null;
    let bestDy = Infinity;
    for (const l of labels) {
      if (l === currentLabel) continue;
      const b = labelBoxes[l];
      if (!b) continue;
      if (b.y0 <= curBox.y1) continue;
      const dy = b.y0 - curBox.y1;
      if (dy < bestDy) {
        bestDy = dy;
        bestLabel = l;
      }
    }
    return bestLabel;
  }

  for (const label of labels) {
    const curBox = labelBoxes[label];
    if (!curBox) continue;

    const nextLabel = getNextLabelBelow(label);
    const yStartUp = curBox.y1 + 10 * scale;
    const yEndUp = nextLabel
      ? labelBoxes[nextLabel].y0 - 10 * scale
      : upCanvas.height - 10 * scale;

    if (yEndUp <= yStartUp) continue;

    const xStartUp = upCanvas.width * 0.1;
    const xEndUp = upCanvas.width * 0.9;

    const cropW = xEndUp - xStartUp;
    const cropH = yEndUp - yStartUp;

    const cropCanvas = document.createElement("canvas");
    cropCanvas.width = cropW;
    cropCanvas.height = cropH;
    const cropCtx = cropCanvas.getContext("2d");
    cropCtx.drawImage(
      upCanvas,
      xStartUp,
      yStartUp,
      cropW,
      cropH,
      0,
      0,
      cropW,
      cropH
    );

    drawBox({ x0: xStartUp, y0: yStartUp, x1: xEndUp, y1: yEndUp }, "#8bc34a", "VALUE");

    const cropDataURL = cropCanvas.toDataURL("image/png");
    const valResult = await Tesseract.recognize(cropDataURL, "eng", {
      tessedit_char_whitelist:
        "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789/.-,' ",
    });

    let text = (valResult.data.text || "").trim();
    let lines = text
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);

    if (!lines.length) continue;

    if (label === "EMPLOYER") {
      values[label] = lines.slice(0, 2).join(" ");
    } else if (label === "NAME") {
      values[label] = lines.slice(0, 2).join(" ");
    } else {
      values[label] = lines[0];
    }
  }

  const extracted = {
    name: values["NAME"] || "",
    passport: values["PASSPORT"] || "",
    nationality: values["NATIONALITY"] || "",
    employer: values["EMPLOYER"] || "",
    expiry: values["EXPIRY DATE"] || ""
  };

  lastExtractedData = extracted;
  showFields(extracted);

  const missing = Object.entries(extracted)
    .filter(([_, v]) => !v)
    .map(([k]) => k.toUpperCase());

  if (missing.length) {
    log("Missing fields: " + missing.join(", "));
  } else {
    log("All fields detected.");
  }
}

/* Show extracted fields */
function showFields(data) {
  fieldsDiv.innerHTML = `
    <div><strong>Name:</strong> ${data.name || "-"}</div>
    <div><strong>Passport:</strong> ${data.passport || "-"}</div>
    <div><strong>Nationality:</strong> ${data.nationality || "-"}</div>
    <div><strong>Employer:</strong> ${data.employer || "-"}</div>
    <div><strong>Expiry Date:</strong> ${data.expiry || "-"}</div>
  `;
  confirmBtn.style.display = "block";
}

/* Save to Google Sheet */
confirmBtn.addEventListener("click", async () => {
  if (!lastExtractedData) return;
  log("Sending to Google Sheet...");

  await fetch(APPS_SCRIPT_URL, {
    method: "POST",
    mode: "no-cors",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(lastExtractedData),
  });

  log("Saved successfully.");
});
