/* ============================================================================
 * breakEftTlvData — client-side CEFT Tag 120 / Field 120 TLV decoder.
 *
 * Scope (kept deliberately small):
 *   - input: a raw Tag 120 / Field 120 TLV string ONLY
 *   - decode each tag (TAG[3] + LENGTH[3] + VALUE[len], repeated)
 *   - map every tag to its field name, meaning and FinancialMessage property
 *   - identify the business flow (QR / CEFT / JustPay / ...) from the values
 *   - explain how each parameter is used inside that flow
 *
 * Everything below is derived from the CEFT core:
 *   EftTlvTag.java, EfvTlvBuilder.java, MessageConversionHelper.breakEftTlvData(),
 *   TransactionCode.java, MerchantType.java, AcquirerTransactionServiceHelper.java
 * ========================================================================== */

/* ----------------------------- tag dictionary ----------------------------- */
const TAGS = {
  "001": { name: "BENEFICIARY_CARD_NO", prop: "beneficiaryCardNo",
    meaning: "Beneficiary card number used in card-based credit transactions." },
  "002": { name: "DESTINATION_ACCOUNT_NO", prop: "destAccountNo",
    meaning: "The destination (beneficiary / credited) account number." },
  "003": { name: "CARDHOLDER_PAN", prop: "cardholderPAN",
    meaning: "Cardholder Primary Account Number (PAN)." },
  "004": { name: "CARDHOLDER_ACCOUNT", prop: "cardholderAccount",
    meaning: "The originating (debited) account. Often currency-prefixed, e.g. LKR<account>." },
  "005": { name: "DESTINATION_BANK_CODE", prop: "destBankCode",
    meaning: "Bank code of the destination institution (also copied to receiverIdentificationCode)." },
  "006": { name: "ORIGINATING_BANK_CODE", prop: "orgBankCode",
    meaning: "Bank code of the originating (sending / acquiring) institution." },
  "007": { name: "DESTINATION_BRANCH_CODE", prop: "destBranchCode",
    meaning: "Branch code of the destination account (validated/transformed on parse)." },
  "008": { name: "ORIGINATING_BRANCH_CODE", prop: "orgBranchCode",
    meaning: "Branch code of the originating account (validated/transformed on parse)." },
  "009": { name: "DESTINATION_ACCOUNT_HOLDERS_NAME", prop: "destAccountHolderName",
    meaning: "Name of the destination account holder (the payee)." },
  "010": { name: "ACCOUNT_HOLDERS_NAME", prop: "orgAccountHolderName",
    meaning: "Name of the originating account holder (the payer)." },
  "011": { name: "PARTICULARS", prop: "particulars",
    meaning: "Narrative / particulars shown to the beneficiary." },
  "012": { name: "REFERENCE", prop: "reference",
    meaning: "Customer / transaction reference." },
  "013": { name: "TRANSACTION_CODE", prop: "transactionCode.code",
    meaning: "Transaction code — the primary signal for the business flow." },
  "014": { name: "TRANSACTION_ID", prop: "transactionId",
    meaning: "Transaction ID (defined in EftTlvTag; not currently built/parsed in core)." },
  "015": { name: "ORIGINATOR_WALLET_NUMBER", prop: "originatorWalletNumber",
    meaning: "Originator wallet number (defined in EftTlvTag; not currently built/parsed)." },
  "016": { name: "DESTINATION_WALLET_NUMBER", prop: "destinationWalletNumber",
    meaning: "Destination wallet number (defined in EftTlvTag; not currently built/parsed)." },
  "017": { name: "ADDITIONAL_DATA", prop: "additionalData",
    meaning: "Additional data (defined in EftTlvTag; not currently built/parsed)." },
};

/* ------------------------- transaction-code catalogue --------------------- */
/* Tag 013 value -> { label, the flow it most strongly implies }. */
const TXN_CODES = {
  "00": "BALANCE_INQUIRY",
  "11": "CALL_MONEY_TRANSACTIONS",
  "12": "FOREIGN_EXCHANGE_SETTLEMENTS",
  "21": "STANDING_ORDERS",
  "22": "INSURANCE",
  "23": "SALARIES",
  "24": "PENSIONS",
  "25": "EPF_REFUNDS",
  "26": "ETF",
  "31": "ELECTRICITY_BILLS",
  "32": "TELEPHONE_BILLS",
  "33": "WATER_BILLS",
  "41": "CREDIT_CARDS",
  "42": "JP_REGISTRATION",
  "43": "JP_TRANSACTION",
  "44": "CUSTOMER_TRANSFER_DR",
  "45": "CUSTOMER_DR",
  "52": "CUSTOMER_TRANSFER",
  "53": "INWARDS_FOREIGN_REMITANCE",
  "54": "CREDIT_CARD_SETTLEMENT",
  "55": "DEVIDEND_PAYMENTS",
  "58": "SL_CUSTOMS_PAYMENTS",
  "62": "LPOPP",
  "70": "MERCHANT_CR",
};

