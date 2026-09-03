import { existsSync } from 'fs';
import { join } from 'path';

/**
 * Gets the path to the Python executable.
 * Prioritizes the local virtual environment (venv) if it exists.
 * Falls back to 'python3' if no local venv is found.
 */
export function getPythonExecutable(): string {
  // venv313 (Python 3.13, matches Bluehost's venv/ exactly) takes priority
  // over venv312 (Python 3.12, the original workaround), which takes
  // priority over venv (Python 3.14): tensorflow-cpu has no 3.14 wheel yet,
  // and predict_weighted_analysis.py's long-term path needs it. Both
  // workaround venvs have the full requirements.txt installed too, so
  // they're a strict superset — safe to prefer whenever they exist.
  const venv313Path = join(process.cwd(), 'venv313', 'bin', 'python3');
  if (existsSync(venv313Path)) {
    return venv313Path;
  }

  const venv312Path = join(process.cwd(), 'venv312', 'bin', 'python3');
  if (existsSync(venv312Path)) {
    return venv312Path;
  }

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
