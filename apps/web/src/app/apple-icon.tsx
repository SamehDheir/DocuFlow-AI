import { ImageResponse } from 'next/og';

/**
 * Apple touch icon.
 *
 * Generated rather than committed as a binary so it stays in sync with the SVG
 * favicon — one shape, one set of colours, edited in one place.
 *
 * iOS ignores transparency and rounds the corners itself, so this fills the
 * full square with the copper field and lets the system apply the squircle.
 * Padding is more generous than the favicon because the icon is displayed
 * large on a home screen, where a tightly cropped glyph looks cramped.
 */
export const size = { width: 180, height: 180 };
export const contentType = 'image/png';

export default function AppleIcon() {
  return new ImageResponse(
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: '#9C5313',
      }}
    >
      <svg width="116" height="116" viewBox="0 0 32 32">
        <path
          d="M9.2 5.5h7.6l6.7 6.7v13.3a2 2 0 0 1-2 2H9.2a2 2 0 0 1-2-2V7.5a2 2 0 0 1 2-2Z"
          fill="#FDF8F3"
        />
        <path d="M16.8 5.5l6.7 6.7h-4.7a2 2 0 0 1-2-2V5.5Z" fill="#E9CBAB" />
        <path
          d="M10.9 16.5h9.4M10.9 20.1h6.9M10.9 23.7h4.2"
          stroke="#9C5313"
          strokeWidth="2.1"
          strokeLinecap="round"
        />
      </svg>
    </div>,
    size,
  );
}
