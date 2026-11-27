/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        canvas: "#09090b",
        panel: "#111115",
        line: "#26262d",
        muted: "#92929d",
        accent: "#b7a4ff"
      }
    }
  },
  plugins: []
};
