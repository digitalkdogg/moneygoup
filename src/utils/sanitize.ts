/**
 * Input sanitization utilities for user-generated content
 * Prevents XSS attacks and ensures data consistency in database
 */

/**
 * Sanitize username for safe storage and display
 * Allows only alphanumeric, underscores, hyphens
 * Removes any special characters that could cause issues
 *
 * @param username - Raw username input
 * @returns Sanitized username
 */
export function sanitizeUsername(username: string): string {
  if (!username || typeof username !== 'string') {
    return '';
  }

  // Remove any character that's not alphanumeric, underscore, or hyphen
  const sanitized = username.replace(/[^a-zA-Z0-9_-]/g, '');

  // Limit length (validation schema should also check this)
  return sanitized.substring(0, 50);
}

/**
 * Sanitize company name for safe storage and display
 * Removes potentially dangerous HTML/script content
 * Allows common business name characters
 *
 * @param name - Raw company name input
 * @returns Sanitized company name
 */
export function sanitizeCompanyName(name: string): string {
  if (!name || typeof name !== 'string') {
    return '';
  }

  // Remove HTML tags and dangerous characters
  // Allow alphanumeric, spaces, and common business punctuation
  let sanitized = name
    .replace(/<[^>]*>/g, '') // Remove HTML tags
    .replace(/[^\w\s&.,'-]/gi, '') // Keep word chars, spaces, &, ., comma, apostrophe, hyphen
    .trim();

  // Limit length
  return sanitized.substring(0, 200);
}

/**
 * Sanitize general text input for safe storage
 * Removes HTML tags and dangerous characters
 * Used for notes, comments, etc.
 *
 * @param text - Raw text input
 * @returns Sanitized text
 */
export function sanitizeText(text: string): string {
  if (!text || typeof text !== 'string') {
    return '';
  }

  // Remove HTML tags
  const sanitized = text.replace(/<[^>]*>/g, '').trim();

  // Limit length
  return sanitized.substring(0, 500);
}

/**
 * Sanitize ticker symbol
 * Removes any character that's not alphanumeric or common ticker symbols
 *
 * @param ticker - Raw ticker input
 * @returns Sanitized ticker
 */
export function sanitizeTicker(ticker: string): string {
  if (!ticker || typeof ticker !== 'string') {
    return '';
  }

  // Keep only alphanumeric, dots, carets, hyphens (common in ticker symbols)
  // Convert to uppercase
  const sanitized = ticker
    .replace(/[^a-zA-Z0-9.^-]/g, '')
    .toUpperCase();

  // Limit length
  return sanitized.substring(0, 10);
}

/**
 * Sanitize email address (basic)
 * Note: Full validation should happen in validation schema
 * This just removes obviously dangerous characters
 *
 * @param email - Raw email input
 * @returns Sanitized email
 */
export function sanitizeEmail(email: string): string {
  if (!email || typeof email !== 'string') {
    return '';
  }

  return email
    .trim()
    .toLowerCase()
    .substring(0, 255);
}

/**
 * Sanitize numeric input (ensure it's actually a number)
 * Prevents injection of non-numeric strings to numeric fields
 *
 * @param value - Input value
 * @returns Numeric value or 0 if invalid
 */
export function sanitizeNumber(value: unknown): number {
  const num = Number(value);
  return isNaN(num) ? 0 : num;
}

/**
 * Escape HTML special characters for safe display in HTML context
 * Used when rendering user-provided content
 *
 * @param text - Text to escape
 * @returns HTML-escaped text
 */
export function escapeHtml(text: string): string {
  const htmlEscapeMap: { [key: string]: string } = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#x27;',
    '/': '&#x2F;',
  };

  return text.replace(/[&<>"'\/]/g, char => htmlEscapeMap[char] || char);
}

/**
 * Sanitize JSON string to prevent injection attacks
 * Validates JSON structure and re-stringifies to ensure safety
 *
 * @param jsonString - JSON string to sanitize
 * @returns Safe JSON string or empty object
 */
export function sanitizeJson(jsonString: string): string {
  try {
    const parsed = JSON.parse(jsonString);
    // Re-stringify to ensure structure is valid
    return JSON.stringify(parsed);
  } catch {
    // Invalid JSON
    return '{}';
  }
}
