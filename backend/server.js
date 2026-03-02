const express = require("express");
const cors = require("cors");
const axios = require("axios");
require("dotenv").config();

const app = express();

const PORT = process.env.PORT || 5000;
const MPESA_ENV = (process.env.MPESA_ENV || "sandbox").toLowerCase();

const REQUIRED_ENV_VARS = [
  "MPESA_CONSUMER_KEY",
  "MPESA_CONSUMER_SECRET",
  "MPESA_SHORTCODE",
  "MPESA_PASSKEY",
  "MPESA_CALLBACK_URL",
];

const baseUrl =
  MPESA_ENV === "production"
    ? "https://api.safaricom.co.ke"
    : "https://sandbox.safaricom.co.ke";

const paymentStore = new Map();

function normalizeKenyanPhone(rawPhone) {
  const value = String(rawPhone || "").replace(/\D/g, "");

  if (!value) return null;

  if (value.startsWith("254") && value.length === 12) {
    return value;
  }

  if (value.startsWith("07") && value.length === 10) {
    return `254${value.slice(1)}`;
  }

  if (value.startsWith("7") && value.length === 9) {
    return `254${value}`;
  }

  return null;
}

function getTimestamp() {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const hh = String(now.getHours()).padStart(2, "0");
  const min = String(now.getMinutes()).padStart(2, "0");
  const ss = String(now.getSeconds()).padStart(2, "0");

  return `${yyyy}${mm}${dd}${hh}${min}${ss}`;
}

function getMpesaPassword(shortcode, passkey, timestamp) {
  return Buffer.from(`${shortcode}${passkey}${timestamp}`).toString("base64");
}

async function getAccessToken() {
  const key = process.env.MPESA_CONSUMER_KEY;
  const secret = process.env.MPESA_CONSUMER_SECRET;
  const auth = Buffer.from(`${key}:${secret}`).toString("base64");

  const response = await axios.get(
    `${baseUrl}/oauth/v1/generate?grant_type=client_credentials`,
    {
      headers: {
        Authorization: `Basic ${auth}`,
      },
      timeout: 15000,
    }
  );

  return response.data.access_token;
}

function extractCallbackMetadata(callbackItemList = []) {
  const result = {};

  for (const item of callbackItemList) {
    if (item && item.Name) {
      result[item.Name] = item.Value;
    }
  }

  return result;
}

const corsOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(",").map((origin) => origin.trim())
  : ["*"];

app.use(
  cors({
    origin(origin, callback) {
      if (!origin || corsOrigins.includes("*") || corsOrigins.includes(origin)) {
        return callback(null, true);
      }

      return callback(new Error("CORS blocked for this origin"));
    },
  })
);
app.use(express.json());

app.get("/api/health", (_req, res) => {
  const missing = REQUIRED_ENV_VARS.filter((name) => !process.env[name]);

  res.json({
    ok: missing.length === 0,
    environment: MPESA_ENV,
    missingConfig: missing,
  });
});

