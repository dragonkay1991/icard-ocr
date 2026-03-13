/* ========== DOM & GLOBALS ========== */

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

/* ========== LOG ========== */
function log(msg) {
  logDiv.textContent += msg + "\n";
}

/* ========== CAMERA ========== */
navigator.mediaDevices
  .getUserMedia({
    video: { facingMode: "environment", width: 1920, height: 1080 }
  })
  .then((s) => {
    stream = s;
    video.srcObject = s;
    video.addEventListener("loadedmetadata", () => {
      captureCanvas.width = video.videoWidth;
      captureCanvas.height = video.videoHeight;
    });
    log("Camera started.");
  })
  .catch((err) => log("Camera error: " + err));

/* Tap-to-focus */
document.getElementById("cameraContainer")?.addEventListener("click", async () => {
  if (!stream) return;
  const track = stream.getVideoTracks()[0];
  const caps = track.getCapabilities?.() || {};
  if (!caps.focusMode) return;
  try {
    await track.applyConstraints({ advanced: [{ focusMode: "single-shot" }] });
    setTimeout(() => {
      track.applyConstraints({ advanced: [{ focusMode: "continuous" }] }).catch(() => {});
    }, 800);
  } catch (e) {}
});

/* ========== CAPTURE ========== */
captureBtn.addEventListener("click", async () => {
  const ctx = captureCanvas.getContext("2d");
  captureCanvas.width = video.videoWidth;
  captureCanvas.height = video.videoHeight;
  ctx.drawImage(video, 0, 0);

  if (stream) {
    stream.getTracks().forEach((t) => t.stop());
    stream = null;
  }

  video.style.display = "none";
  captureCanvas.style.display = "block";

  await runOCR();
});

/* ========== OCR ENGINE ========== */
async function runOCR() {
  log("Running OCR...");

  const dataURL = captureCanvas.toDataURL("image/png");

  const result = await Tesseract.recognize(dataURL, "eng", {
    tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789/.-,' ",
    logger: (m) => log(m.status)
  });

  const rawText = (result.data.text || "").replace(/\r/g, "");
  const linesRaw = rawText
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const lines = linesRaw.map((l) => l.toUpperCase());

  log("OCR complete.");

  const extracted = extractFields(lines, linesRaw);
  lastExtractedData = extracted;
  showFields(extracted);
}

/* ========== SMART TEXT PARSING ========== */
function extractFields(lines, linesRaw) {
  const out = {
    name: "",
    passport: "",
    nationality: "",
    employer: "",
    expiry: ""
  };

  const labelMap = {
    NAME: ["NAME"],
    PASSPORT: ["PASSPORT", "PASSPORT NO", "PASSPORT NO."],
    NATIONALITY: ["NATIONALITY"],
    EMPLOYER: ["EMPLOYER", "COMPANY", "EMPLOYER NAME"],
    EXPIRY: ["EXPIRY DATE", "EXPIRY", "DATE OF EXPIRY"]
  };

  function similarity(a, b) {
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
    const dist = dp[m][n];
    return 1 - dist / Math.max(m, n);
  }

  function findLabelIndex(key) {
    const candidates = labelMap[key];
    let bestIdx = -1;
    let bestScore = 0;
    lines.forEach((line, idx) => {
      candidates.forEach((cand) => {
        const score = similarity(line, cand);
        if (score > bestScore && score >= 0.5) {
          bestScore = score;
          bestIdx = idx;
        }
      });
    });
    return bestIdx;
  }

  function collectNextLines(startIdx, maxLines = 1) {
    const collected = [];
    for (let i = startIdx + 1; i < lines.length && collected.length < maxLines; i++) {
      const upper = lines[i];
      if (
        upper.includes("DATE OF BIRTH") ||
        upper.includes("DOB") ||
        upper.includes("MRZ") ||
        upper.includes("ADDRESS")
      ) {
        continue;
      }
      collected.push(linesRaw[i]);
    }
    return collected.join(" ").trim();
  }

  // NAME (1–2 lines)
  const idxName = findLabelIndex("NAME");
  if (idxName !== -1) out.name = collectNextLines(idxName, 2);

  // PASSPORT
  const idxPass = findLabelIndex("PASSPORT");
  if (idxPass !== -1) {
    let val = collectNextLines(idxPass, 1);
    const m = val.match(/[A-Z0-9]{6,}/);
    out.passport = m ? m[0] : val;
  }

  // NATIONALITY
  const idxNat = findLabelIndex("NATIONALITY");
  if (idxNat !== -1) out.nationality = collectNextLines(idxNat, 1);

  // EMPLOYER (1–2 lines)
  const idxEmp = findLabelIndex("EMPLOYER");
  if (idxEmp !== -1) out.employer = collectNextLines(idxEmp, 2);

  // EXPIRY DATE
  const idxExp = findLabelIndex("EXPIRY");
  if (idxExp !== -1) {
    for (let i = idxExp; i < lines.length && i <= idxExp + 4; i++) {
      const m =
        linesRaw[i].match(/(\d{2}\/\d{2}\/\d{4})/) ||
        linesRaw[i].match(/(\d{2}-\d{2}-\d{4})/);
      if (m) {
        out.expiry = m[1];
        break;
      }
    }
  }

  return out;
}

/* ========== SHOW FIELDS ========== */
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

/* ========== SAVE TO GOOGLE SHEET ========== */
confirmBtn.addEventListener("click", async () => {
  if (!lastExtractedData) return;

  await fetch(APPS_SCRIPT_URL, {
    method: "POST",
    mode: "no-cors",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(lastExtractedData)
  });

  log("Saved successfully.");
});
