import { NextResponse } from 'next/server'
import { spawn } from 'child_process'
import { promises as fs } from 'fs' // Import promises version of fs
import path from 'path' // Import path module

export async function POST( // Changed GET to POST
  request: Request,
  { params }: { params: { ticker: string } }
) {
  const ticker = params.ticker

  if (!ticker) {
    return NextResponse.json({ message: 'Ticker is required' }, { status: 400 })
  }

  const tempFilePath = path.join('/tmp', `tf_prediction_input_${ticker}_${Date.now()}.json`); // Use /tmp for temporary files

  // Determine Python executable path
  const pythonExecutable = process.env.PYPROCESS_URL || 'python3';

  return new Promise<NextResponse>(async (resolve) => { // Added async here and proper typing
    let pythonProcess;
    try {
      const requestBody = await request.json(); // Read request body

      // Write the request body to a temporary file
      await fs.writeFile(tempFilePath, JSON.stringify(requestBody));

      pythonProcess = spawn(pythonExecutable, [
        'predict_weighted_analysis.py',
        ticker,
        '--input_file', tempFilePath // Pass temp file path as argument
      ]);

      // pythonProcess = spawn(pythonExecutable, [
      //    'predict_tensorflow.py',
      //    ticker,
      //    '--input_file', tempFilePath // Pass temp file path as argument
      //  ]);

      pythonProcess.on('error', (err) => {
        console.error('Failed to start python script:', err);
        resolve(NextResponse.json({ message: 'Failed to start Python script.', error: err.message }, { status: 500 }));
        return;
      });

      let output = ''
      pythonProcess.stdout.on('data', (data) => {
        output += data.toString()
      })

      let errorOutput = ''
      pythonProcess.stderr.on('data', (data) => {
        errorOutput += data.toString()
      })

      pythonProcess.on('close', async (code) => { // Added async here
        // Clean up the temporary file
        try {
          await fs.unlink(tempFilePath);
        } catch (fileErr) {
          console.error(`Failed to delete temporary file ${tempFilePath}:`, fileErr);
        }

        if (code !== 0) {
          console.error(`Python script exited with code ${code}`)
          console.error(errorOutput)
          resolve(NextResponse.json({ message: 'Failed to execute Python script', error: errorOutput }, { status: 500 }))
          return
        }

        try {
          const result = JSON.parse(output);
          if (result.error) {
            return resolve(NextResponse.json({ message: result.error }, { status: 500 }));
          }
          resolve(NextResponse.json(result))
        } catch (e) {
          console.error('Failed to parse python script output:')
          console.error(output)
          resolve(NextResponse.json({ message: 'Failed to parse python script output', error: `Python stdout: ${output}\nError: ${e instanceof Error ? e.message : String(e)}` }, { status: 500 }))
        }
      })
    } catch (e) {
      // Handle errors during request body parsing or file writing
      console.error('Error in Next.js API route:', e);
      // Ensure temp file is cleaned up even if initial steps fail
      try {
        await fs.unlink(tempFilePath);
      } catch (fileErr) {
        // Ignore if file doesn't exist yet
      }
      resolve(NextResponse.json({ message: 'Error processing request for Python script', error: e instanceof Error ? e.message : String(e) }, { status: 500 }));
    }
  })
}
