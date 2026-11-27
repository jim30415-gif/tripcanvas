/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{js,html}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', '"Noto Sans TC"', 'system-ui', '-apple-system', 'sans-serif'],
      },
      colors: {
        owl: {
          canvas: 'rgb(var(--owl-canvas-rgb) / <alpha-value>)',
          panel: 'rgb(var(--owl-panel-rgb) / <alpha-value>)',
          card: 'rgb(var(--owl-card-rgb) / <alpha-value>)',
          border: 'rgb(var(--owl-border-rgb) / <alpha-value>)',
          cardBorder: 'rgb(var(--owl-cardBorder-rgb) / <alpha-value>)',
          softBg: 'rgb(var(--owl-softBg-rgb) / <alpha-value>)',
          selectedBg: 'rgb(var(--owl-selectedBg-rgb) / <alpha-value>)',
          primary: 'rgb(var(--owl-primary-rgb) / <alpha-value>)',
          primaryHover: 'rgb(var(--owl-primaryHover-rgb) / <alpha-value>)',
          primaryDeep: 'rgb(var(--owl-primaryDeep-rgb) / <alpha-value>)',
          accentBorder: 'rgb(var(--owl-accentBorder-rgb) / <alpha-value>)',
          text: 'rgb(var(--owl-text-rgb) / <alpha-value>)',
          subtext: 'rgb(var(--owl-subtext-rgb) / <alpha-value>)',
          muted: 'rgb(var(--owl-muted-rgb) / <alpha-value>)',
          darkTop: 'rgb(var(--owl-darkTop-rgb) / <alpha-value>)',
          darkBottom: 'rgb(var(--owl-darkBottom-rgb) / <alpha-value>)',
          gold: 'rgb(var(--owl-gold-rgb) / <alpha-value>)',
          cream: 'rgb(var(--owl-cream-rgb) / <alpha-value>)',
        },
      },
      boxShadow: {
        '2xs': 'var(--owl-shadow-2xs)',
        xs: 'var(--owl-shadow-xs)',
        soft: 'var(--owl-shadow-soft)',
        float: 'var(--owl-shadow-float)',
        dropdown: 'var(--owl-shadow-dropdown)',
        brand: 'var(--owl-shadow-brand)',
      },
      backdropBlur: {
        xs: '2px',
      },
    },
  },
  plugins: [],
};
