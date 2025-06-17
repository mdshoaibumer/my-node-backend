const express = require('express');
const router = express.Router();

module.exports = (searchEngine) => {
  // Semantic Search
  router.post('/semantic', async (req, res) => {
  try {
    const { query, limit } = req.body;
    
    if (!query || typeof query !== 'string') {
      return res.status(400).json({ error: 'Valid query string required' });
    }

    const results = await searchEngine.semanticSearch(query, limit || 5);
    
    res.json({
      success: true,
      query,
      results: results.map(r => ({
        violationId: r.violation_id,
        description: r.description,
        severity: r.severity,
        similarity: (r.similarity * 100).toFixed(1) + '%', // Show as percentage
        url: r.url,
        domain: r.domain
      }))
    });
    
  } catch (error) {
    res.status(500).json({ 
      success: false,
      error: 'Semantic search failed',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

  // Violations Search
  // Violations Search - Updated endpoint
  router.get('/violations', async (req, res) => {
    try {
      const { violationId, severity, domain } = req.query;
      
      if (!violationId && !severity && !domain) {
        return res.status(400).json({ 
          error: 'At least one search parameter required (violationId, severity, or domain)' 
        });
      }

      const filters = {};
      if (violationId) filters.violationId = violationId;
      if (severity) filters.severity = severity.toLowerCase(); // Normalize case
      if (domain) filters.domain = domain;

      const results = await searchEngine.searchViolations(filters);
      res.json(results);
      
    } catch (error) {
      console.error('Violations search error:', error);
      res.status(500).json({ 
        error: 'Violations search failed',
        details: process.env.NODE_ENV === 'development' ? error.message : undefined
      });
    }
  });

  // Compliance Search
  router.get('/compliance', async (req, res) => {
    try {
      const minScore = Number(req.query.minScore) || 0;
      const results = await searchEngine.searchWebsitesByCompliance(minScore);
      res.json(results.length > 0 ? results : []);
    } catch (error) {
      console.error('Compliance search error:', error);
      res.status(500).json({ error: 'Compliance search failed' });
    }
  });

  return router;
};