app.post("/api/mpesa/stkpush", async (req, res) => {
  try {
    const { phone, amount, accountReference, transactionDesc, planId } = req.body || {};

    const normalizedPhone = normalizeKenyanPhone(phone);
    const parsedAmount = Number(amount);

    if (!normalizedPhone) {
      return res.status(400).json({
        ok: false,
        message: "Invalid phone number. Use Kenyan format e.g. 07XXXXXXXX or 2547XXXXXXXX.",
      });
    }

    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
      return res.status(400).json({
        ok: false,
        message: "Amount must be a number greater than 0.",
      });
    }

    const missing = REQUIRED_ENV_VARS.filter((name) => !process.env[name]);
    if (missing.length > 0) {
      return res.status(500).json({
        ok: false,
        message: "Missing required M-Pesa configuration.",
        missingConfig: missing,
      });
    }

    const token = await getAccessToken();
    const timestamp = getTimestamp();
    const shortcode = process.env.MPESA_SHORTCODE;
    const password = getMpesaPassword(shortcode, process.env.MPESA_PASSKEY, timestamp);

    const payload = {
      BusinessShortCode: shortcode,
      Password: password,
      Timestamp: timestamp,
      TransactionType: process.env.MPESA_TRANSACTION_TYPE || "CustomerPayBillOnline",
      Amount: Math.round(parsedAmount),
      PartyA: normalizedPhone,
      PartyB: process.env.MPESA_PARTYB || shortcode,
      PhoneNumber: normalizedPhone,
      CallBackURL: process.env.MPESA_CALLBACK_URL,
      AccountReference: accountReference || planId || "OLOIKA_WIFI",
      TransactionDesc: transactionDesc || "WiFi package payment",
    };

    const stkResponse = await axios.post(
      `${baseUrl}/mpesa/stkpush/v1/processrequest`,
      payload,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        timeout: 20000,
      }
    );

    const data = stkResponse.data || {};
    const checkoutRequestId = data.CheckoutRequestID;

    if (checkoutRequestId) {
      paymentStore.set(checkoutRequestId, {
        status: "PENDING",
        initiatedAt: new Date().toISOString(),
        phone: normalizedPhone,
        amount: Math.round(parsedAmount),
        planId: planId || null,
        mpesaResponse: data,
      });
    }

    return res.status(200).json({
      ok: true,
      message: "STK push sent successfully.",
      data,
    });
  } catch (error) {
    const details =
      error.response?.data ||
      error.message ||
      "Failed to initiate STK push.";

    return res.status(500).json({
      ok: false,
      message: "STK push request failed.",
      error: details,
    });
  }
});

app.post("/api/mpesa/callback", (req, res) => {
  try {
    const callback = req.body?.Body?.stkCallback;

    if (!callback) {
      return res.status(400).json({ ResultCode: 1, ResultDesc: "Invalid callback payload" });
    }

    const checkoutRequestId = callback.CheckoutRequestID;
    const metadata = extractCallbackMetadata(callback.CallbackMetadata?.Item || []);

    const existing = checkoutRequestId ? paymentStore.get(checkoutRequestId) : null;
    const resultCode = callback.ResultCode;
    const isSuccess = resultCode === 0;

    if (checkoutRequestId) {
      paymentStore.set(checkoutRequestId, {
        ...(existing || {}),
        status: isSuccess ? "SUCCESS" : "FAILED",
        callbackAt: new Date().toISOString(),
        resultCode,
        resultDesc: callback.ResultDesc,
        merchantRequestId: callback.MerchantRequestID,
        mpesaReceiptNumber: metadata.MpesaReceiptNumber || null,
        transactionDate: metadata.TransactionDate || null,
        amount: metadata.Amount || existing?.amount || null,
        phone: metadata.PhoneNumber || existing?.phone || null,
        rawCallback: req.body,
      });
    }

    return res.status(200).json({ ResultCode: 0, ResultDesc: "Accepted" });
  } catch (error) {
    return res.status(500).json({ ResultCode: 1, ResultDesc: "Callback processing error" });
  }
});

app.get("/api/mpesa/status/:checkoutRequestId", (req, res) => {
  const { checkoutRequestId } = req.params;
  const payment = paymentStore.get(checkoutRequestId);

  if (!payment) {
    return res.status(404).json({
      ok: false,
      message: "Transaction not found. It may still be pending callback.",
    });
  }

  return res.json({
    ok: true,
    checkoutRequestId,
    payment,
  });
});

app.use((err, _req, res, _next) => {
  if (err.message && err.message.startsWith("CORS blocked")) {
    return res.status(403).json({ ok: false, message: err.message });
  }

  return res.status(500).json({ ok: false, message: "Unexpected server error." });
});

app.listen(PORT, () => {
  console.log(`M-Pesa backend running on port ${PORT}`);
});
