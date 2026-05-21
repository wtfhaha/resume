// Load environment variables from .env file in the server directory
require("dotenv").config();

const fs = require("fs");
const express = require("express");
const cors = require("cors");
const puppeteer = require("puppeteer");
require("dotenv").config();

const DEEPINFRA_API_URL =
  process.env.DEEPINFRA_API_URL || "https://api.deepinfra.com/v1/openai";
const DEEPINFRA_API_KEY = process.env.DEEPINFRA_API_KEY;
const DEEPINFRA_MODEL =
  process.env.DEEPINFRA_MODEL || "deepseek-ai/DeepSeek-V4-Pro";

// dotenv.config(); // No longer loading from .env file

const app = express();
const port = process.env.PORT || 5001;

app.use(cors());
app.use(express.json());

// --- Helper: Validate API Key ---
const validateApiKey = () => {
  if (
    !DEEPINFRA_API_KEY ||
    DEEPINFRA_API_KEY === "YOUR_DEEPINFRA_API_KEY_HERE"
  ) {
    console.error("ERROR: DEEPINFRA_API_KEY is not configured properly");
    console.error("Please set your actual DeepInfra API key in server/.env");
    return false;
  }
  return true;
};

// --- Helper: Call DeepInfra Chat API ---
const deepInfraChatCompletion = async ({
  messages,
  model = DEEPINFRA_MODEL,
  temperature = 0.7,
  max_tokens = 4096,
  retries = 3,
  retryDelay = 2000,
}) => {
  if (typeof fetch === "undefined") {
    throw new Error("Global fetch is not available in this Node runtime.");
  }

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await fetch(`${DEEPINFRA_API_URL}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${DEEPINFRA_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          messages,
          temperature,
          max_tokens,
        }),
      });

      if (!response.ok) {
        const errorBody = await response.text();
        if (response.status === 429 && attempt < retries) {
          console.warn(
            `DeepInfra API rate limit hit. Retrying in ${retryDelay}ms... (Attempt ${attempt} of ${retries})`
          );
          await new Promise((resolve) => setTimeout(resolve, retryDelay));
          continue;
        }
        throw new Error(
          `DeepInfra API error ${response.status}: ${response.statusText} - ${errorBody}`
        );
      }

      return response.json();
    } catch (error) {
      if (attempt === retries) {
        console.error("DeepInfra API call failed after maximum retries:", error);
        throw error;
      }
    }
  }
};

// --- Sanitization Function ---
const sanitizeResumeJson = (data) => {
  const unwantedPatterns = [
    /\bSpecialist\b/gi, // Matches "Specialist" as a whole word, case-insensitive
    /\boutstanding\b/gi,
    /\bworld-class\b/gi,
    /\bexpert\b/gi,
    /\bhighly\b/gi,
    /\bexceptionally\b/gi,
    /\bexcellent\b/gi,
    /\bsuperior\b/gi,
    /\bgroundbreaking\b/gi,
    /\bremarkable\b/gi,
    // Add more patterns here as needed
    // Consider if words like "Manager", "Engineer", "Developer" should be protected in titles too?
    // For now, we only specifically protect "Specialist" in titles via the key check below.
  ];

  const protectedKeys = ["title"]; // Keys whose string values should NOT be sanitized

  const sanitizeString = (str) => {
    let sanitized = str;
    unwantedPatterns.forEach((pattern) => {
      // Extra check: Don't remove "Specialist" if it's likely part of a compound title (simplistic check)
      // This is less robust than the key check, kept as a secondary thought but key check is primary.
      // if (pattern.source.includes('Specialist') && (str.match(/\w+ Specialist/i))) {
      //   return; // Don't remove if preceded by another word (like 'Design Specialist')
      // }
      sanitized = sanitized
        .replace(pattern, "")
        .replace(/\s{2,}/g, " ")
        .trim(); // Remove word, cleanup extra spaces
    });
    return sanitized;
  };

  // Modified traverse to accept the current key
  const traverse = (node, currentKey = null) => {
    if (typeof node === "string") {
      // If the key is in the protected list, return the original string
      if (currentKey && protectedKeys.includes(currentKey)) {
        return node;
      }
      // Otherwise, sanitize the string
      return sanitizeString(node);
    } else if (Array.isArray(node)) {
      // Pass the key down for arrays (though index is more relevant here, key helps identify context)
      return node.map((item) => traverse(item, currentKey));
    } else if (typeof node === "object" && node !== null) {
      const newNode = {}; // Remove type annotation
      for (const key in node) {
        if (Object.hasOwnProperty.call(node, key)) {
          // Pass the current key when traversing object properties
          newNode[key] = traverse(node[key], key);
        }
      }
      return newNode;
    }
    return node; // Return numbers, booleans, null as is
  };

  return traverse(data);
};

const normalizeContactUrl = (url) => {
  if (!url || typeof url !== "string") return "";
  let cleaned = url.trim();
  if (cleaned.length === 0) return "";
  if (!cleaned.startsWith("http://") && !cleaned.startsWith("https://")) {
    if (!cleaned.includes("/") && !cleaned.includes(".")) {
      cleaned = `https://www.behance.net/${cleaned}`;
    } else {
      cleaned = `https://${cleaned}`;
    }
  }
  return cleaned;
};

const getContactLinkUrl = (contact) => {
  const linkValue = (contact && (contact.link || contact.behance)) || "";
  return normalizeContactUrl(linkValue);
};

const getPuppeteerLaunchOptions = () => {
  const launchOptions = {
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
    ],
  };

  const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH?.trim();
  if (executablePath) {
    try {
      fs.accessSync(executablePath, fs.constants.X_OK);
      launchOptions.executablePath = executablePath;
      console.log(
        "Using configured Puppeteer executable path:",
        executablePath,
      );
    } catch (accessError) {
      console.warn(
        `Configured Puppeteer executable path is not usable: ${executablePath}. Falling back to Puppeteer default browser path.`,
        accessError.message,
      );
    }
  } else {
    console.log(
      "No PUPPETEER_EXECUTABLE_PATH configured; using Puppeteer default browser path.",
    );
  }

  return launchOptions;
};

// PDF generation — no artificial scaling or page balancing.
// Content renders at natural size so there are no huge empty gaps.
const createPdfBufferFromHtml = async (page, htmlContent) => {
  await page.setContent(htmlContent, { waitUntil: "networkidle0" });
  await page.evaluate(() =>
    document.fonts && document.fonts.ready ? document.fonts.ready : undefined,
  );

  const pdfBuffer = await page.pdf({
    format: "A4",
    printBackground: true,
    margin: { top: "0", bottom: "0", left: "0", right: "0" },
    preferCSSPageSize: true,
  });

  return {
    pdfBuffer,
    pagination: { scale: 1, finalMetrics: { pages: 1, lastPageUsage: 1 } },
  };
};

// --- TEMPLATE FUNCTIONS (v2) ---
// Puppeteer PDF rules observed throughout:
//   • All sizes in pt/mm — never rem/em
//   • page-break-inside:avoid + break-inside:avoid on every item
//   • page-break-after:avoid  + break-after:avoid  on every heading
//   • No @import for fonts — system fonts only (Arial, Georgia, Helvetica)
//   • For full-bleed headers: negative-margin trick against @page margins
//   • For repeating sidebars: position:fixed (Puppeteer repeats on every page)
//   • float-based dates with overflow:hidden parent (more reliable than flex in body)

