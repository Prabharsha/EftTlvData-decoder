/*
 * breakEftTlvData — client-side CEFT EFT TLV decoder.
 *
 * TLV wire format (CEFT Field 120 / "tag 120"):
 *   [ TAG (3 digits) ][ LENGTH (3 digits) ][ VALUE (LENGTH chars) ] ... repeated
 *
 * The tag dictionary below is the source of truth taken directly from the
 * CEFT core:
 *   - enum / tagId        -> EftTlvTag.java
 *   - financialMessageProp -> EfvTlvBuilder.tagPropertyMap
 *   - apiField            -> FinancialRequest payload (best-effort 1:1 mapping)
 *   - parse target        -> MessageConversionHelper.breakEftTlvData()
 */

const TAGS = {
  "001": {
    enumName: "BENEFICIARY_CARD_NO",
    prop: "beneficiaryCardNo",
    apiField: null,
    desc: "Beneficiary card number (card-based credit flows).",
  },
  "002": {
    enumName: "DESTINATION_ACCOUNT_NO",
    prop: "destAccountNo",
    apiField: "destinationAccount",
    desc: "Destination (beneficiary) account number.",
  },
  "003": {
    enumName: "CARDHOLDER_PAN",
    prop: "cardholderPAN",
    apiField: null,
    desc: "Cardholder Primary Account Number (PAN).",
  },
  "004": {
    enumName: "CARDHOLDER_ACCOUNT",
    prop: "cardholderAccount",
    apiField: "originatingAccount",
    desc: "Cardholder / originating account. Often currency-prefixed, e.g. LKR<account>.",
  },
  "005": {
    enumName: "DESTINATION_BANK_CODE",
    prop: "destBankCode",
    apiField: "destinationBankCode",
    desc: "Destination bank code. Also copied to receiverIdentificationCode.",
  },
  "006": {
    enumName: "ORIGINATING_BANK_CODE",
    prop: "orgBankCode",
    apiField: null,
    desc: "Originating bank code (acquirer / sending bank).",
  },
  "007": {
    enumName: "DESTINATION_BRANCH_CODE",
    prop: "destBranchCode",
    apiField: "destinationBranchCode",
    desc: "Destination branch code (validated / transformed on parse).",
  },
  "008": {
    enumName: "ORIGINATING_BRANCH_CODE",
    prop: "orgBranchCode",
    apiField: "originatingBranchCode",
    desc: "Originating branch code (validated / transformed on parse).",
  },
  "009": {
    enumName: "DESTINATION_ACCOUNT_HOLDERS_NAME",
    prop: "destAccountHolderName",
    apiField: "destinationAccountHolderName",
    desc: "Destination account holder's name.",
  },
  "010": {
    enumName: "ACCOUNT_HOLDERS_NAME",
    prop: "orgAccountHolderName",
    apiField: "originatingAccountHolderName",
    desc: "Originating account holder's name.",
  },
  "011": {
    enumName: "PARTICULARS",
    prop: "particulars",
    apiField: "particulars",
    desc: "Particulars / narrative shown to the beneficiary.",
  },
  "012": {
    enumName: "REFERENCE",
    prop: "reference",
    apiField: "reference",
    desc: "Customer reference for the transaction.",
  },
  "013": {
    enumName: "TRANSACTION_CODE",
    prop: "transactionCode.code",
    apiField: null,
    desc: "Transaction code (resolved to a TransactionCode enum on parse).",
  },
  "014": {
    enumName: "TRANSACTION_ID",
    prop: "transactionId",
    apiField: null,
    desc: "Transaction ID. Defined in enum; not currently built/parsed.",
  },
  "015": {
    enumName: "ORIGINATOR_WALLET_NUMBER",
    prop: "originatorWalletNumber",
    apiField: null,
    desc: "Originator wallet number. Defined in enum; not currently built/parsed.",
  },
  "016": {
    enumName: "DESTINATION_WALLET_NUMBER",
    prop: "destinationWalletNumber",
    apiField: null,
    desc: "Destination wallet number. Defined in enum; not currently built/parsed.",
  },
  "017": {
    enumName: "ADDITIONAL_DATA",
    prop: "additionalData",
    apiField: null,
    desc: "Additional data. Defined in enum; not currently built/parsed.",
  },
};

