/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './index.html',
    './admin/index.html',
    './portfolio/index.html',
    './checkout/index.html',
    './review/index.html',
  ],
  theme: {
    extend: {
      colors: {
        brand: { red: '#ff1a1a', dark: '#050505' },
        ink: "#06060b",
        midnight: "#0b1020",
        electric: "#49c6ff",
        violet: "#7a5cff",
        haze: "#9db4ff",
        zyrored: "#ff1a1a"
      },
      fontFamily: {
        sans: ['Outfit', 'sans-serif'],
        brand: ['"Roboto"', "sans-serif"]
      },
      boxShadow: {
        glow: "0 0 0 1px rgba(130, 96, 255, 0.16), 0 0 32px rgba(73, 198, 255, 0.18)",
        neon: "0 0 30px rgba(73, 198, 255, 0.28)",
      },
      backgroundImage: {
        grid: "linear-gradient(rgba(255,255,255,0.03) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.03) 1px, transparent 1px)",
      }
    }
  },
  plugins: []
}
