// One JSON line per event. Never bodies, header values, query values or tokens.

export type Logger = (line: Record<string, unknown>) => void;

export const stdoutLogger: Logger = (line) => {
  process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), ...line }) + "\n");
};
