/**
 * Strict parsers for environment variables.
 *
 * The pattern these replace - `process.env.X === 'true'` and
 * `parseInt(process.env.X || '0', 10)` - fails silently in the one direction
 * that costs the most: a typo in a limit turns the limit off. `MEDIA_MAX_BYTES=16MB`
 * parses to NaN, every comparison against NaN is false, and the cap that was
 * supposed to bound memory quietly stops existing.
 *
 * These throw instead, so a bad value stops the boot with a message naming the
 * variable rather than surfacing as a memory incident days later.
 */

/** Thrown for any invalid value; the message always names the variable. */
export class EnvValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EnvValidationError';
  }
}

const TRUE_VALUES = new Set(['true', '1', 'yes', 'on']);
const FALSE_VALUES = new Set(['false', '0', 'no', 'off']);

/**
 * Parses a boolean. Accepts true/false, 1/0, yes/no, on/off in any case.
 * An unset or empty value takes the default; anything else throws.
 */
export function parseBoolean(name: string, raw: string | undefined, defaultValue: boolean): boolean {
  const value = raw?.trim().toLowerCase();
  if (!value) return defaultValue;

  if (TRUE_VALUES.has(value)) return true;
  if (FALSE_VALUES.has(value)) return false;

  throw new EnvValidationError(`${name} must be a boolean (true/false, 1/0, yes/no, on/off), received "${raw ?? ''}"`);
}

/**
 * Parses an integer inside an inclusive range.
 *
 * Rejects decimals and trailing garbage rather than truncating: `parseInt` reads
 * "16MB" as 16 and "5.9" as 5, both of which would silently install a limit the
 * operator never chose.
 */
export function parseInteger(
  name: string,
  raw: string | undefined,
  defaultValue: number,
  range: { min?: number; max?: number } = {},
): number {
  const value = raw?.trim();
  if (!value) return defaultValue;

  if (!/^-?\d+$/.test(value)) {
    throw new EnvValidationError(`${name} must be a whole number, received "${raw ?? ''}"`);
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new EnvValidationError(`${name} is out of the safe integer range, received "${raw ?? ''}"`);
  }

  const { min, max } = range;
  if (min !== undefined && parsed < min) {
    throw new EnvValidationError(`${name} must be >= ${min}, received ${parsed}`);
  }
  if (max !== undefined && parsed > max) {
    throw new EnvValidationError(`${name} must be <= ${max}, received ${parsed}`);
  }

  return parsed;
}

/** Parses one of a fixed set of values, case-insensitively. */
export function parseEnum<T extends string>(
  name: string,
  raw: string | undefined,
  allowed: readonly T[],
  defaultValue: T,
): T {
  const value = raw?.trim().toLowerCase();
  if (!value) return defaultValue;

  const match = allowed.find(option => option.toLowerCase() === value);
  if (!match) {
    throw new EnvValidationError(`${name} must be one of: ${allowed.join(', ')}. Received "${raw ?? ''}"`);
  }

  return match;
}

/**
 * Parses a comma-separated list into trimmed, lowercased, de-duplicated entries.
 * Empty entries are dropped, so "image, ,document," yields ["image","document"].
 *
 * @param allowed When given, every entry must belong to it - a typo in
 *   MEDIA_ALLOWED_TYPES would otherwise filter out the very type it was meant
 *   to permit, with nothing in the logs to explain the missing attachments.
 */
export function parseList(name: string, raw: string | undefined, allowed?: readonly string[]): string[] {
  const entries = (raw ?? '')
    .split(',')
    .map(entry => entry.trim().toLowerCase())
    .filter(Boolean);

  const unique = [...new Set(entries)];

  if (allowed) {
    const invalid = unique.filter(entry => !allowed.includes(entry));
    if (invalid.length > 0) {
      throw new EnvValidationError(
        `${name} contains unsupported ${invalid.length === 1 ? 'value' : 'values'}: ${invalid.join(', ')}. ` +
          `Allowed: ${allowed.join(', ')}`,
      );
    }
  }

  return unique;
}
