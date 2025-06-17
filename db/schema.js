const sqlite3 = require('sqlite3').verbose();
const path = require('path');

module.exports = async function() {
  const DB_PATH = path.resolve(__dirname, '../complyai-search.db');
  const db = new sqlite3.Database(DB_PATH);
  console.log(DB_PATH);
  
  await new Promise((resolve, reject) => {
    db.serialize(() => {
      db.run('PRAGMA foreign_keys = ON');
      
      db.run(`CREATE TABLE IF NOT EXISTS websites (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        domain TEXT UNIQUE NOT NULL,
        compliance_score REAL DEFAULT 100,
        last_scanned DATETIME DEFAULT CURRENT_TIMESTAMP
      )`);
      
      db.run(`CREATE TABLE IF NOT EXISTS pages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        website_id INTEGER NOT NULL,
        url TEXT UNIQUE NOT NULL,
        title TEXT,
        risk_score REAL DEFAULT 0,
        scan_data TEXT,
        last_scanned DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(website_id) REFERENCES websites(id) ON DELETE CASCADE
      )`);
      
      db.run(`CREATE TABLE IF NOT EXISTS violations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        page_id INTEGER NOT NULL,
        violation_id TEXT NOT NULL,
        description TEXT NOT NULL,
        severity TEXT NOT NULL,
        html TEXT,
        suggestion TEXT,
        embedding TEXT,
        FOREIGN KEY(page_id) REFERENCES pages(id) ON DELETE CASCADE
      )`, (err) => {
        if (err) reject(err);
        else resolve(db);
      });
    });
  });
  
  return db;
};