/* ----------------------------- flow catalogue ----------------------------- */
/* Keyed by transaction code; refined by heuristics in detectFlow(). */
const FLOWS = {
  "52": {
    name: "CEFT Credit Transfer",
    desc: "A standard CEFT account-to-account credit (Customer Transfer). The originating bank pushes funds to a beneficiary account at the destination bank.",
  },
  "44": {
    name: "CEFT Debit Transfer / JustPay PIN",
    desc: "A customer-debit leg (CUSTOMER_TRANSFER_DR). Used for CEFT debit transfers and for the PIN-based JustPay debit leg.",
  },
  "42": {
    name: "JustPay Registration",
    desc: "Registration of a customer/account for JustPay (LankaPay JustPay). No value is moved — it links the account for future JustPay debits.",
  },
  "43": {
    name: "JustPay Transaction",
    desc: "A JustPay payment — a real-time low-value debit from a registered customer account to a biller/merchant.",
  },
  "70": {
    name: "QR Merchant Credit",
    desc: "The merchant-credit leg of a QR payment (QR Type 1/3/4). Funds settle from a QR GL into the merchant's account.",
  },
  "45": {
    name: "QR Customer Debit",
    desc: "The customer-debit leg of a QR payment (QR Type 2/3/4). The payer's account is debited and funds move toward the QR settlement GL.",
  },
  "53": {
    name: "Inward Foreign Remittance",
    desc: "An inward remittance credited to a local beneficiary (routed as an IB_EFT credit).",
  },
  "54": {
    name: "Credit Card Settlement",
    desc: "A credit-card settlement movement between institutions.",
  },
  "62": {
    name: "LPOPP / IRD Payment",
    desc: "A Local Payment of Public Payments (LPOPP) / IRD government payment. The transaction code is supplied by the caller rather than a fixed value.",
  },
  "00": {
    name: "Balance Inquiry",
    desc: "A non-financial balance inquiry — no funds are moved.",
  },
};

const GENERIC_FLOW = {
  name: "Generic CEFT EFT Transfer",
  desc: "A CEFT electronic fund transfer. The transaction code did not match a more specific flow, so this is treated as a standard EFT credit/debit.",
};

/* Per-field, flow-aware usage text. Falls back to a generic line per tag. */
const USAGE = {
  generic: {
    "002": "Identifies the account to be <strong>credited</strong>. The issuer/destination bank posts the funds here.",
    "004": "Identifies the account to be <strong>debited</strong> (the payer). Drives the funding leg of the transfer.",
    "005": "Routes the message to the correct <strong>destination bank</strong> within the CEFT/LankaPay network.",
    "006": "Identifies the <strong>originating bank</strong> for reconciliation and the return/reversal path.",
    "007": "Pinpoints the destination <strong>branch</strong> for core-banking posting.",
    "008": "Pinpoints the originating <strong>branch</strong> for core-banking posting.",
    "009": "Shown as the <strong>payee name</strong> and used for beneficiary-name validation.",
    "010": "Shown as the <strong>payer name</strong> on statements and advices.",
    "011": "Free-text <strong>narration</strong> carried to the beneficiary's statement.",
    "012": "Customer <strong>reference</strong> used for tracing and reconciliation.",
    "013": "The <strong>transaction code</strong> that selects the processing path and posting rules.",
  },
  qr: {
    "002": "Holds the <strong>merchant identification</strong> (the account credited on the merchant-credit leg).",
    "004": "The <strong>QR settlement GL</strong> on the acquirer side (e.g. acquirer.qr.payable.gl) for external QR, or the payer's account on the debit leg.",
    "005": "The <strong>merchant's bank code</strong> — where the QR funds are routed for settlement.",
    "009": "Often <code>UNKNOWN</code> for external QR merchants, since only the merchant ID/bank is known.",
    "010": "Frequently <code>QR-GL</code>, marking the QR general-ledger account rather than a real customer name.",
    "011": "QR narration (e.g. <em>Transfer QR Money</em>) — a strong hint that this is a QR flow.",
    "013": "<strong>70</strong> = merchant credit leg, <strong>45</strong> = customer debit leg of the QR payment.",
  },
  justpay: {
    "002": "The biller/merchant account credited by the JustPay payment.",
    "004": "The registered customer account debited for the JustPay payment.",
    "013": "<strong>42</strong> = JustPay registration, <strong>43</strong> = JustPay transaction, <strong>44</strong> = PIN-based debit leg.",
    "012": "Used to correlate the JustPay registration/transaction across the acquirer and issuer.",
  },
  lpopp: {
    "013": "Carries the <strong>caller-supplied LPOPP transaction code</strong> (LPOPP overrides the default in EfvTlvBuilder).",
    "002": "The IRD / public-payment destination account.",
  },
};

