#!/usr/bin/env node

/**
 * Open server for file viewing/editing.
 * Serves the file viewer and handles file saves.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { escapeHtml } from '../utils/server-utils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Parse arguments with Commander
const program = new Command()
  .name('open-server')
  .description('File viewer/editor server for Agent Farm')
  .argument('<port>', 'Port to listen on')
  .argument('<filepath>', 'File path to open')
  .parse(process.argv);

const args = program.args;
const port = parseInt(args[0], 10);
const filePath = args[1];

if (isNaN(port) || port < 1 || port > 65535) {
  console.error(`Error: Invalid port "${args[0]}". Must be a number between 1 and 65535.`);
  process.exit(1);
}

// Paths
const fullFilePath = filePath;
const displayPath = path.basename(filePath);

/**
 * Find a template file
 * Templates are bundled with agent-farm package in templates/ directory
 */
function findTemplatePath(filename: string): string {
  // Templates are at package root: packages/codev/templates/
  // From compiled: dist/agent-farm/servers/ -> ../../../templates/
  // From source: src/agent-farm/servers/ -> ../../../templates/
  const pkgPath = path.resolve(__dirname, '../../../templates/', filename);
  if (fs.existsSync(pkgPath)) return pkgPath;

  throw new Error(`Template not found: ${filename}`);
}

const templatePath = findTemplatePath('open.html');

// escapeHtml imported from ../utils/server-utils.js

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
const isMarkdown = ext === 'md';

// Image detection
const imageExtensions = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'];
const isImage = imageExtensions.includes(ext);

// Video detection
const videoExtensions = ['webm', 'mp4', 'mov', 'avi'];
const isVideo = videoExtensions.includes(ext);

// 3D model detection (STL and 3MF)
const isSTL = ext === 'stl';
const is3MF = ext === '3mf';
const is3D = isSTL || is3MF;
const format3D = isSTL ? 'stl' : '3mf';
const viewerTemplatePath3D = is3D ? findTemplatePath('3d-viewer.html') : null;

// MIME type mapping for images
const imageMimeTypes: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml'
};

