# IMb Envelope (Node.js)

Node.js web application for generating USPS Intelligent Mail Barcode (IMb) envelopes/labels and tracking First-Class mail.

## Features
- Generate ready-to-print #10 envelope (HTML/PDF) with IMb barcode.
- Generate Avery 8163 label output (HTML/PDF).
- Track mail by `receipt_zip + serial` or full IMb number.
- Validate recipient addresses using USPS Address APIs.
- Store USPS feed scan events in Redis and merge them into tracking output.

## Configuration
1. Copy `.env.example` to `.env`.
2. Set your USPS and app credentials:
- `MAILER_ID`
- `BSG_USERNAME`
- `BSG_PASSWD`
- `USPS_NEWAPI_CUSTOMER_ID`
- `USPS_NEWAPI_CUSTOMER_SECRET`
- `USPS_WEBAPI_USERNAME` (optional fallback API)
- `SESSION_SECRET`
- `DEBUG_ONLY` (`true` to run without Redis using in-memory storage)
- `DEBUG_SERIAL` (fixed serial value used when `DEBUG_ONLY=true`)
- `WKHTMLTOPDF_PATH` (optional path to `wkhtmltopdf` binary; default: `wkhtmltopdf`)

## Local run
```bash
npm install
npm start
```

App runs at [http://localhost:8080](http://localhost:8080).

## Docker run
```bash
docker compose up -d --build
```

App is exposed at [http://localhost:8084](http://localhost:8084).

## Debug mode (no Redis dependency)
Set `DEBUG_ONLY=true` to run with in-memory storage and a fixed serial number (`DEBUG_SERIAL`).
This is useful for testing without Redis while still calling USPS APIs normally.