// ─── helpers ──────────────────────────────────────────────────────────────────
const esc = (s) => String(s || "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
const contactParts = (contact, contactUrl, contactText) => {
  const p = [];
  if (contact.location) p.push(esc(contact.location));
  if (contact.phone)    p.push(esc(contact.phone));
  if (contact.email)    p.push(`<a href="mailto:${esc(contact.email)}">${esc(contact.email)}</a>`);
  if (contactUrl)       p.push(`<a href="${esc(contactUrl)}" target="_blank">${esc(contactText)}</a>`);
  return p;
};

// ─────────────────────────────────────────────────────────────────────────────
// Template: Classic  — clean single-column, ATS-safe
// ─────────────────────────────────────────────────────────────────────────────
const createResumeHtml_Classic = (data) => {
  const css = `
    @page { size: A4; margin: 20mm 22mm 18mm; }
    * { box-sizing: border-box; }
    body { margin: 0; padding: 0; font-family: Arial, Helvetica, sans-serif;
           font-size: 9pt; line-height: 1.42; color: #1a1a1a; background: #fff; }
    /* ── header ── */
    .hdr       { text-align: center; margin-bottom: 9px;
                 page-break-inside: avoid; break-inside: avoid; }
    .hdr h1    { margin: 0; font-size: 19pt; font-weight: 900; text-transform: uppercase;
                 letter-spacing: 2px; color: #111; }
    .hdr .prof { font-size: 9.5pt; color: #555; margin: 3px 0 5px; }
    .hdr .cbar { font-size: 8.5pt; color: #444; }
    .hdr .cbar a { color: #444; text-decoration: none; }
    /* ── sections ── */
    h2 { font-size: 9.5pt; font-weight: 900; text-transform: uppercase;
         letter-spacing: 1.2px; border-bottom: 1.5px solid #111;
         margin: 11px 0 5px; padding-bottom: 2px;
         page-break-after: avoid; break-after: avoid; }
    .sec { margin-bottom: 8px; }
    /* ── items: title on its own line; company + date share a row ── */
    .item   { margin-bottom: 8px; page-break-inside: avoid; break-inside: avoid; }
    .ititle { font-weight: bold; font-size: 9.5pt; display: block; margin-bottom: 1px; }
    .irow   { display: table; width: 100%; margin-bottom: 3px; }
    .isub   { display: table-cell; font-style: italic; font-size: 9pt; color: #444; }
    .idate  { display: table-cell; white-space: nowrap; text-align: right;
              padding-left: 10px; font-size: 8.5pt; color: #555; }
    ul      { margin: 3px 0 0; padding-left: 14px; }
    li      { margin-bottom: 2px; font-size: 9pt; }
    p       { margin: 0 0 4px; font-size: 9pt; }
    /* ── skills ── */
    .sk         { list-style: none; padding: 0; margin: 0;
                  column-count: 2; column-gap: 15px; }
    .sk li      { margin-bottom: 2px; font-size: 9pt; }
    .sk li::before { content: "• "; }
  `;

  const name   = esc(data.name || "Your Name");
  const prof   = data.experience?.[0]?.title ? esc(data.experience[0].title) : "";
  const contact = data.contact || {};
  const url    = getContactLinkUrl(contact);
  const cparts = contactParts(contact, url, contact.link || contact.behance || "Portfolio");

  const expHtml = (data.experience || []).map(exp => `
    <div class="item">
      <span class="ititle">${esc(exp.title)}</span>
      <div class="irow">
        <span class="isub">${esc(exp.company)}</span>
        <span class="idate">${esc(exp.dates)}</span>
      </div>
      <ul>${(exp.details || []).map(d => `<li>${esc(d)}</li>`).join("")}</ul>
    </div>`).join("");

  const eduHtml = (data.education || []).map(edu => `
    <div class="item">
      <span class="ititle">${esc(edu.degree)}</span>
      <div class="irow">
        <span class="isub">${esc(edu.institution)}</span>
        <span class="idate">${esc(edu.dates)}</span>
      </div>
    </div>`).join("");

  const skHtml = (data.skills || []).length
    ? `<ul class="sk">${(data.skills || []).map(s => `<li>${esc(s)}</li>`).join("")}</ul>` : "";

  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>${css}</style></head><body>
  <div class="hdr">
    <h1>${name}</h1>
    ${prof ? `<div class="prof">${prof}</div>` : ""}
    <div class="cbar">${cparts.join(" &nbsp;|&nbsp; ")}</div>
  </div>
  ${data.summary ? `<div class="sec"><h2>Summary</h2><p>${esc(data.summary)}</p></div>` : ""}
  ${(data.experience||[]).length ? `<div class="sec"><h2>Experience</h2>${expHtml}</div>` : ""}
  ${(data.education||[]).length  ? `<div class="sec"><h2>Education</h2>${eduHtml}</div>`  : ""}
  ${(data.skills||[]).length     ? `<div class="sec"><h2>Skills</h2>${skHtml}</div>`      : ""}
  </body></html>`;
};

// ─────────────────────────────────────────────────────────────────────────────
// Template: Creative  — split header (name left / contact right), slate accent
// ─────────────────────────────────────────────────────────────────────────────
const createResumeHtml_Creative = (data, accentColor = "#2d4a6e") => {
  const ACCENT = accentColor;
  const css = `
    @page { size: A4; margin: 18mm 22mm 16mm; }
    * { box-sizing: border-box; }
    body { margin: 0; padding: 0; font-family: Arial, Helvetica, sans-serif;
           font-size: 9pt; line-height: 1.44; color: #1e1e2e; background: #fff; }
    /* ── header: name+profession left, contact right ── */
    .hdr   { display: table; width: 100%; border-bottom: 3px solid ${ACCENT};
             padding-bottom: 10px; margin-bottom: 11px;
             page-break-inside: avoid; break-inside: avoid; }
    .hdr-l { display: table-cell; vertical-align: bottom; }
    .hdr-r { display: table-cell; vertical-align: bottom; text-align: right;
             width: 40%; }
    .hdr h1   { margin: 0 0 3px; font-size: 22pt; font-weight: 900;
                text-transform: uppercase; letter-spacing: 1px; color: #111; }
    .hdr .prof { font-size: 10pt; color: ${ACCENT}; font-weight: 700; margin: 0; }
    .hdr .citem { font-size: 8pt; color: #555; line-height: 1.85; }
    .hdr .citem a { color: #555; text-decoration: none; }
    /* ── section headers: colored text + extending rule ── */
    h2 { display: table; width: 100%;
         font-size: 8.5pt; font-weight: 900; text-transform: uppercase;
         letter-spacing: 2px; color: ${ACCENT};
         margin: 12px 0 5px; padding: 0;
         page-break-after: avoid; break-after: avoid; }
    h2::before { content: attr(data-label); display: table-cell;
                 white-space: nowrap; padding-right: 10px; }
    h2::after  { content: ""; display: table-cell; width: 100%;
                 border-bottom: 1px solid #c5d0de; vertical-align: middle; }
    .sec { margin-bottom: 9px; }
    /* ── items: title on its own line; company + date share a row ── */
    .item   { margin-bottom: 7px; page-break-inside: avoid; break-inside: avoid; }
    .ititle { font-weight: bold; font-size: 9.5pt; color: #111;
              display: block; margin-bottom: 1px; }
    .irow   { display: table; width: 100%; margin-bottom: 3px; }
    .isub   { display: table-cell; font-style: italic; font-size: 9pt; color: ${ACCENT}; }
    .idate  { display: table-cell; white-space: nowrap; text-align: right;
              padding-left: 10px; font-size: 8.5pt; color: #666; }
    ul { margin: 3px 0 0; padding-left: 14px; }
    li { margin-bottom: 2px; font-size: 9pt; }
    p  { margin: 0 0 4px; font-size: 9pt; }
    /* ── skills 2-col ── */
    .sk     { list-style: none; padding: 0; margin: 0; column-count: 2; column-gap: 14px; }
    .sk li  { margin-bottom: 2px; font-size: 9pt; padding-left: 12px; position: relative; }
    .sk li::before { content: "▸"; position: absolute; left: 0;
                     color: ${ACCENT}; font-size: 8pt; top: 1px; }
  `;

  const h2     = (label) => `<h2 data-label="${esc(label)}"></h2>`;
  const name   = esc(data.name || "Your Name");
  const prof   = data.experience?.[0]?.title ? esc(data.experience[0].title) : "";
  const contact = data.contact || {};
  const url    = getContactLinkUrl(contact);
  const urlTxt = esc(contact.link || contact.behance || "Portfolio");

  const cHtml = [
    contact.email    ? `<div class="citem"><a href="mailto:${esc(contact.email)}">${esc(contact.email)}</a></div>` : "",
    contact.phone    ? `<div class="citem">${esc(contact.phone)}</div>` : "",
    contact.location ? `<div class="citem">${esc(contact.location)}</div>` : "",
    url              ? `<div class="citem"><a href="${esc(url)}">${urlTxt}</a></div>` : "",
  ].filter(Boolean).join("");

  const expHtml = (data.experience || []).map(exp => `
    <div class="item">
      <span class="ititle">${esc(exp.title)}</span>
      <div class="irow">
        <span class="isub">${esc(exp.company)}</span>
        <span class="idate">${esc(exp.dates)}</span>
      </div>
      <ul>${(exp.details || []).map(d => `<li>${esc(d)}</li>`).join("")}</ul>
    </div>`).join("");

  const eduHtml = (data.education || []).map(edu => `
    <div class="item">
      <span class="ititle">${esc(edu.degree)}</span>
      <div class="irow">
        <span class="isub">${esc(edu.institution)}</span>
        <span class="idate">${esc(edu.dates)}</span>
      </div>
    </div>`).join("");

  const skHtml = (data.skills || []).length
    ? `<ul class="sk">${(data.skills || []).map(s => `<li>${esc(s)}</li>`).join("")}</ul>` : "";

  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>${css}</style></head><body>
  <div class="hdr">
    <div class="hdr-l">
      <h1>${name}</h1>
      ${prof ? `<div class="prof">${prof}</div>` : ""}
    </div>
    <div class="hdr-r">${cHtml}</div>
  </div>
  ${data.summary    ? `<div class="sec">${h2("Professional Summary")}<p>${esc(data.summary)}</p></div>` : ""}
  ${(data.experience||[]).length ? `<div class="sec">${h2("Experience")}${expHtml}</div>` : ""}
  ${(data.education||[]).length  ? `<div class="sec">${h2("Education")}${eduHtml}</div>`  : ""}
  ${(data.skills||[]).length     ? `<div class="sec">${h2("Skills")}${skHtml}</div>`      : ""}
  </body></html>`;
};

// ─────────────────────────────────────────────────────────────────────────────
// Template: Compact  — dense layout, name left / contact right, 3-col skills
// ─────────────────────────────────────────────────────────────────────────────
const createResumeHtml_Compact = (data) => {
  const css = `
    @page { size: A4; margin: 13mm 16mm 12mm; }
    * { box-sizing: border-box; }
    body { margin: 0; padding: 0; font-family: Arial, Helvetica, sans-serif;
           font-size: 8.5pt; line-height: 1.32; color: #1e1e1e; background: #fff; }
    /* ── header: name left, contact right ── */
    .hdr        { overflow: hidden; margin-bottom: 6px; border-bottom: 2px solid #1e1e1e; padding-bottom: 5px; }
    .hdr-left   { float: left; }
    .hdr-right  { float: right; text-align: right; font-size: 8pt; color: #444; line-height: 1.65; }
    .hdr-right a{ color: #444; text-decoration: none; }
    .hdr h1     { margin: 0 0 1px; font-size: 17pt; font-weight: 900;
                  text-transform: uppercase; letter-spacing: 1.5px; color: #111; }
    .hdr .prof  { font-size: 8.5pt; color: #555; }
    /* ── sections ── */
    h2 { font-size: 8.5pt; font-weight: 900; text-transform: uppercase;
         letter-spacing: 1.4px; border-bottom: 1px solid #1e1e1e;
         margin: 9px 0 4px; padding-bottom: 1px;
         page-break-after: avoid; break-after: avoid; }
    .sec { margin-bottom: 7px; }
    /* ── items: title on its own line; company + date share a row ── */
    .item   { margin-bottom: 5px; page-break-inside: avoid; break-inside: avoid; }
    .ititle { font-weight: bold; font-size: 8.5pt; display: block; margin-bottom: 1px; }
    .irow   { display: table; width: 100%; margin-bottom: 2px; }
    .isub   { display: table-cell; font-style: italic; font-size: 8pt; color: #555; }
    .idate  { display: table-cell; white-space: nowrap; text-align: right;
              padding-left: 10px; font-size: 8pt; color: #555; }
    ul      { margin: 2px 0 0; padding-left: 12px; }
    li      { margin-bottom: 1px; font-size: 8.5pt; }
    p       { margin: 0 0 3px; font-size: 8.5pt; }
    /* ── 3-column skills ── */
    .sk     { list-style: none; padding: 0; margin: 0; column-count: 3; column-gap: 10px; }
    .sk li  { margin-bottom: 1px; font-size: 8pt; }
    .sk li::before { content: "• "; }
  `;

  const name    = esc(data.name || "Your Name");
  const prof    = data.experience?.[0]?.title ? esc(data.experience[0].title) : "";
  const contact = data.contact || {};
  const url     = getContactLinkUrl(contact);
  const cparts  = contactParts(contact, url, contact.link || contact.behance || "Portfolio");

  const expHtml = (data.experience || []).map(exp => `
    <div class="item">
      <span class="ititle">${esc(exp.title)}</span>
      <div class="irow">
        <span class="isub">${esc(exp.company)}</span>
        <span class="idate">${esc(exp.dates)}</span>
      </div>
      <ul>${(exp.details || []).map(d => `<li>${esc(d)}</li>`).join("")}</ul>
    </div>`).join("");

  const eduHtml = (data.education || []).map(edu => `
    <div class="item">
      <span class="ititle">${esc(edu.degree)}</span>
      <div class="irow">
        <span class="isub">${esc(edu.institution)}</span>
        <span class="idate">${esc(edu.dates)}</span>
      </div>
    </div>`).join("");

  const skHtml = (data.skills || []).length
    ? `<ul class="sk">${(data.skills || []).map(s => `<li>${esc(s)}</li>`).join("")}</ul>` : "";

  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>${css}</style></head><body>
  <div class="hdr">
    <div class="hdr-left">
      <h1>${name}</h1>
      ${prof ? `<div class="prof">${prof}</div>` : ""}
    </div>
    <div class="hdr-right">${cparts.join("<br>")}</div>
  </div>
  ${data.summary ? `<div class="sec"><h2>Summary</h2><p>${esc(data.summary)}</p></div>` : ""}
  ${(data.experience||[]).length ? `<div class="sec"><h2>Experience</h2>${expHtml}</div>` : ""}
  ${(data.education||[]).length  ? `<div class="sec"><h2>Education</h2>${eduHtml}</div>`  : ""}
  ${(data.skills||[]).length     ? `<div class="sec"><h2>Skills</h2>${skHtml}</div>`      : ""}
  </body></html>`;
};

// ─────────────────────────────────────────────────────────────────────────────
// Template: Executive  — strong navy typography, no background tricks
//
// No full-bleed or sidebar — plain @page margins like all other templates.
// The executive feel comes from the thick accent border, navy h2, and
// orange company name accent rather than background hacks.
// ─────────────────────────────────────────────────────────────────────────────
const createResumeHtml_Executive = (data, accentColor = "#ff8a2a") => {
  const ACCENT = accentColor;
  const css = `
    @page { size: A4; margin: 18mm 22mm 16mm; }
    * { box-sizing: border-box; }
    body { margin: 0; padding: 0; font-family: Arial, Helvetica, sans-serif;
           font-size: 9pt; line-height: 1.44; color: #1e1e2e; background: #fff; }
    /* ── header ── */
    .hdr { margin-bottom: 11px; padding-bottom: 9px;
           border-bottom: 3px solid #1b2a3b;
           page-break-inside: avoid; break-inside: avoid; }
    .hdr h1   { margin: 0 0 2px; font-size: 22pt; font-weight: 900;
                text-transform: uppercase; letter-spacing: 2px; color: #1b2a3b; }
    .hdr .prof { font-size: 10pt; color: ${ACCENT}; font-weight: 700;
                 text-transform: uppercase; letter-spacing: 0.8px; margin-bottom: 6px; }
    .hdr .cbar { font-size: 8.5pt; color: #555; }
    .hdr .cbar a { color: #555; text-decoration: none; }
    /* ── section headers ── */
    h2 { font-size: 9pt; font-weight: 900; text-transform: uppercase;
         letter-spacing: 1.5px; color: #1b2a3b;
         border-bottom: 2px solid #1b2a3b;
         margin: 13px 0 5px; padding-bottom: 2px;
         page-break-after: avoid; break-after: avoid; }
    .sec { margin-bottom: 10px; }
    /* ── items: title on its own line; company + date share a row ── */
    .item   { margin-bottom: 8px; page-break-inside: avoid; break-inside: avoid; }
    .ititle { font-weight: bold; font-size: 9.5pt; color: #1b2a3b;
              display: block; margin-bottom: 1px; }
    .irow   { display: table; width: 100%; margin-bottom: 3px; }
    .isub   { display: table-cell; font-style: italic; font-size: 9pt; color: ${ACCENT}; }
    .idate  { display: table-cell; white-space: nowrap; text-align: right;
              padding-left: 10px; font-size: 8.5pt; color: #666; }
    ul { margin: 3px 0 0; padding-left: 14px; }
    li { margin-bottom: 2px; font-size: 9pt; }
    p  { margin: 0 0 4px; font-size: 9pt; }
    /* ── skills 2-col with orange bullets ── */
    .sk     { list-style: none; padding: 0; margin: 0; column-count: 2; column-gap: 14px; }
    .sk li  { margin-bottom: 2px; font-size: 9pt; padding-left: 11px; position: relative; }
    .sk li::before { content: "›"; position: absolute; left: 0;
                     color: ${ACCENT}; font-weight: bold; font-size: 10pt; }
  `;

  const name    = esc(data.name || "Your Name");
  const prof    = data.experience?.[0]?.title ? esc(data.experience[0].title) : "";
  const contact = data.contact || {};
  const url     = getContactLinkUrl(contact);
  const cparts  = contactParts(contact, url, contact.link || contact.behance || "Portfolio");

  const expHtml = (data.experience || []).map(exp => `
    <div class="item">
      <span class="ititle">${esc(exp.title)}</span>
      <div class="irow">
        <span class="isub">${esc(exp.company)}</span>
        <span class="idate">${esc(exp.dates)}</span>
      </div>
      <ul>${(exp.details || []).map(d => `<li>${esc(d)}</li>`).join("")}</ul>
    </div>`).join("");

  const eduHtml = (data.education || []).map(edu => `
    <div class="item">
      <span class="ititle">${esc(edu.degree)}</span>
      <div class="irow">
        <span class="isub">${esc(edu.institution)}</span>
        <span class="idate">${esc(edu.dates)}</span>
      </div>
    </div>`).join("");

  const skHtml = (data.skills || []).length
    ? `<ul class="sk">${(data.skills || []).map(s => `<li>${esc(s)}</li>`).join("")}</ul>` : "";

  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>${css}</style></head><body>
  <div class="hdr">
    <h1>${name}</h1>
    ${prof ? `<div class="prof">${prof}</div>` : ""}
    <div class="cbar">${cparts.join(" &nbsp;|&nbsp; ")}</div>
  </div>
  ${data.summary    ? `<div class="sec"><h2>Summary</h2><p>${esc(data.summary)}</p></div>` : ""}
  ${(data.experience||[]).length ? `<div class="sec"><h2>Experience</h2>${expHtml}</div>` : ""}
  ${(data.education||[]).length  ? `<div class="sec"><h2>Education</h2>${eduHtml}</div>`  : ""}
  ${(data.skills||[]).length     ? `<div class="sec"><h2>Skills</h2>${skHtml}</div>`      : ""}
  </body></html>`;
};

// ─────────────────────────────────────────────────────────────────────────────
// Template: Blueprint  — editorial, h2 with extending rule, serif accent
// ─────────────────────────────────────────────────────────────────────────────
const createResumeHtml_Blueprint = (data) => {
  const css = `
    @page { size: A4; margin: 18mm 22mm 16mm; }
    * { box-sizing: border-box; }
    body { margin: 0; padding: 0; font-family: Arial, Helvetica, sans-serif;
           font-size: 9pt; line-height: 1.44; color: #222; background: #fff; }
    /* ── header ── */
    .hdr     { margin-bottom: 10px; border-bottom: 3px double #111; padding-bottom: 7px; }
    .hdr h1  { margin: 0 0 3px; font-size: 22pt; font-weight: 900;
               letter-spacing: 3px; text-transform: uppercase; color: #111; }
    .hdr .prof { font-size: 9.5pt; color: #555; margin-bottom: 5px; }
    .hdr .cbar { font-size: 8.5pt; color: #444; }
    .hdr .cbar a { color: #444; text-decoration: none; }
    /* ── section headers with extending rule ──
       Uses table layout: h2 text left, rule takes remaining width */
    h2 {
      display: table; width: 100%;
      font-size: 8.8pt; font-weight: 900; text-transform: uppercase;
      letter-spacing: 2px; color: #111;
      margin: 12px 0 5px; padding: 0;
      page-break-after: avoid; break-after: avoid;
    }
    h2::before { content: attr(data-label); display: table-cell;
                 white-space: nowrap; padding-right: 8px; }
    h2::after  { content: ""; display: table-cell; width: 100%;
                 border-bottom: 1.4px solid #111; vertical-align: middle; }
    /* ── items: title on its own line; company + date share a row ── */
    .sec  { margin-bottom: 9px; }
    .item { margin-bottom: 7px; page-break-inside: avoid; break-inside: avoid; }
    .ititle { font-weight: bold; font-size: 9.5pt; text-transform: uppercase;
              letter-spacing: 0.3px; display: block; margin-bottom: 1px; }
    .irow   { display: table; width: 100%; margin-bottom: 3px; }
    .isub   { display: table-cell; font-size: 9pt; color: #555; font-weight: 700; }
    .idate  { display: table-cell; white-space: nowrap; text-align: right;
              padding-left: 10px; font-size: 8.5pt; color: #444; font-weight: 700; }
    ul      { margin: 3px 0 0; padding-left: 13px; list-style-type: square; }
    li      { margin-bottom: 2px; font-size: 9pt; }
    p       { margin: 0 0 4px; font-size: 9pt; }
    /* ── skills 2-col ── */
    .sk     { list-style: none; padding: 0; margin: 0; column-count: 2; column-gap: 14px; }
    .sk li  { margin-bottom: 2px; font-size: 9pt; padding-left: 10px; position: relative; }
    .sk li::before { content: "▪"; position: absolute; left: 0; font-size: 7pt; top: 1px; }
  `;

  // Blueprint uses data-label attribute on h2 so ::before can read the section title
  const h2 = (label) => `<h2 data-label="${esc(label)}"></h2>`;

  const name    = esc(data.name || "Your Name");
  const prof    = data.experience?.[0]?.title ? esc(data.experience[0].title) : "";
  const contact = data.contact || {};
  const url     = getContactLinkUrl(contact);
  const cparts  = contactParts(contact, url, contact.link || contact.behance || "Portfolio");

  const expHtml = (data.experience || []).map(exp => `
    <div class="item">
      <span class="ititle">${esc(exp.title)}</span>
      <div class="irow">
        <span class="isub">${esc(exp.company)}</span>
        <span class="idate">${esc(exp.dates)}</span>
      </div>
      <ul>${(exp.details || []).map(d => `<li>${esc(d)}</li>`).join("")}</ul>
    </div>`).join("");

  const eduHtml = (data.education || []).map(edu => `
    <div class="item">
      <span class="ititle">${esc(edu.degree)}</span>
      <div class="irow">
        <span class="isub">${esc(edu.institution)}</span>
        <span class="idate">${esc(edu.dates)}</span>
      </div>
    </div>`).join("");

  const skHtml = (data.skills || []).length
    ? `<ul class="sk">${(data.skills || []).map(s => `<li>${esc(s)}</li>`).join("")}</ul>` : "";

  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>${css}</style></head><body>
  <div class="hdr">
    <h1>${name}</h1>
    ${prof ? `<div class="prof">${prof}</div>` : ""}
    <div class="cbar">${cparts.join(" &nbsp;·&nbsp; ")}</div>
  </div>
  ${data.summary ? `<div class="sec">${h2("Professional Profile")}<p>${esc(data.summary)}</p></div>` : ""}
  ${(data.experience||[]).length ? `<div class="sec">${h2("Work Experience")}${expHtml}</div>` : ""}
  ${(data.education||[]).length  ? `<div class="sec">${h2("Education")}${eduHtml}</div>`       : ""}
  ${(data.skills||[]).length     ? `<div class="sec">${h2("Skills")}${skHtml}</div>`           : ""}
  </body></html>`;
};

// Legacy/unused — kept for reference, not in switch
const createResumeHtml_Modern = (data) => {
  const styles = `
    @page { size: A4; margin: 15mm; }
    @import url('https://fonts.googleapis.com/css2?family=Lato:wght@300;400;700&display=swap');
    body { font-family: 'Lato', sans-serif; line-height: 1.3; color: #333; margin: 0; padding: 0; background-color: #fff; font-size: 9.5pt; } /* Base size 9pt -> 9.5pt */
    .page { width: 100%; margin: 0; box-sizing: border-box; background-color: #fff; }
    .header { padding: 18mm 20mm 0 20mm; }
    .resume-container { display: grid; grid-template-columns: minmax(0, 1.9fr) minmax(0, 1fr); gap: 18px; padding: 0 20mm; }
    .main-content { min-width: 0; }
    .sidebar { min-width: 0; margin-top: 0; padding-left: 12px; border-left: 1px solid #e0e0e0; }
    .experience-item, .education-item { page-break-inside: avoid; break-inside: avoid; }
    .section { page-break-inside: avoid; break-inside: avoid; }
    .header { page-break-inside: avoid; break-inside: avoid; }
    .sidebar h2 { page-break-inside: avoid; break-inside: avoid; }
    .header { text-align: center; margin-bottom: 12px; } /* Reduced margin */
    .header h1 { margin: 0 0 1px 0; font-size: 21pt; color: #000; font-weight: 700; text-transform: uppercase; letter-spacing: 1px; } /* Reduced size, margin, spacing */
    .profession-title { font-size: 10.5pt; color: #555; margin-bottom: 8px; font-weight: 400; text-transform: uppercase; letter-spacing: 0.5px; } /* Reduced size/margin */
    .sidebar h2 { font-size: 10.5pt; color: #000; border-bottom: 1px solid #555; padding-bottom: 1px; margin-top: 0; margin-bottom: 5px; font-weight: 700; text-transform: uppercase; } /* Reduced size, padding, margin */
    .sidebar .section { margin-bottom: 12px; } /* Reduced margin */
    .contact-info p { margin: 1px 0; font-size: 8.5pt; } /* Size 8pt -> 8.5pt */
    .contact-info a { color: #333; text-decoration: none; }
    .contact-info a:hover { text-decoration: underline; }
    .skills-list { list-style: none; padding: 0; margin: 0; }
    .skills-list li { margin-bottom: 2px; font-size: 8.5pt; } /* Size 8pt -> 8.5pt */
    .main-content h2 { font-size: 12pt; color: #000; border-bottom: 1px solid #555; padding-bottom: 2px; margin-top: 12px; margin-bottom: 8px; font-weight: 700; text-transform: uppercase; } /* Reduced size, padding, margins */
    .main-content .section:first-child h2 { margin-top: 0; }
    .experience-item, .education-item { margin-bottom: 10px; } /* Reduced margin */
    .item-header { display: flex; justify-content: space-between; margin-bottom: 0px; align-items: baseline; } /* Reduced margin */
    .item-header strong { font-weight: 700; font-size: 10pt; color: #000; } /* Reduced size */
    .item-header .dates { font-style: normal; color: #555; font-size: 8.5pt; } /* Size 8pt -> 8.5pt */
    .company, .institution { font-weight: 700; color: #333; margin-bottom: 2px; font-size: 9.5pt; display: block; } /* Size 9pt -> 9.5pt */
    ul { padding-left: 14px; margin-top: 2px; list-style-type: disc; } /* Reduced padding & margin */
    li { margin-bottom: 2px; color: #333; font-size: 9pt; } /* Size 8.5pt -> 9pt */
    p { margin-top: 0; margin-bottom: 4px; color: #333; } /* Reduced margin */
  `;
  const name = data.name || "Your Name";
  const profession = data.experience?.[0]?.title;
  const contact = data.contact || {
    email: "",
    phone: "",
    location: "",
    link: "",
    behance: "",
  };
  const summary = data.summary || "";
  const experience = data.experience || [];
  const education = data.education || [];
  const skills = data.skills || [];
  const contactLinkUrl = getContactLinkUrl(contact);
  const contactLinkText =
    contact.link || contact.behance || "Website/Portfolio";
  let contactHtml = '<div class="section contact-info"><h2>Contact</h2>';
  if (contact.email)
    contactHtml += `<p><a href="mailto:${contact.email}">${contact.email}</a></p>`;
  if (contact.phone) contactHtml += `<p>${contact.phone}</p>`;
  if (contact.location) contactHtml += `<p>${contact.location}</p>`;
  if (contactLinkUrl) {
    contactHtml += `<p><a href="${contactLinkUrl}" target="_blank">${contactLinkText}</a></p>`;
  }
  contactHtml += "</div>";
  const skillsHtml =
    skills.length > 0
      ? `<div class="section skills-section"><h2>Skills</h2><ul class="skills-list">${skills.map((skill) => `<li>${skill}</li>`).join("")}</ul></div>`
      : "";
  let experienceHtml = "";
  experience.forEach((exp) => {
    experienceHtml += `<div class="experience-item"><div class="item-header"><strong>${exp.title || "[Job Title]"}</strong>${exp.dates ? `<span class="dates">${exp.dates}</span>` : ""}</div><span class="company">${exp.company || "[Company]"}</span><ul>${(exp.details || []).map((d) => `<li>${d}</li>`).join("")}</ul></div>`;
  });
  let educationHtml = "";
  education.forEach((edu) => {
    educationHtml += `<div class="education-item"><div class="item-header"><strong>${edu.degree || "[Degree]"}</strong>${edu.dates ? `<span class="dates">${edu.dates}</span>` : ""}</div><span class="institution">${edu.institution || "[Institution]"}</span></div>`;
  });
  const summaryHtml = summary
    ? `<div class="section"><h2>Summary</h2><p>${summary}</p></div>`
    : "";
  const experienceSectionHtml =
    experience.length > 0
      ? `<div class="section"><h2>Experience</h2>${experienceHtml}</div>`
      : "";
  const educationSectionHtml =
    education.length > 0
      ? `<div class="section"><h2>Education</h2>${educationHtml}</div>`
      : "";
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${name} - Resume</title><style>${styles}</style></head><body><div class="page"><div class="header"><h1>${name}</h1>${profession ? `<div class="profession-title">${profession}</div>` : ""}</div><div class="resume-container"><div class="main-content">${summaryHtml}${experienceSectionHtml}${educationSectionHtml}</div><div class="sidebar">${contactHtml}${skillsHtml}</div></div></div></body></html>`;
};


// --- API Endpoints ---

// NEW: Endpoint to extract job title using AI
app.post("/api/extract-title", async (req, res) => {
  const { resumeText } = req.body;

  if (
    !resumeText ||
    typeof resumeText !== "string" ||
    resumeText.trim().length === 0
  ) {
    return res.status(400).json({ error: "Invalid or missing resumeText" });
  }

  const prompt = `Your task is to extract the single primary professional job title from the provided resume text. Follow these instructions carefully:
1. Focus on the area directly below the candidate's name, as this often contains the main title.
2. If multiple titles seem possible, choose the one that represents the candidate's main professional role (usually the most senior or most recent, if determinable from context near the top).
3. Do NOT extract section headers like "Summary", "Experience", "Skills", "Education", "Projects", "Languages".
4. Do NOT extract company names or university names.
5. Do NOT extract generic phrases or descriptions; identify the specific job title.
6. Format your response to contain ONLY the extracted job title text. Do not add any introductory phrases, explanations, labels, or markdown formatting.

Examples of correct output:
"Software Engineer"
"Senior Graphic Designer"
"Project Manager"
"3D Designer & Visualizer"
"Architect"
"Marketing Director"

Resume Text:
---
${resumeText}
---

Job Title:`;

  try {
    console.log("Calling DeepInfra API for title extraction...");
    const chatCompletion = await deepInfraChatCompletion({
      model: DEEPINFRA_MODEL,
      messages: [
        {
          role: "system",
          content:
            "You are a helpful assistant designed to extract specific information.",
        },
        { role: "user", content: prompt },
      ],
      temperature: 0.2,
      max_tokens: 50,
    });

    let extractedTitle =
      chatCompletion.choices[0]?.message?.content?.trim() || "";

    // Basic cleanup: remove potential quotes or leading/trailing punctuation sometimes added by AI
    extractedTitle = extractedTitle.replace(/^["'\s]+|["'\s\.]+$/g, "");

    res.json({ extractedTitle });
  } catch (error) {
    console.error("Error calling DeepInfra API for title extraction:", error);
    res
      .status(500)
      .json({ error: "Failed to extract title from resume using AI" });
  }
});

// Optimize Resume Endpoint (Returns JSON)
app.post("/api/optimize-resume", async (req, res) => {
  console.log("[/api/optimize-resume] Received request");
  const { resumeText, jobDescription, style = "Default" } = req.body;
  if (!resumeText || !jobDescription) {
    console.log("[/api/optimize-resume] Bad request: Missing data");
    return res
      .status(400)
      .json({ error: "Missing resumeText or jobDescription" });
  }
  console.log(`[/api/optimize-resume] Style received: ${style}`);
  console.log("[/api/optimize-resume] Starting optimization process...");
  try {
    console.log("[/api/optimize-resume] Constructing prompt...");

    // Define prompt components using simple strings
    const promptCore =
      "You are an expert resume optimizer. Given the following job description and resume text, rewrite the resume to maximize its fit for the job.\n" +
      "Focus on highlighting the skills and experiences from the original resume that are most relevant to the job description.\n" +
      "Rephrase responsibilities and skills to align with the requirements, but **DO NOT use the exact keywords or phrases directly from the job description.** Use synonyms and describe relevant experiences in a way that implicitly matches the job requirements.\n" +
      "**It is vital that the optimized resume demonstrates alignment through meaning and relevance, not by repeating the job description's specific terminology.**\n" +
      '**Throughout the entire resume (profession, summary, experience details, etc.), maintain professional, clear, and concise language. AVOID generic titles like "Specialist", overly emphatic or subjective adjectives (e.g., "outstanding", "world-class"), and unnecessarily complex vocabulary ("big words"). Focus on concrete actions and results.**\n' +
      "**Crucially, ensure the 'skills' list in the final JSON comprehensively includes the skills mentioned in the original resume.** First, list the skills that are present in BOTH the original resume AND are highly relevant to the job description. After those, list any other significant skills found in the original resume.";

    const promptJobTitleInstruction =
      "\n\n**Regarding the first job title (experience[0].title):** Optimize this title to align with the likely role sought in the job description, inferring from the responsibilities listed. **Crucially, use standard professional role names (e.g., 'Software Engineer', 'Graphic Designer', 'Project Manager') instead of generic terms like 'Specialist'. AVOID overly emphatic language or subjective emphasis.** Ensure the final title is professional, concise, and accurately reflects the core function described.";

    let styleInstruction = "";
    switch (style) {
      case "Concise":
        styleInstruction =
          "\nSTYLE INSTRUCTION: Make the summary and experience descriptions notably more concise and focused on key achievements.";
        break;
      case "Technical":
        styleInstruction =
          "\nSTYLE INSTRUCTION: Place a stronger emphasis on technical skills, tools, technologies, and quantifiable technical achievements mentioned in the experience.";
        break;
      case "Leadership":
        styleInstruction =
          "\nSTYLE INSTRUCTION: Highlight leadership qualities, team management, project coordination, strategic contributions, and soft skills evident in the experience.";
        break;
      // Default: No explicit style instruction
    }

    const datePreservationInstruction =
      "\n\n**ABSOLUTELY CRITICAL: You MUST preserve the exact dates (start/end ranges or graduation years) for all Experience and Education entries exactly as they appear in the original resume text. Do NOT modify, invent, reformat, or omit dates. Ensure each date string is associated with the correct corresponding experience or education entry in the final JSON.**";

    const jsonStructureInstruction =
      "\n\nRETURN THE OPTIMIZED RESUME AS A JSON OBJECT with the following structure:\n" +
      "{\n" +
      '  "name": "Full Name",\n' +
      '  "contact": { "email": "email@example.com", "phone": "123-456-7890", "location": "City, Country", "link": "https://yourportfolio.example.com" },\n' +
      '  "summary": "Professional summary tailored to the job description and selected style...",\n' +
      '  "experience": [ { "title": "Job Title (Use standard role names like Designer, Engineer, Analyst, Manager - avoid generic \'Specialist\')", "company": "Company Name", "dates": "Month Year - Month Year (PRESERVED EXACTLY)", "details": ["Rephrased responsibility relevant to JD", "Another rephrased detail aligned with JD"] }, { ... } ],\n' +
      '  "education": [ { "degree": "Degree Name", "institution": "University Name", "dates": "Year Graduated (PRESERVED EXACTLY)" }, { ... } ],\n' +
      '  "skills": ["Skill from original resume (ideally relevant to JD)", "Another skill from original resume", ... ]\n' +
      "}\n" +
      "ONLY return the JSON object, no other text before or after.";

    // Assemble the final prompt by concatenating strings
    const finalPrompt =
      "\n" +
      promptCore +
      promptJobTitleInstruction +
      styleInstruction +
      datePreservationInstruction +
      jsonStructureInstruction +
      "\n\nJob Description:\n```\n" +
      jobDescription +
      "\n```\n\n" +
      "Original Resume Text:\n```\n" +
      resumeText +
      "\n```\n\n" +
      "Optimized Resume JSON:\n    ";

    console.log(
      `[/api/optimize-resume] Sending prompt to DeepInfra with style: ${style}`,
    );
    // console.log("Full prompt:", finalPrompt); // Optional: uncomment to debug the exact prompt being sent
    const completion = await deepInfraChatCompletion({
      model: DEEPINFRA_MODEL,
      messages: [{ role: "user", content: finalPrompt }],
      temperature: 0.4,
      max_tokens: 4096,
    });
    console.log("[/api/optimize-resume] DeepInfra API call completed.");
    let optimizedResumeJson;
    try {
      console.log("[/api/optimize-resume] Parsing DeepInfra response...");
      optimizedResumeJson = JSON.parse(completion.choices[0].message.content);
      console.log(
        "[/api/optimize-resume] DeepInfra response parsed successfully.",
      );
    } catch (parseError) {
      console.error("Failed to parse DeepInfra JSON response (content omitted for privacy)");
      throw new Error("AI failed to return valid JSON structure.");
    }

    // *** ADD SANITIZATION STEP ***
    console.log("[/api/optimize-resume] Sanitizing JSON response...");
    const sanitizedJson = sanitizeResumeJson(optimizedResumeJson);
    console.log("[/api/optimize-resume] Sanitization complete.");

    res.json({ optimizedResumeJson: sanitizedJson }); // Send sanitized JSON
  } catch (error) {
    console.error("[/api/optimize-resume] Error during optimization:", error);
    res
      .status(500)
      .json({ error: `Failed to optimize resume: ${error.message}` });
  }
});

// Generate PDF Endpoint (Accepts JSON & templateName)
app.post("/api/generate-pdf", async (req, res) => {
  console.log("[/api/generate-pdf] Received request");
  const { resumeData, templateName = "classic", accentColor } = req.body;
  if (!resumeData) {
    console.log("[/api/generate-pdf] Bad request: Missing resumeData");
    return res
      .status(400)
      .json({ error: "Missing resume data for PDF generation." });
  }
  console.log(`[/api/generate-pdf] Using template: ${templateName}`);
  try {
    let htmlContent;
    switch (templateName.toLowerCase()) {
      case "classic":
        htmlContent = createResumeHtml_Classic(resumeData);
        break;
      case "creative":
        htmlContent = createResumeHtml_Creative(resumeData, accentColor);
        break;
      case "compact":
        htmlContent = createResumeHtml_Compact(resumeData);
        break;
      case "executive":
        htmlContent = createResumeHtml_Executive(resumeData, accentColor);
        break;
      case "blueprint":
        htmlContent = createResumeHtml_Blueprint(resumeData);
        break;
      default:
        htmlContent = createResumeHtml_Classic(resumeData);
        break;
    }
    console.log("[/api/generate-pdf] Launching Puppeteer...");
    const browser = await puppeteer.launch(getPuppeteerLaunchOptions());
    console.log("[/api/generate-pdf] Puppeteer launched. Creating new page...");
    const page = await browser.newPage();

    console.log("[/api/generate-pdf] Generating PDF with smart pagination...");
    const { pagination, pdfBuffer } = await createPdfBufferFromHtml(
      page,
      htmlContent,
    );

    console.log(
      "[/api/generate-pdf] Pagination result:",
      JSON.stringify({
        pages: pagination.finalMetrics.pages,
        scale: pagination.scale,
        balancedLastPage: pagination.balancedLastPage,
        lastPageUsage:
          (pagination.finalMetrics.lastPageUsage * 100).toFixed(1) + "%",
      }),
    );

    console.log("[/api/generate-pdf] Closing browser...");
    await browser.close();
    const pdfBase64String = Buffer.from(pdfBuffer).toString("base64");
    console.log("[/api/generate-pdf] Sending response to client...");
    res.json({ pdfBase64: pdfBase64String });
  } catch (error) {
    console.error("[/api/generate-pdf] Error during PDF generation:", error);
    res.status(500).json({ error: `Failed to generate PDF: ${error.message}` });
  }
});

// ─── Document Writer: AI Draft ───────────────────────────────────────────────
app.post("/draft-document", async (req, res) => {
  if (!validateApiKey()) return res.status(500).json({ error: "API key not configured" });

  const { docType, fields } = req.body;
  if (!docType || !fields) return res.status(400).json({ error: "Missing docType or fields" });

  const prompts = {
    coverLetter: `You are an expert cover letter writer. Write a professional cover letter for:
- Applicant: ${fields.yourName}
- Applying for: ${fields.jobTitle} at ${fields.companyName}
- Addressed to: ${fields.recipientName}${fields.recipientTitle ? ", " + fields.recipientTitle : ""}
- Background: ${fields.yourBackground}
- Why this role/company: ${fields.whyThisRole}
- Tone: ${fields.tone}

Return ONLY a JSON object with exactly two keys:
{ "subject": "Application for [Job Title] – [Name]", "body": "Full letter body here with paragraphs separated by \\n\\n. Do NOT include the address block or date — just the salutation through the sign-off." }`,

    formalBusiness: `You are an expert business letter writer. Write a formal business letter for:
- From: ${fields.yourName}
- To: ${fields.recipientName}${fields.recipientTitle ? ", " + fields.recipientTitle : ""} at ${fields.companyName}
- Purpose: ${fields.letterPurpose}
- Key points to cover: ${fields.keyMessage}
- Tone: ${fields.tone}

Return ONLY a JSON object:
{ "subject": "Re: [brief subject line]", "body": "Full letter body with paragraphs separated by \\n\\n. Start with Dear [name], end with Yours sincerely / Regards." }`,

    resignation: `You are an expert at writing professional resignation letters. Write a resignation letter for:
- From: ${fields.yourName}
- To: ${fields.recipientName}, ${fields.recipientTitle} at ${fields.companyName}
- Notice period: ${fields.noticePeriod}
- Last working day: ${fields.lastWorkingDay}
${fields.reasonForLeaving ? "- Reason: " + fields.reasonForLeaving : ""}
- Tone: ${fields.tone}

Return ONLY a JSON object:
{ "subject": "Resignation Letter – ${fields.yourName}", "body": "Full letter body with paragraphs separated by \\n\\n. Professional, gracious, brief. Start with Dear [name], end with a warm sign-off." }`,

    referenceRequest: `You are an expert professional writer. Write a polite reference request letter for:
- From: ${fields.yourName}
- Requesting reference from: ${fields.referenceName} (${fields.referenceRelationship})
- Purpose: ${fields.purposeOfReference}
${fields.keyMessage ? "- Key context: " + fields.keyMessage : ""}
- Tone: ${fields.tone}

Return ONLY a JSON object:
{ "subject": "Reference Request – ${fields.yourName}", "body": "Full letter body with paragraphs separated by \\n\\n. Polite, appreciative, concise. Start with Dear [name], end with a warm thank-you sign-off." }`,
  };

  const prompt = prompts[docType];
  if (!prompt) return res.status(400).json({ error: "Unknown document type" });

  try {
    const completion = await deepInfraChatCompletion({
      messages: [
        { role: "system", content: "You are a professional document writer. Always respond with valid JSON only — no markdown, no code fences, no extra text." },
        { role: "user", content: prompt },
      ],
      temperature: 0.6,
      max_tokens: 1500,
    });

    const raw = completion.choices[0].message.content.trim()
      .replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/i, "").trim();

    const draft = JSON.parse(raw);
    if (!draft.subject || !draft.body) throw new Error("Invalid draft structure");
    res.json(draft);
  } catch (err) {
    console.error("Draft document error (content omitted for privacy)");
    res.status(500).json({ error: "Failed to draft document" });
  }
});

// ─── Document Writer: Generate PDF ───────────────────────────────────────────
app.post("/generate-document-pdf", async (req, res) => {
  const { docType, fields, draft, template } = req.body;
  if (!fields || !draft) return res.status(400).json({ error: "Missing fields or draft" });

  const templates = {
    classic: {
      fontFamily: "'Georgia', 'Times New Roman', serif",
      headingColor: "#1a1a1a",
      accentColor: "#1a1a1a",
      borderStyle: "none",
      headerBg: "transparent",
    },
    modern: {
      fontFamily: "'Arial', 'Helvetica', sans-serif",
      headingColor: "#FF8428",
      accentColor: "#FF8428",
      borderStyle: "none",
      headerBg: "transparent",
    },
    corporate: {
      fontFamily: "'Arial', 'Helvetica', sans-serif",
      headingColor: "#1a1a1a",
      accentColor: "#1a1a1a",
      borderStyle: "2px solid #1a1a1a",
      headerBg: "transparent",
    },
  };

  const tmpl = templates[template] || templates.modern;

  // Build address block
  const senderLines = [
    fields.yourName,
    fields.yourAddress,
    fields.yourEmail,
    fields.yourPhone,
  ].filter(Boolean);

  const recipientLines = [
    fields.recipientName,
    fields.recipientTitle,
    fields.companyName,
    fields.companyAddress,
  ].filter(Boolean);

  // Convert body paragraphs to <p> tags
  const bodyHtml = draft.body
    .split(/\n\n+/)
    .map((p) => `<p>${p.replace(/\n/g, "<br>")}</p>`)
    .join("");

  const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: 210mm; }
  body {
    font-family: ${tmpl.fontFamily};
    font-size: 11pt;
    line-height: 1.7;
    color: #1a1a1a;
    padding: 20mm 22mm;
    background: white;
  }
  .sender-block { margin-bottom: 8mm; }
  .sender-block .name {
    font-size: 15pt;
    font-weight: bold;
    color: ${tmpl.headingColor};
    margin-bottom: 2mm;
    ${template === "corporate" ? "border-bottom: " + tmpl.borderStyle + "; padding-bottom: 3mm;" : ""}
  }
  .sender-block .contact { font-size: 9.5pt; color: #555; line-height: 1.6; }
  .date-line { margin: 6mm 0; font-size: 10.5pt; color: #444; }
  .recipient-block { margin-bottom: 7mm; font-size: 10.5pt; line-height: 1.6; }
  .subject-line {
    font-weight: bold;
    font-size: 11pt;
    margin-bottom: 6mm;
    color: ${tmpl.headingColor};
  }
  .body p {
    margin-bottom: 4mm;
    text-align: justify;
    font-size: 11pt;
  }
  .body p:last-child { margin-bottom: 0; }
  @media print {
    body { padding: 20mm 22mm; }
    p { page-break-inside: avoid; }
  }
</style>
</head>
<body>
  <div class="sender-block">
    <div class="name">${fields.yourName}</div>
    <div class="contact">${[fields.yourEmail, fields.yourPhone, fields.yourAddress].filter(Boolean).join(" &nbsp;·&nbsp; ")}</div>
  </div>

  <div class="date-line">${fields.date}</div>

  ${recipientLines.length > 0 ? `<div class="recipient-block">${recipientLines.join("<br>")}</div>` : ""}

  ${draft.subject ? `<div class="subject-line">${draft.subject}</div>` : ""}

  <div class="body">${bodyHtml}</div>
</body>
</html>`;

  try {
    const browser = await puppeteer.launch({ args: ["--no-sandbox", "--disable-setuid-sandbox"] });
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "networkidle0" });
    const pdfBuffer = await page.pdf({
      format: "A4",
      printBackground: true,
      margin: { top: "0", right: "0", bottom: "0", left: "0" },
    });
    await browser.close();

    res.set({ "Content-Type": "application/pdf", "Content-Disposition": "attachment; filename=document.pdf" });
    res.send(Buffer.from(pdfBuffer));
  } catch (err) {
    console.error("PDF generation error:", err.message);
    res.status(500).json({ error: "Failed to generate PDF" });
  }
});

// --- Server Listen ---
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
