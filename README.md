# IMb Envelope

A Python-based web application for generating envelopes/labels with Intelligent Mail Barcodes (IMb) and tracking First-Class Mail.  

Forked from [1977cui/envelope](https://github.com/1997cui/envelope).

## Features
- Generate a ready-to-print #10 envelope PDF with an IMb barcode.
- "Return Service Requested" is enabled by default.
- Track all First-Class Mail using the IMb number.

## Installation

### 1. Register a USPS Business Customer Gateway (BCG) Account
To use this tool, you need a USPS BCG account.

1. Visit the [USPS Business Customer Gateway](https://gateway.usps.com/) and register an account.
2. Create a **Mailer ID** in your account.

### 2. Configure the Application
1. Rename or move `app/config.py.example` to `app/config.py`.
2. Edit the following credentials in `config.py`:
   - `MAILER_ID`
   - `BSG_USERNAME`
   - `BSG_PASSWD`
   - `USPS_WEBAPI_USERNAME`
3. If needed, modify the `SRV_TYPE` according to the [Service Type Identifier Table](https://postalpro.usps.com/service-type-identifiers/stidtable).

### 3. Set Up with Docker
1. Edit the `Dockerfile` and `docker-compose.yml` if necessary.
2. Run the following command to start the application:
  ```docker-compose up -d```

### 4. Access the Web Interface
Once the service is running, open your browser and go to:
``` http://localhost:8084/```.