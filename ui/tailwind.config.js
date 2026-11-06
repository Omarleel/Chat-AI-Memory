/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  darkMode: 'media',
  theme: {
    extend: {
      fontFamily: {sans: ['ui-sans-serif', 'system-ui', 'Segoe UI', 'sans-serif']},
      colors: {brand: {50: '#ecfdf5', 100: '#d1fae5', 500: '#10b981', 600: '#059669', 700: '#047857', 900: '#064e3b'}}
    }
  },
  plugins: []
};
