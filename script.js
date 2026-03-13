const video = document.getElementById("video");
const canvas = document.getElementById("canvas");
const scanFrame = document.getElementById("scanFrame");
const fieldsDiv = document.getElementById("fields");
const confirmBtn = document.getElementById("confirmBtn");
const logDiv = document.getElementById("log");

let lastExtractedData = null;
let stableCount = 0;
let autoCaptured = false;

// === CONFIG: your Google Apps Script Web App URL ===
const APPS_SCRIPT_URL = "YOUR_APPS_SCRIPT_URL_HERE";

function log(msg) {
  logDiv.textContent += msg + "\n";
}

/* Start back camera in HD */
navigator.mediaDevices.getUserMedia({
  video: {
    facingMode: { ideal: "environment" },
    width: { ideal: 1920 },
    height: { ideal: 1080 }
  }
})
.then(stream => {
  video.srcObject = stream;
  log("Back camera started.");
})
.catch(err => log("Camera error: " + err));

/* Auto-detection loop */
setInterval(() => {
  if (autoCaptured) return;

  const ctx = canvas.getContext("2d");
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

  const frame = ctx.getImageData(0, 0, canvas.width, canvas.height);

  if (!window.cv) return; // OpenCV not ready yet

  let mat = cv.matFromImageData(frame);
  let gray = new cv.Mat();
  cv.cvtColor(mat, gray, cv.COLOR_RGBA2GRAY);

  let edges = new cv.Mat();
  cv.Canny(gray, edges, 50, 150);

  let contours = new cv.MatVector();
  let hierarchy = new cv.Mat();
  cv.findContours(edges, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

  let detected = false;

  for (let i = 0; i < contours.size(); i++) {
    let cnt = contours.get(i);
    let approx = new cv.Mat();
    cv.approxPolyDP(cnt, approx, 0.02 * cv.arcLength(cnt, true), true);

    if (approx.rows === 4) {
      detected = true;
      approx.delete();
      break;
    }
    approx.delete();
  }

  mat.delete();
  gray.delete();
  edges.delete();
  contours.delete();
  hierarchy.delete();

  if (detected) {
    stableCount++;
    scanFrame.style.borderColor = "lime";

    if (stableCount >= 3) {
      autoCaptured = true;
      captureAndOCR();
    }
  } else {
    stableCount = 0;
    scanFrame.style.borderColor = "red";
  }

}, 300);

/* Capture + OCR */
async function captureAndOCR() {
  log("Auto-capturing...");

  const ctx = canvas.getContext("2d");
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

  const dataURL = canvas.toDataURL("image/png");

  log("Running OCR...");

  const result = await Tesseract.recognize(
    dataURL,
    "eng",
    { logger: m => log(m.status + " " + (m.progress ? (m.progress * 100).toFixed(0) + "%" : "")) }
  );

  const text = result.data.text;
  log("OCR done.\n" + text);

  const extracted = extractFields(text);
  lastExtractedData = extracted;
  showFields(extracted);
}

/* Extract fields */
function extractFields(text) {
  const clean = text.replace(/\r/g, "").toUpperCase();

  function get(regex) {
    const m = clean.match(regex);
    return m ? m[1].trim() : "";
  }

  return {
    name: get(/NAME\s*([A-Z\s'.-]+)/),
    passport: get(/PASSPORT\s*([A-Z0-9]+)/),
    nationality: get(/NATIONALITY\s*([A-Z]+)/),
    expiry: get(/EXPIRY DATE\s*([0-9/]+)/),
    employer: get(/EMPLOYER\s*([A-Z0-9 .,&'\/-]+)/)
  };
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

/* Confirm & Save */
confirmBtn.addEventListener("click", async () => {
  log("Sending to Google Sheet...");

  await fetch(APPS_SCRIPT_URL, {
    method: "POST",
    mode: "no-cors",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(lastExtractedData)
  });

  log("Saved successfully.");
});
