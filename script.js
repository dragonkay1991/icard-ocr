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
const APPS_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbwq66OWAFID_aBqvMZpPp_vB1yuzOg3Fkz6ERpbhA3K-xj6JYKRPWJzstXkgxKFMo2o/exec";

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

/* Crop only the card inside the frame */
function cropToFrame() {
  const frame = scanFrame.getBoundingClientRect();
  const videoRect = video.getBoundingClientRect();

  const scaleX = canvas.width / videoRect.width;
  const scaleY = canvas.height / videoRect.height;

  const x = (frame.left - videoRect.left) * scaleX;
  const y = (frame.top - videoRect.top) * scaleY;
  const w = frame.width * scaleX;
  const h = frame.height * scaleY;

  const ctx = canvas.getContext("2d");
  const cropped = ctx.getImageData(x, y, w, h);

  const tempCanvas = document.createElement("canvas");
  tempCanvas.width = w;
  tempCanvas.height = h;
  tempCanvas.getContext("2d").putImageData(cropped, 0, 0);

  return tempCanvas;
}

/* Deskew image using OpenCV */
function deskewImage(mat) {
  let gray = new cv.Mat();
  cv.cvtColor(mat, gray, cv.COLOR_RGBA2GRAY);

  let thresh = new cv.Mat();
  cv.threshold(gray, thresh, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);

  let coords = new cv.Mat();
  cv.findNonZero(thresh, coords);

  let rect = cv.minAreaRect(coords);
  let angle = rect.angle;
  if (angle < -45) angle += 90;

  let center = new cv.Point(mat.cols / 2, mat.rows / 2);
  let M = cv.getRotationMatrix2D(center, angle, 1);

  let rotated = new cv.Mat();
  cv.warpAffine(mat, rotated, M, new cv.Size(mat.cols, mat.rows), cv.INTER_CUBIC);

  gray.delete();
  thresh.delete();
  coords.delete();
  M.delete();

  return rotated;
}

/* Sharpen image */
function sharpen(mat) {
  let kernel = cv.matFromArray(3, 3, cv.CV_32F, [
    0, -1, 0,
    -1, 5, -1,
    0, -1, 0
  ]);
  let dst = new cv.Mat();
  cv.filter2D(mat, dst, cv.CV_8U, kernel);
  kernel.delete();
  return dst;
}

/* Auto-detection loop (green border + auto-capture) */
setInterval(() => {
  if (autoCaptured) return;
  if (!window.cv || !cv.Mat) return;

  const ctx = canvas.getContext("2d");
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

  const frameData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  let mat = cv.matFromImageData(frameData);
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

    // ~1 second stable (300ms * 3)
    if (stableCount >= 3) {
      autoCaptured = true;
      captureAndOCR();
    }
  } else {
    stableCount = 0;
    scanFrame.style.borderColor = "red";
  }

}, 300);

/* Capture + OCR pipeline */
async function captureAndOCR() {
  try {
    log("Auto-capturing...");

    // Draw latest frame to canvas
    const ctx = canvas.getContext("2d");
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    // Crop to card frame
    const tempCanvas = cropToFrame();

    if (!window.cv || !cv.Mat) {
      log("OpenCV not ready, using raw crop for OCR.");
      const dataURL = tempCanvas.toDataURL("image/png");
      await runOCR(dataURL);
      return;
    }

    // OpenCV: deskew + sharpen
    let mat = cv.imread(tempCanvas);
    let rotated = deskewImage(mat);
    mat.delete();

    let sharpened = sharpen(rotated);
    rotated.delete();

    cv.imshow(tempCanvas, sharpened);
    sharpened.delete();

    const dataURL = tempCanvas.toDataURL("image/png");
    await runOCR(dataURL);
  } catch (e) {
    log("Capture/OCR error: " + e);
    autoCaptured = false;
    stableCount = 0;
    scanFrame.style.borderColor = "red";
  }
}

/* Run Tesseract OCR with whitelist */
async function runOCR(dataURL) {
  log("Running OCR...");

  const result = await Tesseract.recognize(
    dataURL,
    "eng",
    {
      tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789/.-' ",
      logger: m => log(m.status + " " + (m.progress ? (m.progress * 100).toFixed(0) + "%" : ""))
    }
  );

  const text = result.data.text;
  log("OCR done.\n" + text);

  const extracted = extractFields(text);
  lastExtractedData = extracted;
  showFields(extracted);
}

/* Extract fields using label-below logic + multi-line employer */
function extractFields(text) {
  const lines = text
    .replace(/\r/g, "")
    .split("\n")
    .map(l => l.trim().toUpperCase())
    .filter(l => l.length > 0);

  function getBelow(label) {
    const i = lines.findIndex(l => l.includes(label));
    if (i >= 0 && i + 1 < lines.length) {
      return lines[i + 1].trim();
    }
    return "";
  }

  function getBelowMulti(label) {
    const i = lines.findIndex(l => l.includes(label));
    if (i < 0) return "";
    let value = "";
    for (let j = i + 1; j < lines.length; j++) {
      // stop when next label appears
      if (["PASSPORT", "NAME", "NATIONALITY", "EXPIRY", "EMPLOYER", "DATE OF BIRTH", "REFERENCE NO", "ADDRESS", "GENDER"]
        .some(x => lines[j].includes(x))) {
        break;
      }
      value += lines[j] + " ";
    }
    return value.trim();
  }

  return {
    passport: getBelow("PASSPORT"),
    name: getBelow("NAME"),
    nationality: getBelow("NATIONALITY"),
    expiry: getBelow("EXPIRY"),
    employer: getBelowMulti("EMPLOYER")
  };
}

/* Show extracted fields + enable confirm */
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

/* Confirm & Save to Google Sheet */
confirmBtn.addEventListener("click", async () => {
  if (!lastExtractedData) return;
  log("Sending to Google Sheet...");

  await fetch(APPS_SCRIPT_URL, {
    method: "POST",
    mode: "no-cors",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(lastExtractedData)
  });

  log("Saved successfully.");
});
