import './globals.css';

export const metadata = {
  title: 'Browser Automation Agent',
  description: 'Type a task in plain English and watch an agent drive a real browser.',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
