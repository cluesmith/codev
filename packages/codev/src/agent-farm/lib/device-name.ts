/**
 * Device name normalization and validation for Tower cloud registration.
 *
 * Device names follow DNS label rules:
 * - 1-63 characters
 * - Lowercase alphanumeric + hyphens
 * - Must start and end with a letter or digit
 */

/**
 * Normalize a raw device name input.
 * Trims, lowercases, replaces spaces/underscores with hyphens,
 * and strips all other invalid characters.
 */
export function normalizeDeviceName(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '');
}

/**
 * Validate a normalized device name.
 * Returns { valid: true } or { valid: false, error: string }.
 */
export function validateDeviceName(name: string): { valid: true } | { valid: false; error: string } {
  if (!name) {
    return { valid: false, error: 'Device name is required.' };
  }

  if (name.length > 63) {
    return { valid: false, error: 'Device name must be 63 characters or fewer.' };
  }

  if (/^-|-$/.test(name)) {
    return { valid: false, error: 'Device name must start and end with a letter or number.' };
  }

  if (/^-+$/.test(name)) {
    return { valid: false, error: 'Device name must contain at least one letter or number.' };
  }

  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(name)) {
    return {
      valid: false,
      error: 'Invalid device name. Use letters, numbers, and hyphens (must start and end with a letter or number).',
    };
  }

  return { valid: true };
}
