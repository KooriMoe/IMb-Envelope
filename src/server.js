const http = require("http");
const { spawn } = require("child_process");
const os = require("os");
const path = require("path");
const fs = require("fs/promises");
const express = require("express");
const session = require("express-session");
const nunjucks = require("nunjucks");
const Redis = require("ioredis");
const imb = require("imb");

const config = require("./config");
const uspsApi = require("./uspsApi");
const { MemoryStore } = require("./store");

const ROLLING_WINDOW = 50;

const app = express();
const server = http.createServer(app);
let tokenMaintenanceInterval = null;
let isShuttingDown = false;

const store = config.debugOnly ? new MemoryStore() : new Redis(config.redisUrl);
if (!config.debugOnly) {
  store.on("error", (error) => {
    console.error("Redis connection error:", error.message);
  });
}

const nunjucksEnv = nunjucks.configure(config.templatesPath, {
  autoescape: true,
  express: app,
  noCache: process.env.NODE_ENV !== "production"
});

app.set("view engine", "html");
app.set("views", config.templatesPath);
app.use("/static", express.static(config.staticPath, { maxAge: "1h" }));
app.use(express.urlencoded({ extended: false }));
app.use(express.json({ limit: "2mb" }));
app.use(
  session({
    name: "imb.sid",
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: false,
      maxAge: 60 * 60 * 1000
    }
  })
);

function generateHumanReadable(receiptZip, serial) {
  const barcodeId = String(config.barcodeId).padStart(2, "0");
  const srvType = String(config.srvType).padStart(3, "0");
  const serialStr = String(serial).padStart(6, "0");
  return `${barcodeId}-${srvType}-${config.mailerId}-${serialStr}-${receiptZip}`;
}

function makeTrackingBarcode(receiptZip, serial) {
  return `${String(config.barcodeId).padStart(2, "0")}${String(config.srvType).padStart(3, "0")}${config.mailerId}${String(
    serial
  ).padStart(6, "0")}${receiptZip}`;
}

function splitZip(zipDigits) {
  return {
    zip: zipDigits.slice(0, 5),
    plus4: zipDigits.length >= 9 ? zipDigits.slice(5, 9) : "",
    delivery_pt: zipDigits.length >= 11 ? zipDigits.slice(9, 11) : ""
  };
}

function toImbBars(recipientZip, serial) {
  const zipFields = splitZip(recipientZip);
  const serialWidth = String(config.mailerId).startsWith("9") ? 6 : 9;
  return imb.encode({
    ...zipFields,
    barcode_id: String(config.barcodeId).padStart(2, "0"),
    service_type: String(config.srvType).padStart(3, "0"),
    mailer_id: String(config.mailerId),
    serial_num: String(serial).padStart(serialWidth, "0")
  });
}

async function generateSerial() {
  if (config.debugOnly) {
    return config.debugSerial;
  }

  const now = new Date();
  const epoch = new Date("1970-01-01T00:00:00Z");
  const numDays = Math.floor((now - epoch) / (24 * 60 * 60 * 1000));
  const base = numDays % ROLLING_WINDOW;
  const dayKey = `serial_${base}`;
  const perDayCounter = await store.incr(dayKey);

  if (perDayCounter >= 9999) {
    throw new Error("Per-day serial limit reached");
  }

  await store.expire(dayKey, 48 * 60 * 60);
  return base * 10000 + Number(perDayCounter);
}

function renderTemplate(templateName, data) {
  return new Promise((resolve, reject) => {
    nunjucksEnv.render(templateName, data, (err, output) => {
      if (err) {
        reject(err);
      } else {
        resolve(output);
      }
    });
  });
}

function renderPdf(html, options) {
  return new Promise((resolve, reject) => {
    const outputFile = path.join(
      os.tmpdir(),
      `imb-envelope-${Date.now()}-${process.pid}-${Math.random().toString(16).slice(2)}.pdf`
    );
    const args = [];
    for (const [key, value] of Object.entries(options)) {
      const flag = `--${key}`;
      args.push(flag);
      if (value !== true) {
        args.push(String(value));
      }
    }
    args.push("-", outputFile);

    const child = spawn(config.wkhtmltopdfPath, args, { stdio: ["pipe", "pipe", "pipe"] });
    const stderr = [];

    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => {
      if (error.code === "ENOENT") {
        reject(new Error(`wkhtmltopdf binary not found. Set WKHTMLTOPDF_PATH or install wkhtmltopdf.`));
        return;
      }
      reject(error);
    });
    child.on("close", async (code) => {
      try {
        if (code !== 0) {
          reject(new Error(`wkhtmltopdf failed with exit code ${code}: ${Buffer.concat(stderr).toString("utf8")}`));
          return;
        }
        const pdf = await fs.readFile(outputFile);
        if (pdf.length === 0) {
          reject(new Error("wkhtmltopdf returned an empty PDF output."));
          return;
        }
        resolve(pdf);
      } catch (error) {
        reject(error);
      } finally {
        fs.unlink(outputFile).catch(() => {});
      }
    });

    child.stdin.end(html);
  });
}

