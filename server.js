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
  process.env.DEEPINFRA_MODEL || "deepseek-ai/DeepSeek-V4-Flash";

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
}) => {
  if (typeof fetch === "undefined") {
    throw new Error("Global fetch is not available in this Node runtime.");
  }

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
    throw new Error(
      `DeepInfra API error ${response.status}: ${response.statusText} - ${errorBody}`,
    );
  }

  return response.json();
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

// --- TEMPLATE FUNCTIONS ---

// Template 1: Modern Multi-Column
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

// Template 2: Classic Single-Column
const createResumeHtml_Classic = (data) => {
  const styles = `
    @page { size: A4; margin: 15mm; }
    @import url('https://fonts.googleapis.com/css2?family=Times+New+Roman&display=swap');
    body { font-family: 'Times New Roman', serif; line-height: 1.3; color: #000; font-size: 10pt; } /* Size 9.5pt -> 10pt, line-height 1.2 -> 1.3 */
    .page { width: 100%; margin: 0; box-sizing: border-box; background-color: #fff; }
    .experience-item, .education-item { page-break-inside: avoid; break-inside: avoid; }
    .section { page-break-inside: avoid; break-inside: avoid; }
    h1 { text-align: center; margin: 0 0 1px 0; font-size: 15pt; font-weight: bold; text-transform: uppercase; } /* Reduced margin & font size */
    .profession-title { text-align: center; font-size: 10.5pt; color: #333; margin-bottom: 6px; font-weight: normal; } /* Reduced size/margin */
    .contact-info { text-align: center; margin-bottom: 10px; font-size: 9pt; } /* Size 8.5pt -> 9pt */
    .contact-info a { color: #000; text-decoration: none; margin: 0 1px; } /* Reduced spacing */
    .contact-info a:hover { text-decoration: underline; }
    h2 { font-size: 11pt; font-weight: bold; text-transform: uppercase; border-bottom: 1px solid #000; padding-bottom: 0px; margin: 10px 0 4px 0; } /* Reduced size, margins, padding */
    .section { margin-bottom: 8px; } /* Reduced margin */
    strong { font-weight: bold; }
    .item-header { margin-bottom: 0px; overflow: hidden; } /* Clear float, reduced margin */
    .item-header .title-company { display: inline; font-weight: bold; font-size: 10pt; } /* Size 9.5pt -> 10pt */
    .item-header .dates { float: right; font-size: 9pt; } /* Size 8.5pt -> 9pt */
    .company, .institution { display: block; font-style: italic; margin-bottom: 1px; font-size: 9.5pt; } /* Size 9pt -> 9.5pt */
    ul { padding-left: 14px; margin-top: 1px; list-style-type: disc; } /* Reduced padding & margin */
    li { margin-bottom: 1px; font-size: 9.5pt; } /* Size 9pt -> 9.5pt */
    p { margin: 2px 0; } /* Reduced margin */
    .skills-list { list-style: none; padding: 0; margin: 2px 0 0 0; column-count: 2; column-gap: 15px; } /* Reduced margin & gap, try 2 columns */
    .skills-list li { margin-bottom: 1px; font-size: 9pt; } /* Size 8.5pt -> 9pt */
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
  const contactUrl = getContactLinkUrl(contact);
  const contactText = contact.link || contact.behance || "Website/Portfolio";
  let contactHtml = "";
  if (contact.email)
    contactHtml += `<a href="mailto:${contact.email}">${contact.email}</a>`;
  if (contact.phone)
    contactHtml += contact.email ? ` | ${contact.phone}` : contact.phone;
  if (contact.location)
    contactHtml +=
      contact.email || contact.phone
        ? ` | ${contact.location}`
        : contact.location;
  if (contactUrl) {
    contactHtml +=
      contact.email || contact.phone || contact.location
        ? ` | <a href="${contactUrl}" target="_blank">${contactText}</a>`
        : `<a href="${contactUrl}" target="_blank">${contactText}</a>`;
  }
  let experienceHtml = "";
  experience.forEach((exp) => {
    experienceHtml += `<div class="experience-item"><div class="item-header"><span class="title-company">${exp.title || "[Job Title]"}</span>${exp.dates ? `<span class="dates">${exp.dates}</span>` : ""}</div><span class="company">${exp.company || "[Company]"}</span><ul>${(exp.details || []).map((d) => `<li>${d}</li>`).join("")}</ul></div>`;
  });
  let educationHtml = "";
  education.forEach((edu) => {
    educationHtml += `<div class="education-item"><div class="item-header"><span class="title-company">${edu.degree || "[Degree]"}</span>${edu.dates ? `<span class="dates">${edu.dates}</span>` : ""}</div><span class="institution">${edu.institution || "[Institution]"}</span></div>`;
  });
  const skillsHtml =
    skills.length > 0
      ? `<ul class="skills-list">${skills.map((skill) => `<li>${skill}</li>`).join("")}</ul>`
      : "";
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${name} - Resume</title><style>${styles}</style></head><body><div class="page"><h1>${name}</h1>${profession ? `<div class="profession-title">${profession}</div>` : ""}<div class="contact-info">${contactHtml}</div>${summary ? `<div class="section"><h2>Summary</h2><p>${summary}</p></div>` : ""}${experience.length > 0 ? `<div class="section"><h2>Experience</h2>${experienceHtml}</div>` : ""}${education.length > 0 ? `<div class="section"><h2>Education</h2>${educationHtml}</div>` : ""}${skills.length > 0 ? `<div class="section"><h2>Skills</h2>${skillsHtml}</div>` : ""}</div></body></html>`;
};

