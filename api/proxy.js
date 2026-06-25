// Headers we forward from the browser to midday.ai
const FORWARD_REQUEST_HEADERS = [
  'accept',
  'accept-language',
  'cache-control',
  'pragma',
  // Next.js App Router specific — must be forwarded or client gets wrong response type
  'rsc',
  'next-router-state-tree',
  'next-router-prefetch',
  'next-router-segment-prefetch',
  'next-url',
  'next-router-server-props',
]

// Headers we strip from midday.ai's response before passing to browser
const BLOCKED_RESPONSE_HEADERS = new Set([
  'content-security-policy',
  'x-frame-options',
  'transfer-encoding',
  'content-length',
  'connection',
  'keep-alive',
])

function buildRequestHeaders(reqHeaders) {
  const out = {
    'User-Agent':
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  }
  for (const key of FORWARD_REQUEST_HEADERS) {
    const val = reqHeaders[key]
    if (val) out[key] = val
  }
  return out
}

function filterResponseHeaders(headers) {
  const out = {}
  headers.forEach((v, k) => {
    if (!BLOCKED_RESPONSE_HEADERS.has(k.toLowerCase())) out[k] = v
  })
  return out
}

function injectFont(html) {
  // Inject font override right before </body> so React's head hydration is unaffected
  const fontLink = '<link rel="stylesheet" href="/quadrant.css"/>'
  if (html.includes('</body>')) {
    return html
      .replace('</body>', fontLink + '</body>')
      .replace(/<meta[^>]*Content-Security-Policy[^>]*>/gi, '')
  }
  // Fallback: before </html>
  return html
    .replace('</html>', fontLink + '</html>')
    .replace(/<meta[^>]*Content-Security-Policy[^>]*>/gi, '')
}

module.exports = async (req, res) => {
  const p = req.query && req.query.p != null ? String(req.query.p) : ''
  const pathPart = p ? '/' + p.replace(/^\/+/, '') : '/'

  const upstream = new URL(pathPart, 'https://midday.ai')

  try {
    const response = await fetch(upstream.toString(), {
      method: req.method || 'GET',
      headers: buildRequestHeaders(req.headers),
      redirect: 'manual',
    })

    // Pass redirects through (strip upstream origin to keep navigation local)
    if (response.status >= 301 && response.status <= 308) {
      const loc = response.headers.get('location') || '/'
      const relLoc = loc.startsWith('https://midday.ai')
        ? loc.slice('https://midday.ai'.length)
        : loc
      res.writeHead(response.status, { location: relLoc })
      return res.end()
    }

    const contentType = response.headers.get('content-type') || ''
    const outHeaders = filterResponseHeaders(response.headers)

    if (contentType.includes('text/html')) {
      const rawHtml = await response.text()
      const html = injectFont(rawHtml)
      outHeaders['content-type'] = 'text/html; charset=utf-8'
      res.writeHead(response.status, outHeaders)
      res.end(html)
    } else {
      // Pass RSC payloads (text/x-component), JS, images, etc. through unchanged
      const buf = await response.arrayBuffer()
      outHeaders['content-type'] = contentType
      res.writeHead(response.status, outHeaders)
      res.end(Buffer.from(buf))
    }
  } catch (e) {
    res.writeHead(502)
    res.end('Upstream error: ' + e.message)
  }
}
