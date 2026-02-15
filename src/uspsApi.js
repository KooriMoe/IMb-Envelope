const axios = require("axios");
const { parseStringPromise } = require("xml2js");

const USPS_API_URL = "https://services.usps.com";
const USPS_SERVICE_API_BASE = "https://iv.usps.com/ivws_api/informedvisapi";
const USPS_ADDRESS_API_URL = "https://secure.shippingapis.com/ShippingAPI.dll";
const USPS_NEW_API_URL_BASE = "https://apis.usps.com";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isBarcodeNotFoundResponse(payload) {
  if (!payload || typeof payload !== "object") {
    return false;
  }
  const message = String(payload.message || payload.error_description || "").toLowerCase();
  if (message.includes("barcode not found") || message.includes("piece not found")) {
    return true;
  }
  const dataMessage = String(payload.data?.message || "").toLowerCase();
  return dataMessage.includes("barcode not found") || dataMessage.includes("piece not found");
}

function axiosErrorPayload(error) {
  const description = error.response
    ? `${error.message}; status=${error.response.status}`
    : error.message;
  return {
    error: "HTTPError",
    error_description: description,
    details: error.response?.data || ""
  };
}

async function generateUspsNewApiToken(config) {
  try {
    const response = await axios.post(
      `${USPS_NEW_API_URL_BASE}/oauth2/v3/token`,
      {
        client_id: config.uspsNewApiCustomerId,
        client_secret: config.uspsNewApiCustomerSecret,
        grant_type: "client_credentials"
      },
      { headers: { "Content-Type": "application/json" }, timeout: 15000 }
    );
    return response.data;
  } catch (error) {
    return axiosErrorPayload(error);
  }
}

async function newApiTokenMaintain(redis, config, logger = console) {
  const expiryRaw = await redis.get("usps_new_api_access_token_expiry");
  const tokenExpiry = expiryRaw ? Number(expiryRaw) : null;
  const now = Date.now() / 1000;

  if (!tokenExpiry || now >= tokenExpiry) {
    logger.info("Refreshing USPS new API OAuth token");
    const resp = await generateUspsNewApiToken(config);
    if (resp.error || !resp.access_token) {
      logger.error("Failed to get USPS new API token", resp);
      return;
    }
    const expiresIn = Number(resp.expires_in || 0);
    const ttl = Math.max(30, Math.floor(expiresIn / 2));
    await redis.set("usps_new_api_access_token", resp.access_token);
    await redis.set("usps_new_api_token_type", resp.token_type || "Bearer");
    await redis.set("usps_new_api_access_token_expiry", String(now + ttl));
  }
}

async function generateIvTokenUsps(config) {
  try {
    const response = await axios.post(
      `${USPS_API_URL}/oauth/authenticate`,
      {
        username: config.bsgUsername,
        password: config.bsgPassword,
        grant_type: "authorization",
        response_type: "token",
        scope: "user.info.ereg,iv1.apis",
        client_id: "687b8a36-db61-42f7-83f7-11c79bf7785e"
      },
      {
        headers: { "Content-type": "application/json" },
        timeout: 15000
      }
    );
    return response.data;
  } catch (error) {
    return axiosErrorPayload(error);
  }
}

async function refreshIvTokenUsps(refreshToken) {
  try {
    const response = await axios.post(
      `${USPS_API_URL}/oauth/token`,
      {
        refresh_token: refreshToken,
        grant_type: "authorization",
        response_type: "token",
        scope: "user.info.ereg,iv1.apis"
      },
      {
        headers: { "Content-type": "application/json" },
        timeout: 15000
      }
    );
    return response.data;
  } catch (error) {
    return axiosErrorPayload(error);
  }
}

