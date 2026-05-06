// Sanitize and normalize user input

export function sanitizeString(input: string, maxLength: number = 500): string {
  if (typeof input !== 'string') {
    return '';
  }

  return input
    .trim() // Remove leading/trailing whitespace
    .slice(0, maxLength) // Enforce max length
    .replace(/[\x00-\x1F\x7F]/g, ''); // Remove control characters
}

export function sanitizeEmail(email: string): string {
  if (typeof email !== 'string') {
    return '';
  }

  return email
    .trim()
    .toLowerCase()
    .slice(0, 255);
}

export function sanitizeName(name: string): string {
  if (typeof name !== 'string') {
    return '';
  }

  return sanitizeString(name, 120);
}

export function sanitizeCompany(company: string | null | undefined): string | null {
  if (!company) {
    return null;
  }

  const sanitized = sanitizeString(company, 180);
  return sanitized.length > 0 ? sanitized : null;
}

export function sanitizeMessage(message: string): string {
  if (typeof message !== 'string') {
    return '';
  }

  return sanitizeString(message, 5000);
}

export function isValidEmail(email: string): boolean {
  // RFC 5322 simplified email validation
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email) && email.length <= 255;
}

export function detectSpamPatterns(text: string): boolean {
  if (!text) return false;

  const spamPatterns = [
    /viagra/i,
    /casino/i,
    /lottery/i,
    /click here/i,
    /buy now/i,
    /limited time/i,
    /act now/i,
  ];

  return spamPatterns.some(pattern => pattern.test(text));
}
