require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const { scanPage, enhanceResults } = require('../scanner/axeScanner');
const { generatePDFReport } = require('../utils/pdfGenerator');
const SearchEngine = require('../services/searchEngine');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();
const initializeDatabase = require('../db/schema');
const searchRoutes = require('../routes/searchRoutes');
const { format } = require('date-fns');

const PORT = process.env.PORT || 5000;

// Initialize Express app
const app = express();
let searchEngine;

// Middleware
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS?.split(',') || '*'
}));
app.use(helmet());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100,
  standardHeaders: true,
  legacyHeaders: false
});
app.use('/api/', limiter);

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({
    status: 'healthy',
    version: '1.0.0',
    uptime: process.uptime(),
    database: 'connected'
  });
});

// Single page scan endpoint
app.post('/api/scan', async (req, res) => {
  try {
    const { url, generateReport = false } = req.body;
    if (!url) return res.status(400).json({ error: 'URL required' });

    console.log(`[SCAN] Starting scan for: ${url}`);
    
    // 1. Perform the scan
    const scanResults = await scanPage(url);
    const enhancedResults = await enhanceResults(scanResults);
    enhancedResults.scanDuration = enhancedResults.scanDuration || 'Not measured';
    
    // 2. Store results in database
    console.log('[DB] Storing scan results...');
    await storeScanResults(url, enhancedResults);
    
    // 3. Generate report if requested
    if (generateReport) {
      const reportPath = path.join(__dirname, '../reports', `report_${Date.now()}.pdf`);
      await generatePDFReport(enhancedResults, reportPath);
      enhancedResults.pdfUrl = `/reports/${path.basename(reportPath)}`;
    }

    res.json({
      success: true,
      url,
      ...enhancedResults,
      message: 'Scan completed and results stored'
    });
  } catch (error) {
    console.error('Scan failed:', error);
    res.status(500).json({ 
      success: false,
      error: error.message,
      details: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

// New endpoint for PDF generation from last scan
app.post('/api/generate-pdf-from-last-scan', async (req, res) => {
  try {
    const lastResults = req.app.locals.lastScanResults;
    if (!lastResults) {
      return res.status(400).json({ 
        error: 'No recent scan available. Please perform a scan first.' 
      });
    }

    // Ensure reports directory exists
    const reportsDir = path.join(__dirname, '../reports');
    if (!fs.existsSync(reportsDir)) {
      fs.mkdirSync(reportsDir, { recursive: true });
    }

    const reportPath = path.join(reportsDir, `report_${Date.now()}.pdf`);
    
    // Generate PDF
    await generatePDFReport(lastResults, reportPath);

    // Verify PDF was created
    if (!fs.existsSync(reportPath)) {
      throw new Error('PDF file was not created');
    }

    // Stream the file with proper error handling
    const fileStream = fs.createReadStream(reportPath);
    
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=accessibility-report-${Date.now()}.pdf`);
    
    fileStream.pipe(res);

    fileStream.on('end', () => {
      // Schedule cleanup after 1 minute
      setTimeout(() => {
        fs.unlink(reportPath, (err) => {
          if (err) console.error('Cleanup error:', err);
        });
      }, 60000);
    });

  } catch (error) {
    console.error('PDF generation failed:', error);
    if (!res.headersSent) {
      res.status(500).json({ 
        error: 'PDF generation failed',
        details: process.env.NODE_ENV === 'development' ? error.message : undefined
      });
    }
  }
});

// Serve PDF reports
app.use('/reports', express.static(path.join(__dirname, '../reports')));

// Search routes
app.use('/api/search', searchRoutes(searchEngine));

// Add test data endpoint
app.post('/api/add-test-data', async (req, res) => {
  try {
    await searchEngine.db.run(`
      INSERT OR IGNORE INTO websites (domain, compliance_score) 
      VALUES ('example.com', 95), ('test.org', 80)
    `);
    
    await searchEngine.db.run(`
      INSERT OR IGNORE INTO pages (website_id, url, title, risk_score)
      VALUES 
        (1, 'https://example.com', 'Example Homepage', 10),
        (2, 'https://test.org', 'Test Site', 30)
    `);
    
    await searchEngine.db.run(`
      INSERT OR IGNORE INTO violations 
        (page_id, violation_id, description, severity, html, suggestion)
      VALUES 
        (1, 'color-contrast', 'Insufficient color contrast', 'critical', '<div style="color:#777">Low contrast</div>', 'Increase contrast ratio'),
        (1, 'image-alt', 'Missing alt text', 'high', '<img src="logo.png">', 'Add descriptive alt text'),
        (2, 'aria-attributes', 'Missing ARIA attributes', 'medium', '<button>Submit</button>', 'Add aria-label')
    `);

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Verify data endpoint
app.get('/api/verify-data/:url', async (req, res) => {
  try {
    const url = decodeURIComponent(req.params.url);
    const db = new sqlite3.Database(path.resolve(__dirname, '../complyai-search.db'));
    
    // 1. Get website
    const domain = new URL(url).hostname;
    const website = await db.get(
      'SELECT * FROM websites WHERE domain = ?', 
      [domain]
    );
    
    if (!website) {
      return res.status(404).json({ error: 'Website not found' });
    }
    
    // 2. Get page
    const page = await db.get(
      'SELECT * FROM pages WHERE url = ?', 
      [url]
    );
    
    // 3. Get violations
    const violations = await db.all(
      'SELECT * FROM violations WHERE page_id = ?',
      [page?.id || 0]
    );
    
    res.json({
      website,
      page,
      violations,
      violationCount: violations.length
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Serve React build files for Azure deployment
app.use(express.static(path.join(__dirname, '../client/build')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../client/build/index.html'));
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// Initialize and start server
async function startServer() {
  try {
    // 1. Initialize database
    const db = await initializeDatabase();
    console.log('Database initialized successfully');
    
    // 2. Create search engine instance
    searchEngine = new SearchEngine(db);

    // 3. Ensure reports directory exists
    const reportsDir = path.join(__dirname, '../reports');
    require('fs').mkdirSync(reportsDir, { recursive: true });
    console.log('Reports directory ready');
    
    // 4. Start server
    app.listen(PORT, () => {
      console.log(`🚀 Server running on port ${PORT}`);
    });
    
  } catch (error) {
    console.error('Server startup failed:', error);
    process.exit(1);
  }
}

// Store scan results in database
async function storeScanResults(url, scanData) {
  const db = new sqlite3.Database(path.resolve(__dirname, '../complyai-search.db'));
  
  try {
    await new Promise((resolve, reject) => {
      db.serialize(() => {
        db.run('BEGIN TRANSACTION');

        // 1. Insert/Update website
        const domain = new URL(url).hostname;
        db.run(
          `INSERT OR REPLACE INTO websites (domain, compliance_score) VALUES (?, ?)`,
          [domain, 100 - Math.min(scanData.metrics.riskScore, 100)],
          function(err) {
            if (err) reject(err);
            
            // 2. Insert/Update page
            db.run(
              `INSERT OR REPLACE INTO pages 
              (website_id, url, title, risk_score, scan_data)
              VALUES (
                (SELECT id FROM websites WHERE domain = ?),
                ?, ?, ?, ?
              )`,
              [domain, url, scanData.pageTitle || url, scanData.metrics.riskScore, JSON.stringify(scanData)],
              function(err) {
                if (err) reject(err);
                const pageId = this.lastID;

                // 3. Delete old violations
                db.run(
                  'DELETE FROM violations WHERE page_id = ?',
                  [pageId],
                  async function(err) {
                    if (err) reject(err);

                    // 4. Insert new violations
                    const violations = scanData.violations || [];
                    for (const violation of violations) {
                      const embedding = await new SearchEngine(db).generateEmbedding(violation.description);
                      
                      db.run(
                        `INSERT INTO violations 
                        (page_id, violation_id, description, severity, html, suggestion, embedding)
                        VALUES (?, ?, ?, ?, ?, ?, ?)`,
                        [
                          pageId,
                          violation.id,
                          violation.description,
                          violation.severity,
                          violation.nodes[0]?.html || '',
                          violation.suggestion?.suggestion || '',
                          JSON.stringify(embedding)
                        ]
                      );
                    }
                    db.run('COMMIT', (err) => {
                      if (err) reject(err);
                      else resolve();
                    });
                  }
                );
              }
            );
          }
        );
      });
    });
    
    console.log(`[DB] Successfully stored results for ${url}`);
  } catch (error) {
    console.error('[DB] Error storing scan results:', error);
    throw error;
  } finally {
    db.close();
  }
}

// Generate PDF endpoint
app.post('/api/generate-pdf', async (req, res) => {
  try {
    const { data } = req.body;
    
    // Validate input data structure first
    if (!data) {
      return res.status(400).json({ error: 'Scan data is required' });
    }

    // Create validatedData with proper fallbacks
    const validatedData = {
      url: data.url || 'Unknown URL',
      scannedAt: data.scannedAt || new Date().toISOString(),
      scanDuration: data.scanDuration || 'Not measured',
      metrics: {
        riskScore: data.metrics?.riskScore || 0,
        violationCount: data.metrics?.violationCount || 0,
        severityBreakdown: data.metrics?.severityBreakdown || {
          critical: 0,
          high: 0,
          medium: 0,
          low: 0
        },
        elementsScanned: data.metrics?.elementsScanned || 0
      },
      violations: Array.isArray(data.violations) 
        ? data.violations.map(v => ({
            id: v.id || 'unknown',
            description: v.description || 'No description available',
            severity: v.severity || 'medium',
            nodes: Array.isArray(v.nodes) ? v.nodes : [{
              html: v.html || '<div>No HTML available</div>'
            }],
            suggestion: {
              suggestion: v.suggestion?.suggestion || 'No suggestion available'
            }
          }))
        : [],
      keyboardIssues: Array.isArray(data.keyboardIssues) ? data.keyboardIssues : [],
      screenReaderIssues: Array.isArray(data.screenReaderIssues) 
        ? data.screenReaderIssues.map(issue => ({
            type: issue.type || 'screenreader-issue',
            message: issue.message || 'No message available',
            element: issue.element || 'Unknown element',
            suggestion: issue.suggestion || issue.parsedSuggestion || {
              suggestion: 'No suggestion available'
            }
          }))
        : []
    };

    console.log('Generating PDF with validated data:', {
      url: validatedData.url,
      violationCount: validatedData.violations.length,
      riskScore: validatedData.metrics.riskScore
    });

    // Now we can safely use validatedData
    console.log('Starting PDF generation...');
    
    // Ensure reports directory exists
    const reportsDir = path.join(__dirname, '../reports');
    if (!fs.existsSync(reportsDir)) {
      fs.mkdirSync(reportsDir, { recursive: true });
    }

    const reportFilename = `accessibility-report-${Date.now()}.pdf`;
    const reportPath = path.join(reportsDir, reportFilename);

    await generatePDFReport(validatedData, reportPath);
    console.log('PDF generated successfully');

    // Stream the file
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=${reportFilename}`);

    const fileStream = fs.createReadStream(reportPath);

    fileStream.on('error', (err) => {
      console.error('File stream error:', err);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Error streaming PDF file' });
      }
    });

    fileStream.on('open', () => {
      fileStream.pipe(res);
    });

    // Clean up after streaming
    fileStream.on('end', () => {
      setTimeout(() => {
        fs.unlink(reportPath, (err) => {
          if (err) console.error('Cleanup error:', err);
        });
      }, 60000); // Delete after 1 minute
    });

  } catch (error) {
    console.error('PDF generation failed:', {
      error: error.message,
      stack: error.stack,
      requestBody: req.body?.data ? {
        url: req.body.data.url,
        violationCount: req.body.data.violations?.length,
        riskScore: req.body.data.metrics?.riskScore
      } : 'No data received'
    });

    if (!res.headersSent) {
      res.status(500).json({ 
        error: 'PDF generation failed',
        details: process.env.NODE_ENV === 'development' ? error.message : undefined
      });
    }
  }
});

// Start the server
startServer();

// Graceful shutdown
process.on('SIGTERM', async () => {
  await searchEngine.close();
  process.exit(0);
});

module.exports = app;