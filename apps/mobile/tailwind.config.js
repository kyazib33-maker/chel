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
        canvas: "#09090b",
        panel: "#18181b",
        accent: "#c4b5fd",
        muted: "#a1a1aa",
        line: "#303039",
      },
    },
  },
  plugins: [],
};
