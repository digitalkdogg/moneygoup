import { ImageResponse } from 'next/og'

export const runtime = 'edge'
export const alt = 'GrowMyStocks — AI Stock Analysis & Market Intelligence'
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
            fontSize: '28px',
            fontWeight: 500,
            textAlign: 'center',
            maxWidth: '860px',
            margin: '0 0 36px 0',
            lineHeight: 1.4,
          }}
        >
          AI-Powered Stock Analysis &amp; Market Intelligence
        </p>
        <div style={{ display: 'flex', gap: '14px' }}>
          <div style={{ background: 'rgba(255,255,255,0.15)', border: '1px solid rgba(255,255,255,0.2)', borderRadius: '100px', padding: '10px 22px', color: 'white', fontSize: '17px', fontWeight: 500 }}>GPS Scores</div>
          <div style={{ background: 'rgba(255,255,255,0.15)', border: '1px solid rgba(255,255,255,0.2)', borderRadius: '100px', padding: '10px 22px', color: 'white', fontSize: '17px', fontWeight: 500 }}>AI Predictions</div>
          <div style={{ background: 'rgba(255,255,255,0.15)', border: '1px solid rgba(255,255,255,0.2)', borderRadius: '100px', padding: '10px 22px', color: 'white', fontSize: '17px', fontWeight: 500 }}>Portfolio Analytics</div>
          <div style={{ background: 'rgba(255,255,255,0.15)', border: '1px solid rgba(255,255,255,0.2)', borderRadius: '100px', padding: '10px 22px', color: 'white', fontSize: '17px', fontWeight: 500 }}>Free to Join</div>
        </div>
      </div>
    ),
    { ...size }
  )
}
