require('dotenv').config();
const { OpenAI } = require("openai");
const { setTimeout } = require('timers/promises');
const { v4: uuidv4 } = require('uuid');

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  timeout: 20000,
  maxRetries: 2
});

// Create response cache
const RESPONSE_CACHE = new Map();

const VIOLATION_TEMPLATES = {
  'color-contrast': `Fix color contrast ratio of at least 4.5:1 for normal text. Current element: {html}`,
  'image-alt': `Add descriptive alt text to this image: {html}`,
  'empty-heading': `Remove or add content to this empty heading: {html}`
};

async function generateFixSuggestions(violation) {
  // Create a more comprehensive cache key using violation details
  const cacheKey = JSON.stringify({
    id: violation.id,
    html: violation.nodes[0].html.replace(/\s+/g, ' ').trim(),
    impact: violation.impact,
    helpUrl: violation.helpUrl
  });

  // Return cached response if available
  if (RESPONSE_CACHE.has(cacheKey)) {
    const cached = RESPONSE_CACHE.get(cacheKey);
    console.log(`Using cached response for ${violation.id}`);
    return { ...cached, cached: true }; // Add cached flag
  }

  const requestId = uuidv4();
  try {
    // Use template if available
    let prompt = VIOLATION_TEMPLATES[violation.id] 
      ? VIOLATION_TEMPLATES[violation.id].replace('{html}', violation.nodes[0].html)
      : `As a senior accessibility engineer, provide:
        1. Explanation of this ${violation.id} violation (${violation.impact} impact)
        2. Fixed HTML code
        3. Implementation steps
        
        Context: ${violation.helpUrl}
        Element: ${violation.nodes[0].html.substring(0, 300)}`;

    const messages = [
      { 
        role: "system", 
        content: `You are an expert web accessibility consultant. Provide your response in the following EXACT format:

        ### Concise Technical Explanation
        [2-3 sentence explanation of the issue]

        ### Fixed HTML Snippet
        [Fixed HTML code snippet ONLY - no explanations]

        ### Implementation Steps
        1. [Step 1]
        2. [Step 2]
        3. [Step 3]

        ### WCAG Reference
        [Specific WCAG guideline reference]

        Context: ${violation.helpUrl}
        Element: ${violation.nodes[0].html.substring(0, 300)}`
      },
      { role: "user", content: prompt }
    ];

    const response = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || "gpt-4-turbo",
      messages,
      temperature: 0.2,
      max_tokens: 500,
      top_p: 0.9
    });

    // Add this after getting the AI response
    const validateSuggestionFormat = (content) => {
      const requiredSections = [
        '### Concise Technical Explanation',
        '### Fixed HTML Snippet',
        '### Implementation Steps',
        '### WCAG Reference'
      ];
      
      return requiredSections.every(section => content.includes(section));
    };

    if (!validateSuggestionFormat(response.choices[0].message.content)) {
      console.warn(`[${requestId}] Invalid suggestion format for ${violation.id}`);
    }

    const result = {
      id: violation.id,
      suggestion: response.choices[0].message.content.trim(),
      model: process.env.OPENAI_MODEL,
      timestamp: new Date().toISOString(),
      cached: false
    };

    // Cache successful response
    RESPONSE_CACHE.set(cacheKey, result);
    console.log(`[${requestId}] Cached new response for ${violation.id}`);
    return result;

  } catch (error) {
    console.error(`[${requestId}] AI Error (${violation.id}):`, error.message);
    return {
      id: violation.id,
      error: `AI Service Unavailable: ${error.code || 'Timeout'}`,
      fallback: violation.helpUrl,
      cached: false
    };
  }
}

function calculateRiskScore(violations) {
  const SEVERITY_WEIGHTS = {
    critical: 10,
    high: 6,
    medium: 3,
    low: 1
  };

  // Calculate raw score
  const rawScore = violations.reduce((total, violation) => {
    return total + (SEVERITY_WEIGHTS[violation.severity] || 1);
  }, 0);

  // Normalize to 0-100 scale (lower is better)
  const maxPossibleScore = violations.length * SEVERITY_WEIGHTS.critical;
  return maxPossibleScore > 0 
    ? Math.min(Math.round((rawScore / maxPossibleScore) * 100), 100)
    : 0;
}

module.exports = { 
  generateFixSuggestions, 
  calculateRiskScore 
};