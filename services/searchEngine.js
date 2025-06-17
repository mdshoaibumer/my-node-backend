const { OpenAI } = require('openai');
const math = require('mathjs');
const path = require('path');


class SearchEngine {
  constructor(db) {
    if (!db) throw new Error('Database connection required');
    this.db = db;
    this.openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      timeout: 20000
    });
  }

  /**
   * Ensure required database indexes exist
   */
  async ensureIndexes() {
    return new Promise((resolve, reject) => {
      this.db.serialize(() => {
        this.db.run(`
          CREATE INDEX IF NOT EXISTS idx_violations_page 
          ON violations(page_id)
        `);
        
        this.db.run(`
          CREATE INDEX IF NOT EXISTS idx_violations_type 
          ON violations(violation_id)
        `);
        
        this.db.run(`
          CREATE INDEX IF NOT EXISTS idx_pages_url 
          ON pages(url)
        `, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    });
  }

  /**
   * Semantic search using AI embeddings
   */
  async semanticSearch(query, limit = 5) {
      try {
      // 1. Get query embedding
      const queryEmbedding = await this.generateEmbedding(query);
      if (!queryEmbedding || queryEmbedding.length === 0) {
        throw new Error('Failed to generate query embedding');
      }

      // 2. Get all violations with their embeddings
      const violations = await new Promise((resolve, reject) => {
        this.db.all(`
          SELECT v.*, p.url, p.title, w.domain
          FROM violations v
          JOIN pages p ON v.page_id = p.id
          JOIN websites w ON p.website_id = w.id
          WHERE v.embedding IS NOT NULL
          LIMIT 1000
        `, [], (err, rows) => {
          if (err) reject(err);
          else resolve(rows || []);
        });
      });

      // 3. Calculate similarities and filter
      const results = violations.map(v => {
        try {
          const vec = JSON.parse(v.embedding);
          return {
            ...v,
            similarity: this.cosineSimilarity(queryEmbedding, vec)
          };
        } catch (e) {
          return { ...v, similarity: 0 };
        }
      })
      .filter(r => r.similarity > 0.3)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, limit);

      return results.length > 0 ? results : [];
    } catch (error) {
      console.error('Semantic search failed:', error);
      return [];
    }
  }

  /**
   * Search websites by compliance score
   */
  async searchWebsitesByCompliance(minScore = 0, limit = 50) {
      return new Promise((resolve, reject) => {
      this.db.all(
        `SELECT domain, 
                compliance_score,
                datetime(last_scanned, 'localtime') as last_scanned
        FROM websites 
        WHERE compliance_score >= ?
        ORDER BY compliance_score DESC
        LIMIT ?`,
        [minScore, limit],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows || []);
        }
      );
    });
  }

  /**
   * Search violations by criteria
   */
  async semanticSearch(query, limit = 5) {
    try {
      // 1. Generate embedding for the query
      const contextualQuery = `Accessibility violation about ${query} in web development`;
      const queryEmbedding = await this.generateEmbedding(contextualQuery);
      if (!queryEmbedding || queryEmbedding.length === 0) {
        throw new Error('Failed to generate query embedding');
      }

      // 2. Retrieve all violations with embeddings
      const violations = await new Promise((resolve, reject) => {
        this.db.all(`
          SELECT 
            v.id,
            v.violation_id,
            v.description,
            v.severity,
            v.embedding,
            p.url,
            p.title,
            w.domain
          FROM violations v
          JOIN pages p ON v.page_id = p.id
          JOIN websites w ON p.website_id = w.id
          WHERE v.embedding IS NOT NULL
          LIMIT 1000
        `, [], (err, rows) => err ? reject(err) : resolve(rows || []));
      });

      // 3. Calculate similarities
      const results = violations.map(v => {
        try {
          const vec = v.embedding ? JSON.parse(v.embedding) : null;
          if (!vec || vec.length !== queryEmbedding.length) return null;
          
          return {
            ...v,
            similarity: this.cosineSimilarity(queryEmbedding, vec)
          };
        } catch (e) {
          console.error('Error processing violation:', v.id, e);
          return null;
        }
      })
      .filter(r => r !== null && r.similarity > 0.3) // Filter low matches
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, limit);

      return results;
    } catch (error) {
      console.error('Semantic search failed:', error);
      return [];
    }
  }

  cosineSimilarity(vecA, vecB) {
  // Decompress if needed
  const decompress = (embedding) => {
    if (typeof embedding === 'string') {
      return JSON.parse(embedding).map(val => val / 127);
    }
    return embedding;
  };

  // Input validation
  if (!vecA || !vecB) return 0;

  const a = decompress(vecA);
  const b = decompress(vecB);
  
  if (a.length !== b.length) return 0;

  // Calculate cosine similarity
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  return magA && magB ? dot / (Math.sqrt(magA) * Math.sqrt(magB)) : 0;
}

  /**
   * Generate text embedding using OpenAI
   */
  async generateEmbedding(text) {
    try {
      const response = await this.openai.embeddings.create({
        model: 'text-embedding-3-small',
        input: text
      });
      return response.data[0].embedding;
    } catch (error) {
      console.error('Embedding generation failed:', error);
      return [];
    }
  }

  async searchViolations(filters = {}, limit = 100) {
  const { violationId, severity, domain } = filters;
  
  return new Promise((resolve, reject) => {
    let query = `
      SELECT 
        v.id,
        v.violation_id as violationId,
        v.description,
        v.severity,
        v.html,
        v.suggestion,
        p.url,
        p.title,
        w.domain
      FROM violations v
      JOIN pages p ON v.page_id = p.id
      JOIN websites w ON p.website_id = w.id
      WHERE 1=1
    `;
    
    const params = [];
    
    // Exact match for violationId
    if (violationId) {
      query += ' AND v.violation_id = ?';
      params.push(violationId);
    }
    
    // Case-insensitive severity match
    if (severity) {
      query += ' AND LOWER(v.severity) = ?';
      params.push(severity.toLowerCase());
    }
    
    // Domain contains (partial match)
    if (domain) {
      query += ' AND w.domain LIKE ?';
      params.push(`%${domain}%`);
    }
    
    query += ' ORDER BY v.severity DESC LIMIT ?';
    params.push(limit);
    
    this.db.all(query, params, (err, rows) => {
      if (err) {
        console.error('Database query error:', err);
        reject(err);
      } else {
        // Transform to consistent response format
        const results = rows.map(row => ({
          id: row.id,
          violationId: row.violationId,
          description: row.description,
          severity: row.severity,
          html: row.html,
          suggestion: row.suggestion,
          url: row.url,
          title: row.title,
          domain: row.domain
        }));
        resolve(results);
      }
    });
  });
}
}

module.exports = SearchEngine;