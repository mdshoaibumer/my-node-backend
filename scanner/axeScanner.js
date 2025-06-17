const axe = require('axe-core');
const puppeteer = require('puppeteer');
const { generateFixSuggestions, calculateRiskScore } = require('../utils/aiUtils');
const { v4: uuidv4 } = require('uuid');
const { chromium, firefox, webkit } = require('playwright');

// Browser instance management
let browserInstances = {};
const MAX_SCAN_TIME = 120000;

async function getBrowserInstance(browserType = 'chromium') {
  browserType = browserType.toLowerCase();
  
  if (!browserInstances[browserType] || !browserInstances[browserType].isConnected()) {
    const browser = {
      chromium,
      firefox,
      webkit
    }[browserType];
    
    if (!browser) throw new Error(`Unsupported browser: ${browserType}`);
    
    browserInstances[browserType] = await browser.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu'
      ],
      executablePath: process.env[`${browserType.toUpperCase()}_PATH`] || 
        (process.platform === 'win32'
          ? getWindowsPath(browserType)
          : getLinuxPath(browserType))
    });
  }
  return browserInstances[browserType];
}

function getWindowsPath(browserType) {
  const paths = {
    chromium: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    firefox: 'C:\\Program Files\\Mozilla Firefox\\firefox.exe',
    webkit: 'C:\\Program Files\\WebKit\\WebKit.exe'
  };
  return paths[browserType];
}

function getLinuxPath(browserType) {
  const paths = {
    chromium: '/usr/bin/google-chrome',
    firefox: '/usr/bin/firefox',
    webkit: '/usr/bin/webkit'
  };
  return paths[browserType];
}

async function testKeyboardNavigation(page) {
  await page.keyboard.press('Tab');
  const issues = [];
  
  for (let i = 0; i < 50; i++) { // Limit to 50 elements
    const focusedElement = await page.evaluateHandle(() => document.activeElement);
    const isVisible = await focusedElement.evaluate(el => {
      const style = window.getComputedStyle(el);
      return style.visibility !== 'hidden' && 
             style.display !== 'none' &&
             el.offsetWidth > 0 &&
             el.offsetHeight > 0;
    });
    
    const tabIndex = await focusedElement.evaluate(el => el.tabIndex);
    const tagName = await focusedElement.evaluate(el => el.tagName);
    
    if (!isVisible) {
      issues.push({
        type: 'keyboard-focus-hidden',
        element: tagName,
        message: 'Focused element is not visible'
      });
    }
    
    if (tagName === 'A' || tagName === 'BUTTON') {
      const hasAccessibleName = await focusedElement.evaluate(el => 
        el.getAttribute('aria-label') || el.textContent.trim()
      );
      
      if (!hasAccessibleName) {
        issues.push({
          type: 'keyboard-missing-aria-label',
          element: tagName,
          message: 'Interactive element missing accessible name'
        });
      }
    }
    
    await page.keyboard.press('Tab');
  }
  
  return issues;
}

async function simulateScreenReader(page) {
  const issues = [];
  
  const elements = await page.$$('img, button, a, input, [role]');
  for (const element of elements) {
    const altText = await element.evaluate(el => el.alt);
    const ariaLabel = await element.evaluate(el => el.getAttribute('aria-label'));
    const role = await element.evaluate(el => el.getAttribute('role'));
    const tagName = await element.evaluate(el => el.tagName);
    
    if (tagName === 'IMG' && !altText && !ariaLabel) {
      const suggestion = await generateFixSuggestions({
        id: 'screenreader-missing-alt',
        description: 'Image missing alt text',
        nodes: [{ html: await element.evaluate(el => el.outerHTML) }]
      });
      
      issues.push({
        type: 'screenreader-missing-alt',
        element: tagName,
        message: 'Image missing alt text for screen readers',
        suggestion // Add AI-generated suggestion
      });
    }
    
    if (['BUTTON', 'A'].includes(tagName) && !ariaLabel && !await element.evaluate(el => el.textContent.trim())) {
      const suggestion = await generateFixSuggestions({
        id: 'screenreader-missing-aria',
        description: 'Interactive element missing ARIA label',
        nodes: [{ html: await element.evaluate(el => el.outerHTML) }]
      });
      
      issues.push({
        type: 'screenreader-missing-aria',
        element: tagName,
        message: 'Interactive element missing ARIA label',
        suggestion // Add AI-generated suggestion
      });
    }
  }
  
  return issues;
}