async function ivTokenMaintain(redis, config) {
  const accessToken = await redis.get("usps_access_token");
  const nextRefreshRaw = await redis.get("usps_token_nextrefresh");
  const refreshToken = await redis.get("usps_refresh_token");
  const nextRefresh = nextRefreshRaw ? Number(nextRefreshRaw) : null;
  const now = Date.now() / 1000;

  if (!nextRefresh || now > nextRefresh || !refreshToken || !accessToken) {
    const resp = await generateIvTokenUsps(config);
    if (resp.error || !resp.access_token) {
      return;
    }
    const expiresIn = Number(resp.expires_in || 0);
    const ttl = Math.max(30, Math.floor(expiresIn / 2));
    await redis.set("usps_access_token", resp.access_token);
    await redis.set("usps_token_nextrefresh", String(now + ttl));
    await redis.set("usps_refresh_token", resp.refresh_token || "");
    await redis.set("usps_token_type", resp.token_type || "Bearer");
    return;
  }

  const resp = await refreshIvTokenUsps(refreshToken);
  if (resp.error || !resp.access_token) {
    return;
  }
  const expiresIn = Number(resp.expires_in || 0);
  const ttl = Math.max(30, Math.floor(expiresIn / 2));
  await redis.set("usps_access_token", resp.access_token);
  await redis.set("usps_token_type", resp.token_type || "Bearer");
  await redis.set("usps_token_nextrefresh", String(now + ttl));
}

async function getIvAuthorizationHeader(redis, config) {
  const nextRefreshRaw = await redis.get("usps_token_nextrefresh");
  const nextRefresh = nextRefreshRaw ? Number(nextRefreshRaw) : null;
  const now = Date.now() / 1000;

  if (!nextRefresh || now > nextRefresh) {
    await ivTokenMaintain(redis, config);
  }

  let accessToken = await redis.get("usps_access_token");
  let tokenType = await redis.get("usps_token_type");

  if (!accessToken || !tokenType) {
    await ivTokenMaintain(redis, config);
    accessToken = await redis.get("usps_access_token");
    tokenType = await redis.get("usps_token_type");
  }

  if (!accessToken || !tokenType) {
    throw new Error("Unable to obtain USPS IV API access token");
  }

  return { Authorization: `${tokenType} ${accessToken}` };
}

async function getNewApiAuthorizationHeader(redis, config) {
  const tokenExpiryRaw = await redis.get("usps_new_api_access_token_expiry");
  const tokenExpiry = tokenExpiryRaw ? Number(tokenExpiryRaw) : null;
  const now = Date.now() / 1000;
  if (!tokenExpiry || now >= tokenExpiry) {
    await newApiTokenMaintain(redis, config);
  }

  let accessToken = await redis.get("usps_new_api_access_token");
  let tokenType = await redis.get("usps_new_api_token_type");

  if (!accessToken || !tokenType) {
    await newApiTokenMaintain(redis, config);
    accessToken = await redis.get("usps_new_api_access_token");
    tokenType = await redis.get("usps_new_api_token_type");
  }

  if (!accessToken || !tokenType) {
    throw new Error("Unable to obtain USPS Address API access token");
  }

  return { Authorization: `${tokenType} ${accessToken}` };
}

async function getPieceTracking(redis, config, barcode) {
  const maxAttempts = 5;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const headers = await getIvAuthorizationHeader(redis, config);
      const response = await axios.get(
        `${USPS_SERVICE_API_BASE}/api/mt/get/piece/imb/${barcode}`,
        {
          headers,
          timeout: 15000
        }
      );
      const payload = response.data;
      if (isBarcodeNotFoundResponse(payload) && attempt < maxAttempts) {
        await sleep(500 * attempt);
        continue;
      }
      return payload;
    } catch (error) {
      const status = error.response?.status;
      if (status === 401 && attempt < maxAttempts) {
        await ivTokenMaintain(redis, config);
        await sleep(300 * attempt);
        continue;
      }
      if (status >= 500 && attempt < maxAttempts) {
        await sleep(500 * attempt);
        continue;
      }
      return axiosErrorPayload(error);
    }
  }
  return { error: "HTTPError", error_description: "USPS tracking request failed after retries" };
}

