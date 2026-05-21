export function getESTDate(): Date {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
}

export function toErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  // Axios / SDK errors expose response.data or response.status
  if (typeof err === 'object' && err !== null) {
    const e = err as Record<string, unknown>;
    const status  = (e['response'] as Record<string, unknown> | undefined)?.['status'];
    const data    = (e['response'] as Record<string, unknown> | undefined)?.['data'];
    const msg     = e['message'];
    if (status !== undefined) return `HTTP ${status}: ${JSON.stringify(data ?? msg)}`;
    if (msg !== undefined)    return String(msg);
    return JSON.stringify(err);
  }
  return String(err);
}
