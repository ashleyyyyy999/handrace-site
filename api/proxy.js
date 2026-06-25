function injectFont(html) {
  return html
    .replace(/<\/head>/i, '<link rel="stylesheet" href="/quadrant.css"/></head>')
    .replace(/<meta[^>]*Content-Security-Policy[^>]*>/gi, '')
}

function filterHeaders(headers) {
  const blocked = new Set([
    'content-security-policy',
    'x-frame-options',
    'transfer-encoding',
    'content-length',
    'connection',
    'keep-alive',
  ])
  const out = {}
  headers.forEach((v, k) => {
    if (!blocked.has(k.toLowerCase())) out[k] = v
  })
  return out
}

module.exports = async (req, res) => {
  // Get original path from Vercel's ?p= rewrite param
  const p = req.query && req.query.p != null ? String(req.query.p) : ''
  const pathPart = p ? '/' + p.replace(/^\/+/, '') : '/'

  // Build upstream URL safely using the URL constructor
  const upstream = new URL(pathPart, 'https://midday.ai')

  try {
    const response = await fetch(upstream.toString(), {
      method: req.method || 'GET',
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        Accept:
          req.headers['accept'] ||
          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cache-Control': 'no-cache',
      },
      redirect: 'manual', // handle redirects ourselves so they stay relative
    })

    // Convert relative redirects (strip upstream origin)
    if (response.status >= 301 && response.status <= 308) {
      const loc = response.headers.get('location') || '/'
      const relLoc = loc.startsWith('https://midday.ai')
        ? loc.slice('https://midday.ai'.length)
        : loc
      res.writeHead(response.status, { location: relLoc })
      return res.end()
    }

    const contentType = response.headers.get('content-type') || ''
    const outHeaders = filterHeaders(response.headers)

    if (contentType.includes('text/html')) {
      const rawHtml = await response.text()
      const html = injectFont(rawHtml)
      outHeaders['content-type'] = 'text/html; charset=utf-8'
      res.writeHead(response.status, outHeaders)
      res.end(html)
    } else {
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
