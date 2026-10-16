/**
 * Express error handler for both processes. It never puts an error's message into a log line: a JSON parse
 * error quotes the request body, and a request body can be a credential being saved. Expected errors
 * (status < 500) carry messages written by this app, which never contain values, and go back to the client.
 * Unexpected ones log only their name and code locations.
 */
export function createErrorHandler(processName) {
  // eslint-disable-next-line no-unused-vars
  return (err, req, res, _next) => {
    if (res.headersSent) return;
    if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: "The request body isn't valid JSON" });
    if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'The request body is too large' });
    const status = Number.isInteger(err?.status) ? err.status : 500;
    // details: structured, safe extras some refusals carry (e.g. a card-save conflict and the latest card).
    if (status < 500) return res.status(status).json({ error: err.message, ...(err.details ?? {}) });
    const frames = String(err?.stack ?? '').split('\n').slice(1, 6).join('\n');
    console.error(`[${processName}] ${req.method} ${req.path} failed: ${err?.name ?? 'Error'}${err?.code ? ` (${err.code})` : ''}\n${frames}`);
    res.status(500).json({ error: 'Internal server error' });
  };
}
