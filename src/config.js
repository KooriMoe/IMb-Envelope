const path = require("path");
const dotenv = require("dotenv");

dotenv.config();

function required(name, fallback = "") {
  return process.env[name] ?? fallback;
}

module.exports = {
  port: Number(process.env.PORT || 8080),
  debugOnly: String(process.env.DEBUG_ONLY || "false").toLowerCase() === "true",
  debugSerial: Number(process.env.DEBUG_SERIAL || 424242),
  wkhtmltopdfPath: process.env.WKHTMLTOPDF_PATH || "wkhtmltopdf",
  mailerId: String(required("MAILER_ID", "123456789")),
  srvType: Number(process.env.SRV_TYPE || 340),
  barcodeId: Number(process.env.BARCODE_ID || 0),
  bsgUsername: required("BSG_USERNAME", ""),
  bsgPassword: required("BSG_PASSWD", ""),
  sessionSecret: required("SESSION_SECRET", "change-me"),
  uspsWebApiUsername: process.env.USPS_WEBAPI_USERNAME || "",
  uspsNewApiCustomerId: required("USPS_NEWAPI_CUSTOMER_ID", ""),
  uspsNewApiCustomerSecret: required("USPS_NEWAPI_CUSTOMER_SECRET", ""),
  redisUrl: process.env.REDIS_URL || `redis://${process.env.REDIS_HOST || "127.0.0.1"}:6379/0`,
  templatesPath: path.join(process.cwd(), "app", "templates"),
  staticPath: path.join(process.cwd(), "app", "static")
};
