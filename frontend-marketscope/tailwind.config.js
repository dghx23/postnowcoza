/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: "#172127",
        paper: "#f1f3ee",
        accent: { DEFAULT: "#1f6f5c", soft: "#e6efe9" },
        rust: { DEFAULT: "#b5502e", soft: "#f7e9e2" },
        gold: { DEFAULT: "#b9822c", soft: "#f6eddb" },
        line: "#dde1d8",
        muted: "#6c7873",
      },
      fontFamily: {
        display: ["Georgia", "Iowan Old Style", "Times New Roman", "serif"],
      },
    },
  },
  plugins: [],
};
