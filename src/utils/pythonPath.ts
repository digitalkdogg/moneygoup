import { existsSync } from 'fs';
import { join } from 'path';

/**
 * Gets the path to the Python executable.
 * Prioritizes the local virtual environment (venv) if it exists.
 * Falls back to 'python3' if no local venv is found.
 */
export function getPythonExecutable(): string {
  // Check for local venv first (Linux/macOS)
  const venvPath = join(process.cwd(), 'venv', 'bin', 'python3');
  if (existsSync(venvPath)) {
    return venvPath;
  }
  
  // Check for local venv (Windows)
  const venvPathWin = join(process.cwd(), 'venv', 'Scripts', 'python.exe');
  if (existsSync(venvPathWin)) {
    return venvPathWin;
  }

  // Fallback to system python3
  return 'python3';
}