// MIME type mapping for videos
const videoMimeTypes: Record<string, string> = {
  webm: 'video/webm',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  avi: 'video/x-msvideo'
};

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

  // Parse URL for robust pathname matching (handles query strings, etc.)
  const url = new URL(req.url || '/', `http://localhost:${port}`);
  const pathname = url.pathname;

  // Serve 3D viewer for STL and 3MF files
  if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html') && is3D && viewerTemplatePath3D) {
    try {
      let template = fs.readFileSync(viewerTemplatePath3D, 'utf-8');

      // Replace placeholders with proper escaping for security
      // FILE_PATH_JSON: JSON-encoded for JavaScript string context
      template = template.replace(/\{\{FILE_PATH_JSON\}\}/g, JSON.stringify(fullFilePath));
      // FILE: HTML-escaped for HTML context (title, visible text)
      template = template.replace(/\{\{FILE\}\}/g, escapeHtml(displayPath));
      // FORMAT: hardcoded 'stl' or '3mf', no escaping needed
      template = template.replace(/\{\{FORMAT\}\}/g, format3D);

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(template);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Error loading 3D viewer: ' + (err as Error).message);
    }
    return;
  }

  // Serve annotation viewer for other files
  if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
    try {
      let template = fs.readFileSync(templatePath, 'utf-8');

      // Get file stats for images
      const fileStats = fs.statSync(fullFilePath);
      const fileSize = fileStats.size;

      // Replace placeholders
      template = template.replace(/\{\{BUILDER_ID\}\}/g, '');
      template = template.replace(/\{\{FILE_PATH\}\}/g, fullFilePath);
      template = template.replace(/\{\{FILE\}\}/g, displayPath);
      template = template.replace(/\{\{LANG\}\}/g, lang);
      template = template.replace(/\{\{IS_MARKDOWN\}\}/g, String(isMarkdown));
      template = template.replace(/\{\{IS_IMAGE\}\}/g, String(isImage));
      template = template.replace(/\{\{IS_VIDEO\}\}/g, String(isVideo));
      template = template.replace(/\{\{FILE_SIZE\}\}/g, String(fileSize));

      if (isImage) {
        // For images, don't inject file content - it will be loaded via /api/image
        template = template.replace(
          '// FILE_CONTENT will be injected by the server',
          `initImage(${fileSize});`
        );
      } else if (isVideo) {
        // For videos, don't inject file content - it will be loaded via /api/video
        template = template.replace(
          '// FILE_CONTENT will be injected by the server',
          `initVideo(${fileSize});`
        );
      } else {
        // For text files, inject content as before
        const fileContent = fs.readFileSync(fullFilePath, 'utf-8');
        // JSON.stringify escapes quotes but not </script> which would break HTML parsing
        // Replace </script> with <\/script> (valid JS, doesn't match HTML closing tag)
        const escapedContent = JSON.stringify(fileContent).replace(/<\/script>/gi, '<\\/script>');
        template = template.replace(
          '// FILE_CONTENT will be injected by the server',
          `init(${escapedContent});`
        );
      }

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(template);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Error loading viewer: ' + (err as Error).message);
    }
    return;
  }

  // Handle file reload (GET /file)
  if (req.method === 'GET' && pathname.startsWith('/file')) {
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

  // Handle image content (GET /api/image)
  if (req.method === 'GET' && pathname.startsWith('/api/image')) {
    if (!isImage) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Not an image file');
      return;
    }

    try {
      const imageData = fs.readFileSync(fullFilePath);
      const mimeType = imageMimeTypes[ext] || 'application/octet-stream';
      res.writeHead(200, {
        'Content-Type': mimeType,
        'Content-Length': imageData.length,
        'Cache-Control': 'no-cache'  // Don't cache, allow reload to work
      });
      res.end(imageData);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Error reading image: ' + (err as Error).message);
    }
    return;
  }

  // Handle video content (GET /api/video)
  if (req.method === 'GET' && pathname.startsWith('/api/video')) {
    if (!isVideo) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Not a video file');
      return;
    }

    try {
      const videoData = fs.readFileSync(fullFilePath);
      const mimeType = videoMimeTypes[ext] || 'application/octet-stream';
      res.writeHead(200, {
        'Content-Type': mimeType,
        'Content-Length': videoData.length,
        'Cache-Control': 'no-cache'  // Don't cache, allow reload to work
      });
      res.end(videoData);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Error reading video: ' + (err as Error).message);
    }
    return;
  }

  // Handle file mtime check (GET /api/mtime) - for auto-reload
  if (req.method === 'GET' && pathname.startsWith('/api/mtime')) {
    try {
      const stat = fs.statSync(fullFilePath);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ mtime: stat.mtimeMs }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to stat file' }));
    }
    return;
  }

  // Handle 3D model content (GET /api/model) - supports STL and 3MF
  if (req.method === 'GET' && pathname.startsWith('/api/model')) {
    if (!is3D) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Not a 3D model file');
      return;
    }

    try {
      const modelData = fs.readFileSync(fullFilePath);
      const mimeType = isSTL ? 'model/stl' : 'model/3mf';
      res.writeHead(200, {
        'Content-Type': mimeType,
        'Content-Length': modelData.length,
        'Cache-Control': 'no-cache'
      });
      res.end(modelData);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Error reading 3D model: ' + (err as Error).message);
    }
    return;
  }

  // Handle legacy STL endpoint (GET /api/stl) - redirects to /api/model
  if (req.method === 'GET' && pathname.startsWith('/api/stl')) {
    if (!isSTL) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Not an STL file');
      return;
    }

    try {
      const stlData = fs.readFileSync(fullFilePath);
      res.writeHead(200, {
        'Content-Type': 'model/stl',
        'Content-Length': stlData.length,
        'Cache-Control': 'no-cache'
      });
      res.end(stlData);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Error reading STL: ' + (err as Error).message);
    }
    return;
  }

  // Handle file save
  if (req.method === 'POST' && pathname === '/save') {
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
  console.log(`File Viewer: http://localhost:${port}`);
  console.log(`File: ${fullFilePath}`);
});
