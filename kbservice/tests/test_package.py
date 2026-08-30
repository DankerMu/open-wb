"""包自证：版本号可导入且为合法 semver——CI 覆盖率门禁的最小锚点。"""

import re

import kbservice


def test_version_is_semver() -> None:
    assert re.fullmatch(r"\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?", kbservice.__version__)
