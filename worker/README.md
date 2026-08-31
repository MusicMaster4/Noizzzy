# Noizzzy Worker

Worker FastAPI local responsável por validação de mídia, separação vocal, restauração e mastering. O executável principal é criado com PyInstaller sem incluir PyTorch; os dois ambientes de IA ficam isolados e são gerenciados pelo Electron.

Isso evita o conflito entre as dependências atuais do `audio-separator` e do `clearvoice`, além de permitir runtimes específicos para CUDA, Apple Silicon e Mac Intel.

## Desenvolvimento

```bash
python -m pip install -e ".[dev]"
python -m pytest
python -m voice_worker.entrypoint
```

Variáveis principais:

- `VOICE_DATA_DIR`, `VOICE_MODEL_DIR`
- `VOICE_FFMPEG`, `VOICE_FFPROBE`
- `VOICE_SEPARATOR_PYTHON`, `VOICE_SEPARATOR_RUNNER`, `VOICE_SEPARATOR_DEVICE`
- `VOICE_ENHANCER_PYTHON`, `VOICE_ENHANCER_RUNNER`
- `VOICE_ALLOW_DEVELOPMENT_FALLBACK` (desativado por padrão)

O endpoint `POST /api/jobs` aceita `file`, `profile` (`streaming` ou `broadcast`) e `separate_voice`. Jobs terminais e seus arquivos são removidos de acordo com `VOICE_JOB_TTL_HOURS`.
