import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFile, stat } from 'fs/promises';
import http from 'http';

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = express();
const PORT = process.env.PORT || 3102;
const MAX_LINES = parseInt(process.env.MAX_LINES || '500', 10);
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL || '2000', 10);
const DOCKER_SOCKET = process.env.DOCKER_SOCKET || '/var/run/docker.sock';

// Parse log sources from env
// Supports two types:
//   { "name": "App", "path": "/path/to/file.log" }              - file source
//   { "name": "Plex", "container": "big-bear-plex" }            - docker container
let LOG_SOURCES = [];
try {
  LOG_SOURCES = JSON.parse(process.env.LOG_SOURCES || '[]');
} catch (e) {
  console.error('Failed to parse LOG_SOURCES:', e.message);
}

// Docker API helper - calls Docker Engine via unix socket
function dockerGet(path) {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath: DOCKER_SOCKET, path, method: 'GET' }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        if (res.statusCode >= 400) {
          return reject(new Error(`Docker API ${res.statusCode}: ${body.toString()}`));
        }
        resolve(body);
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// Parse Docker log stream (multiplexed format: 8-byte header + payload per frame)
function parseDockerLogs(buffer) {
  const lines = [];
  let offset = 0;

  while (offset + 8 <= buffer.length) {
    // Header: [stream_type(1), 0, 0, 0, size(4 big-endian)]
    const size = buffer.readUInt32BE(offset + 4);
    offset += 8;

    if (offset + size > buffer.length) break;

    const text = buffer.subarray(offset, offset + size).toString('utf-8');
    // Split in case a single frame has multiple lines
    const frameLines = text.split('\n').filter(l => l.length > 0);
    lines.push(...frameLines);
    offset += size;
  }

  // If parsing as multiplexed yielded nothing, it might be plain text (tty mode)
  if (lines.length === 0 && buffer.length > 0) {
    return buffer.toString('utf-8').split('\n').filter(l => l.length > 0);
  }

  return lines;
}

// Per-source cache for docker logs (since docker doesn't support byte offsets)
const dockerCache = {};

async function fetchDockerLogs(source, sinceTimestamp) {
  const tail = sinceTimestamp ? '0' : String(MAX_LINES);
  let url = `/containers/${encodeURIComponent(source.container)}/logs?stdout=1&stderr=1&timestamps=1&tail=${tail}`;
  if (sinceTimestamp) {
    url += `&since=${sinceTimestamp}`;
  }
  const buf = await dockerGet(url);
  return parseDockerLogs(buf);
}

app.use(express.static(join(__dirname, 'public')));

// List configured log sources
app.get('/api/sources', (req, res) => {
  const sources = LOG_SOURCES.map((s, i) => ({
    id: i,
    name: s.name,
    type: s.container ? 'docker' : 'file'
  }));
  res.json({ sources, pollInterval: POLL_INTERVAL });
});

// Read log content
app.get('/api/logs/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (id < 0 || id >= LOG_SOURCES.length) {
    return res.status(404).json({ error: 'Log source not found' });
  }

  const source = LOG_SOURCES[id];

  // Docker container source
  if (source.container) {
    const afterTimestamp = req.query.after || '';

    try {
      if (!afterTimestamp) {
        // Initial load - get last MAX_LINES
        const lines = await fetchDockerLogs(source, null);
        // Extract timestamp from last line for future polling
        const lastTs = lines.length > 0 ? extractTimestamp(lines[lines.length - 1]) : '';
        const truncated = lines.length >= MAX_LINES;
        dockerCache[id] = { lastTs };
        return res.json({ lines, offset: lastTs, truncated });
      }

      // Poll for new lines since last timestamp
      // Add a tiny amount to avoid re-fetching the last line
      const sinceTs = afterTimestamp;
      const lines = await fetchDockerLogs(source, sinceTs);

      // Docker 'since' is inclusive, so skip first line if it matches the previous last
      const filtered = lines.length > 0 && dockerCache[id]?.lastLine === lines[0]
        ? lines.slice(1) : lines;

      const lastTs = filtered.length > 0 ? extractTimestamp(filtered[filtered.length - 1]) : sinceTs;
      if (filtered.length > 0) {
        dockerCache[id] = { lastTs, lastLine: filtered[filtered.length - 1] };
      }
      return res.json({ lines: filtered, offset: lastTs, truncated: false });
    } catch (err) {
      return res.json({ lines: ['[Docker error: ' + err.message + ']'], offset: afterTimestamp, truncated: false });
    }
  }

  // File source (original logic)
  const afterByte = parseInt(req.query.after || '0', 10);

  try {
    const stats = await stat(source.path);
    const fileSize = stats.size;

    if (afterByte >= fileSize) {
      return res.json({ lines: [], offset: fileSize, truncated: false });
    }

    if (afterByte === 0) {
      const content = await readFile(source.path, 'utf-8');
      const allLines = content.split('\n').filter(l => l.length > 0);
      const truncated = allLines.length > MAX_LINES;
      const lines = truncated ? allLines.slice(-MAX_LINES) : allLines;
      return res.json({ lines, offset: fileSize, truncated });
    }

    const { createReadStream } = await import('fs');
    const chunks = [];
    await new Promise((resolve, reject) => {
      const stream = createReadStream(source.path, {
        start: afterByte,
        encoding: 'utf-8'
      });
      stream.on('data', chunk => chunks.push(chunk));
      stream.on('end', resolve);
      stream.on('error', reject);
    });

    const newContent = chunks.join('');
    const newLines = newContent.split('\n').filter(l => l.length > 0);

    res.json({ lines: newLines, offset: fileSize, truncated: false });
  } catch (err) {
    if (err.code === 'ENOENT') {
      return res.json({ lines: ['[Log file not found: ' + source.path + ']'], offset: 0, truncated: false });
    }
    res.status(500).json({ error: 'Failed to read log: ' + err.message });
  }
});

// Check container/file status
app.get('/api/status/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (id < 0 || id >= LOG_SOURCES.length) {
    return res.status(404).json({ error: 'Source not found' });
  }

  const source = LOG_SOURCES[id];

  if (source.container) {
    try {
      const buf = await dockerGet(`/containers/${encodeURIComponent(source.container)}/json`);
      const info = JSON.parse(buf.toString());
      const running = info.State?.Running === true;
      const health = info.State?.Health?.Status; // "healthy", "unhealthy", "starting", or undefined
      let status = running ? 'running' : 'stopped';
      if (running && health === 'unhealthy') status = 'unhealthy';
      res.json({ status, detail: health || (running ? 'running' : info.State?.Status || 'stopped') });
    } catch (err) {
      res.json({ status: 'error', detail: err.message });
    }
  } else {
    try {
      await stat(source.path);
      res.json({ status: 'running', detail: 'file accessible' });
    } catch {
      res.json({ status: 'error', detail: 'file not found' });
    }
  }
});

// Extract RFC3339 timestamp from the beginning of a docker log line
function extractTimestamp(line) {
  const match = line.match(/^(\d{4}-\d{2}-\d{2}T[\d:.]+Z)/);
  return match ? match[1] : '';
}

app.listen(PORT, () => {
  console.log(`Log viewer running on port ${PORT}`);
  console.log(`Configured sources: ${LOG_SOURCES.map(s => s.name + (s.container ? ` [docker:${s.container}]` : ` [file:${s.path}]`)).join(', ') || 'none'}`);
});
