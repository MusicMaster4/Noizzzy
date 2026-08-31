# Vox Polish

Aplicativo local para enviar áudio ou vídeo, isolar a voz, restaurar detalhes e entregar um master com volume consistente. A interface é Next.js; o processamento pesado roda em um worker FastAPI na GPU da própria máquina.

## Cadeia de áudio

1. O FFmpeg extrai a primeira faixa de áudio como PCM float32/44,1 kHz.
2. O **Mel-Band RoFormer** separa o stem vocal de música e fundo. O [artigo original](https://arxiv.org/abs/2310.01809) reporta melhora sobre o BS-RoFormer na separação de vocais; o app usa o checkpoint vocal de [KimberleyJSN](https://huggingface.co/KimberleyJSN/melbandroformer/tree/main) por padrão.
3. O **MossFormer2_SE_48K** restaura fala em 48 kHz. O [paper do ClearerVoice-Studio](https://www.isca-archive.org/interspeech_2025/zhao25f_interspeech.pdf) publica resultados superiores a DeepFilterNet e Resemble Enhance no benchmark full-band usado pelo projeto.
4. Um mastering de diálogo aplica high-pass suave, de-esser e compressão soft-knee 2,5:1 para controlar picos sem achatar a interpretação.
5. O FFmpeg mede e normaliza em dois passes com `loudnorm`, segundo [ITU-R BS.1770](https://www.itu.int/rec/R-REC-BS.1770-5-202311-I) e [EBU R128](https://tech.ebu.ch/docs/r/r128v4_0.pdf), incluindo true peak.
6. A entrega inclui a voz finalizada e o áudio sem voz em WAV PCM 24-bit/48 kHz; entradas em vídeo também recebem um MP4 com a imagem preservada e a nova faixa de voz.

Se o arquivo enviado já é um stem finalizado, selecione **Voz já pronta** antes de iniciar. O app preserva timbre, efeitos e imagem estéreo: pula o Mel-Band RoFormer, o restaurador de fala e o DSP de diálogo, ajustando apenas ganho e true peak sem compressão ou limitação. Nesse modo não há saída instrumental.

Perfis disponíveis:

- **Streaming / voz pronta:** −16 LUFS, −1,5 dBTP.
- **Broadcast EBU R128:** −23 LUFS, −1 dBTP.

## Instalação rápida no Windows

Requisitos: Node.js 20+, Python 3.12, FFmpeg/FFprobe no `PATH` e, para o modo recomendado, uma GPU NVIDIA com driver atual. O instalador GPU fixa o build oficial PyTorch 2.11/CUDA 12.8, compatível com a RTX 3070 usada na validação.

```powershell
.\install.ps1
```

O instalador cria dois ambientes Python. Isso é intencional: as versões atuais de `audio-separator` e `clearvoice` fixam versões incompatíveis de NumPy e `rotary-embedding-torch`. Separá-los mantém os dois modelos reproduzíveis.

Para uma máquina sem CUDA:

```powershell
.\install.ps1 -Cpu
```

## Executar

```powershell
npm run dev
```

O comando inicia frontend e backend juntos; `.\run.ps1` continua disponível como alternativa direta. Abra `http://localhost:27295`. O backend local usa a porta `35592`. O primeiro processamento baixa cerca de 1,2 GB de pesos e demora mais; os próximos usam o cache. Pressione `Ctrl+C` no terminal para encerrar frontend e worker juntos. O script não abre o navegador automaticamente.

Arquivos enviados e resultados ficam em `worker/.voice-data` e são removidos por um ciclo de retenção após 24 horas. O app não envia a mídia a uma API externa.

## Desenvolvimento e testes

```powershell
cd web
npm run lint
npm run build

cd ..\worker
.venv\Scripts\python.exe -m pytest
```

O backend só usa os substitutos DSP simplificados quando `VOICE_ALLOW_DEVELOPMENT_FALLBACK=true`. O padrão é `false`: se um modelo real estiver ausente, o job falha de forma explícita em vez de fingir que executou IA.

Mais detalhes da API e das variáveis estão em [worker/README.md](worker/README.md).
