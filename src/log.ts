/** One JSON line per event, on stderr. Message text never goes in a log. */
export type LogFn = (event: string, fields?: Record<string, unknown>) => void;

export const logEvent: LogFn = (event, fields = {}) => {
  process.stderr.write(`${JSON.stringify({ time: new Date().toISOString(), event, ...fields })}\n`);
};