function decodeXmlText(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

async function getUSPSStandardizedAddress(config, address) {
  let req = "";
  if (address.firmname) {
    req += `<FirmName>${address.firmname}</FirmName>`;
  }
  req += `
    <Address1>${address.address2 || ""}</Address1>
    <Address2>${address.street_address || ""}</Address2>
    <City>${address.city || ""}</City>
    <State>${address.state || ""}</State>
    <Zip5>${address.zip5 || ""}</Zip5>
  `;
  req += address.zip4 ? `<Zip4>${address.zip4}</Zip4>` : "<Zip4/>";

  const requestXml = `
    <AddressValidateRequest USERID="${config.uspsWebApiUsername}">
      <Revision>1</Revision>
      <Address ID="0">${req}</Address>
    </AddressValidateRequest>
  `;

  try {
    const response = await axios.get(USPS_ADDRESS_API_URL, {
      params: { API: "Verify", XML: requestXml },
      timeout: 15000
    });
    const parsed = await parseStringPromise(response.data, {
      explicitArray: false,
      trim: true
    });

    if (parsed.Error) {
      return { error: decodeXmlText(parsed.Error.Description) };
    }

    const addr = parsed?.AddressValidateResponse?.Address;
    if (!addr) {
      return { error: "Missing USPS address response" };
    }
    if (addr.Error) {
      return { error: decodeXmlText(addr.Error.Description) };
    }

    return {
      firmname: addr.FirmName || "",
      address2: addr.Address1 || "",
      street_address: addr.Address2 || "",
      city: addr.City || "",
      state: addr.State || "",
      zip5: addr.Zip5 || "",
      zip4: addr.Zip4 || "",
      dp: addr.DeliveryPoint || ""
    };
  } catch (error) {
    return axiosErrorPayload(error);
  }
}

async function getUSPSStandardizedAddressNew(redis, config, address) {
  const params = {
    firm: address.firmname || "",
    streetAddress: address.street_address || "",
    secondaryAddress: address.address2 || "",
    city: address.city || "",
    state: address.state || "",
    ZIPCode: address.zip5 || "",
    ZIPPlus4: address.zip4 || ""
  };

  for (const key of Object.keys(params)) {
    if (!params[key]) {
      delete params[key];
    }
  }

  try {
    let headers = await getNewApiAuthorizationHeader(redis, config);
    headers = { ...headers, accept: "application/json" };

    let response;
    try {
      response = await axios.get(`${USPS_NEW_API_URL_BASE}/addresses/v3/address`, {
        headers,
        params,
        timeout: 15000
      });
    } catch (error) {
      if (error.response?.status === 401) {
        // Force token refresh on unauthorized responses even if cached token is not expired yet.
        await redis.set("usps_new_api_access_token_expiry", "0");
        await newApiTokenMaintain(redis, config);
        const refreshed = await getNewApiAuthorizationHeader(redis, config);
        response = await axios.get(`${USPS_NEW_API_URL_BASE}/addresses/v3/address`, {
          headers: { ...refreshed, accept: "application/json" },
          params,
          timeout: 15000
        });
      } else {
        throw error;
      }
    }

    const data = response.data;
    if (data.errors) {
      return { error: data.errors };
    }

    return {
      firmname: data.firm || "",
      street_address: data.address?.streetAddress || "",
      address2: data.address?.secondaryAddress || "",
      city: data.address?.city || "",
      state: data.address?.state || "",
      zip5: data.address?.ZIPCode || "",
      zip4: data.address?.ZIPPlus4 || "",
      dp: data.additionalInfo?.deliveryPoint || ""
    };
  } catch (error) {
    return axiosErrorPayload(error);
  }
}

module.exports = {
  newApiTokenMaintain,
  ivTokenMaintain,
  getPieceTracking,
  getUSPSStandardizedAddress,
  getUSPSStandardizedAddressNew
};
