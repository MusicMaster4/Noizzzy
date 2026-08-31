import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Noizzzy — restauração profissional de voz",
  description: "Isole, restaure e finalize vozes de arquivos de áudio e vídeo com processamento local.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="pt-BR" className="h-full antialiased">
      <head>
        <meta
          httpEquiv="Content-Security-Policy"
          content="default-src 'self' file:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src http://127.0.0.1:35592 http://localhost:35592; media-src 'self' blob: http://127.0.0.1:35592 http://localhost:35592; img-src 'self' data: blob:; font-src 'self' data:; object-src 'none'; frame-src 'none'; base-uri 'self'; form-action 'none'"
        />
      </head>
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
