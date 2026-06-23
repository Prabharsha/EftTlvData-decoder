# breakEftTlvData

A tiny, **client-side** single-page app that decodes a CEFT **Tag 120 / Field 120
TLV string** — and only that. Paste the raw string and it shows you:

- **Decoded fields** — every tag, its length and value
- **Field name / tag** — the `EftTlvTag` name and `FinancialMessage` property
- **Business meaning** — what each value represents
- **Applicable business flow** — QR (Type 2 / merchant credit / peer-to-peer),
  CEFT transfer, JustPay, LPOPP, remittance, etc., inferred from the values
- **Usage per parameter** — how each field is used inside the detected flow

> Nothing leaves the browser. There is **no** API-body handling, no transaction
> processing and no external calls — just TLV decoding and mapping.

## TLV wire format

Field 120 is a flat concatenation of sub-fields, each:

```
[ TAG (3 digits) ][ LENGTH (3 digits) ][ VALUE (LENGTH chars) ]
```

repeated until the string is consumed. Example:

```
002 012 100641123718   004 016 LKR1516300010104   ...
└┬┘ └┬┘ └────┬─────┘
 │   │       └ value (12 chars) → destination account
 │   └ length = 012
 └ tag 002 = DESTINATION_ACCOUNT_NO
```

## How the business flow is identified

Tag 120 does **not** carry the ISO merchant type (field 18), so the flow is
inferred from values inside the TLV:

1. **Tag 013 — transaction code** is the primary signal
   (`70` = merchant credit, `45` = customer debit, `42`/`43` = JustPay,
   `52` = CEFT transfer, `62` = LPOPP, …).
2. **Heuristics** refine it — a `QR-GL` originating name, an `UNKNOWN`
   beneficiary, or `QR` / `JustPay` / peer-to-peer markers in the particulars.

Each result shows a **confidence** level and the exact reasons used, so the
inference stays transparent.

## Source of truth

Mapping and flow logic mirror the CEFT core:

| File | What it provides |
| --- | --- |
| `EftTlvTag.java` | tag id ↔ field name |
| `EfvTlvBuilder.java` | tag ↔ `FinancialMessage` property |
| `MessageConversionHelper.breakEftTlvData()` | the parse algorithm |
| `TransactionCode.java` / `MerchantType.java` | transaction-code & flow catalogue |
| `AcquirerTransactionServiceHelper.java` | which code each flow sets |

## Run locally

Static site — no build step, no dependencies:

```bash
npx serve .        # or: python -m http.server 8000
```

…or just open `index.html`.

## Deploy to Vercel (zero-config static)

```bash
npm i -g vercel
vercel          # accept defaults — framework preset "Other", no build command
vercel --prod   # promote to production
```

Or import the repo in the Vercel dashboard → framework **Other**, build command
empty, output directory = root.

## Push to a new git repo

This folder is a standalone repo (separate from `ceft-suit-main`):

```bash
git remote add origin https://github.com/<you>/breakEftTlvData.git
git branch -M main
git push -u origin main
```
