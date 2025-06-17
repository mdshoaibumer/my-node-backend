const puppeteer = require('puppeteer');
const { URL } = require('url');
const db = require('../db/schema');

class SiteCrawler {
  constructor() {
    this.browser = null;
    this.visited = new Set();
  }

  async init() {
    this.browser = await puppeteer.launch({ 
      headless: 'new',
      args: ['--no-sandbox']
    });
  }

  async crawl(baseUrl, maxDepth = 2) {
    const domain = new URL(baseUrl).hostname;
    const pages = [];
    const queue = [{ url: baseUrl, depth: 0 }];
    
    while (queue.length > 0) {
      const { url, depth } = queue.shift();
      
      if (depth > maxDepth || this.visited.has(url)) continue;
      this.visited.add(url);
      
      try {
        const page = await this.browser.newPage();
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
        
        // Extract page metadata
        const title = await page.title();
        const links = await page.evaluate(() => 
          Array.from(document.querySelectorAll('a[href]'))
            .map(a => a.href)
            .filter(href => href.startsWith('http'))
        );
        
        pages.push({ url, title });
        console.log(`Crawled: ${url} (Depth ${depth})`);
        
        // Add internal links to queue
        links.forEach(link => {
          try {
            const nextUrl = new URL(link);
            if (nextUrl.hostname === domain) {
              queue.push({ url: link, depth: depth + 1 });
            }
          } catch (e) {
            // Skip invalid URLs
          }
        });
        
        await page.close();
      } catch (error) {
        console.error(`Crawl error for ${url}:`, error.message);
      }
    }
    
    return pages;
  }

  async close() {
    if (this.browser) await this.browser.close();
  }
}

module.exports = SiteCrawler;