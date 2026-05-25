import { ImageResponse } from 'next/og'

export const runtime = 'edge'
export const alt = 'Register for GrowMyStocks — Free AI Stock Analysis'
export const size = { width: 1200, height: 630 }
export const contentType = 'image/png'

export default function Image() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'linear-gradient(135deg, #013d1d 0%, #015f2d 50%, #017e3b 100%)',
          padding: '60px',
          fontFamily: '"Inter", "Helvetica Neue", sans-serif',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '18px', marginBottom: '28px' }}>
          <div
            style={{
              width: '68px',
              height: '68px',
              background: 'white',
              borderRadius: '14px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: '38px',
              fontWeight: 800,
              color: '#017e3b',
            }}
          >
            G
          </div>
          <span style={{ color: 'white', fontSize: '54px', fontWeight: 800, letterSpacing: '-1px' }}>
            GrowMyStocks
          </span>
        </div>
        <p
          style={{
            color: 'rgba(255,255,255,0.92)',
            fontSize: '30px',
            fontWeight: 600,
            textAlign: 'center',
            margin: '0 0 12px 0',
          }}
        >
          Create Your Free Account
        </p>
        <p
          style={{
            color: 'rgba(255,255,255,0.7)',
            fontSize: '22px',
            fontWeight: 400,
            textAlign: 'center',
            maxWidth: '700px',
            margin: '0 0 36px 0',
          }}
        >
          Start analyzing stocks with AI-powered GPS scores and price predictions
        </p>
        <div style={{ display: 'flex', gap: '14px' }}>
          <div style={{ background: 'rgba(255,255,255,0.15)', border: '1px solid rgba(255,255,255,0.2)', borderRadius: '100px', padding: '10px 22px', color: 'white', fontSize: '17px', fontWeight: 500 }}>Free to Join</div>
          <div style={{ background: 'rgba(255,255,255,0.15)', border: '1px solid rgba(255,255,255,0.2)', borderRadius: '100px', padding: '10px 22px', color: 'white', fontSize: '17px', fontWeight: 500 }}>GPS Scores</div>
          <div style={{ background: 'rgba(255,255,255,0.15)', border: '1px solid rgba(255,255,255,0.2)', borderRadius: '100px', padding: '10px 22px', color: 'white', fontSize: '17px', fontWeight: 500 }}>AI Predictions</div>
          <div style={{ background: 'rgba(255,255,255,0.15)', border: '1px solid rgba(255,255,255,0.2)', borderRadius: '100px', padding: '10px 22px', color: 'white', fontSize: '17px', fontWeight: 500 }}>Portfolio Analytics</div>
        </div>
      </div>
    ),
    { ...size }
  )
}