/* API request body fields that do NOT land in Field 120 (shown in JSON mode). */
const NON_TLV_API_FIELDS = {
  amount: "ISO DE4 — Amount, transaction",
  originatingAccountType: "ISO DE3 — Processing code (from-account type)",
  destinationAccountType: "ISO DE3 — Processing code (to-account type)",
  consumerTranId: "Client transaction id (audit / idempotency, not in tag 120)",
  handleCoreBankEntries: "Core-banking posting flag (service-level, not in tag 120)",
};

/* Keys that, inside a JSON body, carry a raw TLV string we should decode. */
const TLV_STRING_KEYS = [
  "120", "field120", "tag120", "f120",
  "eftTlvData", "eftTlv", "tlvData", "tlv", "efttlvdata",
];

const SAMPLE_TLV =
  "002012100641123718004016LKR1516300010104005004699000600467190070030020080046719009013Deepal Herath010013Deepal Herath011014Transfer Money012009reference01300245";

const SAMPLE_JSON = JSON.stringify(
  {
    originatingAccount: "1516300010104",
    originatingAccountHolderName: "Deepal Herath",
    originatingAccountType: "SAVINGS",
    originatingBranchCode: "002",
    destinationAccount: "100641123718",
    destinationAccountHolderName: "Deepal Herath",
    destinationBankCode: "6990",
    destinationBranchCode: "002",
    amount: 1500.0,
    particulars: "Transfer Money",
    reference: "reference",
    consumerTranId: "TXN-2026-0001",
  },
  null,
  2
);

/* ---------------------------------------------------------------- elements */
const $ = (id) => document.getElementById(id);
const input = $("input");
const detectBadge = $("detectBadge");
const errorMsg = $("errorMsg");
const resultSection = $("resultSection");
const resultTitle = $("resultTitle");
const resultMeta = $("resultMeta");
const resultBody = $("resultBody");

let lastDecoded = null; // for "Copy as JSON"

/* ---------------------------------------------------------------- helpers */
function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function showError(msg) {
  errorMsg.textContent = msg;
  errorMsg.hidden = false;
}
function clearError() {
  errorMsg.hidden = true;
  errorMsg.textContent = "";
}

function setBadge(el, text, cls) {
  el.textContent = text;
  el.className = "badge " + cls;
}

/* Decode a raw TLV string -> array of segments (mirrors breakEftTlvData). */
function decodeTlv(raw) {
  const segments = [];
  let i = 0;
  while (i < raw.length) {
    const remaining = raw.length - i;
    if (remaining < 6) {
      segments.push({ error: true, message: `Trailing data too short for a TLV header (need 6+ chars, got ${remaining}): "${raw.slice(i)}"` });
      break;
    }
    const tagId = raw.substr(i, 3);
    const lenStr = raw.substr(i + 3, 3);
    const len = parseInt(lenStr, 10);
    if (!/^\d{3}$/.test(lenStr) || Number.isNaN(len)) {
      segments.push({ error: true, message: `Invalid length "${lenStr}" at position ${i + 3} (expected 3 digits).` });
      break;
    }
    if (i + 6 + len > raw.length) {
      segments.push({ error: true, message: `Tag ${tagId} declares length ${len} but only ${raw.length - (i + 6)} chars remain.` });
      break;
    }
    const value = raw.substr(i + 6, len);
    segments.push({ tagId, len, lenStr, value, meta: TAGS[tagId] || null });
    i += 6 + len;
  }
  return segments;
}

