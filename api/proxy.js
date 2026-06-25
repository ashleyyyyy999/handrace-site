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

const INJECT_SCRIPT = `<script>
(function(){
  // Rewrite absolute midday.ai URLs to relative so they go through this proxy
  // (avoids CORS errors when midday's React components fetch their own API)
  var _origFetch = window.fetch;
  window.fetch = function(input, init) {
    try {
      var url = input instanceof Request ? input.url : String(input);
      if (url.indexOf('https://midday.ai') === 0) {
        url = url.slice('https://midday.ai'.length) || '/';
        input = input instanceof Request ? new Request(url, input) : url;
      }
    } catch(e) {}
    return _origFetch.apply(this, [input, init]);
  };
  // Inject Quadrant font after hydration so React never sees it as a mismatch
  document.addEventListener('DOMContentLoaded', function() {
    var l = document.createElement('link');
    l.rel = 'stylesheet';
    l.href = '/quadrant.css';
    document.head.appendChild(l);
  });
})();
</script>`

function injectFont(html) {
  // Inject our script FIRST in <head> so fetch is patched before React runs
  // The script dynamically appends the font link after DOMContentLoaded
  return html
    .replace(/<head>/i, '<head>' + INJECT_SCRIPT)
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
