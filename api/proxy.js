const https = require('https')
const http = require('http')
const zlib = require('zlib')

// Inject Quadrant font override into HTML
function injectFont(html) {
  return html
    .replace(
      /<\/head>/i,
      '<link rel="stylesheet" href="/quadrant.css"/></head>'
    )
    // Strip CSP so our font and injected CSS are allowed
    .replace(/<meta[^>]*Content-Security-Policy[^>]*>/gi, '')
}

// Rewrite response headers — strip problematic ones
function filterHeaders(headers) {
  const blocked = new Set([
    'content-security-policy',
    'x-frame-options',
    'transfer-encoding',
    'content-encoding',
    'content-length',
    'connection',
    'keep-alive',
  ])
  const out = {}
  for (const [k, v] of Object.entries(headers)) {
    if (!blocked.has(k.toLowerCase())) out[k] = v
  }
  return out
}

module.exports = (req, res) => {
  // Vercel passes the original path via ?p= query param from the rewrite rule
  // Fall back to the raw URL path if query param is missing
  // Get the original path from Vercel's rewrite query param
  // p="" → root, p="pricing" → /pricing, p="pricing/features" → /pricing/features
  const p = (req.query && req.query.p != null) ? String(req.query.p) : ''
  const targetPath = p ? '/' + p.replace(/^\/+/, '') : '/'

  const options = {
    hostname: 'midday.ai',
    port: 443,
    path: targetPath,
    method: req.method || 'GET',
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      Accept:
        req.headers['accept'] ||
        'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
      'Cache-Control': 'no-cache',
      Pragma: 'no-cache',
    },
  }

  const proxyReq = https.request(options, (proxyRes) => {
    // Follow redirects manually (up to 5 hops)
    if (
      proxyRes.statusCode >= 301 &&
      proxyRes.statusCode <= 308 &&
      proxyRes.headers.location
    ) {
      res.writeHead(302, { Location: proxyRes.headers.location.replace('https://midday.ai', '') })
      return res.end()
    }

    const contentType = proxyRes.headers['content-type'] || ''
    const encoding = proxyRes.headers['content-encoding']

    if (contentType.includes('text/html')) {
      // Decompress if needed, modify HTML, send
      let chunks = []
      proxyRes.on('data', (chunk) => chunks.push(chunk))
      proxyRes.on('end', () => {
        const buf = Buffer.concat(chunks)
        const decode = (data) => {
          if (encoding === 'gzip') return zlib.gunzipSync(data)
          if (encoding === 'br') return zlib.brotliDecompressSync(data)
          if (encoding === 'deflate') return zlib.inflateSync(data)
          return data
        }
        try {
          const html = injectFont(decode(buf).toString('utf8'))
          const out = filterHeaders(proxyRes.headers)
          out['content-type'] = 'text/html; charset=utf-8'
          res.writeHead(proxyRes.statusCode || 200, out)
          res.end(html)
        } catch (e) {
          res.writeHead(500)
          res.end('Decompression error: ' + e.message)
        }
      })
    } else {
      // Pass binary content through
      const out = filterHeaders(proxyRes.headers)
      res.writeHead(proxyRes.statusCode || 200, out)

      // Pipe decompressed or raw
      if (encoding === 'gzip') {
        proxyRes.pipe(zlib.createGunzip()).pipe(res)
      } else if (encoding === 'br') {
        proxyRes.pipe(zlib.createBrotliDecompress()).pipe(res)
      } else if (encoding === 'deflate') {
        proxyRes.pipe(zlib.createInflate()).pipe(res)
      } else {
        proxyRes.pipe(res)
      }
    }
  })

  proxyReq.on('error', (e) => {
    res.writeHead(502)
    res.end('Upstream error: ' + e.message)
  })

  if (req.method === 'POST') {
    req.pipe(proxyReq)
  } else {
    proxyReq.end()
  }
}
