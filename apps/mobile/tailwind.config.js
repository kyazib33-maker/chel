/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./app/**/*.{js,jsx,ts,tsx}",
    "./src/**/*.{js,jsx,ts,tsx}",
  ],
  presets: [require("nativewind/preset")],
  theme: {
    extend: {
      colors: {
        canvas: "#0d0d10",
        panel: "#141418",
        raised: "#1c1c22",
        accent: "#b7a4ff",
        muted: "#86868f",
        line: "#25252c",
      },
    },
  },
  plugins: [],
};