/* ---------------------------------------------------------------- render */
function renderTlv(segments, title, metaText, metaCls) {
  resultTitle.textContent = title;
  setBadge(resultMeta, metaText, metaCls);

  const known = segments.filter((s) => !s.error && s.meta).length;
  const unknown = segments.filter((s) => !s.error && !s.meta).length;
  const errors = segments.filter((s) => s.error).length;

  let html = `<p class="summary-line">Parsed <strong>${segments.length - errors}</strong> tag(s)` +
    ` &mdash; ${known} mapped, ${unknown} unknown` +
    (errors ? `, <span class="unknown-tag">${errors} error(s)</span>` : "") + `.</p>`;

  html += `<div class="table-wrap"><table class="data-table"><thead><tr>
      <th>Tag</th><th>Len</th><th>Value</th>
      <th>Field name (enum)</th><th>FinancialMessage property</th><th>Description</th>
    </tr></thead><tbody>`;

  for (const s of segments) {
    if (s.error) {
      html += `<tr class="row-error"><td colspan="6">⚠ ${esc(s.message)}</td></tr>`;
      continue;
    }
    if (s.meta) {
      html += `<tr>
        <td class="mono tag-id">${esc(s.tagId)}</td>
        <td class="mono len-cell">${s.len}</td>
        <td class="mono val-cell">${esc(s.value) || '<span class="na">(empty)</span>'}</td>
        <td class="enum-name">${esc(s.meta.enumName)}</td>
        <td class="prop-name">${esc(s.meta.prop)}</td>
        <td>${esc(s.meta.desc)}</td>
      </tr>`;
    } else {
      html += `<tr>
        <td class="mono tag-id unknown-tag">${esc(s.tagId)}</td>
        <td class="mono len-cell">${s.len}</td>
        <td class="mono val-cell">${esc(s.value)}</td>
        <td class="unknown-tag" colspan="3">Unknown tag — not defined in EftTlvTag.</td>
      </tr>`;
    }
  }
  html += `</tbody></table></div>`;
  resultBody.innerHTML = html;
  resultSection.hidden = false;

  lastDecoded = segments
    .filter((s) => !s.error)
    .map((s) => ({
      tag: s.tagId,
      length: s.len,
      value: s.value,
      fieldName: s.meta ? s.meta.enumName : "UNKNOWN",
      property: s.meta ? s.meta.prop : null,
    }));
}

/* Render API request body -> tag mapping (forward direction). */
function renderRequestBody(obj) {
  resultTitle.textContent = "API request body → tag mapping";
  setBadge(resultMeta, "request body", "badge-json");

  const rows = [];
  const exported = [];
  for (const [key, rawVal] of Object.entries(obj)) {
    const value = typeof rawVal === "object" && rawVal !== null ? JSON.stringify(rawVal) : String(rawVal);
    // Find the tag this API field maps to.
    const tagEntry = Object.entries(TAGS).find(([, m]) => m.apiField === key);
    if (tagEntry) {
      const [tagId, meta] = tagEntry;
      rows.push(`<tr>
        <td class="mono">${esc(key)}</td>
        <td class="mono val-cell">${esc(value)}</td>
        <td class="mono tag-id">${esc(tagId)}</td>
        <td class="enum-name">${esc(meta.enumName)}</td>
        <td>${esc(meta.desc)}</td>
      </tr>`);
      exported.push({ apiField: key, value, tag: tagId, fieldName: meta.enumName });
    } else if (NON_TLV_API_FIELDS[key]) {
      rows.push(`<tr>
        <td class="mono">${esc(key)}</td>
        <td class="mono val-cell">${esc(value)}</td>
        <td class="na">—</td>
        <td class="na" colspan="2">${esc(NON_TLV_API_FIELDS[key])}</td>
      </tr>`);
      exported.push({ apiField: key, value, tag: null, fieldName: NON_TLV_API_FIELDS[key] });
    } else {
      rows.push(`<tr>
        <td class="mono">${esc(key)}</td>
        <td class="mono val-cell">${esc(value)}</td>
        <td class="na">—</td>
        <td class="unknown-tag" colspan="2">Not a recognised CEFT field.</td>
      </tr>`);
      exported.push({ apiField: key, value, tag: null, fieldName: "UNRECOGNISED" });
    }
  }

  const mappedCount = exported.filter((e) => e.tag).length;
  let html = `<p class="summary-line"><strong>${mappedCount}</strong> field(s) map to Field 120 tags; ` +
    `the rest are carried in other ISO fields or at the service layer.</p>`;
  html += `<div class="table-wrap"><table class="data-table"><thead><tr>
      <th>API field</th><th>Value</th><th>Tag</th><th>Field name (enum)</th><th>Notes</th>
    </tr></thead><tbody>${rows.join("")}</tbody></table></div>`;
  resultBody.innerHTML = html;
  resultSection.hidden = false;
  lastDecoded = exported;
}