const SAMPLE =
  "002012100641123718004016LKR1516300010104005004699000600467190070030020080046719009013Deepal Herath010013Deepal Herath011014Transfer Money012009reference01300245";

/* ------------------------------- elements --------------------------------- */
const $ = (id) => document.getElementById(id);
const input = $("input");
const errorMsg = $("errorMsg");
const flowCard = $("flowCard");
const fieldsSection = $("fieldsSection");
const fieldsList = $("fieldsList");

/* -------------------------------- helpers --------------------------------- */
function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function showError(msg) { errorMsg.textContent = msg; errorMsg.hidden = false; }
function hideResults() { flowCard.hidden = true; fieldsSection.hidden = true; }

/* Decode a raw TLV string into an array of segments (mirrors breakEftTlvData). */
function decodeTlv(raw) {
  const out = [];
  let i = 0;
  while (i < raw.length) {
    const remaining = raw.length - i;
    if (remaining < 6) {
      out.push({ error: `Trailing data too short for a TLV header (need 6+ chars, got ${remaining}): "${raw.slice(i)}"` });
      break;
    }
    const tagId = raw.substr(i, 3);
    const lenStr = raw.substr(i + 3, 3);
    if (!/^\d{3}$/.test(lenStr)) {
      out.push({ error: `Invalid length "${lenStr}" at position ${i + 3} — expected 3 digits.` });
      break;
    }
    const len = parseInt(lenStr, 10);
    if (i + 6 + len > raw.length) {
      out.push({ error: `Tag ${tagId} declares length ${len} but only ${raw.length - (i + 6)} chars remain.` });
      break;
    }
    out.push({ tagId, len, value: raw.substr(i + 6, len), meta: TAGS[tagId] || null });
    i += 6 + len;
  }
  return out;
}

/* Identify the business flow from the decoded values. */
function detectFlow(segments) {
  const byTag = {};
  for (const s of segments) if (!s.error) byTag[s.tagId] = s.value;

  const txnCode = byTag["013"];
  const particulars = (byTag["011"] || "").toLowerCase();
  const orgName = (byTag["010"] || "");
  const destName = (byTag["009"] || "");
  const blob = (particulars + " " + orgName + " " + destName).toLowerCase();

  const hasQr = /qr/.test(blob) || orgName.toUpperCase() === "QR-GL";
  const hasJp = /just\s*pay|justpay|\bjp\b/.test(blob);
  const hasP2p = /p2p|peer[\s-]*to[\s-]*peer/.test(blob);

  const reasons = [];
  let flow, category = "generic", confidence = "low";

  if (txnCode && FLOWS[txnCode]) {
    flow = { ...FLOWS[txnCode] };
    confidence = "medium";
    const label = TXN_CODES[txnCode] || "?";
    reasons.push(`Tag <code>013</code> = <code>${esc(txnCode)}</code> (${label}) selects the processing path.`);

    if (txnCode === "70" || txnCode === "45") {
      category = "qr";
      if (hasP2p) {
        flow.name = "Peer-to-Peer QR Credit";
        flow.desc = "A peer-to-peer QR transfer (PEER_TO_PEER_QR_CUSTOMER_CR). Funds move directly between two individuals via a QR payment rather than to a merchant.";
        reasons.push("Particulars/name indicate a peer-to-peer QR transfer.");
        confidence = "high";
      } else if (hasQr) {
        flow.name = txnCode === "70" ? "QR Merchant Credit" : "QR Customer Debit";
        reasons.push(orgName.toUpperCase() === "QR-GL"
          ? "Originating holder is <code>QR-GL</code> — the QR settlement general-ledger account."
          : "Particulars contain a <code>QR</code> marker.");
        if (destName.toUpperCase() === "UNKNOWN")
          reasons.push("Destination holder is <code>UNKNOWN</code>, typical of an external QR merchant.");
        confidence = "high";
      } else {
        // CUSTOMER_DR/MERCHANT_CR without a QR marker — still most likely QR, but less certain.
        flow.name = txnCode === "70" ? "Merchant Credit (QR/EFT)" : "Customer Debit (QR/EFT)";
        reasons.push("No explicit QR marker found — flow inferred from the transaction code alone.");
      }
    } else if (txnCode === "42" || txnCode === "43" || txnCode === "44") {
      category = "justpay";
      if (txnCode === "44" && !hasJp) {
        // 44 is shared between CEFT debit and JustPay PIN.
        reasons.push("Code 44 is shared by CEFT debit transfers and the JustPay PIN leg.");
      } else if (hasJp) {
        reasons.push("Particulars/name reference JustPay.");
        confidence = "high";
      } else {
        confidence = "high";
      }
    } else if (txnCode === "62") {
      category = "lpopp";
      confidence = "high";
    } else if (txnCode === "52" || txnCode === "53" || txnCode === "54") {
      category = "generic";
      confidence = "high";
    }
  } else {
    flow = { ...GENERIC_FLOW };
    if (txnCode) reasons.push(`Tag <code>013</code> = <code>${esc(txnCode)}</code> did not match a known flow code.`);
    else reasons.push("No Tag <code>013</code> (transaction code) present — flow could not be pinned down.");
    if (hasQr) { reasons.push("Particulars/name contain a QR marker."); category = "qr"; }
  }

  return { flow, category, confidence, reasons };
}

