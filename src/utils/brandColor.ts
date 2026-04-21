import { execFile } from 'child_process';
import { promisify } from 'util';
import { createLogger } from './logger';

const execFileAsync = promisify(execFile);
const logger = createLogger('utils/brandColor');

export type BrandColorScriptResult = {
  ticker: string;
  company: string;
  website: string | null;
  brand_color: string;
  source: 'css' | 'logo' | 'favicon' | 'default' | string;
};

export async function getBrandColorFromScript(
  ticker: string,
  company: string,
): Promise<BrandColorScriptResult | null> {
  const scriptPath = `${process.cwd()}/scripts/find_brand_color.py`;
  logger.info(`getBrandColorFromScript: Executing script at ${scriptPath} for ${ticker}`);

  try {
    const { stdout, stderr } = await execFileAsync('python3', [
      scriptPath,
      '--ticker',
      ticker,
      '--company',
      company,
    ], {
      timeout: 20000,
      maxBuffer: 1024 * 1024,
    });

    logger.info(`getBrandColorFromScript: stdout type: ${typeof stdout}, length: ${stdout?.length}`);
    logger.info(`getBrandColorFromScript: script stdout: "${stdout?.trim()}"`);

    if (stderr) {
      logger.warn(`Brand color script stderr for ${ticker}: ${stderr}`);
    }

    if (!stdout || stdout.trim() === '') {
      logger.warn(`getBrandColorFromScript: Empty stdout for ${ticker}`);
      return null;
    }

    const parsed = JSON.parse(stdout.trim()) as BrandColorScriptResult;
    if (!parsed?.brand_color) {
      return null;
    }

    return parsed;
  } catch (error) {
    logger.warn(`Brand color script failed for ${ticker}`, error as Error);
    return null;
  }
}