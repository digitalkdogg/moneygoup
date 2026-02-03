import { NextResponse } from 'next/server'
import { spawn } from 'child_process'

export async function GET(
  request: Request,
  { params }: { params: { ticker: string } }
) {
  const ticker = params.ticker

  if (!ticker) {
    return NextResponse.json({ message: 'Ticker is required' }, { status: 400 })
  }

  return new Promise((resolve) => {
    const pythonProcess = spawn('python3', [
      'predict_tensorflow.py',
      ticker,
    ], {
      env: {
        ...process.env,
        HTTP_PROXY: 'http://sysproxy.wal-mart.com:8080',
        HTTPS_PROXY: 'http://sysproxy.wal-mart.com:8080'
      }
    })

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

    pythonProcess.on('close', (code) => {
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
        resolve(NextResponse.json({ message: 'Failed to parse python script output', error: output }, { status: 500 }))
      }
    })
  })
}