async function attachStoredScans(trackingData) {
  try {
    if (!trackingData?.data?.imb) {
      return trackingData;
    }
    const imbKey = `imb:${trackingData.data.imb}`;
    const stored = await store.lrange(imbKey, 0, -1);
    if (!Array.isArray(trackingData.data.scans)) {
      trackingData.data.scans = [];
    }
    for (const rawScan of stored) {
      trackingData.data.scans.unshift(JSON.parse(rawScan));
    }
  } catch (_err) {
    // Keep behavior resilient even if stored scan merge fails.
  }
  return trackingData;
}

async function fetchTrackingByBarcode(barcode) {
  const trackingData = await uspsApi.getPieceTracking(store, config, barcode);
  return attachStoredScans(trackingData);
}

app.get("/", (_req, res) => {
  res.render("index.html");
});

app.post("/generate", async (req, res) => {
  try {
    const senderAddress = req.body.sender_address || "";
    const recipientName = req.body.recipient_name || "";
    const recipientCompany = req.body.recipient_company || "";
    const recipientStreet = req.body.recipient_street || "";
    const recipientAddress2 = req.body.recipient_address2 || "";
    const recipientCity = req.body.recipient_city || "";
    const recipientState = req.body.recipient_state || "";
    const zipRaw = req.body.recipient_zip || "";
    const zipDigits = String(zipRaw).replace(/\D/g, "");

    if (!zipDigits) {
      return res.status(400).send("Recipient zip is not number!");
    }
    if (zipDigits.length < 5) {
      return res.status(400).send("Invalid recipient zip");
    }
    if (![5, 9, 11].includes(zipDigits.length)) {
      return res.status(400).send("Invalid recipient zip length");
    }

    const zip5 = zipDigits.slice(0, 5);
    const zipFull = zipDigits.length >= 9 ? `${zip5}-${zipDigits.slice(5, 9)}` : zip5;
    const recipientAddress = [
      recipientName,
      recipientCompany,
      recipientStreet,
      recipientAddress2,
      `${recipientCity}, ${recipientState} ${zipFull}`
    ]
      .filter(Boolean)
      .join("\n");

    const serial = await generateSerial();
    req.session.sender_address = senderAddress;
    req.session.recipient_address = recipientAddress;
    req.session.serial = serial;
    req.session.recipient_zip = zipDigits;

    return res.render("generate.html", {
      serial,
      recipient_zip: zipDigits
    });
  } catch (error) {
    return res.status(500).send(error.message || "Failed to generate envelope");
  }
});

