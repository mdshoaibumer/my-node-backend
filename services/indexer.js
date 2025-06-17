const { OpenAI } = require('openai');
const db = require('../db/schema');
const { scanPage, enhanceResults } = require('../scanner/axeScanner');
const SiteCrawler = require('../crawler/crawler');

class AIIndexer {
  constructor() {
    this.openai = new OpenAI({ 
      apiKey: process.env.OPENAI_API_KEY,
      timeout: 30000
    });
    this.db = db;
  }

  async indexWebsite(domain) {
    const crawler = new SiteCrawler();
    await crawler.init();
    
    try {
      // Validate and normalize domain
      if (!domain.startsWith('http')) {
        domain = `https://${domain}`;
      }
      const domainObj = new URL(domain);
      const baseDomain = domainObj.hostname;

      // Crawl website
      console.log(`[INDEXER] Starting crawl for: ${baseDomain}`);
      const pages = await crawler.crawl(domain);
      console.log(`[INDEXER] Found ${pages.length} pages to index`);

      let totalScore = 0;
      let indexedPages = 0;

      // Process pages in batches
      const BATCH_SIZE = 5;
      for (let i = 0; i < pages.length; i += BATCH_SIZE) {
        const batch = pages.slice(i, i + BATCH_SIZE);
        
        await Promise.all(batch.map(async (page) => {
          try {
            console.log(`[INDEXER] Scanning ${page.url}`);
            const scanResults = await scanPage(page.url);
            const enhanced = await enhanceResults(scanResults);
            
            // Store results
            await this.storePageResults(baseDomain, page.url, page.title, enhanced);
            
            totalScore += enhanced.metrics.riskScore;
            indexedPages++;
          } catch (error) {
            console.error(`[INDEXER] Failed to index ${page.url}:`, error.message);
          }
        }));
      }

      // Calculate and update compliance score
      const avgScore = indexedPages > 0 ? totalScore / indexedPages : 0;
      const complianceScore = 100 - Math.min(avgScore, 100);
      
      await this.updateWebsiteScore(baseDomain, complianceScore);
      
      console.log(`[INDEXER] Completed indexing for ${baseDomain}. Compliance score: ${complianceScore}`);
      return { 
        domain: baseDomain, 
        pages: indexedPages, 
        complianceScore 
      };

    } finally {
      await crawler.close();
    }
  }

  async storePageResults(domain, url, title, scanData) {
  const complianceScore = 100 - scanData.metrics.riskScore;
  return new Promise((resolve, reject) => {
    this.db.serialize(() => {
      try {
        this.db.run('BEGIN TRANSACTION');

        // 1. Insert/Update website
        this.db.run(
          `INSERT OR REPLACE INTO websites (domain, compliance_score) VALUES (?, ?)`,
          [domain, complianceScore],
          (err) => {
            if (err) {
              this.db.run('ROLLBACK');
              return reject(err);
            }

            // 2. Insert/Update page
            this.db.run(
              `INSERT OR REPLACE INTO pages 
              (website_id, url, title, risk_score, scan_data) 
              VALUES (
                (SELECT id FROM websites WHERE domain = ?),
                ?, ?, ?, ?
              )`,
              [domain, url, title, scanData.metrics.riskScore, JSON.stringify(scanData)],
              async function(err) {
                if (err) {
                  this.db.run('ROLLBACK');
                  return reject(err);
                }
                const pageId = this.lastID;

                try {
                  // 3. Delete old violations
                  await new Promise((res, rej) => {
                    this.db.run(
                      'DELETE FROM violations WHERE page_id = ?',
                      [pageId],
                      (err) => err ? rej(err) : res()
                    );
                  });

                  // 4. Insert new violations with embeddings
                  const violations = scanData.violations || [];
                  const BATCH_SIZE = 5;
                  
                  for (let i = 0; i < violations.length; i += BATCH_SIZE) {
                    const batch = violations.slice(i, i + BATCH_SIZE);
                    try {
                      await Promise.all(
                        batch.map(violation => 
                          this.insertViolation(pageId, violation)
                        )
                      );
                    } catch (batchErr) {
                      console.error(`Batch ${i} failed:`, batchErr);
                      // Continue with next batch
                    }
                  }

                  // Commit transaction
                  this.db.run('COMMIT', (err) => {
                    if (err) {
                      this.db.run('ROLLBACK');
                      reject(err);
                    } else {
                      resolve();
                    }
                  });
                } catch (err) {
                  this.db.run('ROLLBACK');
                  reject(err);
                }
              }
            );
          }
        );
      } catch (err) {
        this.db.run('ROLLBACK');
        reject(err);
      }
    });
  });
}

async insertViolation(pageId, violation) {
  try {
    // Enhanced embedding generation with more context
     const embeddingText = `Violation: ${violation.id} | ${violation.description} | 
                         Standard: ${violation.tags.join(', ')} | 
                         Element: ${violation.nodes[0]?.html.substring(0,100)}`;
    
    const embedding = await this.generateEmbedding(embeddingText);
    
    // Compress embedding to save space
    const compressedEmbedding = this.compressEmbedding(embedding);

    return new Promise((resolve, reject) => {
      this.db.run(
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
          compressedEmbedding
        ],
        (err) => err ? reject(err) : resolve()
      );
    });
  } catch (error) {
    console.error(`[INDEXER] Failed to process violation ${violation.id}:`, error);
    return this.storeBasicViolation(pageId, violation);
  }
}

compressEmbedding(embedding) {
  // Simple compression - convert to Int8Array and JSON stringify
  const int8Embedding = new Int8Array(embedding.map(val => Math.round(val * 127)));
  return JSON.stringify(Array.from(int8Embedding));
}

async storeBasicViolation(pageId, violation) {
  return new Promise((resolve, reject) => {
    this.db.run(
      `INSERT INTO violations 
      (page_id, violation_id, description, severity, html, suggestion)
      VALUES (?, ?, ?, ?, ?, ?)`,
      [
        pageId,
        violation.id,
        violation.description,
        violation.severity,
        violation.nodes[0]?.html || '',
        violation.suggestion?.suggestion || ''
      ],
      (err) => err ? reject(err) : resolve()
    );
  });
}

async storeBasicViolation(pageId, violation) {
  return new Promise((resolve, reject) => {
    this.db.run(
      `INSERT INTO violations 
      (page_id, violation_id, description, severity, html, suggestion)
      VALUES (?, ?, ?, ?, ?, ?)`,
      [
        pageId,
        violation.id,
        violation.description,
        violation.severity,
        violation.nodes[0]?.html || '',
        violation.suggestion?.suggestion || ''
      ],
      (err) => err ? reject(err) : resolve()
    );
  });
}

  async updateWebsiteScore(domain, score) {
    return new Promise((resolve, reject) => {
      this.db.run(
        `UPDATE websites SET compliance_score = ?, last_scanned = CURRENT_TIMESTAMP 
         WHERE domain = ?`,
        [score, domain],
        (err) => err ? reject(err) : resolve()
      );
    });
  }

  async generateEmbedding(text) {
    try {
      const response = await this.openai.embeddings.create({
        model: 'text-embedding-3-small',
        input: text
      });
      return response.data[0].embedding;
    } catch (error) {
      console.error('[INDEXER] Embedding generation failed:', error);
      throw error;
    }
  }
}

module.exports = AIIndexer;