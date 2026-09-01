# Noizzzy

Aplicativo desktop local para Windows e macOS que remove música e ruído, restaura a voz e finaliza áudio de arquivos de áudio ou vídeos MP4 para streaming. A interface é Electron + Next.js estático; a API e todo o processamento rodam na própria máquina. Nenhuma mídia é enviada para serviços externos.

## Plataformas

| Build | Runner nativo | Processamento de IA |
| --- | --- | --- |
| Windows x64 | `windows-2025` | CUDA 12.8 quando há GPU NVIDIA; CPU caso contrário |
| macOS Apple Silicon | `macos-15` arm64 | PyTorch/MPS quando disponível, com fallback de CPU |
| macOS Intel | `macos-15-intel` x64 | CPU, Python 3.11 e PyTorch 2.2.2 compatíveis com Intel |

Cada instalador contém Electron, o worker FastAPI, FFmpeg, FFprobe e o gerenciador de Python `uv`. O usuário não precisa instalar Node.js, Python nem FFmpeg.

A interface possui um único fluxo: o usuário arrasta um arquivo de áudio ou vídeo MP4 e o Noizzzy assume automaticamente que há ruído de fundo, ativa separação e restauração e usa o perfil de streaming em −16 LUFS/−1,5 dBTP. Para MP4, o app entrega a voz tratada em WAV e uma cópia do vídeo com a faixa de áudio tratada. No primeiro uso, o app oferece a instalação guiada do runtime de IA. Essa instalação é separada porque PyTorch, CUDA e os modelos somam vários gigabytes e são diferentes em cada arquitetura. Os pesos do Mel-Band RoFormer e do MossFormer2 são baixados no primeiro processamento e permanecem em cache local.

## Pipeline

1. FFmpeg valida a mídia enviada e extrai a primeira faixa de áudio.
2. Mel-Band RoFormer separa voz e acompanhamento.
3. MossFormer2_SE_48K restaura a voz em 48 kHz.
4. O DSP de diálogo aplica high-pass suave, de-esser e compressão soft-knee.
5. `loudnorm` em dois passes finaliza em −16 LUFS/−1,5 dBTP para streaming.
6. O app entrega a voz limpa em WAV PCM 24-bit e o acompanhamento sem voz quando disponível.
7. Para entradas MP4, o app também preserva o vídeo e substitui sua faixa de áudio pela voz tratada.

## Desenvolvimento

Requisitos de desenvolvimento: Node.js 24 e Python 3.12. O FFmpeg de sistema é opcional, porque os testes desktop usam os binários empacotados.

No Windows:

```powershell
.\install.ps1
.\run.ps1
```

No Windows ou macOS:

```bash
npm ci
npm ci --prefix web
python -m pip install -e "./worker[dev]" "pyinstaller>=6.16,<7"
npm run dev
```

## Testes e builds locais

```bash
npm run lint --prefix web
npm test
npm run test:e2e
python -m pytest worker/tests

npm run dist:windows   # Windows x64
npm run dist:mac-arm   # macOS Apple Silicon
npm run dist:mac-intel # macOS Intel
```

`npm run test:worker-smoke` inicia o worker empacotado, gera um WAV real com o FFmpeg incluído, envia o arquivo à API, processa no modo transparente e valida o download final. `npm run test:e2e:packaged` abre o aplicativo já empacotado e verifica janela, preload seguro e conexão com o worker.

## GitHub Actions

O workflow [build-desktop.yml](.github/workflows/build-desktop.yml) é executado em pushes para branches e também manualmente. Primeiro roda lint, build e testes; depois cria três builds em hardware nativo e publica os instaladores como artifacts por 14 dias:

- `Noizzzy-windows-x64-*`
- `Noizzzy-macos-arm64-*`
- `Noizzzy-macos-x64-*`

As builds de macOS recebem assinatura ad-hoc para executar corretamente em Intel e Apple Silicon. Para distribuição sem o aviso do Gatekeeper é necessário um certificado Apple Developer ID e notarização; essas credenciais não pertencem ao repositório e devem ser configuradas como secrets antes de uma distribuição pública assinada.

Em pushes para `main`, o workflow cria automaticamente a tag correspondente à versão do `package.json` e publica o GitHub Release somente depois que as três builds e todos os testes passam. A versão deve ser incrementada antes de cada merge em `main`; uma versão ou tag já publicada encerra o workflow com um erro explícito. Execuções manuais apenas validam e geram artifacts, sem publicar uma versão.

Cada build nativa instala o runtime de IA da plataforma, importa PyTorch, audio-separator e ClearVoice, reinicia o worker empacotado e processa um MP4 real de ponta a ponta com separação, restauração, mastering e remux antes de autorizar a publicação.

## Dados locais

- Jobs e resultados: diretório `data` dentro do `userData` do Electron.
- Modelos: `models` dentro do `userData`.
- Runtime de IA: `ml-runtime` dentro do `userData`.
- Retenção padrão dos jobs: 24 horas.

Os termos de redistribuição dos pesos e modelos devem ser verificados antes de uso comercial. O repositório não incorpora pesos de terceiros nos instaladores.
