from pathlib import Path

from voice_worker.separator_bridge import separator_init_options


class LegacySeparator:
    def __init__(self, log_level, model_file_dir, output_dir, output_format):
        pass


class ModernSeparator:
    def __init__(self, log_level, model_file_dir, output_dir, output_format, use_autocast=False):
        pass


def test_separator_options_support_legacy_and_current_audio_separator() -> None:
    legacy = separator_init_options(LegacySeparator, Path("models"), Path("output"), True)
    modern = separator_init_options(ModernSeparator, Path("models"), Path("output"), True)

    assert "use_autocast" not in legacy
    assert modern["use_autocast"] is True
