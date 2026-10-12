import { ImageResponse } from 'next/og';

export const alt = 'Bullseye · Research for Indian stocks';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

// The preview card shown when a link is shared (WhatsApp, X, LinkedIn).
export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          padding: '72px 80px',
          background: '#0b0c0e',
          color: '#f3f4f6',
          fontFamily: 'sans-serif',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
          <div
            style={{
              width: 64,
              height: 64,
              borderRadius: 999,
              border: '9px solid #f3f4f6',
              display: 'flex',
              alignItems: 'flex-start',
              justifyContent: 'flex-end',
              padding: 4,
            }}
          >
            <div style={{ width: 22, height: 22, borderRadius: 999, background: '#ff4fa3' }} />
          </div>
          <div style={{ fontSize: 48, fontWeight: 700, letterSpacing: -1.5 }}>Bullseye</div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
          <div style={{ fontSize: 76, fontWeight: 700, letterSpacing: -2.5, lineHeight: 1.05 }}>
            Research for Indian stocks
          </div>
          <div style={{ fontSize: 32, color: '#a0a4ae', lineHeight: 1.4, maxWidth: 980 }}>
            Screen 2,000+ NSE stocks in plain English, test trading rules on real history, read a plain verdict.
          </div>
        </div>
        <div style={{ display: 'flex', fontSize: 26, color: '#8a8f9a' }}>bullseye.help · Research, not investment advice</div>
      </div>
    ),
    size,
  );
}
