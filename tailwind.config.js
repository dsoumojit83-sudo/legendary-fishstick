/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './index.html',
    './admin/index.html',
    './payment-success/index.html',
    './payment-failed/index.html',
  ],
  theme: {
    extend: {
      colors: {
        brand: { red: '#ff1a1a', dark: '#050505' }
      },
      fontFamily: {
        sans: ['Outfit', 'sans-serif']
      }
    }
  },
  plugins: []
}
