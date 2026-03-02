# M-Pesa Backend (Daraja)

## 1) Install dependencies

```bash
cd backend
npm install
```

## 2) Configure environment

Copy `.env.example` to `.env` and fill in your real Daraja credentials.

Required:
- `MPESA_CONSUMER_KEY`
- `MPESA_CONSUMER_SECRET`
- `MPESA_SHORTCODE`
- `MPESA_PASSKEY`
- `MPESA_CALLBACK_URL`

## 3) Start server

```bash
npm run dev
```

Server base URL: `http://localhost:5000`

## 4) API endpoints

- `GET /api/health`
- `POST /api/mpesa/stkpush`
- `POST /api/mpesa/callback`
- `GET /api/mpesa/status/:checkoutRequestId`

## STK Push request body

```json
{
  "phone": "0712345678",
  "amount": 35,
  "accountReference": "UNLIMITED_24HRS",
  "transactionDesc": "WiFi package payment",
  "planId": "plan_24h_unlimited"
}
```

## Notes

- Phone is normalized to `2547XXXXXXXX`.
- Callback status is stored in memory (Map). For production, use a database.
- `MPESA_CALLBACK_URL` must be publicly reachable by Safaricom.
