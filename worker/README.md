# Voice Clean Worker

Worker local em FastAPI para isolar diálogo e entregar áudio masterizado. O pipeline é intencionalmente exigente: se os modelos de ML não estiverem instalados, o job falha com uma mensagem clara. Um substituto simplificado de FFmpeg só é usado quando `VOICE_ALLOW_DEVELOPMENT_FALLBACK=true`.

## Pipeline

1. Validação real da mídia com `ffprobe` e extração PCM float32/44,1 kHz por FFmpeg, evitando uma quantização intermediária desnecessária.
2. Separação do stem vocal com **Mel-Band RoFormer**, pelo `audio-separator`, usando por padrão o checkpoint `vocals_mel_band_roformer.ckpt` de KimberleyJSN.
3. Speech enhancement com **MossFormer2_SE_48K**, via ClearerVoice-Studio.
4. Mastering de diálogo determinístico: high-pass suave em 75 Hz, de-esser e compressor soft-knee 2,5:1.
5. Normalização em dois passes com o filtro `loudnorm` do FFmpeg, baseada em EBU R128:
   - `streaming`: -16 LUFS, -1,5 dBTP;
   - `broadcast`: -23 LUFS, -1 dBTP.
6. WAV PCM 24-bit/48 kHz e, quando a entrada é vídeo, MP4 com a faixa tratada.

O Mel-Band RoFormer é o padrão porque o artigo *Mel-Band RoFormer for Music Source Separation* reporta resultados melhores que BS-RoFormer para separação vocal nas comparações publicadas. Isso não significa que um único checkpoint será ótimo para todo material; `VOICE_SEPARATOR_MODEL` permite trocar o modelo sem alterar código.

Licenças precisam ser avaliadas por componente antes de distribuição comercial: este worker não redistribui pesos. `audio-separator` é MIT; FFmpeg depende da configuração de build; ClearerVoice-Studio e cada checkpoint mantêm seus próprios termos. Consulte os repositórios e model cards oficiais dos pesos efetivamente instalados.

## Instalação no Windows / Python 3.12

Instale FFmpeg 7+ e confirme que `ffmpeg` e `ffprobe` estão no `PATH`. Depois:

```powershell
cd worker
py -3.12 -m venv .venv
.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
pip install -e ".[separation-gpu,dev]"
```

O extra `separation-gpu` é o recomendado nesta máquina com GPU compatível. Para uma máquina somente CPU, troque-o por `separation`. Os dois extras são mutuamente exclusivos.

Os projetos upstream atualmente possuem conflitos de dependência: versões atuais do `audio-separator` usam NumPy 2 e requerem `rotary-embedding-torch <0.7`, enquanto `clearvoice==0.1.2` exige NumPy <2 e fixa `rotary-embedding-torch==0.8.3`. Por isso os extras `separation` e `enhancement` são declarados mutuamente exclusivos. A configuração segura é instalar o ClearerVoice em um segundo ambiente e apontar `VOICE_ENHANCER_PYTHON` para ele:

```powershell
py -3.12 -m venv .clearvoice-venv
.clearvoice-venv\Scripts\python.exe -m pip install --upgrade pip
.clearvoice-venv\Scripts\python.exe -m pip install clearvoice==0.1.2
```

Por exemplo, no `.env`:

```dotenv
VOICE_ENHANCER_PYTHON=H:/Python/Slop/voice-clean/worker/.clearvoice-venv/Scripts/python.exe
```

O worker chama `enhancer_bridge.py` nesse ambiente como subprocesso cancelável. Se o conflito for resolvido em versões futuras, também é possível instalar apenas `.[enhancement]` no ambiente principal e deixar `VOICE_ENHANCER_PYTHON` vazio para usar o import no próprio processo. Os dois pacotes baixam os checkpoints configurados na primeira execução. Como as dependências PyTorch variam entre CPU, CUDA e DirectML, ajuste a instalação do PyTorch para a máquina e valide:

```python
from clearvoice import ClearVoice
ClearVoice(task="speech_enhancement", model_names=["MossFormer2_SE_48K"])
```

Os pacotes de ML permanecem em extras opcionais para que a API e os testes unitários possam ser instalados sem baixar vários gigabytes. Em uma máquina sem GPU, confirme memória e tempo de inferência antes de processar vídeos longos.

Copie `.env.example` para `.env`, ajuste as opções e inicie:

```powershell
uvicorn voice_worker.main:app --host 127.0.0.1 --port 35592
```

O processo não precisa permanecer aberto após o uso. Ao receber shutdown, o worker sinaliza cancelamento dos jobs ativos e encerra subprocessos FFmpeg.

## API

- `POST /api/jobs` — multipart com `file` e `profile` (`streaming` ou `broadcast`)
- `GET /api/jobs/{id}` — estado, etapa, progresso de `0.0` a `1.0`, métricas e downloads
- `DELETE /api/jobs/{id}` — solicita cancelamento
- `GET /api/jobs/{id}/source` — preview/download da fonte
- `GET /api/jobs/{id}/outputs/{name}` — download do resultado

O upload é gravado em blocos de 1 MiB, tem limite configurável e nunca utiliza o nome do cliente como caminho no disco. Jobs e cancelamento são mantidos em memória. Um ciclo periódico remove jobs terminais e seus arquivos após `VOICE_JOB_TTL_HOURS`; a frequência é o menor valor entre uma hora e metade do TTL.

## Testes rápidos

```powershell
pip install -e ".[dev]"
pytest
```
