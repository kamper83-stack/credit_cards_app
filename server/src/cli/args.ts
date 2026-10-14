/** Strict argv parsing for the admin CLIs: unknown flags, missing values and stray arguments are errors. */
export class UsageError extends Error {}

export type FlagSpec = Record<string, 'string' | 'int'>;

export interface ParsedArgs {
  flags: Record<string, string>;
  positionals: string[];
}

/**
 * Accepts `--name value` and `--name=value`. A value may not start with `--` in the two-token form
 * (so `--label --days 3` is an error, not a label of "--days"); use `--label=--x` if needed.
 * Repeated flags, unknown flags and more positionals than `maxPositionals` throw UsageError.
 */
export function parseCliArgs(argv: string[], spec: FlagSpec, maxPositionals = 0): ParsedArgs {
  const flags: Record<string, string> = {};
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      positionals.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    const name = eq >= 0 ? a.slice(2, eq) : a.slice(2);
    if (!Object.prototype.hasOwnProperty.call(spec, name)) throw new UsageError(`Unknown option --${name}.`);
    if (name in flags) throw new UsageError(`Option --${name} given more than once.`);
    let value: string | undefined;
    if (eq >= 0) value = a.slice(eq + 1);
    else {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { value = next; i++; }
    }
    if (value === undefined || value === '') throw new UsageError(`Option --${name} needs a value.`);
    if (spec[name] === 'int' && !/^\d+$/.test(value)) throw new UsageError(`--${name} must be an integer.`);
    flags[name] = value;
  }
  if (positionals.length > maxPositionals) throw new UsageError(`Unexpected argument: ${positionals[maxPositionals]}`);
  return { flags, positionals };
}

/** Parses an int flag with a default and inclusive range. */
export function intFlag(flags: Record<string, string>, name: string, def: number, min: number, max: number): number {
  const raw = flags[name];
  if (raw === undefined) return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new UsageError(`--${name} must be an integer between ${min} and ${max}.`);
  return n;
}

/** Prints the error and usage, exits with code 2. */
export function usageExit(e: unknown, usage: string): never {
  console.error(e instanceof Error ? e.message : String(e));
  console.error(`Usage: ${usage}`);
  process.exit(2);
}