// Template 3: Modern Monochrome - tall, editorial single-column layout inspired by reference 1
const createResumeHtml_Compact = (data) => {
  const styles = `
    @page { size: A4; margin: 21mm 25mm 24mm; }
    body { margin: 0; padding: 0; background: #fff; color: #30343a; font-family: Arial, Helvetica, sans-serif; font-size: 9.4pt; line-height: 1.34; }
    .page { box-sizing: border-box; min-height: auto; }
    .header { margin-bottom: 14mm; }
    h1 { margin: 0; color: #2f3640; font-size: 26pt; line-height: 0.98; font-weight: 800; letter-spacing: 5px; text-transform: uppercase; }
    .profession-title { margin-top: 4mm; color: #9a9ca0; font-size: 8.2pt; font-weight: 700; letter-spacing: 3.5px; text-transform: uppercase; }
    h2 { margin: 8mm 0 3.2mm; color: #30343a; font-size: 11.2pt; font-weight: 900; letter-spacing: 2.3px; text-transform: uppercase; page-break-after: avoid; break-after: avoid; }
    .contact-info { color: #565b61; font-size: 8pt; }
    .contact-info a { color: #565b61; text-decoration: none; }
    .section { margin-bottom: 5.4mm; page-break-inside: avoid; break-inside: avoid; }
    p { margin: 0; color: #53585f; }
    .experience-item, .education-item { margin-bottom: 5.2mm; page-break-inside: avoid; break-inside: avoid; }
    .item-header { display: block; margin-bottom: 1mm; }
    .item-header strong { color: #30343a; font-size: 9.8pt; font-weight: 900; text-transform: uppercase; }
    .item-header .dates { color: #6f747b; font-size: 8.8pt; }
    .company, .institution { display: block; color: #565b61; font-size: 8.9pt; margin-bottom: 1.6mm; }
    ul { margin: 1.4mm 0 0 7mm; padding: 0; }
    li { margin-bottom: 0.8mm; padding-left: 1mm; color: #4f545a; }
    .skills-list { list-style: none; margin: 0; padding: 0; column-count: 2; column-gap: 10mm; }
    .skills-list li { margin: 0 0 1.2mm; padding: 0; color: #4f545a; }
  `;

  const name = data.name || "Your Name";
  const profession = data.experience?.[0]?.title || "Professional Title";
  const contact = data.contact || {};
  const summary = data.summary || "";
  const experience = data.experience || [];
  const education = data.education || [];
  const skills = data.skills || [];
  const contactUrl =
    typeof getContactLinkUrl === "function"
      ? getContactLinkUrl(contact)
      : contact.link || contact.behance || "";
  const contactText = contact.link || contact.behance || "Portfolio";
  const contactItems = [];
  if (contact.email)
    contactItems.push(`<a href="mailto:${contact.email}">${contact.email}</a>`);
  if (contact.phone) contactItems.push(`<span>${contact.phone}</span>`);
  if (contact.location) contactItems.push(`<span>${contact.location}</span>`);
  if (contactUrl)
    contactItems.push(
      `<a href="${contactUrl}" target="_blank">${contactText}</a>`,
    );

  const experienceHtml = experience
    .map(
      (exp) =>
        `<div class="experience-item"><div class="item-header"><strong>${exp.title || "Position Title"}</strong>${exp.dates ? `<span class="dates">, ${exp.dates}</span>` : ""}</div><span class="company">${exp.company || "Company, City"}</span><ul>${(exp.details || []).map((d) => `<li>${d}</li>`).join("")}</ul></div>`,
    )
    .join("");
  const educationHtml = education
    .map(
      (edu) =>
        `<div class="education-item"><div class="item-header"><strong>${edu.degree || "Degree"}</strong>${edu.dates ? `<span class="dates">, ${edu.dates}</span>` : ""}</div><span class="institution">${edu.institution || "Institution"}</span></div>`,
    )
    .join("");
  const skillsHtml = skills.length
    ? `<ul class="skills-list">${skills.map((skill) => `<li>${skill}</li>`).join("")}</ul>`
    : "";

  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${name} - Resume</title><style>${styles}</style></head><body><div class="page"><div class="header"><h1>${name}</h1>${profession ? `<div class="profession-title">${profession}</div>` : ""}</div>${contactItems.length ? `<div class="section"><h2>Contact</h2><div class="contact-info">${contactItems.join(" | ")}</div></div>` : ""}${summary ? `<div class="section"><h2>Summary</h2><p>${summary}</p></div>` : ""}${experience.length ? `<div class="section"><h2>Experience</h2>${experienceHtml}</div>` : ""}${education.length ? `<div class="section"><h2>Education</h2>${educationHtml}</div>` : ""}${skills.length ? `<div class="section"><h2>Skills</h2>${skillsHtml}</div>` : ""}</div></body></html>`;
};

// Template 4: Minimalist Designer - structured header, timeline rows, rules, and skill bars inspired by reference 2
const createResumeHtml_Executive = (data) => {
  const styles = `
    @page { size: A4; margin: 15mm 18mm 13mm; }
    body { margin: 0; padding: 0; background: #fff; color: #34383e; font-family: Arial, Helvetica, sans-serif; font-size: 8.8pt; line-height: 1.42; }
    .page { box-sizing: border-box; min-height: auto; }
    .top { display: grid; grid-template-columns: 1fr 54mm; gap: 10mm; align-items: start; margin-bottom: 8mm; }
    h1 { margin: 0; color: #2f3338; font-size: 24pt; line-height: 1.02; font-weight: 900; letter-spacing: 1px; text-transform: uppercase; }
    .profession-title { margin-top: 4mm; color: #3c4046; font-size: 9.2pt; font-weight: 700; letter-spacing: 0.9px; text-transform: uppercase; }
    .contact-info { color: #4f545a; font-size: 8pt; line-height: 1.65; }
    .contact-row { display: grid; grid-template-columns: 6mm 1fr; gap: 2mm; align-items: center; }
    .contact-icon { color: #222; font-size: 8.5pt; text-align: center; }
    .contact-info a { color: #4f545a; text-decoration: none; }
    .rule { position: relative; height: 1px; background: #bbb; margin: 0 0 4mm; }
    .rule::before { content: ''; position: absolute; left: 0; top: -1px; width: 12mm; height: 2px; background: #2d3035; }
    .section { margin-bottom: 5mm; page-break-inside: avoid; break-inside: avoid; }
    h2 { margin: 0 0 3mm; color: #2f3338; font-size: 12pt; font-weight: 900; letter-spacing: 2.8px; text-transform: uppercase; page-break-after: avoid; break-after: avoid; }
    p { margin: 0; color: #62676e; }
    .timeline-item { display: grid; grid-template-columns: 26mm 1fr; gap: 8mm; margin-bottom: 5.5mm; page-break-inside: avoid; break-inside: avoid; }
    .dates { color: #35393e; font-size: 8.4pt; font-weight: 800; }
    .item-title { color: #34383e; font-size: 9.3pt; font-weight: 900; letter-spacing: 0.7px; text-transform: uppercase; }
    .company, .institution { display: block; color: #4c5157; font-size: 8.4pt; font-weight: 700; margin: 0.4mm 0 1.4mm; }
    ul { margin: 1.4mm 0 0; padding-left: 4.2mm; color: #62676e; }
    li { margin-bottom: 0.8mm; }
    .bottom-grid { display: grid; grid-template-columns: 1.05fr 0.95fr; gap: 10mm; }
    .compact-item { display: grid; grid-template-columns: 24mm 1fr; gap: 8mm; margin-bottom: 4.2mm; page-break-inside: avoid; break-inside: avoid; }
    .skills-list { list-style: none; margin: 0; padding: 0; }
    .skills-list li { margin-bottom: 1.9mm; font-size: 8.8pt; }
  `;

  const name = data.name || "Your Name";
  const profession = data.experience?.[0]?.title || "Professional Title";
  const contact = data.contact || {};
  const summary = data.summary || "";
  const experience = data.experience || [];
  const education = data.education || [];
  const skills = data.skills || [];
  const contactUrl =
    typeof getContactLinkUrl === "function"
      ? getContactLinkUrl(contact)
      : contact.link || contact.behance || "";
  const contactText = contact.link || contact.behance || "yourdomainname.com";
  const contactRows = [];
  if (contact.phone)
    contactRows.push(
      `<div class="contact-row"><span class="contact-icon">☎</span><span>${contact.phone}</span></div>`,
    );
  if (contact.email)
    contactRows.push(
      `<div class="contact-row"><span class="contact-icon">✉</span><a href="mailto:${contact.email}">${contact.email}</a></div>`,
    );
  if (contactUrl)
    contactRows.push(
      `<div class="contact-row"><span class="contact-icon">↗</span><a href="${contactUrl}" target="_blank">${contactText}</a></div>`,
    );
  if (contact.location)
    contactRows.push(
      `<div class="contact-row"><span class="contact-icon">●</span><span>${contact.location}</span></div>`,
    );

  const experienceHtml = experience
    .map(
      (exp) =>
        `<div class="timeline-item"><div class="dates">${exp.dates || ""}</div><div><div class="item-title">${exp.title || "Job Title"}</div><span class="company">${exp.company || "Company Name Here"}</span><ul>${(exp.details || []).map((d) => `<li>${d}</li>`).join("")}</ul></div></div>`,
    )
    .join("");
  const educationHtml = education
    .map(
      (edu) =>
        `<div class="compact-item"><div class="dates">${edu.dates || ""}</div><div><div class="item-title">${edu.degree || "Degree"}</div><span class="institution">${edu.institution || "Institution"}</span></div></div>`,
    )
    .join("");
  const skillsHtml = skills.length
    ? `<ul class="skills-list">${skills.map((skill) => `<li>${skill}</li>`).join("")}</ul>`
    : "";

  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${name} - Resume</title><style>${styles}</style></head><body><div class="page"><div class="top"><div><h1>${name}</h1>${profession ? `<div class="profession-title">${profession}</div>` : ""}</div><div class="contact-info">${contactRows.join("")}</div></div><div class="rule"></div>${summary ? `<div class="section"><h2>About Me</h2><p>${summary}</p></div><div class="rule"></div>` : ""}${experience.length ? `<div class="section"><h2>Experience</h2>${experienceHtml}</div><div class="rule"></div>` : ""}<div class="bottom-grid">${education.length ? `<div class="section"><h2>Education</h2>${educationHtml}</div>` : ""}${skills.length ? `<div class="section"><h2>Expertise</h2>${skillsHtml}</div>` : ""}</div></div></body></html>`;
};

// Template 5: Editorial Classic - clean lined document layout inspired by reference 3
const createResumeHtml_Blueprint = (data) => {
  const styles = `
    @page { size: A4; margin: 15mm 16mm 14mm; }
    body { margin: 0; padding: 0; background: #fff; color: #23272b; font-family: Arial, Helvetica, sans-serif; font-size: 8.2pt; line-height: 1.38; }
    .page { box-sizing: border-box; min-height: auto; }
    .header { margin-bottom: 8mm; }
    h1 { margin: 0 0 1.5mm; color: #111; font-size: 17pt; line-height: 1; font-weight: 900; letter-spacing: 3.2px; text-transform: uppercase; }
    .contact-info { color: #4e5358; font-size: 8.2pt; }
    .contact-info a { color: #4e5358; text-decoration: none; }
    .section { margin-bottom: 8.2mm; page-break-inside: avoid; break-inside: avoid; }
    h2 { display: flex; align-items: center; gap: 4mm; margin: 0 0 4.2mm; color: #1f2327; font-size: 8.7pt; font-weight: 900; letter-spacing: 3px; text-transform: uppercase; page-break-after: avoid; break-after: avoid; }
    h2::after { content: ''; flex: 1; border-top: 1.4px solid #333; }
    p { margin: 0; color: #42474c; }
    .experience-item, .education-item { margin-bottom: 4mm; page-break-inside: avoid; break-inside: avoid; }
    .item-header { display: flex; justify-content: space-between; gap: 10mm; align-items: baseline; margin-bottom: 0.7mm; }
    .item-header strong { color: #1f2327; font-size: 8.8pt; font-weight: 900; text-transform: uppercase; }
    .dates { flex: 0 0 auto; color: #1f2327; font-size: 8pt; font-weight: 900; text-align: right; }
    .company, .institution { display: block; color: #252a2f; font-size: 8.2pt; font-weight: 800; margin-bottom: 1.6mm; }
    ul { margin: 1.2mm 0 0 4mm; padding: 0; color: #42474c; }
    li { margin-bottom: 1mm; padding-left: 1.2mm; }
    .skills-list { list-style: none; margin: 0; padding: 0; }
    .skills-list li { margin: 0 0 1.1mm; padding: 0; }
  `;

  const name = data.name || "Your Name";
  const contact = data.contact || {};
  const summary = data.summary || "";
  const experience = data.experience || [];
  const education = data.education || [];
  const skills = data.skills || [];
  const contactUrl =
    typeof getContactLinkUrl === "function"
      ? getContactLinkUrl(contact)
      : contact.link || contact.behance || "";
  const contactText = contact.link || contact.behance || "Portfolio";
  const contactItems = [];
  if (contact.location) contactItems.push(`<span>${contact.location}</span>`);
  if (contact.phone) contactItems.push(`<span>${contact.phone}</span>`);
  if (contact.email)
    contactItems.push(`<a href="mailto:${contact.email}">${contact.email}</a>`);
  if (contactUrl)
    contactItems.push(
      `<a href="${contactUrl}" target="_blank">${contactText}</a>`,
    );

  const experienceHtml = experience
    .map(
      (exp) =>
        `<div class="experience-item"><div class="item-header"><strong>${exp.title || "Job Title"}</strong>${exp.dates ? `<span class="dates">${exp.dates}</span>` : ""}</div><span class="company">${exp.company || "Company name (City, Country)"}</span><ul>${(exp.details || []).map((d) => `<li>${d}</li>`).join("")}</ul></div>`,
    )
    .join("");
  const educationHtml = education
    .map(
      (edu) =>
        `<div class="education-item"><div class="item-header"><strong>${edu.degree || "Degree"}</strong>${edu.dates ? `<span class="dates">${edu.dates}</span>` : ""}</div><span class="institution">${edu.institution || "Name of the institution or university"}</span></div>`,
    )
    .join("");
  const skillsHtml = skills.length
    ? `<ul class="skills-list">${skills.map((skill) => `<li><strong>${skill}</strong></li>`).join("")}</ul>`
    : "";

  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${name} - Resume</title><style>${styles}</style></head><body><div class="page"><div class="header"><h1>${name}</h1><div class="contact-info">${contactItems.join(" • ")}</div></div>${summary ? `<div class="section"><h2>Professional Profile</h2><p>${summary}</p></div>` : ""}${experience.length ? `<div class="section"><h2>Work Experience</h2>${experienceHtml}</div>` : ""}${education.length ? `<div class="section"><h2>Education</h2>${educationHtml}</div>` : ""}${skills.length ? `<div class="section"><h2>Skills</h2>${skillsHtml}</div>` : ""}</div></body></html>`;
};

// Template 4: Creative
const createResumeHtml_Creative = (data) => {
  const accentColor = "#4A90E2"; // Example accent color (a nice blue)
  const styles = `
    @page { size: A4; margin: 18mm; }
    @import url('https://fonts.googleapis.com/css2?family=Montserrat:wght@400;700&family=Roboto+Slab:wght@400;700&display=swap');
    body { font-family: 'Montserrat', sans-serif; line-height: 1.35; color: #333; font-size: 10pt; margin: 0; padding: 0; background-color: #fff; } /* Size 9.5pt -> 10pt */
    .page { width: 100%; margin: 0; box-sizing: border-box; background-color: #fff; } /* Full width for PDF */
    .header h1 { margin: 0; font-family: 'Roboto Slab', serif; font-size: 24pt; color: #111; font-weight: 700; }
    .profession-title { font-family: 'Roboto Slab', serif; font-size: 12pt; color: ${accentColor}; margin: 2px 0 8px 0; font-weight: 400; } /* Style for profession */
    .contact-line { font-size: 9.5pt; margin-top: 6px; color: #555; } /* Size 9pt -> 9.5pt */
    .contact-line a { color: ${accentColor}; text-decoration: none; }
    .contact-line a:hover { text-decoration: underline; }
    .contact-line .separator { margin: 0 6px; color: #ccc; }

    h2 { font-family: 'Roboto Slab', serif; font-size: 13pt; color: ${accentColor}; margin: 20px 0 8px 0; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; border-bottom: 1px solid #eee; padding-bottom: 3px; } /* Reduced size, margins, padding, letter-spacing */
    .section { margin-bottom: 15px; }
    .header { page-break-inside: avoid; break-inside: avoid; }

    .experience-item, .education-item { margin-bottom: 15px; padding-left: 12px; border-left: 2px solid ${accentColor}; } /* Reduced margin & padding */
    .item-header { margin-bottom: 2px; overflow: hidden; } /* Added overflow hidden for float */
    .item-header strong { font-weight: 700; font-size: 11pt; color: #222; display: inline; } /* Size 10.5pt -> 11pt */
    .item-header .dates { float: right; font-style: normal; color: #666; font-size: 9.5pt; font-weight: 400; } /* Size 9pt -> 9.5pt */
    .company, .institution { font-weight: 700; color: #555; margin-bottom: 4px; font-size: 10pt; display: block; font-style: italic; } /* Size 9.5pt -> 10pt */

    ul { padding-left: 15px; margin-top: 3px; list-style-type: none; /* Using custom bullets potentially */ } /* Reduced padding/margin */
    li { margin-bottom: 3px; position: relative; padding-left: 12px; font-size: 9.5pt; } /* Size 9pt -> 9.5pt */
    li::before { /* Custom bullet */
        content: '•';
        color: ${accentColor};
        font-weight: bold;
        display: inline-block;
        width: 1em;
        margin-left: -1em; /* Adjust spacing */
        position: absolute;
        left: 0;
        font-size: 9.5pt; /* Match li font size */
    }

    p { margin-top: 0; margin-bottom: 5px; } /* Reduced margin */

    .skills-section { margin-top: 15px; } /* Further reduced margin */
    .skills-list { list-style: none; padding: 0; margin: 6px 0 0 0; display: flex; flex-wrap: wrap; gap: 6px 12px; }
    .skills-list li { margin: 0; font-size: 9.5pt; padding: 3px 10px; background: #f0f4f8; border-radius: 4px; color: #333; }

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
  const contactUrl = getContactLinkUrl(contact);
  const contactText = contact.link || contact.behance || "Website/Portfolio";

  let contactItems = [];
  if (contact.email)
    contactItems.push(`<a href="mailto:${contact.email}">${contact.email}</a>`);
  if (contact.phone) contactItems.push(`<span>${contact.phone}</span>`);
  if (contact.location) contactItems.push(`<span>${contact.location}</span>`);
  if (contactUrl) {
    contactItems.push(
      `<a href="${contactUrl}" target="_blank">${contactText}</a>`,
    );
  }
  const contactHtml =
    contactItems.length > 0
      ? `<div class="contact-line">${contactItems.join('<span class="separator">|</span>')}</div>`
      : "";

  let experienceHtml = "";
  experience.forEach((exp) => {
    experienceHtml += `
          <div class="experience-item">
              <div class="item-header">
                  ${exp.dates ? `<span class="dates">${exp.dates}</span>` : ""}
                  <strong>${exp.title || "[Job Title]"}</strong>
              </div>
              <span class="company">${exp.company || "[Company]"}</span>
              <ul>${(exp.details || []).map((d) => `<li>${d}</li>`).join("")}</ul>
          </div>
      `;
  });

  let educationHtml = "";
  education.forEach((edu) => {
    educationHtml += `
          <div class="education-item">
              <div class="item-header">
                  ${edu.dates ? `<span class="dates">${edu.dates}</span>` : ""}
                  <strong>${edu.degree || "[Degree]"}</strong>
              </div>
              <span class="institution">${edu.institution || "[Institution]"}</span>
          </div>
      `;
  });

  const skillsHtml =
    skills.length > 0
      ? `<ul class="skills-list">${skills.map((skill) => `<li>${skill}</li>`).join("")}</ul>`
      : "";

  const summaryHtml = summary
    ? `<div class="section"><h2>Profile</h2><p>${summary}</p></div>`
    : "";
  const experienceSectionHtml =
    experience.length > 0
      ? `<div class="section"><h2>Experience</h2>${experienceHtml}</div>`
      : "";
  const educationSectionHtml =
    education.length > 0
      ? `<div class="section"><h2>Education</h2>${educationHtml}</div>`
      : "";
  const skillsSectionHtml =
    skills.length > 0
      ? `<div class="section skills-section"><h2>Skills</h2>${skillsHtml}</div>`
      : "";

  return `
    <!DOCTYPE html>
    <html>
    <head>
        <meta charset="UTF-8">
        <title>${name} - Resume</title>
        <style>${styles}</style>
    </head>
    <body>
        <div class="page">
            <div class="header">
                <h1>${name}</h1>
                ${profession ? `<div class="profession-title">${profession}</div>` : ""}
                ${contactHtml}
            </div>
            ${summaryHtml}
            ${experienceSectionHtml}
            ${educationSectionHtml}
            ${skillsSectionHtml}
        </div>
    </body>
    </html>
  `;
};

// Template 5: Gradient Modern
const createResumeHtml_GradientModern = (data) => {
  // Example Gradient: Teal to Blue
  const gradient = "linear-gradient(135deg, #16a085 0%, #2980b9 100%)";
  const styles = `
    @page { size: A4; margin: 12mm; }
    @import url('https://fonts.googleapis.com/css2?family=Roboto:wght@300;400;700&display=swap');
    body { font-family: 'Roboto', sans-serif; line-height: 1.35; color: #444; font-size: 9.5pt; margin: 0; padding: 0; background-color: #fff; } /* Size 9pt -> 9.5pt, line-height 1.3 -> 1.35 */
    .page { width: 100%; margin: 0; box-sizing: border-box; background-color: #fff; position: relative; overflow: hidden; }
    .experience-item, .education-item { page-break-inside: avoid; break-inside: avoid; }
    .section { page-break-inside: avoid; break-inside: avoid; }
    .header { page-break-inside: avoid; break-inside: avoid; background: ${gradient}; color: #fff; padding: 15mm 0 10mm 0; text-align: left; } /* Full-width gradient bar */
    .header-inner { padding: 0 20mm; display: grid; grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr); gap: 18px; align-items: start; }
    .header-left { min-width: 0; }
    .header-right { min-width: 0; }
    .header h1 { margin: 0 0 2px 0; font-size: 22pt; font-weight: 700; letter-spacing: 0.5px; } /* Reduced size/spacing */
    .profession-title { font-size: 11pt; font-weight: 300; margin-bottom: 10px; opacity: 0.9; } /* Reduced size/margin */
    .contact-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 3px 12px; font-size: 9pt; margin-top: 8px; } /* Size 8.5pt -> 9pt */
    .contact-grid a { color: #fff; text-decoration: none; }
    .contact-grid a:hover { text-decoration: underline; }
    .contact-grid span { display: inline-block; min-width: 45px; font-weight: 700; opacity: 0.8; } /* Reduced min-width */
    .content-area { padding: 12mm 18mm; display: block; } /* Reduced padding */
    h2 { font-size: 13pt; color: #2980b9; border-bottom: 1px solid #e8e8e8; padding-bottom: 3px; margin: 15px 0 10px 0; font-weight: 700; text-transform: uppercase; } /* Reduced size/margins */
    .section { margin-bottom: 15px; } /* Reduced margin */
    .experience-item, .education-item { margin-bottom: 12px; padding-left: 12px; border-left: 2px solid #16a085; } /* Reduced margin/padding/border */
    .item-header { margin-bottom: 2px; overflow: hidden; }
    .item-header strong { font-weight: 700; font-size: 10pt; color: #333; } /* Reduced size */
    .item-header .dates { float: right; font-style: normal; color: #666; font-size: 9pt; } /* Size 8.5pt -> 9pt */
    .company, .institution { font-weight: 700; color: #555; margin-bottom: 3px; font-size: 9.5pt; display: block; } /* Reduced size/margin */
    ul { padding-left: 15px; margin: 3px 0 0 0; list-style-type: disc; } /* Reduced padding/margin */
    li { margin-bottom: 3px; font-size: 9.5pt; } /* Size 9pt -> 9.5pt */
    p { margin: 0 0 6px 0; } /* Reduced margin */
    .skills-section h2 { margin-top: 18px; } /* Reduced margin */
    .skills-list { list-style: none; padding: 0; margin: 8px 0 0 0; column-count: 3; column-gap: 20px; } /* Reduced margin/gap */
    .skills-list li { margin-bottom: 4px; font-size: 9.5pt; } /* Size 9pt -> 9.5pt */
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
  const contactUrl = getContactLinkUrl(contact);
  const contactText = contact.link || contact.behance || "Website/Portfolio";

  let contactDetailsHtml = '<div class="contact-grid">';
  if (contact.email)
    contactDetailsHtml += `<div><span>Email:</span> <a href="mailto:${contact.email}">${contact.email}</a></div>`;
  if (contact.phone)
    contactDetailsHtml += `<div><span>Phone:</span> ${contact.phone}</div>`;
  if (contact.location)
    contactDetailsHtml += `<div><span>Location:</span> ${contact.location}</div>`;
  if (contactUrl) {
    contactDetailsHtml += `<div><span>Website/Portfolio:</span> <a href="${contactUrl}" target="_blank">${contactText}</a></div>`;
  }
  contactDetailsHtml += "</div>";

  let experienceHtml = "";
  experience.forEach((exp) => {
    experienceHtml += `<div class="experience-item"><div class="item-header"><span class="dates">${exp.dates || ""}</span><strong>${exp.title || ""}</strong></div><span class="company">${exp.company || ""}</span><ul>${(exp.details || []).map((d) => `<li>${d}</li>`).join("")}</ul></div>`;
  });
  let educationHtml = "";
  education.forEach((edu) => {
    educationHtml += `<div class="education-item"><div class="item-header"><span class="dates">${edu.dates || ""}</span><strong>${edu.degree || ""}</strong></div><span class="institution">${edu.institution || ""}</span></div>`;
  });
  const skillsHtml =
    skills.length > 0
      ? `<ul class="skills-list">${skills.map((skill) => `<li>${skill}</li>`).join("")}</ul>`
      : "";

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
  const skillsSectionHtml =
    skills.length > 0
      ? `<div class="section skills-section"><h2>Skills</h2>${skillsHtml}</div>`
      : "";

  return `
    <!DOCTYPE html><html><head><meta charset="UTF-8"><title>${name} - Resume</title><style>${styles}</style></head><body><div class="page">
      <div class="header"><div class="header-inner">
        <div class="header-left">
          <h1>${name}</h1>
          ${profession ? `<div class="profession-title">${profession}</div>` : ""}
          ${contactDetailsHtml}
        </div>
        <div class="header-right">
          ${skillsHtml}
        </div>
      </div></div>
      <div class="content-area">
        ${summaryHtml}
        ${experienceSectionHtml}
        ${educationSectionHtml}
      </div>
    </div></body></html>
  `;
};

// Template 6: Gradient Creative
const createResumeHtml_GradientCreative = (data) => {
  // Example Gradient: Purple to Pink
  const gradient = "linear-gradient(135deg, #8e44ad 0%, #c0392b 100%)";
  const accentColor = "#c0392b"; // Use end gradient color as accent
  const styles = `
    @import url('https://fonts.googleapis.com/css2?family=Poppins:wght@300;400;600;700&display=swap');
    body { font-family: 'Poppins', sans-serif; line-height: 1.45; color: #333; font-size: 10pt; margin: 0; padding: 0; background-color: #fff; } /* Size 9.5pt -> 10pt */
    @page { size: A4; margin: 18mm; }
    .page { width: 100%; margin: 0; box-sizing: border-box; background-color: #fff; }
    .layout { display: block; }
    .sidebar { background: ${gradient}; color: #fff; width: 100%; padding: 18mm 20mm; display: block; }
    .main-content { width: 100%; padding: 18mm 20mm; display: block; }
    .sidebar h1 { font-size: 22pt; margin: 0 0 2px 0; font-weight: 700; page-break-inside: avoid; break-inside: avoid; }
    .sidebar .profession-title { font-size: 12pt; font-weight: 300; margin-bottom: 20px; opacity: 0.9; }
    .sidebar h2 { font-size: 11pt; font-weight: 600; text-transform: uppercase; border-bottom: 1px solid rgba(255,255,255,0.3); padding-bottom: 4px; margin: 20px 0 10px 0; page-break-inside: avoid; break-inside: avoid; }
    .contact-info { page-break-inside: avoid; break-inside: avoid; }
    .contact-info p { margin: 4px 0; font-size: 9.5pt; } /* Size 9pt -> 9.5pt */
    .contact-info a { color: #fff; text-decoration: none; page-break-inside: avoid; break-inside: avoid; }
    .contact-info a:hover { text-decoration: underline; }
    .skills-list { list-style: none; padding: 0; margin: 8px 0 0 0; page-break-inside: avoid; break-inside: avoid; }
    .skills-list li { margin-bottom: 4px; font-size: 9.5pt; } /* Size 9pt -> 9.5pt */
    .main-content h2 { font-size: 14pt; color: ${accentColor}; border-bottom: 2px solid #eee; padding-bottom: 3px; margin: 0 0 12px 0; font-weight: 700; text-transform: uppercase; }
    .main-content .section:not(:first-child) h2 { margin-top: 20px; }
    .section { margin-bottom: 18px; page-break-inside: avoid; break-inside: avoid; }
    .experience-item, .education-item { margin-bottom: 15px; page-break-inside: avoid; break-inside: avoid; }
    .item-header { margin-bottom: 2px; overflow: hidden; }
    .item-header strong { font-weight: 600; font-size: 10.5pt; color: #111; }
    .item-header .dates { float: right; font-style: normal; color: #555; font-size: 9.5pt; } /* Size 9pt -> 9.5pt */
    .company, .institution { font-weight: 600; color: #444; margin-bottom: 4px; font-size: 10pt; display: block; }
    ul { padding-left: 18px; margin: 4px 0 0 0; list-style-type: none; page-break-inside: avoid; break-inside: avoid; }
    li { margin-bottom: 4px; position: relative; padding-left: 15px; font-size: 9.5pt; page-break-inside: avoid; break-inside: avoid; } /* Size 9pt -> 9.5pt */
    li::before { content: '•'; color: ${accentColor}; position: absolute; left: 0; font-weight: bold; font-size: 9.5pt; /* Match li size */ }
    p { margin: 0 0 8px 0; page-break-inside: avoid; break-inside: avoid; }
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
  const contactUrl = getContactLinkUrl(contact);
  const contactText = contact.link || contact.behance || "Website/Portfolio";

  let contactHtml = '<div class="section contact-info"><h2>Contact</h2>';
  if (contact.email)
    contactHtml += `<p><a href="mailto:${contact.email}">${contact.email}</a></p>`;
  if (contact.phone) contactHtml += `<p>${contact.phone}</p>`;
  if (contact.location) contactHtml += `<p>${contact.location}</p>`;
  if (contactUrl) {
    contactHtml += `<p><a href="${contactUrl}" target="_blank">${contactText}</a></p>`;
  }
  contactHtml += "</div>";

  const skillsHtml =
    skills.length > 0
      ? `<div class="section skills-section"><h2>Skills</h2><ul class="skills-list">${skills.map((skill) => `<li>${skill}</li>`).join("")}</ul></div>`
      : "";

  let experienceHtml = "";
  experience.forEach((exp) => {
    experienceHtml += `<div class="experience-item"><div class="item-header"><span class="dates">${exp.dates || ""}</span><strong>${exp.title || ""}</strong></div><span class="company">${exp.company || ""}</span><ul>${(exp.details || []).map((d) => `<li>${d}</li>`).join("")}</ul></div>`;
  });
  let educationHtml = "";
  education.forEach((edu) => {
    educationHtml += `<div class="education-item"><div class="item-header"><span class="dates">${edu.dates || ""}</span><strong>${edu.degree || ""}</strong></div><span class="institution">${edu.institution || ""}</span></div>`;
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

  return `
    <!DOCTYPE html><html><head><meta charset="UTF-8"><title>${name} - Resume</title><style>${styles}</style></head><body><div class="page"><div class="layout">
      <div class="sidebar">
          <h1>${name}</h1>
          ${profession ? `<div class="profession-title">${profession}</div>` : ""}
          ${contactHtml}
          ${skillsHtml}
      </div>
      <div class="main-content">
        ${summaryHtml}
        ${experienceSectionHtml}
        ${educationSectionHtml}
      </div>
    </div></div></body></html>
  `;
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
    console.log("DeepInfra API response for title:", extractedTitle);

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
      console.error(
        "Failed to parse DeepInfra JSON response:",
        completion.choices[0].message.content,
      );
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
  const { resumeData, templateName = "classic" } = req.body;
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
        htmlContent = createResumeHtml_Creative(resumeData);
        break;
      case "compact":
        htmlContent = createResumeHtml_Compact(resumeData);
        break;
      case "executive":
        htmlContent = createResumeHtml_Executive(resumeData);
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

// --- Server Listen ---
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
