// Talks to the local Buildwerk server.

const token = document.querySelector('meta[name="bw-token"]')?.content || '';

async function call(method, url, body) {
  const response = await fetch(url, {
    method,
    headers: { 'X-Buildwerk-Token': token, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try {
    data = await response.json();
  } catch {
    // no JSON body
  }
  if (!response.ok) throw new Error(data?.error || `Anfrage fehlgeschlagen (${response.status})`);
  return data;
}

export const api = {
  get: (url) => call('GET', url),
  post: (url, body = {}) => call('POST', url, body),
  put: (url, body) => call('PUT', url, body),
  /** Server-sent events need the token in the URL because they cannot set headers. */
  events: (runId) => new EventSource(`/api/runs/${runId}/events?token=${encodeURIComponent(token)}`),
};
