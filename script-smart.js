const video = document.getElementById("video");
const overlay = document.getElementById("overlay");
const captureCanvas = document.getElementById("captureCanvas");
const captureBtn = document.getElementById("captureBtn");
const fieldsDiv = document.getElementById("fields");
const confirmBtn = document.getElementById("confirmBtn");
const logDiv = document.getElementById("log");

let lastExtractedData = null;

// Your Apps Script URL
const APPS_SCRIPT_URL =
  "https://script.google.com/macros/s/AKfycbwq66OWAFID_aBqvMZpPp_vB1yuzOg3Fkz6ERpbhA3K-xj6JYKRPWJzstXkgxKFMo2o/exec";

function log(msg) {
  logDiv.textContent += msg + "\n";
}

/* Start back camera */
navigator.mediaDevices
  .getUserMedia({
    video: {
      facingMode: { ideal: "environment" },
      width: { ideal: 1920 },
      height: { ideal: 1080 },
    },
  })
  .then((stream) => {
    video.srcObject = stream;
    video.addEventListener("loadedmetadata", () => {
      // Match overlay & capture canvas to video size
      overlay.width = video.videoWidth;
      overlay.height = video.videoHeight;
      captureCanvas.width = video.videoWidth;
      captureCanvas.height = video.videoHeight;
    });
    log("Back camera started.");
  })
  .catch((err) => log("Camera error: " + err));

/* Capture & Scan */
captureBtn.addEventListener("click", async () => {
  try {
    log("Capturing frame...");
    const ctx = captureCanvas.getContext("2d");
    ctx.drawImage(video, 0, 0, captureCanvas.width, captureCanvas.height);

    const dataURL = captureCanvas.toDataURL("image/png");
    await runOCRWithLayout(dataURL);
  } catch (e) {
    log("Capture error: " + e);
  }
});

/* Run OCR with layout and draw rectangles */
async function runOCRWithLayout(dataURL) {
  log("Running OCR...");

  const result = await Tesseract.recognize(dataURL, "eng", {
    tessedit_char_whitelist:
      "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789/.-' ",
    logger: (m) =>
      log(
        m.status +
          " " +
          (m.progress ? (m.progress * 100).toFixed(0) + "%" : "")
      ),
  });

  log("OCR done.");

  const { blocks } = result.data;
  if (!blocks || blocks.length === 0) {
    log("No text blocks detected.");
    return;
  }

  // Normalize text and keep bbox
  const normBlocks = blocks.map((b) => ({
    text: (b.text || "").trim().toUpperCase(),
    bbox: b.bbox, // { x0, y0, x1, y1 }
  })).filter(b => b.text.length > 0);

  // Required labels
  const labels = ["NAME", "PASSPORT", "NATIONALITY", "EXPIRY DATE", "EMPLOYER"];

  const labelMap = {};
  const valueMap = {};

  // Find label blocks
  for (const label of labels) {
    const lb = normBlocks.find(b => b.text.includes(label));
    if (lb) labelMap[label] = lb;
  }

  // For each label, find nearest block below it
  for (const label of labels) {
    const lb = labelMap[label];
    if (!lb) continue;

    const ly1 = lb.bbox.y1;
    const lx0 = lb.bbox.x0;
    const lx1 = lb.bbox.x1;

    let best = null;
    let bestDy = Infinity;

    for (const b of normBlocks) {
      if (b === lb) continue;
      const { x0, x1, y0 } = b.bbox;
      if (y0 <= ly1) continue; // must be below
      const overlap = Math.min(lx1, x1) - Math.max(lx0, x0);
      if (overlap <= 0) continue; // no horizontal overlap

      const dy = y0 - ly1;
      if (dy < bestDy) {
        bestDy = dy;
        best = b;
      }
    }

    if (best) valueMap[label] = best;
  }

  // Draw rectangles
  drawRectangles(labelMap, valueMap);

  // Extract values
  const extracted = {
    name: valueMap["NAME"] ? valueMap["NAME"].text : "",
    passport: valueMap["PASSPORT"] ? valueMap["PASSPORT"].text : "",
    nationality: valueMap["NATIONALITY"] ? valueMap["NATIONALITY"].text : "",
    expiry: valueMap["EXPIRY DATE"] ? valueMap["EXPIRY DATE"].text : "",
    employer: valueMap["EMPLOYER"] ? valueMap["EMPLOYER"].text : "",
  };

  lastExtractedData = extracted;
  showFields(extracted);

  // Basic check
  const missing = [];
  if (!extracted.name) missing.push("NAME");
  if (!extracted.passport) missing.push("PASSPORT");
  if (!extracted.nationality) missing.push("NATIONALITY");
  if (!extracted.expiry) missing.push("EXPIRY DATE");
  if (!extracted.employer) missing.push("EMPLOYER");

  if (missing.length > 0) {
    log("Missing labels/values: " + missing.join(", "));
  }
}

/* Draw rectangles around labels and values */
function drawRectangles(labelMap, valueMap) {
  const ctx = overlay.getContext("2d");
  ctx.clearRect(0, 0, overlay.width, overlay.height);

  ctx.lineWidth = 3;
  ctx.font = "16px Arial";
  ctx.textBaseline = "top";

  // Helper to draw one box
  function drawBox(bbox, color, label) {
    const { x0, y0, x1, y1 } = bbox;
    ctx.strokeStyle = color;
    ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
    if (label) {
      ctx.fillStyle = color;
      ctx.fillText(label, x0 + 2, y0 - 18);
    }
  }

  // Labels in cyan, values in lime
  for (const key in labelMap) {
    drawBox(labelMap[key].bbox, "#00bcd4", key);
  }
  for (const key in valueMap) {
    drawBox(valueMap[key].bbox, "#8bc34a", "VALUE");
  }
}

/* Show extracted fields */
function showFields(data) {
  fieldsDiv.innerHTML = `
    <div><strong>Name:</strong> ${data.name || "-"}</div>
    <div><strong>Passport:</strong> ${data.passport || "-"}</div>
    <div><strong>Nationality:</strong> ${data.nationality || "-"}</div>
    <div><strong>Expiry Date:</strong> ${data.expiry || "-"}</div>
    <div><strong>Employer:</strong> ${data.employer || "-"}</div>
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
