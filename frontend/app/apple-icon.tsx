import { ImageResponse } from 'next/og';

export const size = { width: 180, height: 180 };
export const contentType = 'image/png';

// Home-screen icon on iPhone and iPad (they don't use SVG favicons).
export default function AppleIcon() {
  return new ImageResponse(
    (
      <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#0b0b0d' }}>
        <div
          style={{
            width: 104,
            height: 104,
            borderRadius: 999,
            border: '15px solid #ffffff',
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'flex-end',
            padding: 6,
          }}
        >
          <div style={{ width: 34, height: 34, borderRadius: 999, background: '#ff4fa3' }} />
        </div>
      </div>
    ),
    size,
  );
}
