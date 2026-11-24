/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,html}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', '"Noto Sans TC"', 'system-ui', '-apple-system', 'sans-serif'],
      },
      colors: {
        owl: {
          canvas: '#F5EFE6',
          panel: '#FBF8F3',
          card: '#FFFDF9',
          border: '#E2D6C5',
          cardBorder: '#E6DBC9',
          softBg: '#EFE6DA',
          selectedBg: '#F6EFE6',
          primary: '#9A7B5C',
          primaryHover: '#816448',
          primaryDeep: '#6B513A',
          accentBorder: '#A48262',
          text: '#3A2C21',
          subtext: '#786454',
          muted: '#A08D7C',
          darkTop: '#4A382B',
          darkBottom: '#3D2E23',
          gold: '#E5C59E',
          cream: '#FAF4EC',
        },
      },
      boxShadow: {
        '2xs': '0 1px 2px 0 rgba(58, 44, 33, 0.05)',
        xs: '0 1px 3px 0 rgba(58, 44, 33, 0.07)',
        soft: '0 4px 18px -2px rgba(58, 44, 33, 0.08)',
        float: '0 10px 28px -5px rgba(58, 44, 33, 0.16)',
        dropdown: '0 18px 38px -8px rgba(58, 44, 33, 0.22)',
        brand: '0 4px 12px -2px rgba(130, 100, 71, 0.42)',
      },
      backdropBlur: {
        xs: '2px',
      },
    },
  },
  plugins: [],
};
