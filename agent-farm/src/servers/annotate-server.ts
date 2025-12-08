#!/usr/bin/env node

/**
 * Annotation server for file review.
 * Serves the annotation viewer and handles file saves.
 *
 * Usage: node annotate-server.js <port> <filepath>
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Parse arguments
const args = process.argv.slice(2);
const port = parseInt(args[0] || '8080', 10);
const filePath = args[1];

if (!filePath) {
  console.error('Usage: annotate-server.js <port> <filepath>');
  process.exit(1);
}

// Paths
const fullFilePath = filePath;
const displayPath = path.basename(filePath);

/**
 * Find the annotate template
 * Template is bundled with agent-farm package in templates/ directory
 */
function findTemplatePath(): string {
  const filename = 'annotate.html';

  // 1. Try relative to compiled output (dist/servers/ -> templates/)
  const pkgPath = path.resolve(__dirname, '../templates/', filename);
  if (fs.existsSync(pkgPath)) return pkgPath;

  // 2. Try relative to source (src/servers/ -> templates/)
  const devPath = path.resolve(__dirname, '../../templates/', filename);
  if (fs.existsSync(devPath)) return devPath;

  throw new Error(`Template not found: ${filename}`);
}

const templatePath = findTemplatePath();

// Validate file exists
if (!fs.existsSync(fullFilePath)) {
  console.error(`File not found: ${fullFilePath}`);
  process.exit(1);
}

// Get language from extension
const ext = path.extname(filePath).slice(1).toLowerCase();
const langMap: Record<string, string> = {
  js: 'javascript', ts: 'typescript', jsx: 'javascript', tsx: 'typescript',
  py: 'python', sh: 'bash', bash: 'bash',
  md: 'markdown', html: 'markup', css: 'css',
  json: 'json', yaml: 'yaml', yml: 'yaml'
};
const lang = langMap[ext] || ext;

// Create server
const server = http.createServer((req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  // Serve annotation viewer
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    try {
      let template = fs.readFileSync(templatePath, 'utf-8');
      const fileContent = fs.readFileSync(fullFilePath, 'utf-8');

      // Replace placeholders
      template = template.replace(/\{\{BUILDER_ID\}\}/g, '');
      template = template.replace(/\{\{FILE_PATH\}\}/g, fullFilePath);
      template = template.replace(/\{\{FILE\}\}/g, displayPath);
      template = template.replace(/\{\{LANG\}\}/g, lang);

      // Inject file content
      const escapedContent = JSON.stringify(fileContent);
      template = template.replace(
        '// FILE_CONTENT will be injected by the server',
        `init(${escapedContent});`
      );

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(template);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Error loading viewer: ' + (err as Error).message);
    }
    return;
  }

  // Handle file reload (GET /file)
  if (req.method === 'GET' && req.url?.startsWith('/file')) {
    try {
      // Re-read file from disk
      const fileContent = fs.readFileSync(fullFilePath, 'utf-8');
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(fileContent);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Error reading file: ' + (err as Error).message);
    }
    return;
  }

  // Handle file save
  if (req.method === 'POST' && req.url === '/save') {
    let body = '';
    req.on('data', (chunk: Buffer) => body += chunk.toString());
    req.on('end', () => {
      try {
        const { file, content } = JSON.parse(body);

        // Security: only allow saving the opened file
        if (file !== fullFilePath) {
          res.writeHead(403, { 'Content-Type': 'text/plain' });
          res.end('Cannot save to different file');
          return;
        }

        fs.writeFileSync(fullFilePath, content, 'utf-8');
        console.log(`Saved: ${fullFilePath}`);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Error saving file: ' + (err as Error).message);
      }
    });
    return;
  }

  // 404 for everything else
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

server.listen(port, () => {
  console.log(`Annotation Viewer: http://localhost:${port}`);
  console.log(`File: ${fullFilePath}`);
});