/* ------------------------------- rendering -------------------------------- */
function renderFlow(detected) {
  $("flowName").textContent = detected.flow.name;
  $("flowDesc").textContent = detected.flow.desc;
  const conf = $("flowConfidence");
  conf.textContent = detected.confidence + " confidence";
  conf.className = "confidence " + detected.confidence;
  $("flowReasons").innerHTML = detected.reasons.map((r) => `<li>${r}</li>`).join("");
  flowCard.hidden = false;
}

function usageFor(tagId, category) {
  return (USAGE[category] && USAGE[category][tagId]) || USAGE.generic[tagId] || null;
}

function renderFields(segments, category) {
  const ok = segments.filter((s) => !s.error);
  const known = ok.filter((s) => s.meta).length;
  const errs = segments.filter((s) => s.error).length;

  $("fieldsSummary").textContent =
    `${ok.length} tag${ok.length === 1 ? "" : "s"} · ${known} mapped` + (errs ? ` · ${errs} error` : "");

  fieldsList.innerHTML = segments.map((s) => {
    if (s.error) {
      return `<div class="field-item error"><p class="field-error-msg">⚠ ${esc(s.error)}</p></div>`;
    }
    const meta = s.meta;
    const value = s.value === "" ? `<span class="empty">(empty)</span>` : esc(s.value);
    if (!meta) {
      return `<div class="field-item unknown">
        <div class="tag-badge">${esc(s.tagId)}</div>
        <div class="field-main">
          <div class="field-top"><span class="field-name">Unknown tag</span></div>
          <div class="field-value">${value} <span class="len">· len ${s.len}</span></div>
          <p class="field-meaning">This tag is not defined in <code>EftTlvTag</code>.</p>
        </div>
      </div>`;
    }
    const usage = usageFor(s.tagId, category);
    let valExtra = "";
    if (s.tagId === "013") {
      const label = TXN_CODES[s.value];
      if (label) valExtra = ` <span class="len">· ${esc(label)}</span>`;
    }
    return `<div class="field-item">
      <div class="tag-badge">${esc(s.tagId)}</div>
      <div class="field-main">
        <div class="field-top">
          <span class="field-name">${esc(meta.name)}</span>
          <span class="field-prop">${esc(meta.prop)}</span>
        </div>
        <div class="field-value">${value} <span class="len">· len ${s.len}</span>${valExtra}</div>
        <p class="field-meaning">${esc(meta.meaning)}</p>
        ${usage ? `<p class="field-usage">In this flow: ${usage}</p>` : ""}
      </div>
    </div>`;
  }).join("");

  fieldsSection.hidden = false;
}

/* --------------------------------- main ----------------------------------- */
function run() {
  errorMsg.hidden = true;
  const raw = input.value.trim();
  if (!raw) {
    hideResults();
    showError("Paste a Tag 120 / Field 120 TLV string to decode.");
    return;
  }
  if (raw.startsWith("{") || raw.startsWith("[")) {
    hideResults();
    showError("This tool only decodes a raw Tag 120 / Field 120 TLV string — not JSON / API bodies.");
    return;
  }
  if (!/^\d{3}/.test(raw)) {
    hideResults();
    showError("That does not look like a TLV string — it should start with a 3-digit tag (e.g. 002…).");
    return;
  }

  const segments = decodeTlv(raw);
  const detected = detectFlow(segments);
  renderFlow(detected);
  renderFields(segments, detected.category);
  flowCard.scrollIntoView({ behavior: "smooth", block: "start" });
}

/* -------------------------------- events ---------------------------------- */
$("decodeBtn").addEventListener("click", run);
$("sampleBtn").addEventListener("click", () => { input.value = SAMPLE; run(); });
$("clearBtn").addEventListener("click", () => {
  input.value = ""; errorMsg.hidden = true; hideResults(); input.focus();
});
input.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") run();
});