async function scanPage(url, options = {}) {
  const { browserType = 'chromium' } = options;
  const scanId = uuidv4();
  console.log(`[${scanId}] Starting ${browserType} scan for: ${url}`);
  
  const browser = await getBrowserInstance(browserType);
  const context = await browser.newContext({
    bypassCSP: true,
    viewport: { width: 1280, height: 800 }
  });
  const page = await context.newPage();
  
  try {
    await page.setDefaultNavigationTimeout(MAX_SCAN_TIME);
    
    // Store navigation promise before using it in Promise.race
    const navigationPromise = page.goto(url, { 
      waitUntil: 'networkidle',
      timeout: MAX_SCAN_TIME
    });

    // Add timeout race condition
    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error('Navigation timeout')), MAX_SCAN_TIME)
    );

    await Promise.race([navigationPromise, timeoutPromise]);

    // Inject axe-core and run analysis
    await page.evaluate(axe.source);
    const results = await page.evaluate(() => axe.run({
      runOnly: {
        type: 'tag',
        values: ['wcag2a', 'wcag2aa', 'wcag21aa', 'section508', 'best-practice']
      },
      rules: {
        'color-contrast': { enabled: true },
        'empty-heading': { enabled: true },
        'image-alt': { enabled: true }
      },
      reporter: 'v2',
      resultTypes: ['violations', 'incomplete', 'inapplicable']
    }));

    // Check for authoring tool and run ATAG checks
    const isAuthoringTool = await page.evaluate(() => {
      return document.querySelector('[contenteditable], .wysiwyg, .rich-text-editor') !== null;
    });

    if (isAuthoringTool) {
      const authoringResults = await page.evaluate(() => axe.run({
        runOnly: {
          type: 'tag',
          values: ['atag2.0']
        }
      }));
      results.authoringViolations = authoringResults.violations;
    }

    // Run keyboard navigation tests
    const keyboardResults = await testKeyboardNavigation(page);
    results.keyboardIssues = keyboardResults;

    // Run screen reader simulation
    const screenReaderResults = await simulateScreenReader(page);
    results.screenReaderIssues = screenReaderResults;

    console.log(`[${scanId}] Scan completed with ${results.violations?.length || 0} violations`);
    return results;

  } catch (error) {
    console.error(`[${scanId}] Scan failed:`, error);
    throw new Error(`Scan failed: ${error.message}`);
  } finally {
    if (context) await context.close();
    if (page && !page.isClosed()) await page.close();
  }
}

async function enhanceResults(results) {
  const SEVERITY_MAPPING = {
    critical: ['serious', 'critical'],
    high: ['moderate'],
    medium: ['minor'],
    low: ['cosmetic']
  };

  // Process violations in parallel batches
  const BATCH_SIZE = 5;
  const violationBatches = [];
  for (let i = 0; i < results.violations.length; i += BATCH_SIZE) {
    violationBatches.push(results.violations.slice(i, i + BATCH_SIZE));
  }

  const processedViolations = [];
  for (const batch of violationBatches) {
    const enhancedBatch = await Promise.all(
      batch.map(async (violation) => {
        const severity = Object.keys(SEVERITY_MAPPING).find(level => 
          SEVERITY_MAPPING[level].includes(violation.impact)) || 'unknown';

        // Enhanced node processing
        const nodes = violation.nodes.map(node => ({
          ...node,
          target: node.target.join(' > '),
          html: node.html.substring(0, 500) // Truncate long HTML
        }));

        return {
          ...violation,
          severity,
          nodes,
          suggestion: await generateFixSuggestions({ ...violation, severity, nodes })
        };
      })
    );
    processedViolations.push(...enhancedBatch);
  }

  // Calculate comprehensive metrics
  const metrics = {
    riskScore: calculateRiskScore(processedViolations),
    violationCount: processedViolations.length,
    severityBreakdown: processedViolations.reduce((acc, v) => {
      acc[v.severity] = (acc[v.severity] || 0) + 1;
      return acc;
    }, {})
  };

  return {
    ...results,
    violations: processedViolations,
    metrics,
    scannedAt: new Date().toISOString(),
    engine: {
      name: 'Axe-Core',
      version: axe.version,
      standards: ['WCAG 2.1', 'Section 508', 'ATAG 2.0']
    }
  };
}

async function closeBrowser() {
  for (const type in browserInstances) {
    if (browserInstances[type] && browserInstances[type].isConnected()) {
      await browserInstances[type].close();
    }
  }
  browserInstances = {};
}

// Graceful shutdown handler
process.on('SIGTERM', async () => {
  await closeBrowser();
  process.exit(0);
});

process.on('SIGINT', async () => {
  await closeBrowser();
  process.exit(0);
});

module.exports = { 
  scanPage, 
  enhanceResults,
  closeBrowser
};