// Minimal fixed-window, in-memory rate limiter for the auth endpoints.
// Suitable for a single-process deployment; swap for a shared store if
// the app is ever scaled out.
function createRateLimiter({ windowMs, max, message }) {
  const hits = new Map(); // key -> { start, count }

  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of hits) {
      if (now - entry.start >= windowMs) hits.delete(key);
    }
  }, windowMs);
  cleanup.unref();

  return function rateLimit(req, res, next) {
    const key = req.ip;
    const now = Date.now();
    let entry = hits.get(key);
    if (!entry || now - entry.start >= windowMs) {
      entry = { start: now, count: 0 };
      hits.set(key, entry);
    }
    entry.count += 1;
    if (entry.count > max) {
      const retryAfterSec = Math.ceil((entry.start + windowMs - now) / 1000);
      res.set('Retry-After', String(retryAfterSec));
      return res.status(429).json({ error: message });
    }
    next();
  };
}

module.exports = createRateLimiter;
