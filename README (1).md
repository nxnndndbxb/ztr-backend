# ZIC Oil — WhatsApp Auto-Sender Service (FREE)

FREE WhatsApp integration for the ZIC Oil Dealership System. Uses
**whatsapp-web.js** with QR-code login — **NO Meta Cloud API, NO paid
service, NO third-party gateway**.

> ⚠️ **ANTI-BAN WARNING**
> Sending too many messages too fast can cause WhatsApp to temporarily or
> permanently ban your number. This service queues messages with a fixed
> delay (`MESSAGE_DELAY_MS`, minimum **5000 ms**). **Do NOT lower the
> delay.** Use a dedicated business number and keep volumes reasonable.

---

## 1. Requirements

- Node.js **v18 or newer** (`node -v`)
- A dedicated WhatsApp number (business account recommended)
- The main app `index.html` opened in a browser

## 2. Install & Run

```bash
npm install
node server.js
```

`npm install` also downloads a Chromium build for Puppeteer (bundled with
whatsapp-web.js). On minimal Linux servers you may need system libraries:

```bash
sudo apt-get install -y libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2   libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxrandr2 libgbm1   libasound2 libpango-1.0-0 libpangocairo-1.0-0
```

## 3. Connect WhatsApp (QR scan)

1. Open the app → sidebar → **💬 WhatsApp Auto-Sender**
2. The page shows a **QR code** (also visible in the `node server.js` terminal output)
3. On the phone with your business number:
   **WhatsApp → Settings → Linked Devices → Link a Device** → scan
4. The status badge turns **🟢 Connected**

The session persists in `.wwebjs_auth/` — next runs skip the QR scan.

## 4. How it works

- New sale saved → the app renders a **high-resolution invoice IMAGE (PNG)**
  with html2canvas → base64 → `POST /send-invoice` → the service delivers
  the image (+ short caption) to the customer's WhatsApp number taken from
  the invoice's customer record.
- If the service is offline or the number is invalid, the sale still saves —
  you only get a toast notification.
- The WhatsApp admin page polls `GET /status` every **4 seconds** and shows
  the live QR / connection state.
- Outgoing messages are processed **sequentially** with a fixed
  `MESSAGE_DELAY_MS` delay between them (anti-ban queue).

## 5. HTTP API

| Method | Endpoint      | Description |
|--------|---------------|-------------|
| GET    | `/status`     | `{ connected, qrImage, me, state, queueLength }` |
| POST   | `/send-invoice` | Body: `{ number, imageBase64, caption, invoiceNumber, fileName }` |
| POST   | `/logout`     | Disconnect; a fresh QR is generated |

## 6. Configuration

- **Service URL**: default `http://localhost:3001` — editable and saved in
  the browser (localStorage) from the WhatsApp admin page.
- **Port**: `PORT` env var (default 3001).
- **Message delay**: `MESSAGE_DELAY_MS` env var (default 5000, minimum 5000).

## 7. Manual invoice sharing (no server needed)

In **Invoices → View**, the 💬 and 📤 buttons generate the invoice IMAGE and
use the native share sheet (`navigator.share({ files })`) on mobile browsers.
On desktop, the image is downloaded and WhatsApp Web chat opens as fallback.
The **PDF download/print** buttons remain available as extra options.

## 8. Troubleshooting

- **🔴 Offline badge** → is `node server.js` running? Is the Service URL correct?
- **QR keeps refreshing** → scan within ~20 seconds of it appearing.
- **Messages not arriving** → check the customer number format (03XX… is
  auto-converted to 92XXXXXXXXXX), and confirm the recipient has WhatsApp.
