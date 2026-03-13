const video = document.getElementById("video");
const canvas = document.getElementById("canvas");
const scanBtn = document.getElementById("scanBtn");
const fieldsDiv = document.getElementById("fields");
const logDiv = document.getElementById("log");

// === CONFIG: your Google Apps Script Web App URL ===
const APPS_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbwq66OWAFID_aBqvMZpPp_vB1yuzOg3Fkz6ERpbhA3K-xj6JYKRPWJzstXkgxKFMo2o/exec";

function log(msg) {
  logDiv.textContent += msg + "\n";
}

// Start camera
navigator.mediaDevices.getUserMedia({ video: true })
  .then(stream => {
    video.srcObject = stream;
    log("Camera started.");
  })
  .catch(err => {
    log("Camera error: " + err);
  });

scanBtn.addEventListener("click", async () => {
  scanBtn.disabled = true;
  log("Capturing frame...");

  const ctx = canvas.getContext("2d");
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

  const dataURL = canvas.toDataURL("image/png");

  log("Running OCR...");
  try {
    const result = await Tesseract.recognize(
      dataURL,
      "eng",
      { logger: m => log(m.status + " " + (m.progress ? (m.progress * 100).toFixed(0) + "%" : "")) }
    );

    const text = result.data.text;
    log("OCR done.\n" + text);

    const extracted = extractFields(text);
    showFields(extracted);

    log("Sending to Google Apps Script...");
    await sendToSheet(extracted);
    log("Saved to Google Sheet.");

  } catch (err) {
    log("Error: " + err);
  } finally {
    scanBtn.disabled = false;
  }
});

function extractFields(text) {
  const clean = text.replace(/\r/g, "").toUpperCase();

  function get(regex) {
    const m = clean.match(regex);
    return m ? m[1].trim() : "";
  }

  const passport = get(/PASSPORT\s*([A-Z0-9]+)/);
  const name = get(/NAME\s*([A-Z\s'.-]+)/);
  const nationality = get(/NATIONALITY\s*([A-Z]+)/);
  const expiry = get(/EXPIRY DATE\s*([0-9/]+)/);
  const employer = get(/EMPLOYER\s*([A-Z0-9 .,&'\/-]+)/);

  return { name, passport, nationality, expiry, employer };
}

function showFields(data) {
  fieldsDiv.innerHTML = `
    <div><strong>Name:</strong> ${data.name || "-"}</div>
    <div><strong>Passport:</strong> ${data.passport || "-"}</div>
    <div><strong>Nationality:</strong> ${data.nationality || "-"}</div>
    <div><strong>Expiry Date:</strong> ${data.expiry || "-"}</div>
    <div><strong>Employer:</strong> ${data.employer || "-"}</div>
  `;
}

async function sendToSheet(data) {
  const res = await fetch(APPS_SCRIPT_URL, {
    method: "POST",
    mode: "no-cors",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(data)
  });
}
