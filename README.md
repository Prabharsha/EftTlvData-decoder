# breakEftTlvData

A tiny, **client-side** single-page app that decodes CEFT **EFT TLV** data — the
sub-fields packed into ISO-8583 **Field 120** ("tag 120") — into human-readable
field names and shows how each tag maps to the API request body / `FinancialMessage`.

Paste either:

1. a raw **tag 120 TLV string**, or
2. an **API request body (JSON)** — either the request itself, or a JSON that
   embeds the TLV string under a key like `eftTlvData` / `field120` / `120`.

…and you get a table of `Tag → Length → Value → field name → property → description`.

> Nothing leaves the browser — all decoding happens locally in JavaScript.

## TLV wire format

Field 120 is a flat concatenation of sub-fields, each:

```
[ TAG (3 digits) ][ LENGTH (3 digits) ][ VALUE (LENGTH chars) ]
```

repeated until the string is consumed. Example:

```
002012100641123718004016LKR1516300010104005004699000600467190070030020080046719...
└┬┘└┬┘└─────┬─────┘
 │  │       └ value (12 chars)
 │  └ length = 012
 └ tag 002 = DESTINATION_ACCOUNT_NO
```

## Tag dictionary (source of truth)

The mapping is taken directly from the CEFT core and shown in-app:

| Source | What it gives |
| --- | --- |
| `EftTlvTag.java` | tag id ↔ enum name |
| `EfvTlvBuilder.java` (`tagPropertyMap`) | tag ↔ `FinancialMessage` property |
| `MessageConversionHelper.breakEftTlvData()` | the parse algorithm replicated here |
| `FinancialRequest` payload | API request field ↔ tag (best-effort 1:1) |

## Run locally

It's a static site — no build step, no dependencies. Just open `index.html`,
or serve the folder:

```bash
# any static server works
npx serve .
# or
python -m http.server 8000
```

## Deploy to Vercel

This is a zero-config static deploy.

**Option A — Vercel dashboard**
1. Push this repo to GitHub (see below).
2. In Vercel → *Add New… → Project* → import the repo.
3. Framework preset: **Other**. Build command: *(none)*. Output dir: *(root)*.
4. Deploy.

**Option B — Vercel CLI**
```bash
npm i -g vercel
vercel        # follow prompts, accept defaults
vercel --prod # promote to production
```

## Push to a new git repo

This folder is already a standalone git repo (separate from `ceft-suit-main`).
Point it at a fresh remote and push:

```bash
git remote add origin https://github.com/<you>/breakEftTlvData.git
git branch -M main
git push -u origin main
```
