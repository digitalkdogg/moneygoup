// src/utils/formatters.ts
export function formatNumber(value: number | null | undefined, decimals: number = 2, stripTrailingZeros: boolean = false): string {
  if (value === null || value === undefined) {
    return 'N/A';
  }

  // Handle cases where value might be non-numeric (e.g., string from API that wasn't parsed)
  const numValue = typeof value === 'string' ? parseFloat(value) : value;

  if (isNaN(numValue)) {
    return 'N/A';
  }

  // Use toLocaleString for comma separation and toFixed for decimal places
  // The 'en-US' locale typically uses commas for thousands separators.
  let formatted = numValue.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
    useGrouping: true // Ensure comma grouping
  });

  // Apply stripTrailingZeros logic if requested and there are decimals to potentially strip
  if (stripTrailingZeros && decimals > 0) {
    // Check if the formatted string ends with a decimal point followed by zeros
    const regex = new RegExp(`\\.${'0'.repeat(decimals)}$`);
    if (regex.test(formatted)) {
      formatted = formatted.replace(regex, ''); // Remove . and zeros
    }
  }

  return formatted;
}

export function formatCurrency(value: number | null | undefined, decimals: number = 2): string {
  if (value === null || value === undefined || isNaN(value)) {
    return 'N/A';
  }
  return `$${formatNumber(value, decimals)}`;
}