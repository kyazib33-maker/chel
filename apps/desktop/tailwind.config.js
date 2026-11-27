/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        canvas: "#0d0d10",
        sidebar: "#0a0a0d",
        panel: "#141418",
        raised: "#1c1c22",
        line: "#25252c",
        muted: "#86868f",
        accent: "#b7a4ff"
      }
    }
  },
  plugins: []
};
