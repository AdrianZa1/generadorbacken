import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import { pathToFileURL, fileURLToPath } from 'url';
import fs from 'fs/promises';
import os from 'os';
import puppeteer from 'puppeteer';
import { PDFDocument } from 'pdf-lib';

dotenv.config();

const app = express();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// CORS: allow specific origins via ALLOWED_ORIGINS env (comma-separated), otherwise allow all
const allowedEnv = process.env.ALLOWED_ORIGINS;
const allowedList = allowedEnv ? allowedEnv.split(',').map(s => s.trim()).filter(Boolean) : null;
app.use(cors({ origin: (origin, cb) => {
  if (!allowedList || allowedList.length === 0) return cb(null, true);
  if (!origin) return cb(null, true);
  if (allowedList.includes(origin)) return cb(null, true);
  return cb(new Error('CORS not allowed'));
}}));

app.use(express.json({ limit: '20mb' }));

// Serve frontend static files from ../docs
app.use(express.static(path.resolve(__dirname, '..', 'docs')));

const OPENAI_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_KEY) {
  console.warn('Warning: OPENAI_API_KEY not set. /api/gpt will return 503. This is OK if you use client-side key.');
}

app.post('/api/gpt', async (req, res) => {
  try {
    if (!OPENAI_KEY) return res.status(503).json({ error: 'OPENAI_API_KEY not configured on server' });
    const { prompt, max_tokens = 200 } = req.body;
    if (!prompt) return res.status(400).json({ error: 'prompt required' });

    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_KEY}`
      },
      body: JSON.stringify({
        model: 'gpt-3.5-turbo',
        messages: [{ role: 'user', content: prompt }],
        max_tokens
      })
    });

    const data = await r.json();
    const text = data?.choices?.[0]?.message?.content || data?.choices?.[0]?.text || '';
    res.json({ text });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || String(err) });
  }
});

// Endpoint para generar PDF server-side usando Puppeteer
app.post('/generate-pdf', async (req, res) => {
  try {
    const { html } = req.body;
    if (!html) return res.status(400).json({ error: 'html required' });

    // Crear archivo temporal
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cv-html-'));
    const tmpFile = path.join(tmpDir, 'cv.html');
    await fs.writeFile(tmpFile, html, 'utf8');

    const browser = await puppeteer.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const page = await browser.newPage();
    await page.goto(pathToFileURL(tmpFile).href, { waitUntil: 'networkidle0' });
    const pdfBuffer = await page.pdf({ format: 'A4', printBackground: true, margin: { top: '20mm', right: '15mm', bottom: '20mm', left: '15mm' } });
    await browser.close();

    // Limpiar
    try { await fs.rm(tmpDir, { recursive: true, force: true }); } catch (e) {}

    const outBuf = Buffer.from(pdfBuffer);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename=Mi_CV.pdf');
    res.setHeader('Content-Length', outBuf.length);
    res.end(outBuf);
  } catch (err) {
    console.error('generate-pdf error', err);
    res.status(500).json({ error: String(err) });
  }
});

// Merge base PDF and attachments server-side
app.post('/merge-pdfs', async (req, res) => {
  try {
    const { basePdf, attachments } = req.body;
    if (!basePdf) return res.status(400).json({ error: 'basePdf required' });

    const toBuffer = (input) => {
      if (!input) return null;
      const s = String(input || '');
      if (s.startsWith('data:')) {
        const parts = s.split(',');
        return Buffer.from(parts[1] || '', 'base64');
      }
      return Buffer.from(s, 'base64');
    };

    const baseBuf = toBuffer(basePdf);
    if (!baseBuf) return res.status(400).json({ error: 'invalid basePdf' });

    const baseDoc = await PDFDocument.load(baseBuf);

    for (const att of (attachments || [])) {
      try {
        const attBuf = toBuffer(att.fileData || att.data || '');
        if (!attBuf) continue;
        const attDoc = await PDFDocument.load(attBuf);
        const copied = await baseDoc.copyPages(attDoc, attDoc.getPageIndices());
        copied.forEach(p => baseDoc.addPage(p));
      } catch (e) {
        console.error('Failed to append attachment', e, att && att.fileName);
      }
    }

    const merged = await baseDoc.save();
    const outBuf = Buffer.from(merged);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename=Mi_CV_con_adjuntos.pdf');
    res.setHeader('Content-Length', outBuf.length);
    res.end(outBuf);
  } catch (err) {
    console.error('merge-pdfs error', err);
    res.status(500).json({ error: String(err) });
  }
});

// Health check for platform health checks
app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), time: new Date().toISOString() });
});

// Basic root info
app.get('/', (req, res) => {
  res.type('text').send('Asistente CV backend. Endpoints: /api/gpt, /generate-pdf, /health');
});

const PORT = process.env.PORT || 3000;
const allowedStr = allowedList ? allowedList.join(',') : 'any';
app.listen(PORT, () => {
  console.log(`Backend API running on http://localhost:${PORT}`);
  console.log(`CORS allowed origins: ${allowedStr}`);
});
