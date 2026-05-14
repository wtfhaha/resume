const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer');
const pdfParse = require('pdf-parse');
const Groq = require('groq-sdk');
require('dotenv').config({ path: '.env.production' });

const app = express();
const PORT = process.env.PORT || 5001;

// Middleware
app.use(cors({
  origin: process.env.NODE_ENV === 'production' 
    ? [
        'https://yourdomain.com', 
        'https://www.yourdomain.com',
        process.env.FRONTEND_URL // Allow setting via environment variable
      ].filter(Boolean)
    : ['http://localhost:3000'],
  credentials: true
}));

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Initialize Groq with error handling
let groq;
try {
  groq = new Groq({
    apiKey: process.env.GROQ_API_KEY,
  });
  console.log('Groq client initialized successfully');
} catch (error) {
  console.error('Failed to initialize Groq client:', error.message);
  process.exit(1);
}

// Helper function to validate API key
const validateApiKey = () => {
  if (!process.env.GROQ_API_KEY || process.env.GROQ_API_KEY === 'YOUR_GROQ_API_KEY_HERE') {
    console.error('ERROR: GROQ_API_KEY is not configured properly');
    console.error('Please set your actual Groq API key in server/.env.production');
    return false;
  }
  return true;
};

// API Routes
app.post('/api/optimize-resume', async (req, res) => {
  if (!validateApiKey()) {
    return res.status(500).json({ error: 'Server configuration error: API key not properly set' });
  }

  const { resumeText, jobDescription, style = 'Default' } = req.body;
  
  if (!resumeText || !jobDescription) {
    return res.status(400).json({ error: 'Resume text and job description are required' });
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

    const chatCompletion = await groq.chat.completions.create({
      messages: [
        {
          role: "user",
          content: optimizationPrompt
        }
      ],
      model: "deepseek-r1-distill-llama-70b",
      temperature: 0.7,
      max_tokens: 4000,
    });

    const response = chatCompletion.choices[0]?.message?.content;
    if (!response) {
      return res.status(500).json({ error: 'Failed to generate optimized resume' });
    }

    let optimizedResumeJson;
    try {
      optimizedResumeJson = JSON.parse(response);
    } catch (parseError) {
      console.error('Failed to parse AI response:', parseError.message);
      return res.status(500).json({ error: 'Failed to parse optimized resume data' });
    }

    res.json({ optimizedResumeJson });
  } catch (error) {
    console.error('Resume optimization error:', error.message);
    res.status(500).json({ error: 'Failed to optimize resume' });
  }
});

app.post('/api/extract-title', async (req, res) => {
  if (!validateApiKey()) {
    return res.status(500).json({ error: 'Server configuration error: API key not properly set' });
  }

  const { resumeText } = req.body;
  
  if (!resumeText || resumeText.trim().length < 50) {
    return res.json({ extractedTitle: '' });
  }

  try {
    const titlePrompt = `Extract the primary job title or profession from this resume. Return ONLY the job title, no other text. If multiple roles exist, return the most recent or prominent one.

Resume:
${resumeText}`;

    const chatCompletion = await groq.chat.completions.create({
      messages: [
        {
          role: "user",
          content: titlePrompt
        }
      ],
      model: "llama3-8b-8192",
      temperature: 0.3,
      max_tokens: 100,
    });

    const response = chatCompletion.choices[0]?.message?.content?.trim();
    res.json({ extractedTitle: response || '' });
  } catch (error) {
    console.error('Title extraction error:', error.message);
    res.status(500).json({ error: 'Failed to extract job title' });
  }
});

app.post('/api/generate-pdf', async (req, res) => {
  if (!validateApiKey()) {
    return res.status(500).json({ error: 'Server configuration error: API key not properly set' });
  }

  const { resumeData, templateName = 'modern' } = req.body;

  if (!resumeData) {
    return res.status(400).json({ error: 'Resume data is required' });
  }

  try {
    const browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--single-process'
      ]
    });

    const page = await browser.newPage();
    
    // Set content based on template
    const htmlContent = generateResumeHTML(resumeData, templateName);
    
    await page.setContent(htmlContent, { waitUntil: 'networkidle0' });
    
    const pdfBuffer = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: {
        top: '20px',
        right: '20px',
        bottom: '20px',
        left: '20px'
      }
    });

    await browser.close();
    
    const pdfBase64 = pdfBuffer.toString('base64');
    res.json({ pdfBase64 });
  } catch (error) {
    console.error('PDF generation error:', error.message);
    res.status(500).json({ error: 'Failed to generate PDF' });
  }
});

// PDF Generation Functions
function generateResumeHTML(data, template) {
  const templates = {
    modern: `
      <html>
        <head>
          <meta charset="UTF-8">
          <style>
            body { font-family: Arial, sans-serif; margin: 0; padding: 20px; background: #fff; }
            .header { text-align: center; margin-bottom: 30px; }
            .name { font-size: 24px; font-weight: bold; color: #28A745; }
            .contact { margin-bottom: 20px; }
            .section { margin-bottom: 25px; }
            .section-title { font-size: 18px; font-weight: bold; color: #28A745; border-bottom: 2px solid #28A745; padding-bottom: 5px; }
            .item { margin-bottom: 15px; }
            .item-title { font-weight: bold; }
            .skills { display: flex; flex-wrap: wrap; gap: 10px; }
            .skill { background: #28A745; color: white; padding: 5px 10px; border-radius: 3px; }
          </style>
        </head>
        <body>
          <div class="header">
            <div class="name">${data.name || ''}</div>
            <div class="contact">${data.contact?.email || ''} | ${data.contact?.phone || ''} | ${data.contact?.location || ''}</div>
          </div>
          
          ${data.summary ? `
          <div class="section">
            <div class="section-title">Summary</div>
            <div>${data.summary}</div>
          </div>` : ''}
          
          ${data.experience?.map(exp => `
          <div class="section">
            <div class="section-title">Experience</div>
            ${exp.details?.map(detail => `<div class="item"><div class="item-title">${exp.title} at ${exp.company}</div><div>${exp.dates}</div><div>${detail}</div></div>`).join('')}
          </div>`).join('')}
          
          ${data.education?.map(edu => `
          <div class="section">
            <div class="section-title">Education</div>
            <div class="item"><div class="item-title">${edu.degree}</div><div>${edu.institution}</div><div>${edu.dates}</div></div>
          </div>`).join('')}
          
          ${data.skills?.length > 0 ? `
          <div class="section">
            <div class="section-title">Skills</div>
            <div class="skills">
              ${data.skills.map(skill => `<span class="skill">${skill}</span>`).join('')}
            </div>
          </div>` : ''}
        </body>
      </html>
    `,
    // Add other templates as needed
    classic: templates.modern,
    compact: templates.modern,
    creative: templates.modern
  };

  return templates[template] || templates.modern;
}

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development'
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

// Start server with error handling
const server = app.listen(PORT, () => {
  console.log(`Server running on port ${PORT} in ${process.env.NODE_ENV || 'development'} mode`);
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use`);
  } else {
    console.error('Server error:', error);
  }
  process.exit(1);
});
