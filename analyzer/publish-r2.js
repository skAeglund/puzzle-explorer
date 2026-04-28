#!/usr/bin/env node
/**
 * publish-r2.js — Upload ./data to a Cloudflare R2 bucket via the S3-compatible API.
 *
 * Why R2 over the existing GitHub Pages data repo:
 *   - GitHub Pages caps published sites at 1GB (currently exceeded; enforced
 *     "on need basis"). Our full ~5.88M-puzzle build is ~2.4GB pre-cap, ~1.5GB
 *     post-MAX_PER_POSITION cap. R2 free tier is 10GB. Plenty of headroom.
 *   - R2 has zero egress fees behind Cloudflare's CDN. Same cache behavior the
 *     frontend already expects from Pages, with no Pages quota concerns.
 *
 * Strategy:
 *   1. List existing keys in the bucket (under PREFIX) → existingEtags
 *   2. Walk local data/ tree, computing MD5 ETag per file
 *   3. Skip uploads where local ETag matches existing ETag (= unchanged shards)
 *   4. Upload changed/new shards CONCURRENTLY (default 50 parallel)
 *   5. Delete bucket keys not in the local set (orphan cleanup)
 *   6. Upload meta.json LAST — acts as a soft commit marker. If steps 4-5 are
 *      interrupted the bucket is in a transient state, but meta.json stays
 *      the OLD one until the run completes. Re-running the script brings
 *      consistency back. Not transactional, but recoverable.
 *
 * Auth via env vars (or .env file in the data dir, parsed manually):
 *   R2_ACCOUNT_ID            32-char hex Cloudflare account id
 *   R2_BUCKET                bucket name
 *   R2_ACCESS_KEY_ID         R2 API token access key
 *   R2_SECRET_ACCESS_KEY     R2 API token secret
 *   R2_PREFIX                (optional) prefix inside bucket; default ''
 *
 * Usage:
 *   node analyzer/publish-r2.js
 *     [--source-dir DIR]     local data directory (default ./data; alias --data)
 *     [--prefix STR]         override R2_PREFIX env
 *     [--concurrency N]      parallel ops (default 50)
 *     [--dry-run]            print plan without uploading/deleting
 *     [--no-cleanup]         skip orphan deletion
 *
 * IMPORTANT: bucket-level CORS must allow the frontend's origin. Set once via
 * the Cloudflare dashboard (Bucket → Settings → CORS Policy) with something
 * like: AllowedOrigins=["https://skaeglund.github.io"], AllowedMethods=["GET"],
 * AllowedHeaders=["*"].
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');

// ─── CLI ─────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const pos = [];
  const flags = Object.create(null);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) flags[a.slice(2, eq)] = a.slice(eq + 1);
      else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) flags[a.slice(2)] = argv[++i];
      else flags[a.slice(2)] = true;
    } else { pos.push(a); }
  }
  return { pos, flags };
}

// ─── SigV4 (S3, region=auto, service=s3, UNSIGNED-PAYLOAD) ───────────────
// AWS Signature Version 4 spec; R2 implements it 1:1 against region "auto".
// We send all PUT/DELETE bodies with x-amz-content-sha256: UNSIGNED-PAYLOAD
// (TLS handles wire integrity; bucket auth handles authenticity). Saves us
// from having to hash multi-MB request bodies twice.
function hmac(key, msg) { return crypto.createHmac('sha256', key).update(msg).digest(); }
function sha256hex(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

// All path segments URL-encoded per RFC 3986 (unreserved chars unchanged).
function uriEncode(s, encodeSlash) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (
      (c >= 0x30 && c <= 0x39) || // 0-9
      (c >= 0x41 && c <= 0x5A) || // A-Z
      (c >= 0x61 && c <= 0x7A) || // a-z
      c === 0x2D || c === 0x2E || c === 0x5F || c === 0x7E  // - . _ ~
    ) { out += s[i]; }
    else if (c === 0x2F && !encodeSlash) { out += '/'; }
    else { out += '%' + s.charCodeAt(i).toString(16).toUpperCase().padStart(2, '0'); }
  }
  return out;
}

// canonical query: keys sorted, value-encoded, joined as k=v&k=v
function canonicalQueryString(query) {
  if (!query) return '';
  const pairs = [];
  for (const k of Object.keys(query).sort()) {
    pairs.push(uriEncode(k, true) + '=' + uriEncode(String(query[k]), true));
  }
  return pairs.join('&');
}

function signRequest({ method, host, canonicalUri, query, headers, accessKeyId, secretAccessKey, region, service, amzDate, dateStamp }) {
  const sortedHeaderKeys = Object.keys(headers).map(k => k.toLowerCase()).sort();
  const canonicalHeaders = sortedHeaderKeys.map(k => k + ':' + String(headers[Object.keys(headers).find(h => h.toLowerCase() === k)]).trim() + '\n').join('');
  const signedHeaders = sortedHeaderKeys.join(';');
  const canonicalRequest = [
    method,
    canonicalUri,
    canonicalQueryString(query),
    canonicalHeaders,
    signedHeaders,
    'UNSIGNED-PAYLOAD',
  ].join('\n');
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    sha256hex(canonicalRequest),
  ].join('\n');
  const kDate = hmac('AWS4' + secretAccessKey, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');
  return `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}

// ─── HTTPS request driver ────────────────────────────────────────────────
function httpsRequest({ method, host, path: urlPath, headers, body }) {
  return new Promise((resolve, reject) => {
    const opts = { method, host, path: urlPath, headers };
    const req = https.request(opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: buf,
        });
      });
    });
    req.on('error', reject);
    if (body && body.length > 0) req.write(body);
    req.end();
  });
}

// ─── S3 client (minimal, just what we need) ──────────────────────────────
function makeR2Client(cfg) {
  const { accountId, bucket, accessKeyId, secretAccessKey, region } = cfg;
  const host = `${accountId}.r2.cloudflarestorage.com`;
  const service = 's3';

  function timestamps() {
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');  // YYYYMMDDTHHMMSSZ
    const dateStamp = amzDate.slice(0, 8);                            // YYYYMMDD
    return { amzDate, dateStamp };
  }

  async function send(method, key, { body = null, query = null, contentType = null } = {}) {
    const { amzDate, dateStamp } = timestamps();
    const canonicalUri = key
      ? '/' + uriEncode(bucket) + '/' + uriEncode(key, false)
      : '/' + uriEncode(bucket) + '/';
    const headers = {
      'Host': host,
      'X-Amz-Date': amzDate,
      'X-Amz-Content-Sha256': 'UNSIGNED-PAYLOAD',
    };
    if (contentType) headers['Content-Type'] = contentType;
    if (body) headers['Content-Length'] = String(body.length);
    headers['Authorization'] = signRequest({
      method, host, canonicalUri, query, headers,
      accessKeyId, secretAccessKey, region, service, amzDate, dateStamp,
    });
    const qs = canonicalQueryString(query);
    return httpsRequest({
      method, host,
      path: canonicalUri + (qs ? '?' + qs : ''),
      headers,
      body,
    });
  }

  return {
    // Returns Map<key, etag-without-quotes>. ETags are MD5 of the object body
    // for non-multipart uploads (which is all we do).
    async list(prefix) {
      const out = new Map();
      let continuationToken = null;
      while (true) {
        const query = { 'list-type': '2', prefix: prefix || '' };
        if (continuationToken) query['continuation-token'] = continuationToken;
        const resp = await send('GET', '', { query });
        if (resp.status !== 200) {
          throw new Error(`list failed: ${resp.status} ${resp.body.toString('utf8').slice(0, 500)}`);
        }
        const xml = resp.body.toString('utf8');
        const re = /<Contents>([\s\S]*?)<\/Contents>/g;
        let m;
        while ((m = re.exec(xml)) !== null) {
          const blk = m[1];
          const km = blk.match(/<Key>([\s\S]*?)<\/Key>/);
          const em = blk.match(/<ETag>"?([^"<]*)"?<\/ETag>/);
          if (km && em) out.set(km[1], em[1].replace(/"/g, ''));
        }
        const truncated = /<IsTruncated>true<\/IsTruncated>/.test(xml);
        if (!truncated) break;
        const tokenMatch = xml.match(/<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/);
        if (!tokenMatch) break;
        continuationToken = tokenMatch[1];
      }
      return out;
    },
    async put(key, body, contentType) {
      const resp = await send('PUT', key, { body, contentType });
      if (resp.status < 200 || resp.status >= 300) {
        throw new Error(`put ${key} failed: ${resp.status} ${resp.body.toString('utf8').slice(0, 500)}`);
      }
      return resp;
    },
    async delete(key) {
      const resp = await send('DELETE', key, {});
      if (resp.status !== 204 && resp.status !== 200) {
        throw new Error(`delete ${key} failed: ${resp.status} ${resp.body.toString('utf8').slice(0, 500)}`);
      }
      return resp;
    },
  };
}

// ─── concurrency pool ────────────────────────────────────────────────────
async function runPool(items, concurrency, worker, onProgress) {
  const results = [];
  let next = 0;
  const errors = [];
  async function loop() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      try { results[i] = await worker(items[i], i); }
      catch (e) { errors.push({ item: items[i], err: e }); results[i] = null; }
      if (onProgress) onProgress(i + 1, items.length);
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => loop());
  await Promise.all(workers);
  return { results, errors };
}

// ─── walk local data dir → key→file map ──────────────────────────────────
function walkDataDir(dataDir, prefix) {
  const map = new Map();   // key → { absPath, etag (md5 hex) }
  function visit(rel) {
    const abs = path.join(dataDir, rel);
    const stat = fs.statSync(abs);
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(abs)) {
        if (entry.startsWith('.')) continue;  // skip .git/, .tmp-index/
        visit(rel ? rel + '/' + entry : entry);
      }
    } else if (stat.isFile()) {
      const data = fs.readFileSync(abs);
      const md5 = crypto.createHash('md5').update(data).digest('hex');
      const key = (prefix ? prefix + '/' : '') + rel;
      map.set(key, { absPath: abs, etag: md5, size: stat.size });
    }
  }
  visit('');
  return map;
}

function contentTypeFor(key) {
  if (key.endsWith('.json')) return 'application/json';
  if (key.endsWith('.ndjson')) return 'application/x-ndjson';
  if (key.endsWith('.html')) return 'text/html';
  return 'application/octet-stream';
}

// ─── main publish driver (testable: client is injected) ──────────────────
async function publish({ dataDir, client, prefix, concurrency, dryRun, cleanup, log }) {
  const t0 = Date.now();
  log(`scanning local: ${dataDir}`);
  const local = walkDataDir(dataDir, prefix);
  log(`  ${local.size} local files, ${[...local.values()].reduce((a, v) => a + v.size, 0)} bytes total`);

  log(`listing remote (prefix="${prefix}")...`);
  const remote = await client.list(prefix);
  log(`  ${remote.size} remote keys`);

  // Plan: skip = matched ETag (unchanged), upload = differ/new, delete = orphan.
  const toUpload = [];
  let skipped = 0;
  // meta.json deferred: uploaded last as commit marker.
  const metaKey = (prefix ? prefix + '/' : '') + 'meta.json';
  let metaPlanned = null;
  for (const [key, info] of local) {
    const remoteEtag = remote.get(key);
    if (remoteEtag === info.etag) { skipped++; continue; }
    if (key === metaKey) { metaPlanned = { key, info }; continue; }
    toUpload.push({ key, info });
  }
  const toDelete = [];
  if (cleanup) {
    for (const key of remote.keys()) {
      if (!local.has(key)) toDelete.push(key);
    }
  }

  log(`plan: ${toUpload.length} upload, ${skipped} skip-unchanged, ${toDelete.length} delete${metaPlanned ? ', meta.json deferred to last' : ''}`);

  if (dryRun) {
    log('--dry-run: not executing.');
    if (toUpload.length) log('  would upload:\n    ' + toUpload.slice(0, 10).map(u => u.key).join('\n    ') + (toUpload.length > 10 ? `\n    ... ${toUpload.length - 10} more` : ''));
    if (toDelete.length) log('  would delete:\n    ' + toDelete.slice(0, 10).join('\n    ') + (toDelete.length > 10 ? `\n    ... ${toDelete.length - 10} more` : ''));
    return { uploaded: 0, deleted: 0, skipped, errors: [], dryRun: true, durationMs: Date.now() - t0 };
  }

  // ─── upload phase ───
  let uploadedCount = 0;
  const uploadResult = await runPool(toUpload, concurrency, async ({ key, info }) => {
    const body = fs.readFileSync(info.absPath);
    await client.put(key, body, contentTypeFor(key));
    uploadedCount++;
  }, (done, total) => {
    if (done % 200 === 0 || done === total) log(`  upload ${done}/${total}`);
  });
  log(`uploaded: ${uploadedCount}/${toUpload.length} (errors: ${uploadResult.errors.length})`);

  // ─── delete phase ───
  let deletedCount = 0;
  let deleteErrors = [];
  if (toDelete.length) {
    const deleteResult = await runPool(toDelete, concurrency, async (key) => {
      await client.delete(key);
      deletedCount++;
    }, (done, total) => {
      if (done % 200 === 0 || done === total) log(`  delete ${done}/${total}`);
    });
    deleteErrors = deleteResult.errors;
    log(`deleted: ${deletedCount}/${toDelete.length} (errors: ${deleteErrors.length})`);
  }

  // ─── meta.json (commit marker) ───
  if (metaPlanned) {
    log('uploading meta.json (commit marker)...');
    const body = fs.readFileSync(metaPlanned.info.absPath);
    await client.put(metaPlanned.key, body, contentTypeFor(metaPlanned.key));
    uploadedCount++;
  }

  return {
    uploaded: uploadedCount,
    deleted: deletedCount,
    skipped,
    errors: [...uploadResult.errors, ...deleteErrors].map(e => ({ item: e.item, message: e.err && e.err.message })),
    dryRun: false,
    durationMs: Date.now() - t0,
  };
}

// ─── env loader (env vars + optional .env in data dir) ───────────────────
function loadEnv(dataDir) {
  const env = Object.assign({}, process.env);
  const envFile = path.join(dataDir, '..', '.env.r2');
  if (fs.existsSync(envFile)) {
    const lines = fs.readFileSync(envFile, 'utf8').split(/\r?\n/);
    for (const ln of lines) {
      const m = ln.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && !env[m[1]]) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
  return env;
}

// ─── CLI entry ───────────────────────────────────────────────────────────
async function main() {
  const { flags } = parseArgs(process.argv.slice(2));
  const DATA_DIR = path.resolve(flags['source-dir'] || flags.data || './data');
  const env = loadEnv(DATA_DIR);

  const accountId = env.R2_ACCOUNT_ID;
  const bucket = env.R2_BUCKET;
  const accessKeyId = env.R2_ACCESS_KEY_ID;
  const secretAccessKey = env.R2_SECRET_ACCESS_KEY;
  const prefix = flags.prefix != null ? String(flags.prefix) : (env.R2_PREFIX || '');
  const concurrency = flags.concurrency ? Math.max(1, parseInt(flags.concurrency, 10) || 50) : 50;
  const dryRun = !!flags['dry-run'];
  const cleanup = !flags['no-cleanup'];

  if (!accountId || !bucket || !accessKeyId || !secretAccessKey) {
    console.error('Missing R2 credentials. Set in env or .env.r2 next to the data dir:');
    console.error('  R2_ACCOUNT_ID, R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY');
    process.exit(1);
  }
  if (!fs.existsSync(DATA_DIR)) {
    console.error(`data dir not found: ${DATA_DIR}`);
    process.exit(1);
  }

  const client = makeR2Client({ accountId, bucket, accessKeyId, secretAccessKey, region: 'auto' });
  console.log(`publishing ${DATA_DIR} → r2://${bucket}/${prefix}${prefix ? '/' : ''}`);
  console.log(`concurrency: ${concurrency}, cleanup: ${cleanup}, dry-run: ${dryRun}`);
  const meta = await publish({
    dataDir: DATA_DIR, client, prefix, concurrency, dryRun, cleanup,
    log: (...a) => console.log(...a),
  });
  console.log('\n─── publish complete ───');
  console.log(JSON.stringify(meta, null, 2));
}

if (require.main === module) {
  main().catch(err => { console.error(err); process.exit(1); });
}

module.exports = {
  parseArgs,
  uriEncode,
  canonicalQueryString,
  signRequest,
  walkDataDir,
  contentTypeFor,
  runPool,
  publish,
};