/* ---------------------------------------------------------------- main */
function run() {
  clearError();
  const raw = input.value.trim();
  if (!raw) {
    showError("Please paste a tag 120 TLV string or an API request body first.");
    resultSection.hidden = true;
    setBadge(detectBadge, "awaiting input", "badge-muted");
    return;
  }

  // JSON?
  if (raw.startsWith("{") || raw.startsWith("[")) {
    let obj;
    try {
      obj = JSON.parse(raw);
    } catch (e) {
      showError("Looks like JSON but failed to parse: " + e.message);
      return;
    }
    if (Array.isArray(obj)) obj = obj[0] || {};

    // Does the JSON embed a raw TLV string under a known key?
    const tlvKey = Object.keys(obj).find((k) =>
      TLV_STRING_KEYS.includes(k.toLowerCase())
    );
    if (tlvKey && typeof obj[tlvKey] === "string") {
      setBadge(detectBadge, `JSON → TLV in "${tlvKey}"`, "badge-json");
      renderTlv(decodeTlv(obj[tlvKey].trim()), `Decoded "${tlvKey}"`, "embedded TLV", "badge-tlv");
      return;
    }

    setBadge(detectBadge, "API request body", "badge-json");
    renderRequestBody(obj);
    return;
  }

  // Raw TLV string. Strip an optional leading 3-digit LLLVAR length prefix only
  // if it makes the rest parse cleanly is risky, so we decode as-is.
  setBadge(detectBadge, "tag 120 TLV string", "badge-tlv");
  const segments = decodeTlv(raw);
  const hasError = segments.some((s) => s.error);
  renderTlv(
    segments,
    "Decoded tag 120 TLV",
    hasError ? "parsed with warnings" : "valid",
    hasError ? "badge-warn" : "badge-tlv"
  );
}

/* ---------------------------------------------------------------- dictionary table */
function buildDictTable() {
  const tbody = document.querySelector("#dictTable tbody");
  tbody.innerHTML = Object.entries(TAGS)
    .map(
      ([tagId, m]) => `<tr>
        <td class="mono tag-id">${tagId}</td>
        <td class="enum-name">${m.enumName}</td>
        <td class="prop-name">${m.prop}</td>
        <td class="mono">${m.apiField ? esc(m.apiField) : '<span class="na">—</span>'}</td>
        <td>${esc(m.desc)}</td>
      </tr>`
    )
    .join("");
}

/* ---------------------------------------------------------------- events */
$("decodeBtn").addEventListener("click", run);
$("sampleTlvBtn").addEventListener("click", () => {
  input.value = SAMPLE_TLV;
  run();
});
$("sampleJsonBtn").addEventListener("click", () => {
  input.value = SAMPLE_JSON;
  run();
});
$("clearBtn").addEventListener("click", () => {
  input.value = "";
  clearError();
  resultSection.hidden = true;
  setBadge(detectBadge, "awaiting input", "badge-muted");
  input.focus();
});
$("copyJsonBtn").addEventListener("click", async () => {
  if (!lastDecoded) return;
  try {
    await navigator.clipboard.writeText(JSON.stringify(lastDecoded, null, 2));
    const btn = $("copyJsonBtn");
    const old = btn.textContent;
    btn.textContent = "Copied ✓";
    setTimeout(() => (btn.textContent = old), 1200);
  } catch {
    showError("Clipboard not available in this context.");
  }
});
input.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") run();
});

buildDictTable();
