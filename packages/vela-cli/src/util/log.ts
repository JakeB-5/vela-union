// Small logging helpers for the vela CLI. Plain ANSI, no external deps.

const isTTY = process.stdout.isTTY === true;

const ansi = (code: string) => (text: string): string =>
  isTTY ? `\x1b[${code}m${text}\x1b[0m` : text;

export const green = ansi("32");
export const red = ansi("31");
export const yellow = ansi("33");
export const cyan = ansi("36");
export const dim = ansi("2");
export const bold = ansi("1");

export function ok(message: string): void {
  console.log(`${green("\u2713")} ${message}`);
}

export function fail(message: string): void {
  console.log(`${red("\u2717")} ${message}`);
}

export function warn(message: string): void {
  console.log(`${yellow("!")} ${message}`);
}

export function info(message: string): void {
  console.log(`${cyan("\u2139")} ${message}`);
}

export function step(n: number, total: number, label: string): void {
  console.log(`\n${bold(`[${n}/${total}]`)} ${label}`);
}

export function indent(message: string): void {
  console.log(`  ${dim(message)}`);
}

export function header(title: string): void {
  console.log(`\n${bold(cyan(title))}`);
}

/** Format elapsed milliseconds as "1.23s" */
export function fmtElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}
