/** @type {import('tailwindcss').Config} */
export default {
    content: ['./index.html', './src/**/*.{ts,tsx}'],
    theme: {
        extend: {
            fontFamily: {
                sans: ['Inter', 'system-ui', 'sans-serif'],
            },
            colors: {
                fuel: {
                    50: '#f0f4ff',
                    100: '#e0e9ff',
                    500: '#3b5bdb',
                    600: '#2f4ac4',
                    700: '#2641a8',
                    900: '#1a2d7a',
                },
                success: '#22c55e',
                warning: '#f59e0b',
                danger: '#ef4444',
                surface: '#0f172a',
                card: '#1e293b',
                border: '#334155',
            },
        },
    },
    plugins: [],
}
