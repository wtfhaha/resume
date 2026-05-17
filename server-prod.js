const fs = require("fs");
const express = require("express");
const cors = require("cors");
const puppeteer = require("puppeteer");
const pdfParse = require("pdf-parse");
require("dotenv").config({ path: ".env.production" });

const DEEPINFRA_API_URL =
  process.env.DEEPINFRA_API_URL || "https://api.deepinfra.com/v1/openai";
const DEEPINFRA_API_KEY = process.env.DEEPINFRA_API_KEY;
const DEEPINFRA_MODEL =
  process.env.DEEPINFRA_MODEL || "deepseek-ai/DeepSeek-V4-Flash";

const app = express();
const PORT = process.env.PORT || 5001;

// Middleware
app.use(
  cors({
    origin:
      process.env.NODE_ENV === "production"
        ? [
            "https://my-aitools.online",
            "https://www.my-aitools.online",
            process.env.FRONTEND_URL, // Allow setting via environment variable
          ].filter(Boolean)
        : ["http://localhost:3000"],
    credentials: true,
  }),
);

app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

// Helper function to validate API key
const validateApiKey = () => {
  if (
    !DEEPINFRA_API_KEY ||
    DEEPINFRA_API_KEY === "YOUR_DEEPINFRA_API_KEY_HERE"
  ) {
    console.error("ERROR: DEEPINFRA_API_KEY is not configured properly");
    console.error(
      "Please set your actual DeepInfra API key in server/.env.production or environment variables",
    );
    return false;
  }
  return true;
};

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
      "--disable-gpu",
      "--single-process",
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

// API Routes
app.post("/api/optimize-resume", async (req, res) => {
  if (!validateApiKey()) {
    return res
      .status(500)
      .json({ error: "Server configuration error: API key not properly set" });
  }

  const { resumeText, jobDescription, style = "Default" } = req.body;

  if (!resumeText || !jobDescription) {
    return res
      .status(400)
      .json({ error: "Resume text and job description are required" });
  }

  try {
    const optimizationPrompt = `Optimize the following resume for the target job description. Return the result as a structured JSON object with the following format:
{
  "name": "Full Name",
  "contact": {
    "email": "email@example.com",
    "phone": "+1-555-123-4567",
    "location": "City, State",
    "link": "https://yourportfolio.example.com"
  },
  "summary": "Professional summary optimized for the target role",
  "experience": [
    {
      "title": "Job Title",
      "company": "Company Name",
      "dates": "Start Date - End Date",
      "details": ["Achievement 1", "Achievement 2", "Achievement 3"]
    }
  ],
  "education": [
    {
      "degree": "Degree Name",
      "institution": "Institution Name",
      "dates": "Year"
    }
  ],
  "skills": ["Skill 1", "Skill 2", "Skill 3"]
}

Style: ${style}

Resume Text:
${resumeText}

Job Description:
${jobDescription}`;

    const chatCompletion = await deepInfraChatCompletion({
      model: DEEPINFRA_MODEL,
      messages: [
        {
          role: "user",
          content: optimizationPrompt,
        },
      ],
      temperature: 0.7,
      max_tokens: 4000,
    });

    const response = chatCompletion.choices[0]?.message?.content;
    if (!response) {
      return res
        .status(500)
        .json({ error: "Failed to generate optimized resume" });
    }

    let optimizedResumeJson;
    try {
      optimizedResumeJson = JSON.parse(response);
    } catch (parseError) {
      console.error("Failed to parse AI response:", parseError.message);
      return res
        .status(500)
        .json({ error: "Failed to parse optimized resume data" });
    }

    res.json({ optimizedResumeJson });
  } catch (error) {
    console.error("Resume optimization error:", error.message);
    res.status(500).json({ error: "Failed to optimize resume" });
  }
});