app.get("/download/:format_type/:doc_type", async (req, res) => {
  try {
    const senderAddress = req.session.sender_address;
    const recipientAddress = req.session.recipient_address;
    const serial = req.session.serial;
    const recipientZip = req.session.recipient_zip;

    if (!senderAddress || !recipientAddress || serial === undefined || !recipientZip) {
      return res.status(400).send("Missing session data. Generate a barcode first.");
    }

    const { format_type: formatType, doc_type: docType } = req.params;
    const row = Number.parseInt(String(req.query.row || "1"), 10) || 1;
    const col = Number.parseInt(String(req.query.col || "1"), 10) || 1;

    const templateName =
      formatType === "envelope" ? "envelopepdf.html" : formatType === "avery" ? "avery8163.html" : null;

    if (!templateName) {
      return res.status(400).send("Format type not valid");
    }

    const humanReadableBar = generateHumanReadable(recipientZip, serial);
    const barcode = toImbBars(recipientZip, serial);

    const html = await renderTemplate(templateName, {
      sender_address: senderAddress,
      sender_lines: String(senderAddress).split("\n"),
      recipient_address: recipientAddress,
      recipient_lines: String(recipientAddress).split("\n"),
      human_readable_bar: humanReadableBar,
      barcode,
      row,
      col
    });

    if (docType === "html") {
      return res.send(html);
    }

    if (docType === "pdf") {
      const options =
        formatType === "envelope"
          ? {
              "page-height": "4.125in",
              "page-width": "9.5in",
              "margin-bottom": "0in",
              "margin-top": "0in",
              "margin-left": "0in",
              "margin-right": "0in",
              "disable-smart-shrinking": true
            }
          : {
              "page-height": "11in",
              "page-width": "8.5in",
              "margin-bottom": "0in",
              "margin-top": "0in",
              "margin-left": "0in",
              "margin-right": "0in",
              "disable-smart-shrinking": true
            };

      const pdf = await renderPdf(html, options);
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename=${formatType}_${String(serial).padStart(6, "0")}_${recipientZip}.pdf`
      );
      return res.send(pdf);
    }

    return res.status(400).send("Document type not valid");
  } catch (error) {
    return res.status(500).send(error.message || "Failed to render document");
  }
});

app.get("/tracking", (_req, res) => {
  res.render("tracking.html");
});

app.get("/trackingIMb", (_req, res) => {
  res.render("trackingIMb.html");
});

app.get("/track-data", async (req, res) => {
  try {
    res.setHeader("Cache-Control", "no-store");
    const receiptZip = String(req.query.receipt_zip || "").replace(/\D/g, "");
    const serial = Number.parseInt(String(req.query.serial || ""), 10);
    if (![5, 9, 11].includes(receiptZip.length) || !Number.isFinite(serial)) {
      return res.status(400).json({ error: "Invalid request", error_description: "receipt_zip and serial are required" });
    }

    const barcode = makeTrackingBarcode(receiptZip, serial);
    const trackingData = await fetchTrackingByBarcode(barcode);
    return res.json(trackingData);
  } catch (error) {
    return res.status(500).json({ error: "Exception", error_description: error.message });
  }
});

app.get("/trackimb-data", async (req, res) => {
  try {
    res.setHeader("Cache-Control", "no-store");
    const barcode = String(req.query.IMbNum || "").replace(/\D/g, "");
    if (!/^\d{31}$/.test(barcode)) {
      return res.status(400).json({ error: "Invalid request", error_description: "IMbNum must be a 31-digit numeric barcode" });
    }

    const trackingData = await fetchTrackingByBarcode(barcode);
    return res.json(trackingData);
  } catch (error) {
    return res.status(500).json({ error: "Exception", error_description: error.message });
  }
});

app.post("/validate_address", async (req, res) => {
  try {
    const zipFull = String(req.body.zip || "").replace(/-/g, "");
    const zipDigits = zipFull.replace(/\D/g, "");
    const zip5 = zipDigits.slice(0, 5);

    const address = {
      street_address: req.body.street_address || req.body.address2 || "",
      address2: req.body.address2 || req.body.address1 || "",
      city: req.body.city || "",
      state: req.body.state || "",
      zip5
    };

    if (zipDigits.length >= 9) {
      address.zip4 = zipDigits.slice(5, 9);
    }
    if (zipDigits.length >= 11) {
      address.dp = zipDigits.slice(9, 11);
    }
    if (String(req.body.firmname || "").length > 0) {
      address.firmname = req.body.firmname;
    }

    let standardizedAddress = await uspsApi.getUSPSStandardizedAddressNew(store, config, address);
    if (standardizedAddress.error && config.uspsWebApiUsername) {
      standardizedAddress = await uspsApi.getUSPSStandardizedAddress(config, address);
    }
    standardizedAddress.zip4 = standardizedAddress.zip4 || "";
    standardizedAddress.address1 = standardizedAddress.address2 || "";
    standardizedAddress.address2 = standardizedAddress.street_address || "";
    return res.json(standardizedAddress);
  } catch (error) {
    return res.status(500).json({ error: "Exception", error_description: error.message });
  }
});

app.post("/usps_feed", async (req, res) => {
  const data = req.body;
  if (!data || !Array.isArray(data.events)) {
    return res.status(400).send("Invalid data format.");
  }

  for (const event of data.events) {
    if (!event.imb) {
      continue;
    }
    if (event.handlingEventType !== "L") {
      continue;
    }

    const redisKey = `imb:${event.imb}`;
    await store.rpush(
      redisKey,
      JSON.stringify({
        scan_date_time: event.scanDatetime || null,
        scan_event_code: event.scanEventCode || null,
        handling_event_type: event.handlingEventType || null,
        mail_phase: event.mailPhase || null,
        machine_name: event.machineName || null,
        scanner_type: event.scannerType || null,
        scan_facility_name: event.scanFacilityName || null,
        scan_facility_locale_key: event.scanLocaleKey || null,
        scan_facility_city: event.scanFacilityCity || null,
        scan_facility_state: event.scanFacilityState || null,
        scan_facility_zip: event.scanFacilityZip || null
      })
    );
    await store.expire(redisKey, 60 * 24 * 60 * 60);
  }

  return res.send("Data stored in Redis.");
});

function startTokenMaintenance() {
  const tick = async () => {
    try {
      await uspsApi.ivTokenMaintain(store, config);
      await uspsApi.newApiTokenMaintain(store, config, console);
    } catch (error) {
      console.error("Token maintenance failed", error);
    }
  };

  tick();
  tokenMaintenanceInterval = setInterval(tick, 5 * 60 * 1000);
}

server.listen(config.port, "0.0.0.0", () => {
  startTokenMaintenance();
  console.log(`IMb Envelope server running on http://0.0.0.0:${config.port}`);
  if (config.debugOnly) {
    console.log(`DEBUG_ONLY enabled. Fixed serial: ${config.debugSerial}`);
  }
});

async function shutdown() {
  if (isShuttingDown) {
    return;
  }
  isShuttingDown = true;
  if (tokenMaintenanceInterval) {
    clearInterval(tokenMaintenanceInterval);
  }
  try {
    await new Promise((resolve) => server.close(resolve));
  } catch (_error) {
    // Ignore close errors during shutdown path.
  }
  try {
    await store.quit();
  } catch (_error) {
    // Ignore store shutdown errors during process exit.
  }
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
