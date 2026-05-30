/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./src/renderer/**/*.{html,tsx,ts}"],
  theme: {
    extend: {
      colors: {
        bg: "#0f1115",
        panel: "#161922",
        panel2: "#1d2230",
        line: "#262b39",
        ink: "#e6e9ef",
        muted: "#8a92a6",
        accent: "#5b8def",
        pick: "#3ec574",
        reject: "#ef4444",
      },
      fontFamily: {
        sans: [
          "-apple-system",
          "BlinkMacSystemFont",
          "Segoe UI",
          "Inter",
          "system-ui",
          "sans-serif",
        ],
      },
    },
  },
  plugins: [],
};