app.post("/api/extract-title", async (req, res) => {
  if (!validateApiKey()) {
    return res
      .status(500)
      .json({ error: "Server configuration error: API key not properly set" });
  }

  const { resumeText } = req.body;

  if (!resumeText || resumeText.trim().length < 50) {
    return res.json({ extractedTitle: "" });
  }

  try {
    const titlePrompt = `Extract the primary job title or profession from this resume. Return ONLY the job title, no other text. If multiple roles exist, return the most recent or prominent one.

Resume:
${resumeText}`;

    const chatCompletion = await deepInfraChatCompletion({
      model: DEEPINFRA_MODEL,
      messages: [
        {
          role: "user",
          content: titlePrompt,
        },
      ],
      temperature: 0.3,
      max_tokens: 100,
    });

    const response = chatCompletion.choices[0]?.message?.content?.trim();
    res.json({ extractedTitle: response || "" });
  } catch (error) {
    console.error("Title extraction error:", error.message);
    res.status(500).json({ error: "Failed to extract job title" });
  }
});

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

app.post("/api/generate-pdf", async (req, res) => {
  if (!validateApiKey()) {
    return res
      .status(500)
      .json({ error: "Server configuration error: API key not properly set" });
  }

  const { resumeData, templateName = "modern" } = req.body;

  if (!resumeData) {
    return res.status(400).json({ error: "Resume data is required" });
  }

  try {
    const browser = await puppeteer.launch(getPuppeteerLaunchOptions());
    const page = await browser.newPage();
    const htmlContent = generateResumeHTML(resumeData, templateName);

    const { pagination, pdfBuffer } = await createPdfBufferFromHtml(
      page,
      htmlContent,
    );

    console.log(
      "PDF pagination:",
      JSON.stringify({
        pages: pagination.finalMetrics.pages,
        scale: pagination.scale,
        balancedLastPage: pagination.balancedLastPage,
        lastPageUsage:
          (pagination.finalMetrics.lastPageUsage * 100).toFixed(1) + "%",
      }),
    );

    await browser.close();
    const pdfBase64 = pdfBuffer.toString("base64");
    res.json({ pdfBase64 });
  } catch (error) {
    console.error("PDF generation error:", error.message);
    res.status(500).json({ error: "Failed to generate PDF" });
  }
});

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
  const contactUrl = getContactLinkUrl(contact);
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
  const contactUrl = getContactLinkUrl(contact);
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
        `<div class="timeline-item"><div class="dates">${exp.dates || "Dates"}</div><div><div class="item-title">${exp.title || "Job Title"}</div><span class="company">${exp.company || "Company Name Here"}</span><ul>${(exp.details || []).map((d) => `<li>${d}</li>`).join("")}</ul></div></div>`,
    )
    .join("");
  const educationHtml = education
    .map(
      (edu) =>
        `<div class="compact-item"><div class="dates">${edu.dates || "Year"}</div><div><div class="item-title">${edu.degree || "Degree"}</div><span class="institution">${edu.institution || "Institution"}</span></div></div>`,
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
  const contactUrl = getContactLinkUrl(contact);
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
        `<div class="experience-item"><div class="item-header"><strong>${exp.title || "Job Title"}</strong><span class="dates">${exp.dates || "mm/yyyy – mm/yyyy"}</span></div><span class="company">${exp.company || "Company name (City, Country)"}</span><ul>${(exp.details || []).map((d) => `<li>${d}</li>`).join("")}</ul></div>`,
    )
    .join("");
  const educationHtml = education
    .map(
      (edu) =>
        `<div class="education-item"><div class="item-header"><strong>${edu.degree || "Degree"}</strong><span class="dates">${edu.dates || "mm/yyyy – mm/yyyy"}</span></div><span class="institution">${edu.institution || "Name of the institution or university"}</span></div>`,
    )
    .join("");
  const skillsHtml = skills.length
    ? `<ul class="skills-list">${skills.map((skill) => `<li><strong>${skill}</strong></li>`).join("")}</ul>`
    : "";

  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${name} - Resume</title><style>${styles}</style></head><body><div class="page"><div class="header"><h1>${name}</h1><div class="contact-info">${contactItems.join(" • ")}</div></div>${summary ? `<div class="section"><h2>Professional Profile</h2><p>${summary}</p></div>` : ""}${experience.length ? `<div class="section"><h2>Work Experience</h2>${experienceHtml}</div>` : ""}${education.length ? `<div class="section"><h2>Education</h2>${educationHtml}</div>` : ""}${skills.length ? `<div class="section"><h2>Skills</h2>${skillsHtml}</div>` : ""}</div></body></html>`;
};

// PDF Generation Functions
function generateResumeHTML(data, template) {
  const selectedTemplate = (template || "classic").toLowerCase();
  if (selectedTemplate === "compact") return createResumeHtml_Compact(data);
  if (selectedTemplate === "executive") return createResumeHtml_Executive(data);
  if (selectedTemplate === "blueprint") return createResumeHtml_Blueprint(data);
  const contact = data.contact || {};
  const profession = data.experience?.[0]?.title || "";
  const contactItems = [
    contact.email,
    contact.phone,
    contact.location,
    contact.link,
  ]
    .filter(Boolean)
    .map((item) => `<span>${item}</span>`);

  const templateStyles = {
    classic: {
      accent: "#111",
      font: "'Times New Roman', Times, serif",
      nameStyle: "text-align:center;text-transform:uppercase;font-size:20pt;",
      headingStyle: "border-bottom:1px solid #111;color:#111;",
      itemStyle: "",
      skillStyle: "background:#f4f4f4;color:#111;border:1px solid #ddd;",
    },
    creative: {
      accent: "#4A90E2",
      font: "Arial, Helvetica, sans-serif",
      nameStyle:
        "font-family:Georgia, 'Times New Roman', serif;font-size:26pt;",
      headingStyle: "border-bottom:1px solid #e8e8e8;color:#4A90E2;",
      itemStyle: "padding-left:10px;border-left:2px solid #4A90E2;",
      skillStyle: "background:#eef5ff;color:#245b9f;border:1px solid #d7e8ff;",
    },
    compact: {
      accent: "#222",
      font: "Arial, Helvetica, sans-serif",
      nameStyle: "text-align:center;text-transform:uppercase;font-size:18pt;",
      headingStyle: "border-top:1px solid #222;color:#222;padding-top:3px;",
      itemStyle: "",
      skillStyle: "background:#f5f5f5;color:#111;border:1px solid #e1e1e1;",
    },
    executive: {
      accent: "#1f2a44",
      font: "Georgia, 'Times New Roman', serif",
      nameStyle: "font-size:25pt;color:#1f2a44;",
      headingStyle:
        "border-bottom:1px solid #d8dce4;color:#1f2a44;letter-spacing:1px;",
      itemStyle: "",
      skillStyle: "background:#f6f2ec;color:#1f2a44;border:1px solid #e5d7c4;",
    },
    blueprint: {
      accent: "#5f8fdc",
      font: "Arial, Helvetica, sans-serif",
      nameStyle:
        "font-family:Georgia, 'Times New Roman', serif;font-size:26pt;color:#111;",
      headingStyle:
        "font-family:Georgia, 'Times New Roman', serif;border-bottom:1px solid #e5e8ed;color:#5f8fdc;",
      itemStyle: "padding-left:10px;border-left:2px solid #5f8fdc;",
      skillStyle: "background:#f2f6ff;color:#2f64b5;border:1px solid #d8e5ff;",
    },
  };

  const theme = templateStyles[selectedTemplate] || templateStyles.classic;
  const isCompact = selectedTemplate === "compact";

  const experienceHtml = (data.experience || [])
    .map(
      (exp) =>
        `<div class="item"><div class="item-header"><strong>${exp.title || ""}</strong><span>${exp.dates || ""}</span></div><em>${exp.company || ""}</em><ul>${(exp.details || []).map((detail) => `<li>${detail}</li>`).join("")}</ul></div>`,
    )
    .join("");

  const educationHtml = (data.education || [])
    .map(
      (edu) =>
        `<div class="item"><div class="item-header"><strong>${edu.degree || ""}</strong><span>${edu.dates || ""}</span></div><em>${edu.institution || ""}</em></div>`,
    )
    .join("");

  const skillsHtml =
    data.skills?.length > 0
      ? `<div class="skills">${data.skills.map((skill) => `<span class="skill">${skill}</span>`).join("")}</div>`
      : "";

  const styles = `
    @page { size: A4; margin: ${isCompact ? "12mm" : "16mm"}; }
    body { font-family: ${theme.font}; margin: 0; padding: 0; background: #fff; color: #222; font-size: ${isCompact ? "8.8pt" : "10pt"}; line-height: ${isCompact ? "1.24" : "1.34"}; }
    .page { width: 100%; margin: 0; box-sizing: border-box; background: #fff; }
    .header, .section-title, .item-header { page-break-inside: avoid; break-inside: avoid; }
    .item { page-break-inside: avoid; break-inside: avoid; margin-bottom: ${isCompact ? "7px" : "12px"}; ${theme.itemStyle} }
    .header { margin-bottom: ${isCompact ? "8px" : "14px"}; padding-bottom: ${selectedTemplate === "executive" ? "8px" : "0"}; border-bottom: ${selectedTemplate === "executive" ? "2px solid #1f2a44" : "0"}; }
    .name { margin: 0 0 2px 0; font-weight: 700; ${theme.nameStyle} }
    .profession { color: ${theme.accent}; margin-bottom: 6px; font-size: ${isCompact ? "9.3pt" : "11pt"}; }
    .contact { color: #555; font-size: ${isCompact ? "8pt" : "9pt"}; }
    .contact span:not(:last-child)::after { content: ' | '; color: #aaa; }
    .section { margin-bottom: ${isCompact ? "7px" : "12px"}; }
    .section-title { font-weight: 800; text-transform: uppercase; font-size: ${isCompact ? "9.5pt" : "12pt"}; margin: ${isCompact ? "8px 0 4px" : "15px 0 8px"}; padding-bottom: 3px; ${theme.headingStyle} }
    .item-header { display: flex; justify-content: space-between; gap: 12px; align-items: baseline; }
    .item-header span { flex: 0 0 auto; color: #666; font-size: ${isCompact ? "8.2pt" : "9pt"}; text-align: right; }
    em { display: block; color: #555; margin: 1px 0 3px; font-weight: 700; }
    ul { margin: 3px 0 0; padding-left: 16px; }
    li { margin-bottom: ${isCompact ? "1px" : "3px"}; }
    p { margin: 0 0 7px; }
    .skills { display: flex; flex-wrap: wrap; gap: 6px; }
    .skill { ${theme.skillStyle} padding: 3px 8px; border-radius: 999px; }
  `;

  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${data.name || "Resume"}</title><style>${styles}</style></head><body><div class="page"><div class="header"><div class="name">${data.name || ""}</div>${profession ? `<div class="profession">${profession}</div>` : ""}<div class="contact">${contactItems.join("")}</div></div>${data.summary ? `<div class="section"><div class="section-title">${selectedTemplate === "blueprint" ? "Profile" : "Summary"}</div><p>${data.summary}</p></div>` : ""}${experienceHtml ? `<div class="section"><div class="section-title">Experience</div>${experienceHtml}</div>` : ""}${educationHtml ? `<div class="section"><div class="section-title">Education</div>${educationHtml}</div>` : ""}${skillsHtml ? `<div class="section"><div class="section-title">Skills</div>${skillsHtml}</div>` : ""}</div></body></html>`;
}

// Health check endpoint
app.get("/api/health", (req, res) => {
  res.json({
    status: "OK",
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || "development",
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ error: "Internal server error" });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: "Endpoint not found" });
});

// Start server with error handling
const server = app.listen(PORT, () => {
  console.log(
    `Server running on port ${PORT} in ${process.env.NODE_ENV || "development"} mode`,
  );
});

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(`Port ${PORT} is already in use`);
  } else {
    console.error("Server error:", error);
  }
  process.exit(1);
});
