# Noizzzy Web

Interface estática Next.js do aplicativo Electron. O build usa `output: "export"` e caminhos de assets relativos para funcionar via `file://` sem servidor Node.

```bash
npm ci
npm run lint
npm run build
```

No navegador de desenvolvimento, a API padrão é `http://127.0.0.1:35592`. No Electron, o preload expõe apenas informações de plataforma e o instalador do runtime de IA; Node.js permanece desabilitado e o renderer roda com `contextIsolation` e sandbox.
