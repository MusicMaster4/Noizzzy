from __future__ import annotations

from voice_worker.media import _last_loudnorm_json
from voice_worker.models import PROFILES


def test_loudnorm_parser_uses_last_measurement() -> None:
    stderr = '''
    [Parsed_loudnorm_0] summary
    {
      "input_i" : "-27.44",
      "input_tp" : "-3.10",
      "input_lra" : "4.20",
      "input_thresh" : "-38.00",
      "output_i" : "-23.00",
      "target_offset" : "0.01"
    }
    '''
    measured = _last_loudnorm_json(stderr)
    assert measured["input_i"] == "-27.44"
    assert measured["target_offset"] == "0.01"


def test_mastering_profiles_match_contract() -> None:
    assert PROFILES["streaming"].integrated_lufs == -16
    assert PROFILES["streaming"].true_peak_dbtp == -1.5
    assert PROFILES["broadcast"].integrated_lufs == -23
    assert PROFILES["broadcast"].true_peak_dbtp == -1

